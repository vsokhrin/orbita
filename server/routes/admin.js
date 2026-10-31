// Администрирование: пользователи и журнал аудита.
import { adminOnly } from '../auth/sessions.js';
import { hashPassword, validatePasswordStrength } from '../auth/passwords.js';
import { validate, parseId, fieldError } from '../lib/validate.js';
import { audit, diff } from '../lib/audit.js';
import { buildWhere, buildOrder } from '../lib/resource.js';
import { toCsv } from '../lib/csv.js';
import { HttpError, notFound } from '../http/app.js';
import { ROLES } from '../domain/dictionaries.js';

const USER_FIELDS = 'id, username, full_name, role, is_active, last_login_at, created_at, updated_at';

const AUDIT_DEF = {
  search: ['username', 'summary', 'entity', 'action'],
  filters: { action: 'action', entity: 'entity', user_id: 'user_id' },
  dateField: 'ts',
  sortable: { ts: 'ts', username: 'username', action: 'action' },
  defaultSort: 'ts DESC',
};

export function adminRoutes(app, { db, hub }) {
  app.get('/api/users', adminOnly, async () => ({
    items: await db.many(
      `SELECT ${USER_FIELDS}, (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now())::int AS sessions
         FROM users u ORDER BY is_active DESC, array_position(ARRAY['admin','operator','observer'], role), username`,
    ),
  }));

  app.post('/api/users', adminOnly, async (req, res) => {
    const v = validate(
      {
        username: { type: 'string', required: true, pattern: /^[a-z0-9_.-]{3,32}$/, patternMessage: '3–32 символа: латиница в нижнем регистре, цифры, «_», «.», «-»', transform: (s) => s.toLowerCase() },
        full_name: { type: 'string', required: true, min: 2, max: 120 },
        role: { type: 'enum', values: Object.keys(ROLES), required: true },
        password: { type: 'string', required: true, max: 128 },
      },
      { ...req.body, username: String(req.body.username || '').toLowerCase() },
    );
    const weak = validatePasswordStrength(v.password);
    if (weak) throw fieldError('password', weak);
    const row = await db.transaction(async (tx) => {
      const r = await tx.one(
        `INSERT INTO users (username, full_name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING ${USER_FIELDS}`,
        [v.username, v.full_name, v.role, await hashPassword(v.password)],
      );
      await audit(tx, req, { action: 'create', entity: 'user', entityId: r.id, summary: `${r.full_name} (${r.username}), роль: ${ROLES[r.role]}` });
      return r;
    });
    res.json(row, 201);
  });

  app.put('/api/users/:id', adminOnly, async (req) => {
    const id = parseId(req.params.id);
    const v = validate(
      {
        full_name: { type: 'string', min: 2, max: 120 },
        role: { type: 'enum', values: Object.keys(ROLES) },
        is_active: { type: 'bool' },
      },
      req.body,
      { partial: true },
    );
    if (id === req.user.id && (v.role && v.role !== 'admin')) throw fieldError('role', 'Нельзя снять с себя роль администратора');
    if (id === req.user.id && v.is_active === false) throw fieldError('is_active', 'Нельзя заблокировать собственную учётную запись');
    const row = await db.transaction(async (tx) => {
      const before = await tx.one(`SELECT ${USER_FIELDS} FROM users WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound('Пользователь не найден');
      const changes = diff(before, v);
      if (!Object.keys(changes).length) return before;
      const cols = Object.keys(changes);
      const r = await tx.one(
        `UPDATE users SET ${cols.map((c, k) => `${c} = $${k + 2}`).join(', ')} WHERE id = $1 RETURNING ${USER_FIELDS}`,
        [id, ...cols.map((c) => v[c])],
      );
      if (v.is_active === false || (v.role && v.role !== before.role)) await tx.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      await audit(tx, req, { action: 'update', entity: 'user', entityId: id, summary: `${r.full_name} (${r.username})`, details: changes });
      return r;
    });
    if (v.is_active === false || v.role) hub.disconnectUser(id);
    return row;
  });

  app.post('/api/users/:id/password', adminOnly, async (req, res) => {
    const id = parseId(req.params.id);
    const weak = validatePasswordStrength(req.body.password);
    if (weak) throw fieldError('password', weak);
    await db.transaction(async (tx) => {
      const r = await tx.one('UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING username, full_name', [id, await hashPassword(req.body.password)]);
      if (!r) throw notFound('Пользователь не найден');
      await tx.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      await audit(tx, req, { action: 'password_reset', entity: 'user', entityId: id, summary: `Пароль сброшен: ${r.full_name} (${r.username})` });
    });
    hub.disconnectUser(id);
    res.noContent();
  });

  app.delete('/api/users/:id', adminOnly, async (req, res) => {
    const id = parseId(req.params.id);
    if (id === req.user.id) throw new HttpError(409, 'Нельзя удалить собственную учётную запись');
    await db.transaction(async (tx) => {
      const r = await tx.one('DELETE FROM users WHERE id = $1 RETURNING username, full_name', [id]);
      if (!r) throw notFound('Пользователь не найден');
      await audit(tx, req, { action: 'delete', entity: 'user', entityId: id, summary: `${r.full_name} (${r.username})` });
    });
    hub.disconnectUser(id);
    res.noContent();
  });

  app.get('/api/audit', adminOnly, async (req) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const where = buildWhere(AUDIT_DEF, req.query);
    const rows = await db.many(
      `SELECT a.*, count(*) OVER() AS _total FROM audit_log a ${where.sql} ${buildOrder(AUDIT_DEF, req.query)} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      where.params,
    );
    const total = rows[0]?._total ?? 0;
    for (const r of rows) delete r._total;
    return { items: rows, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
  });

  app.get('/api/audit.csv', adminOnly, async (req, res) => {
    const where = buildWhere(AUDIT_DEF, req.query);
    const rows = await db.many(`SELECT * FROM audit_log ${where.sql} ORDER BY ts DESC LIMIT 50000`, where.params);
    res.send(
      toCsv(rows, [
        { key: 'ts', label: 'Время (UTC)' },
        { key: 'username', label: 'Пользователь' },
        { key: 'action', label: 'Действие' },
        { key: 'entity', label: 'Объект' },
        { key: 'entity_id', label: 'ID' },
        { key: 'summary', label: 'Описание' },
        { key: 'ip', label: 'IP' },
      ]),
      200,
      'text/csv; charset=utf-8',
      { 'Content-Disposition': `attachment; filename="orbita-audit-${new Date().toISOString().slice(0, 10)}.csv"` },
    );
  });
}
