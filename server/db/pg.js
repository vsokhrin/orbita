// Минимальный клиент PostgreSQL поверх wire-протокола v3 — без внешних зависимостей.
// Поддерживает: SCRAM-SHA-256 / MD5 / cleartext аутентификацию, расширенный протокол
// с параметрами ($1, $2 …), простой протокол для миграций, пул соединений и транзакции.
import net from 'node:net';
import crypto from 'node:crypto';

const PROTOCOL_V3 = 196608;
const EMPTY = Buffer.alloc(0);

export class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'Ошибка PostgreSQL');
    this.name = 'PgError';
    this.severity = fields.V || fields.S;
    this.code = fields.C;
    this.detail = fields.D;
    this.hint = fields.H;
    this.position = fields.P;
    this.schema = fields.s;
    this.table = fields.t;
    this.column = fields.c;
    this.constraint = fields.n;
  }
}

// ---------- разбор значений по OID типа ----------

function parseTimestamp(text) {
  // Сессия работает в UTC с DateStyle=ISO: "2026-10-31 17:03:40.332417+00"
  let s = text.replace(' ', 'T');
  s = s.replace(/(\.\d{3})\d+/, '$1');
  if (/[+-]\d\d$/.test(s)) s += ':00';
  else if (!/[zZ]|[+-]\d\d:\d\d$/.test(s)) s += 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? text : d.toISOString();
}

function parseArray(text, conv) {
  // простые одномерные массивы без вложенных кавычек: {1,2,3} или {a,"b c"}
  if (text === '{}') return [];
  const inner = text.slice(1, -1);
  const out = [];
  let cur = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quoted) {
      if (ch === '\\') { cur += inner[++i]; continue; }
      if (ch === '"') { quoted = false; continue; }
      cur += ch;
    } else if (ch === '"') { quoted = true; wasQuoted = true; }
    else if (ch === ',') { out.push(!wasQuoted && cur === 'NULL' ? null : conv(cur)); cur = ''; wasQuoted = false; }
    else cur += ch;
  }
  out.push(!wasQuoted && cur === 'NULL' ? null : conv(cur));
  return out;
}

const toNumber = (v) => Number(v);
const toBigint = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
};
const identity = (v) => v;

const PARSERS = new Map([
  [16, (v) => v === 't'],
  [20, toBigint],
  [21, toNumber],
  [23, toNumber],
  [26, toNumber],
  [700, toNumber],
  [701, toNumber],
  [1700, toNumber],
  [114, JSON.parse],
  [3802, JSON.parse],
  [1114, parseTimestamp],
  [1184, parseTimestamp],
  [1082, identity],
  [1005, (v) => parseArray(v, toNumber)], // int2[]
  [1007, (v) => parseArray(v, toNumber)], // int4[]
  [1016, (v) => parseArray(v, toBigint)], // int8[]
  [1009, (v) => parseArray(v, identity)], // text[]
  [1015, (v) => parseArray(v, identity)], // varchar[]
]);

// ---------- сериализация параметров ----------

function arrayLiteral(arr) {
  const items = arr.map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  });
  return '{' + items.join(',') + '}';
}

