// Оперативное управление: инциденты (журнал аномалий) и командная очередь.
import { resource } from '../lib/resource.js';
import { canEdit } from '../auth/sessions.js';
import { validate, parseId, fieldError } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../http/app.js';
import * as D from '../domain/dictionaries.js';
import * as R from '../domain/schemas.js';

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
    ...R.INCIDENTS,
    select: INCIDENT_SELECT,
    beforeSave: (v, before, req) => {
      if (!before) {
        v.created_by = req.user.id;
        v.source = 'manual';
      }
    },
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
    const { resolution } = validate(R.INCIDENT_RESOLVE, req.body);
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
    ...R.COMMANDS,
    select: COMMAND_SELECT,
    // создание — commandCreateRoute (объявлен раньше и перехватывает POST), отмена — отдельный маршрут;
    // правка и удаление записей журнала команд запрещены
    writeGuard: () => {
      throw new HttpError(405, 'Команды не редактируются: создайте новую или отмените команду в очереди');
    },
    deleteGuard: () => {
      throw new HttpError(405, 'Журнал команд не удаляется');
    },
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
    const v = validate(R.COMMAND_CREATE, req.body);
    const def = D.COMMAND_TYPES[v.type];
    const params = R.commandParams(v.type, v.params);
    const sc = await db.one('SELECT id, name, status FROM spacecraft WHERE id = $1', [v.spacecraft_id]);
    if (!sc) throw fieldError('spacecraft_id', 'КА не найден');
    if (!R.COMMANDABLE.includes(sc.status)) {
      throw fieldError('spacecraft_id', `КА «${sc.name}» в состоянии «${D.SPACECRAFT_STATUSES[sc.status]}» — управление невозможно`);
    }
    const queued = await db.one(`SELECT count(*)::int AS n FROM commands WHERE spacecraft_id = $1 AND status = 'queued'`, [sc.id]);
    if (queued.n >= R.MAX_QUEUED_PER_SPACECRAFT) throw new HttpError(429, `В очереди этого КА уже ${R.MAX_QUEUED_PER_SPACECRAFT} команд — дождитесь сеанса связи`);
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
