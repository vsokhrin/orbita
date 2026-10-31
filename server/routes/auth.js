// Вход, выход, текущий пользователь, смена пароля.
import { HttpError, badRequest } from '../http/app.js';
import { verifyPassword, dummyVerify, hashPassword, validatePasswordStrength } from '../auth/passwords.js';
import { createSession, destroySession, requireAuth, loginRateLimit, resetLoginAttempts } from '../auth/sessions.js';
import { audit } from '../lib/audit.js';
import { fieldError } from '../lib/validate.js';

export function authRoutes(app, { db }) {
  app.post('/api/auth/login', loginRateLimit, async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!username || !password) throw badRequest('Введите логин и пароль');
    const user = await db.one('SELECT * FROM users WHERE username = $1', [username]);
    const ok = user ? await verifyPassword(password, user.password_hash) : await dummyVerify(password);
    if (!ok || !user.is_active) {
      await audit(db, req, { action: 'login_failed', entity: 'user', summary: `Неудачный вход: ${username}` });
      throw new HttpError(401, user && ok && !user.is_active ? 'Учётная запись заблокирована. Обратитесь к администратору.' : 'Неверный логин или пароль');
    }
    resetLoginAttempts(req);
    await createSession(db, user, req, res);
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    req.user = { id: user.id, username: user.username };
    await audit(db, req, { action: 'login', entity: 'user', entityId: user.id, summary: `Вход в систему: ${user.full_name}` });
    return { user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role } };
  });

  app.post('/api/auth/logout', async (req, res) => {
    if (req.user) await audit(db, req, { action: 'logout', entity: 'user', entityId: req.user.id, summary: `Выход из системы: ${req.user.fullName}` });
    await destroySession(db, req, res);
    res.noContent();
  });

  // 200 и user: null для гостя — чтобы не засорять консоль браузера ошибкой 401 при открытии страницы входа
  app.get('/api/auth/me', (req) => ({ user: req.user ?? null }));

  app.post('/api/auth/password', requireAuth, async (req, res) => {
    const { current, next } = req.body;
    const user = await db.one('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!(await verifyPassword(String(current || ''), user.password_hash))) throw fieldError('current', 'Текущий пароль указан неверно');
    const weak = validatePasswordStrength(next);
    if (weak) throw fieldError('next', weak);
    if (current === next) throw fieldError('next', 'Новый пароль совпадает с текущим');
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(next)]);
    // завершаем остальные сессии пользователя
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [user.id, req.sessionId]);
    await audit(db, req, { action: 'password_change', entity: 'user', entityId: user.id, summary: 'Пользователь сменил пароль' });
    res.noContent();
  });
}
