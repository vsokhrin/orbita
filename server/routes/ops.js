// Оперативное управление: инциденты (журнал аномалий) и командная очередь.
import { resource } from '../lib/resource.js';
import { canEdit } from '../auth/sessions.js';
import { validate, parseId, fieldError } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../http/app.js';
import * as D from '../domain/dictionaries.js';

const keys = Object.keys;
const label = (dict, key) => (row) => dict[row[key]] ?? row[key];

const INCIDENT_SELECT = `SELECT i.*, s.name AS spacecraft_name, g.name AS station_name,
       cu.full_name AS created_by_name, au.full_name AS acknowledged_by_name, ru.full_name AS resolved_by_name
  FROM incidents i
  LEFT JOIN spacecraft s ON s.id = i.spacecraft_id
  LEFT JOIN ground_stations g ON g.id = i.station_id
  LEFT JOIN users cu ON cu.id = i.created_by
  LEFT JOIN users au ON au.id = i.acknowledged_by
  LEFT JOIN users ru ON ru.id = i.resolved_by`;

const COMMAND_SELECT = `SELECT c.*, s.name AS spacecraft_name, s.code AS spacecraft_code, g.name AS station_name, u.full_name AS issued_by_name
  FROM commands c
  JOIN spacecraft s ON s.id = c.spacecraft_id
  LEFT JOIN ground_stations g ON g.id = c.station_id
  LEFT JOIN users u ON u.id = c.issued_by`;

export function opsRoutes(app, { db, engine, hub }) {
  // ---------- Инциденты ----------
  const incidents = resource(app, db, {
    path: '/api/incidents',
    table: 'incidents',
    entity: 'incident',
    title: (r) => r.title,
    select: INCIDENT_SELECT,
    search: ['title', 'description', 'spacecraft_name', 'station_name'],
    filters: { status: 'status', severity: 'severity', spacecraft_id: 'spacecraft_id', station_id: 'station_id', source: 'source' },
    dateField: 'created_at',
    sortable: { created_at: 'created_at', severity: "array_position(ARRAY['info','warning','critical'], severity)", status: 'status', title: 'title', spacecraft_name: 'spacecraft_name' },
    defaultSort: "array_position(ARRAY['open','acknowledged','resolved'], status), array_position(ARRAY['critical','warning','info'], severity), created_at DESC",
    schema: {
      spacecraft_id: { type: 'int', min: 1 },
      station_id: { type: 'int', min: 1 },
      severity: { type: 'enum', values: keys(D.INCIDENT_SEVERITIES), required: true },
      title: { type: 'string', required: true, min: 3, max: 200 },
      description: { type: 'text', max: 4000 },
    },
    beforeSave: (v, before, req) => {
      if (!before) {
        v.created_by = req.user.id;
        v.source = 'manual';
      }
    },
    csv: [
      { key: 'created_at', label: 'Создан (UTC)' },
      { label: 'Важность', value: label(D.INCIDENT_SEVERITIES, 'severity') },
      { label: 'Статус', value: label(D.INCIDENT_STATUSES, 'status') },
      { key: 'title', label: 'Инцидент' },
      { key: 'spacecraft_name', label: 'КА' },
      { key: 'station_name', label: 'Станция' },
      { label: 'Источник', value: (r) => (r.source === 'auto' ? 'Автоматически' : 'Оператор') },
      { key: 'resolved_at', label: 'Закрыт (UTC)' },
      { key: 'resolution', label: 'Решение' },
    ],
    afterChange: (action, row) => hub.broadcast('incident', { action: action === 'create' ? 'created' : 'updated', incident: row }),
  });

  app.post('/api/incidents/:id/ack', canEdit, async (req) => {
    const id = parseId(req.params.id);
    const row = await db.transaction(async (tx) => {
      const r = await tx.one(
        `UPDATE incidents SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now()
          WHERE id = $1 AND status = 'open' RETURNING *`,
        [id, req.user.id],
      );
      if (!r) throw new HttpError(409, 'Инцидент уже принят в работу или закрыт');
      await audit(tx, req, { action: 'acknowledge', entity: 'incident', entityId: id, summary: r.title });
      return incidents.getOne(tx, id);
    });
    hub.broadcast('incident', { action: 'updated', incident: row });
    return row;
  });

  app.post('/api/incidents/:id/resolve', canEdit, async (req) => {
    const id = parseId(req.params.id);
    const { resolution } = validate({ resolution: { type: 'text', required: true, min: 3, max: 2000 } }, req.body);
    const row = await db.transaction(async (tx) => {
      const r = await tx.one(
        `UPDATE incidents SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution = $3,
                acknowledged_by = coalesce(acknowledged_by, $2), acknowledged_at = coalesce(acknowledged_at, now())
          WHERE id = $1 AND status <> 'resolved' RETURNING *`,
        [id, req.user.id, resolution],
      );
      if (!r) throw new HttpError(409, 'Инцидент уже закрыт');
      await audit(tx, req, { action: 'resolve', entity: 'incident', entityId: id, summary: r.title, details: { resolution } });
      return incidents.getOne(tx, id);
    });
    if (row.kind && row.spacecraft_id) engine.clearFault(row.spacecraft_id, row.kind);
    hub.broadcast('incident', { action: 'updated', incident: row });
    return row;
  });

  // ---------- Командная очередь ----------
  resource(app, db, {
    path: '/api/commands',
    table: 'commands',
    entity: 'command',
    title: (r) => `${D.COMMAND_TYPES[r.type]?.label ?? r.type} → ${r.spacecraft_name}`,
    select: COMMAND_SELECT,
    search: ['spacecraft_name', 'type', 'result', 'issued_by_name'],
    filters: { status: 'status', spacecraft_id: 'spacecraft_id', type: 'type', station_id: 'station_id' },
    dateField: 'created_at',
    sortable: { created_at: 'created_at', status: 'status', type: 'type', spacecraft_name: 'spacecraft_name' },
    defaultSort: 'created_at DESC',
    // создание — commandCreateRoute (объявлен раньше и перехватывает POST), отмена — отдельный маршрут;
    // правка и удаление записей журнала команд запрещены
    writeGuard: () => {
      throw new HttpError(405, 'Команды не редактируются: создайте новую или отмените команду в очереди');
    },
    deleteGuard: () => {
      throw new HttpError(405, 'Журнал команд не удаляется');
    },
    schema: {},
    csv: [
      { key: 'created_at', label: 'Создана (UTC)' },
      { key: 'spacecraft_name', label: 'КА' },
      { label: 'Команда', value: (r) => D.COMMAND_TYPES[r.type]?.label ?? r.type },
      { label: 'Статус', value: label(D.COMMAND_STATUSES, 'status') },
      { key: 'station_name', label: 'Станция' },
      { key: 'issued_by_name', label: 'Оператор' },
      { key: 'result', label: 'Результат' },
    ],
  });

  app.post('/api/commands/:id/cancel', canEdit, async (req) => {
    const id = parseId(req.params.id);
    const row = await db.transaction(async (tx) => {
      const r = await tx.one(
        `UPDATE commands SET status = 'cancelled', completed_at = now(), result = $2
          WHERE id = $1 AND status = 'queued' RETURNING *`,
        [id, `Отменена оператором: ${req.user.fullName}`],
      );
      if (!r) throw new HttpError(409, 'Отменить можно только команду в очереди');
      await audit(tx, req, { action: 'cancel', entity: 'command', entityId: id, summary: `${D.COMMAND_TYPES[r.type]?.label ?? r.type} — отменена` });
      return tx.one(`SELECT * FROM (${COMMAND_SELECT}) q WHERE id = $1`, [id]);
    });
    await engine.refreshQueue();
    hub.broadcast('command', { action: 'updated', command: row });
    return row;
  });
}

