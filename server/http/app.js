// Небольшой HTTP-фреймворк поверх node:http: маршруты с параметрами, цепочки обработчиков,
// JSON-тело, cookies, gzip, единая обработка ошибок. Без внешних зависимостей.
import zlib from 'node:zlib';
import { logger } from '../lib/logger.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const notFound = (msg = 'Запись не найдена') => new HttpError(404, msg);
export const forbidden = (msg = 'Недостаточно прав') => new HttpError(403, msg);

const MAX_BODY = 1024 * 1024;

function compilePath(path) {
  const keys = [];
  const re = path
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    })
    .replace(/\*$/, '(.*)');
  return { regex: new RegExp('^' + re + '/?$'), keys };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function enhanceResponse(req, res) {
  res.json = (data, status = 200) => {
    if (res.writableEnded) return;
    let body = Buffer.from(JSON.stringify(data));
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (body.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      body = zlib.gzipSync(body, { level: 6 });
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  res.send = (text, status = 200, type = 'text/plain; charset=utf-8', extraHeaders = {}) => {
    if (res.writableEnded) return;
    const body = Buffer.isBuffer(text) ? text : Buffer.from(String(text));
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, ...extraHeaders });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  res.noContent = () => {
    if (res.writableEnded) return;
    res.writeHead(204);
    res.end();
  };
  res.cookies = [];
  res.setCookie = (name, value, { maxAge, httpOnly = true, sameSite = 'Lax', secure = false, path = '/' } = {}) => {
    let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
    if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
    if (httpOnly) c += '; HttpOnly';
    if (secure) c += '; Secure';
    res.cookies.push(c);
    res.setHeader('Set-Cookie', res.cookies);
  };
}

export function createApp({ trustProxy = false } = {}) {
  const routes = [];
  const before = [];
  let fallback = null;

  const add = (method) => (path, ...handlers) => {
    routes.push({ method, ...compilePath(path), handlers });
  };

  async function runChain(handlers, req, res) {
    for (const h of handlers) {
      const result = await h(req, res);
      if (res.writableEnded || res.headersSent) return true;
      if (result !== undefined) {
        res.json(result);
        return true;
      }
    }
    return false;
  }

  async function handle(req, res) {
    const started = process.hrtime.bigint();
    const url = new URL(req.url, 'http://localhost');
    req.path = decodeURIComponent(url.pathname);
    req.query = Object.fromEntries(url.searchParams);
    req.searchParams = url.searchParams;
    req.cookies = parseCookies(req.headers.cookie);
    req.ip = ((trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    req.params = {};
    req.body = {};
    enhanceResponse(req, res);

    res.on('finish', () => {
      if (req.path.startsWith('/api/') && req.path !== '/api/stream') {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        logger.debug(`${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms`);
      }
    });

    try {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const raw = await readBody(req);
        if (raw.length) {
          const type = req.headers['content-type'] || '';
          if (!type.includes('application/json')) throw new HttpError(415, 'Ожидается JSON (Content-Type: application/json)');
          try {
            req.body = JSON.parse(raw.toString('utf8'));
          } catch {
            throw badRequest('Некорректный JSON в теле запроса');
          }
          if (req.body === null || typeof req.body !== 'object') throw badRequest('Тело запроса должно быть объектом');
        }
      }

      if (await runChain(before, req, res)) return;

      const method = req.method === 'HEAD' ? 'GET' : req.method;
      let pathMatched = false;
      for (const route of routes) {
        const m = route.regex.exec(req.path);
        if (!m) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        route.keys.forEach((k, i) => (req.params[k] = m[i + 1]));
        if (await runChain(route.handlers, req, res)) return;
        return; // обработчик ничего не вернул — считаем, что ответ отправлен сам
      }
      if (pathMatched) throw new HttpError(405, 'Метод не поддерживается');
      if (fallback && (await fallback(req, res)) !== false) return;
      throw new HttpError(404, 'Ресурс не найден');
    } catch (err) {
      sendError(err, req, res);
    }
  }

  return {
    use: (fn) => before.push(fn),
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
    setFallback: (fn) => (fallback = fn),
    handle,
  };
}

// Перевод ошибок PostgreSQL в понятные пользователю сообщения
function translatePgError(err) {
  switch (err.code) {
    case '23505':
      return new HttpError(409, 'Такая запись уже существует', { constraint: err.constraint, detail: err.detail });
    case '23503':
      return new HttpError(409, 'Запись связана с другими данными или ссылается на несуществующую запись', { constraint: err.constraint });
    case '23514':
      return new HttpError(422, 'Значение не прошло проверку ограничений БД', { constraint: err.constraint });
    case '22P02':
    case '22007':
    case '22008':
      return badRequest('Некорректный формат значения');
    case '57014':
      return new HttpError(503, 'Запрос к БД превысил лимит времени');
    default:
      return null;
  }
}

export function sendError(err, req, res) {
  let e = err;
  if (err?.name === 'PgError') e = translatePgError(err) || err;
  const status = e instanceof HttpError ? e.status : 500;
  if (status >= 500) logger.error(`${req.method} ${req.path}: ${err.stack || err.message}`, err.query ? { query: err.query } : undefined);
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = { error: status >= 500 && !(e instanceof HttpError) ? 'Внутренняя ошибка сервера' : e.message };
  if (e.details) body.details = e.details;
  if (req.path.startsWith('/api/') || !req.headers.accept?.includes('text/html')) res.json(body, status);
  else res.send(body.error, status);
}