function serializeParam(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  if (Array.isArray(v)) return arrayLiteral(v);
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

// ---------- построение сообщений ----------

function cstr(s) {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
}
function int16(n) {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
}
function int32(n) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}
function message(type, parts) {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(5);
  head.write(type, 0, 'ascii');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

// ---------- SCRAM-SHA-256 ----------

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
function xor(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}
function parseScramAttrs(str) {
  const attrs = {};
  for (const part of str.split(',')) {
    const idx = part.indexOf('=');
    attrs[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return attrs;
}

// ---------- соединение ----------

export class Connection {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.buffer = EMPTY;
    this.pending = null; // текущая операция
    this.queue = []; // ожидающие операции
    this.alive = false;
    this.params = {};
    this.lastUsed = Date.now();
    this.onNotice = null;
  }

  connect() {
    const { host, port, user, database, password, connectTimeoutMs = 10_000 } = this.config;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.alive = false;
        try {
          this.socket?.destroy();
        } catch {}
        reject(err);
      };
      const socket = net.connect({ host, port });
      this.socket = socket;
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
      const timer = setTimeout(() => fail(new Error(`Таймаут подключения к PostgreSQL ${host}:${port}`)), connectTimeoutMs);

      this.pending = {
        kind: 'startup',
        resolve: () => {
          clearTimeout(timer);
          settled = true;
          this.alive = true;
          resolve(this);
        },
        reject: (err) => {
          clearTimeout(timer);
          fail(err);
        },
      };

      socket.on('connect', () => {
        const params = {
          user,
          database,
          client_encoding: 'UTF8',
          DateStyle: 'ISO, YMD',
          TimeZone: 'UTC',
          application_name: this.config.applicationName || 'orbita',
          ...(this.config.statementTimeoutMs ? { statement_timeout: String(this.config.statementTimeoutMs) } : {}),
        };
        const parts = [int32(PROTOCOL_V3)];
        for (const [k, v] of Object.entries(params)) parts.push(cstr(k), cstr(v));
        parts.push(Buffer.from([0]));
        const body = Buffer.concat(parts);
        socket.write(Buffer.concat([int32(body.length + 4), body]));
      });
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (err) => this._onClose(err));
      socket.on('close', () => this._onClose(new Error('Соединение с PostgreSQL закрыто')));
      this._password = password;
      this._user = user;
    });
  }

  _onClose(err) {
    const wasAlive = this.alive;
    this.alive = false;
    const ops = [this.pending, ...this.queue].filter(Boolean);
    this.pending = null;
    this.queue = [];
    for (const op of ops) op.reject(err);
    if (wasAlive && this.config.onError) this.config.onError(err);
  }

  _write(buf) {
    this.socket.write(buf);
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let offset = 0;
    const buf = this.buffer;
    while (buf.length - offset >= 5) {
      const len = buf.readInt32BE(offset + 1);
      if (buf.length - offset < 1 + len) break;
      const type = String.fromCharCode(buf[offset]);
      const payload = buf.subarray(offset + 5, offset + 1 + len);
      offset += 1 + len;
      try {
        this._handle(type, payload);
      } catch (err) {
        this._onClose(err);
        this.socket?.destroy();
        return;
      }
    }
    this.buffer = offset >= buf.length ? EMPTY : Buffer.from(buf.subarray(offset));
  }

  _handle(type, p) {
    const op = this.pending;
    switch (type) {
      case 'R':
        return this._handleAuth(p);
      case 'S': {
        const [k, v] = readCStrings(p, 2);
        this.params[k] = v;
        return;
      }
      case 'K':
        this.backendPid = p.readInt32BE(0);
        return;
      case 'Z': // ReadyForQuery
        this.txStatus = String.fromCharCode(p[0]);
        if (!op) return;
        this.pending = null;
        if (op.error) op.reject(op.error);
        else op.resolve(op.result);
        this._next();
        return;
      case 'T': {
        // RowDescription
        const n = p.readInt16BE(0);
        let o = 2;
        const fields = [];
        for (let i = 0; i < n; i++) {
          const end = p.indexOf(0, o);
          const name = p.toString('utf8', o, end);
          o = end + 1;
          const typeOid = p.readInt32BE(o + 6);
          o += 18;
          fields.push({ name, typeOid, parse: PARSERS.get(typeOid) || identity });
        }
        if (op) {
          op.result.fields = fields;
          op.result.rows = [];
        }
        return;
      }
      case 'D': {
        if (!op || op.error) return;
        const fields = op.result.fields;
        const n = p.readInt16BE(0);
        let o = 2;
        const row = {};
        for (let i = 0; i < n; i++) {
          const len = p.readInt32BE(o);
          o += 4;
          if (len === -1) {
            row[fields[i].name] = null;
          } else {
            const text = p.toString('utf8', o, o + len);
            o += len;
            row[fields[i].name] = fields[i].parse(text);
          }
        }
        op.result.rows.push(row);
        return;
      }
      case 'C': {
        if (!op) return;
        const tag = p.toString('utf8', 0, p.length - 1);
        const m = /(\d+)$/.exec(tag);
        op.result.command = tag.split(' ')[0];
        op.result.rowCount = m ? Number(m[1]) : 0;
        return;
      }
      case 'E': {
        const err = new PgError(readFields(p));
        if (op) {
          if (op.kind === 'startup') {
            this.pending = null;
            op.reject(err);
          } else op.error = op.error || err;
        }
        return;
      }
      case 'N':
        if (this.onNotice) this.onNotice(readFields(p));
        return;
      case '1':
      case '2':
      case '3':
      case 'n':
      case 's':
      case 'I':
      case 'A':
        return;
      default:
        return;
    }
  }

  _handleAuth(p) {
    const code = p.readInt32BE(0);
    const password = this._password ?? '';
    switch (code) {
      case 0:
        return; // AuthenticationOk — дальше придёт ReadyForQuery
      case 3:
        return this._write(message('p', [cstr(password)]));
      case 5: {
        const salt = p.subarray(4, 8);
        const inner = crypto.createHash('md5').update(password + this._user).digest('hex');
        const outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
        return this._write(message('p', [cstr('md5' + outer)]));
      }
      case 10: {
        const mechanisms = readCStrings(p.subarray(4)).filter(Boolean);
        if (!mechanisms.includes('SCRAM-SHA-256')) throw new Error('Сервер не поддерживает SCRAM-SHA-256: ' + mechanisms.join(', '));
        this._scramNonce = crypto.randomBytes(18).toString('base64');
        this._scramFirstBare = `n=*,r=${this._scramNonce}`;
        const first = Buffer.from('n,,' + this._scramFirstBare, 'utf8');
        return this._write(message('p', [cstr('SCRAM-SHA-256'), int32(first.length), first]));
      }
      case 11: {
        const serverFirst = p.toString('utf8', 4);
        const attrs = parseScramAttrs(serverFirst);
        if (!attrs.r || !attrs.r.startsWith(this._scramNonce)) throw new Error('SCRAM: неверный nonce сервера');
        const salt = Buffer.from(attrs.s, 'base64');
        const iterations = Number(attrs.i);
        const salted = crypto.pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
        const clientKey = hmac(salted, 'Client Key');
        const storedKey = sha256(clientKey);
        const finalNoProof = `c=biws,r=${attrs.r}`;
        const authMessage = `${this._scramFirstBare},${serverFirst},${finalNoProof}`;
        const proof = xor(clientKey, hmac(storedKey, authMessage)).toString('base64');
        this._scramServerSig = hmac(hmac(salted, 'Server Key'), authMessage).toString('base64');
        return this._write(message('p', [Buffer.from(`${finalNoProof},p=${proof}`, 'utf8')]));
      }
      case 12: {
        const attrs = parseScramAttrs(p.toString('utf8', 4));
        if (attrs.v !== this._scramServerSig) throw new Error('SCRAM: подпись сервера не совпала');
        return;
      }
      default:
        throw new Error('Неподдерживаемый метод аутентификации PostgreSQL: ' + code);
    }
  }

  _enqueue(op) {
    if (!this.alive) return op.reject(new Error('Соединение с PostgreSQL не активно'));
    if (this.pending) this.queue.push(op);
    else this._start(op);
  }

  _next() {
    const op = this.queue.shift();
    if (op) this._start(op);
  }

  _start(op) {
    this.pending = op;
    this.lastUsed = Date.now();
    this._write(op.payload);
  }

  // Простой протокол: допускает несколько выражений, без параметров.
  simpleQuery(text) {
    return new Promise((resolve, reject) => {
      this._enqueue({
        kind: 'simple',
        payload: message('Q', [cstr(text)]),
        result: { rows: [], fields: [], rowCount: 0, command: null },
        resolve,
        reject,
      });
    });
  }

  // Расширенный протокол: Parse/Bind/Describe/Execute/Sync — параметры передаются отдельно от SQL.
  query(text, params = []) {
    const values = params.map(serializeParam);
    const bindParts = [cstr(''), cstr(''), int16(0), int16(values.length)];
    for (const v of values) {
      if (v === null) bindParts.push(int32(-1));
      else {
        const b = Buffer.from(v, 'utf8');
        bindParts.push(int32(b.length), b);
      }
    }
    bindParts.push(int16(0));
    const payload = Buffer.concat([
      message('P', [cstr(''), cstr(text), int16(0)]),
      message('B', bindParts),
      message('D', [Buffer.from('P'), cstr('')]),
      message('E', [cstr(''), int32(0)]),
      message('S', []),
    ]);
    return new Promise((resolve, reject) => {
      this._enqueue({
        kind: 'extended',
        payload,
        result: { rows: [], fields: [], rowCount: 0, command: null },
        resolve,
        reject: (err) => {
          if (err instanceof PgError) {
            err.query = text.length > 500 ? text.slice(0, 500) + '…' : text;
          }
          reject(err);
        },
      });
    });
  }

  close() {
    if (!this.socket) return;
    try {
      if (this.alive) this.socket.end(message('X', []));
      else this.socket.destroy();
    } catch {}
    this.alive = false;
  }
}

