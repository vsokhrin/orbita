// Сессии в БД: в cookie лежит случайный токен, в таблице — только его SHA-256.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError, forbidden } from '../http/app.js';

export const COOKIE = 'orbita_session';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(db, user, req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttlSec = config.sessionTtlHours * 3600;
  await db.query(
    `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5)`,
    [sha256(token), user.id, ttlSec, req.ip, (req.headers['user-agent'] || '').slice(0, 300)],
  );
  res.setCookie(COOKIE, token, { maxAge: ttlSec, secure: config.cookieSecure });
}

export async function destroySession(db, req, res) {
  const token = req.cookies[COOKIE];
  if (token) await db.query('DELETE FROM sessions WHERE id = $1', [sha256(token)]);
  res.setCookie(COOKIE, '', { maxAge: 0, secure: config.cookieSecure });
}

/** Middleware: загружает пользователя по cookie и продлевает сессию (скользящее окно). */
export function loadSession(db) {
  return async (req, res) => {
    if (!req.path.startsWith('/api/')) return;
    const token = req.cookies[COOKIE];
    if (!token || token.length > 100) return;
    const row = await db.one(
      `SELECT s.id AS sid, s.last_seen_at, u.id, u.username, u.full_name, u.role, u.is_active
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.expires_at > now()`,
      [sha256(token)],
    );
    if (!row || !row.is_active) return;
    req.user = { id: row.id, username: row.username, fullName: row.full_name, role: row.role };
    req.sessionId = row.sid;
    // продлеваем не чаще раза в 5 минут, чтобы не писать в БД на каждый запрос
    if (Date.now() - Date.parse(row.last_seen_at) > 5 * 60_000) {
      const ttlSec = config.sessionTtlHours * 3600;
      await db.query('UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(secs => $2) WHERE id = $1', [row.sid, ttlSec]);
      res.setCookie(COOKIE, token, { maxAge: ttlSec, secure: config.cookieSecure });
    }
  };
}

export const requireAuth = (req) => {
  if (!req.user) throw new HttpError(401, 'Требуется вход в систему');
};

/** Проверка роли: requireRole('admin', 'operator') */
export const requireRole =
  (...roles) =>
  (req) => {
    requireAuth(req);
    if (!roles.includes(req.user.role)) throw forbidden();
  };

export const canEdit = requireRole('admin', 'operator');
export const adminOnly = requireRole('admin');

/** Защита от CSRF: запросы, меняющие данные, должны приходить с того же origin. */
export function sameOriginGuard(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (!origin) return; // не браузер или старый клиент; cookie всё равно SameSite=Lax
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    throw forbidden('Некорректный Origin');
  }
  const expected = req.headers['x-forwarded-host'] || req.headers.host;
  if (host !== expected) throw forbidden('Запрос с чужого источника отклонён');
}

/** Ограничение частоты попыток входа: окно 10 минут, 8 попыток на пару (IP, логин). */
const attempts = new Map();
export function loginRateLimit(req) {
  const key = `${req.ip}|${String(req.body?.username || '').toLowerCase()}`;
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, reset: now + 10 * 60_000 };
  if (now > rec.reset) {
    rec.count = 0;
    rec.reset = now + 10 * 60_000;
  }
  if (rec.count >= 8) {
    const wait = Math.ceil((rec.reset - now) / 60_000);
    throw new HttpError(429, `Слишком много попыток входа. Повторите через ${wait} мин.`);
  }
  rec.count++;
  attempts.set(key, rec);
  if (attempts.size > 10_000) attempts.clear();
  req.rateKey = key;
}
export function resetLoginAttempts(req) {
  if (req.rateKey) attempts.delete(req.rateKey);
}