/** Создание команды объявляется до resource('/api/commands'), чтобы перехватить POST. */
export function commandCreateRoute(app, { db, engine, hub }) {
  app.post('/api/commands', canEdit, async (req, res) => {
    const v = validate(
      {
        spacecraft_id: { type: 'int', required: true, min: 1 },
        type: { type: 'enum', values: keys(D.COMMAND_TYPES), required: true },
        params: { type: 'json' },
        ttl_hours: { type: 'number', min: 0.25, max: 48, default: 6 },
        incident_id: { type: 'int', min: 1 },
      },
      req.body,
    );
    const def = D.COMMAND_TYPES[v.type];
    const params = {};
    for (const [key, p] of Object.entries(def.params || {})) {
      const raw = v.params?.[key] ?? p.default;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < p.min || n > p.max) throw fieldError(`params.${key}`, `${p.label}: от ${p.min} до ${p.max}`);
      if (key === 'delta_km' && n === 0) throw fieldError(`params.${key}`, 'Изменение высоты не может быть нулевым');
      params[key] = n;
    }
    const sc = await db.one('SELECT id, name, status FROM spacecraft WHERE id = $1', [v.spacecraft_id]);
    if (!sc) throw fieldError('spacecraft_id', 'КА не найден');
    if (!['active', 'standby', 'safe_mode'].includes(sc.status)) {
      throw fieldError('spacecraft_id', `КА «${sc.name}» в состоянии «${D.SPACECRAFT_STATUSES[sc.status]}» — управление невозможно`);
    }
    const queued = await db.one(`SELECT count(*)::int AS n FROM commands WHERE spacecraft_id = $1 AND status = 'queued'`, [sc.id]);
    if (queued.n >= 20) throw new HttpError(429, 'В очереди этого КА уже 20 команд — дождитесь сеанса связи');
    const row = await db.transaction(async (tx) => {
      const r = await tx.one(
        `INSERT INTO commands (spacecraft_id, type, params, issued_by, incident_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6)) RETURNING id`,
        [sc.id, v.type, params, req.user.id, v.incident_id ?? null, Math.round(v.ttl_hours * 3600)],
      );
      await audit(tx, req, { action: 'command', entity: 'command', entityId: r.id, summary: `${def.label} → ${sc.name}`, details: params });
      return tx.one(`SELECT * FROM (${COMMAND_SELECT}) q WHERE id = $1`, [r.id]);
    });
    await engine.refreshQueue();
    hub.broadcast('command', { action: 'created', command: row });
    res.json(row, 201);
  });
}