function readCStrings(buf, limit = Infinity) {
  const out = [];
  let o = 0;
  while (o < buf.length && out.length < limit) {
    const end = buf.indexOf(0, o);
    if (end === -1) break;
    out.push(buf.toString('utf8', o, end));
    o = end + 1;
  }
  return out;
}

function readFields(p) {
  const fields = {};
  let o = 0;
  while (o < p.length && p[o] !== 0) {
    const code = String.fromCharCode(p[o]);
    const end = p.indexOf(0, o + 1);
    fields[code] = p.toString('utf8', o + 1, end);
    o = end + 1;
  }
  return fields;
}

export function parseConnectionString(url) {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('DATABASE_URL должен начинаться с postgres://');
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode && !['disable', 'allow', 'prefer'].includes(sslmode)) {
    throw new Error(`sslmode=${sslmode} не поддерживается встроенным драйвером; используйте sslmode=disable во внутренней сети`);
  }
  return {
    host: u.hostname || 'localhost',
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || ''),
    database: decodeURIComponent(u.pathname.replace(/^\//, '') || u.username || 'postgres'),
  };
}

// ---------- пул соединений ----------

export class Pool {
  constructor({ connectionString, max = 10, idleTimeoutMs = 30_000, statementTimeoutMs = 20_000, logger } = {}) {
    this.config = { ...parseConnectionString(connectionString), statementTimeoutMs, onError: (e) => logger?.warn?.('pg: ' + e.message) };
    this.max = max;
    this.idleTimeoutMs = idleTimeoutMs;
    this.idle = [];
    this.waiters = [];
    this.total = 0;
    this.ended = false;
    this.sweeper = setInterval(() => this._sweep(), 10_000);
    this.sweeper.unref();
  }

  _sweep() {
    const now = Date.now();
    const keep = [];
    for (const c of this.idle) {
      if (now - c.lastUsed > this.idleTimeoutMs && keep.length >= 1) {
        c.close();
        this.total--;
      } else keep.push(c);
    }
    this.idle = keep;
  }

  async acquire() {
    if (this.ended) throw new Error('Пул закрыт');
    while (this.idle.length) {
      const c = this.idle.pop();
      if (c.alive) return c;
      this.total--;
    }
    if (this.total < this.max) {
      this.total++;
      try {
        const c = new Connection(this.config);
        await c.connect();
        return c;
      } catch (err) {
        this.total--;
        throw err;
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('Нет свободных соединений с БД (таймаут ожидания)'));
      }, 15_000);
      const waiter = { resolve: (c) => (clearTimeout(timer), resolve(c)), reject };
      this.waiters.push(waiter);
    });
  }

  release(c) {
    if (!c.alive || this.ended) {
      this.total--;
      c.close();
      // если кто-то ждёт, а соединение умерло — откроем новое
      const w = this.waiters.shift();
      if (w) this.acquire().then(w.resolve, w.reject);
      return;
    }
    if (c.txStatus && c.txStatus !== 'I') {
      // соединение вернули посреди транзакции — сбрасываем
      c.simpleQuery('ROLLBACK').catch(() => {});
    }
    const w = this.waiters.shift();
    if (w) return w.resolve(c);
    c.lastUsed = Date.now();
    this.idle.push(c);
  }

  async query(text, params) {
    const c = await this.acquire();
    try {
      return await c.query(text, params);
    } finally {
      this.release(c);
    }
  }

  async one(text, params) {
    const { rows } = await this.query(text, params);
    return rows[0] ?? null;
  }

  async many(text, params) {
    const { rows } = await this.query(text, params);
    return rows;
  }

  async transaction(fn) {
    const c = await this.acquire();
    const tx = {
      query: (t, p) => c.query(t, p),
      one: async (t, p) => (await c.query(t, p)).rows[0] ?? null,
      many: async (t, p) => (await c.query(t, p)).rows,
      simpleQuery: (t) => c.simpleQuery(t),
    };
    try {
      await c.query('BEGIN');
      const result = await fn(tx);
      await c.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await c.query('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      this.release(c);
    }
  }

  async end() {
    this.ended = true;
    clearInterval(this.sweeper);
    for (const c of this.idle) c.close();
    this.idle = [];
    for (const w of this.waiters) w.reject(new Error('Пул закрыт'));
    this.waiters = [];
  }
}
