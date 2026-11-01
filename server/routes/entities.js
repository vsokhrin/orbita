// Справочники ИС: космические аппараты, наземные станции, миссии, экипаж, запуски.
import { resource } from '../lib/resource.js';
import { requireAuth, canEdit } from '../auth/sessions.js';
import { fieldError, parseId, validate } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../http/app.js';
import * as D from '../domain/dictionaries.js';
import * as R from '../domain/schemas.js';
import { orbitClass, elementsFrom, periodMinutes } from '../../shared/orbit.js';

export function entityRoutes(app, { db, engine, hub }) {
  const fleetChanged = () => {
    engine.reloadFleet().then(() => hub.broadcast('fleet', { reason: 'edit' }));
  };

  // ---------- Космические аппараты ----------
  resource(app, db, {
    ...R.SPACECRAFT,
    select: `SELECT s.*,
               (SELECT count(*) FROM incidents i WHERE i.spacecraft_id = s.id AND i.status <> 'resolved')::int AS open_incidents,
               (SELECT count(*) FROM missions m WHERE m.spacecraft_id = s.id AND m.status = 'active')::int AS active_missions
             FROM spacecraft s`,
    expand: async (row) => {
      const [missions, incidents, commands] = await Promise.all([
        db.many(`SELECT id, code, name, status, priority, progress FROM missions WHERE spacecraft_id = $1 ORDER BY start_date DESC NULLS LAST`, [row.id]),
        db.many(`SELECT * FROM incidents WHERE spacecraft_id = $1 ORDER BY created_at DESC LIMIT 12`, [row.id]),
        db.many(
          `SELECT c.*, g.name AS station_name, u.full_name AS issued_by_name FROM commands c
             LEFT JOIN ground_stations g ON g.id = c.station_id LEFT JOIN users u ON u.id = c.issued_by
            WHERE c.spacecraft_id = $1 ORDER BY c.created_at DESC LIMIT 15`,
          [row.id],
        ),
      ]);
      const el = elementsFrom(row);
      return { ...row, orbit_class: orbitClass(row.perigee_km, row.apogee_km, row.inclination_deg), period_min: +periodMinutes(el.a).toFixed(2), missions, incidents, commands };
    },
    afterChange: fleetChanged,
  });

  app.get('/api/spacecraft/:id/telemetry', requireAuth, async (req) => {
    const id = parseId(req.params.id);
    const { hours, bucket } = R.telemetryWindow(req.query);
    const rows = await db.many(
      `SELECT to_timestamp(floor(extract(epoch FROM ts) / $3) * $3) AS t,
              round(avg(battery)::numeric, 2) AS battery, round(avg(temperature)::numeric, 2) AS temperature,
              round(avg(power_w)::numeric, 1) AS power, round(avg(signal_dbm)::numeric, 1) AS signal,
              round(avg(altitude_km)::numeric, 1) AS altitude, bool_or(sunlit) AS sunlit,
              bool_or(station_id IS NOT NULL) AS link
         FROM telemetry
        WHERE spacecraft_id = $1 AND ts > now() - make_interval(hours => $2)
        GROUP BY 1 ORDER BY 1`,
      [id, hours, bucket],
    );
    return { hours, bucketSec: bucket, points: rows };
  });

  app.get('/api/spacecraft/:id/passes', requireAuth, (req) => {
    const id = parseId(req.params.id);
    const hours = Math.min(48, Math.max(1, Number(req.query.hours) || 24));
    return { hours, items: engine.passesFor(id, hours) };
  });

  // ---------- Наземные станции ----------
  resource(app, db, {
    ...R.STATIONS,
    select: `SELECT g.*,
               (SELECT count(*) FROM commands c WHERE c.station_id = g.id AND c.uplinked_at > now() - interval '7 days')::int AS uplinks_week
             FROM ground_stations g`,
    afterChange: fleetChanged,
  });

  app.get('/api/stations/:id/schedule', requireAuth, (req) => {
    const id = parseId(req.params.id);
    const hours = Math.min(48, Math.max(1, Number(req.query.hours) || 12));
    return { hours, items: engine.scheduleFor(id, hours) };
  });

  // ---------- Миссии ----------
  const missionSelect = `SELECT m.*, s.name AS spacecraft_name, s.code AS spacecraft_code,
           (SELECT count(*) FROM mission_crew mc WHERE mc.mission_id = m.id)::int AS crew_count
         FROM missions m LEFT JOIN spacecraft s ON s.id = m.spacecraft_id`;
  resource(app, db, {
    ...R.MISSIONS,
    select: missionSelect,
    expand: async (row) => {
      const crew = await db.many(
        `SELECT c.id, c.full_name, c.call_sign, c.status, mc.role, mc.assigned_at FROM mission_crew mc
           JOIN crew_members c ON c.id = mc.crew_id WHERE mc.mission_id = $1
          ORDER BY array_position(ARRAY['commander','flight_engineer','mission_specialist','payload_specialist','backup'], mc.role), c.full_name`,
        [row.id],
      );
      const launches = await db.many('SELECT * FROM launches WHERE mission_id = $1 ORDER BY scheduled_at', [row.id]);
      return { ...row, crew, launches };
    },
  });

  // Назначение экипажа на миссию (связь многие-ко-многим)
  app.post('/api/missions/:id/crew', canEdit, async (req, res) => {
    const missionId = parseId(req.params.id);
    const v = validate(R.MISSION_CREW, req.body);
    const mission = await db.one('SELECT id, name, code FROM missions WHERE id = $1', [missionId]);
    if (!mission) throw notFound('Миссия не найдена');
    const crew = await db.one('SELECT id, full_name, status FROM crew_members WHERE id = $1', [v.crew_id]);
    if (!crew) throw fieldError('crew_id', 'Член экипажа не найден');
    if (crew.status === 'retired') throw fieldError('crew_id', 'Нельзя назначить космонавта, завершившего карьеру');
    if (v.role === 'commander') {
      const cmd = await db.one(`SELECT 1 FROM mission_crew WHERE mission_id = $1 AND role = 'commander' AND crew_id <> $2`, [missionId, v.crew_id]);
      if (cmd) throw fieldError('role', 'У миссии уже есть командир');
    }
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO mission_crew (mission_id, crew_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (mission_id, crew_id) DO UPDATE SET role = EXCLUDED.role`,
        [missionId, v.crew_id, v.role],
      );
      await audit(tx, req, { action: 'assign', entity: 'mission', entityId: missionId, summary: `${crew.full_name} назначен(а) в миссию ${mission.code}: ${D.CREW_ROLES[v.role]}` });
    });
    res.json({ ok: true }, 201);
  });

  app.delete('/api/missions/:id/crew/:crewId', canEdit, async (req, res) => {
    const missionId = parseId(req.params.id);
    const crewId = parseId(req.params.crewId);
    await db.transaction(async (tx) => {
      const row = await tx.one(
        `DELETE FROM mission_crew mc USING crew_members c, missions m
          WHERE mc.mission_id = $1 AND mc.crew_id = $2 AND c.id = mc.crew_id AND m.id = mc.mission_id
          RETURNING c.full_name, m.code`,
        [missionId, crewId],
      );
      if (!row) throw notFound('Назначение не найдено');
      await audit(tx, req, { action: 'unassign', entity: 'mission', entityId: missionId, summary: `${row.full_name} снят(а) с миссии ${row.code}` });
    });
    res.noContent();
  });

  // ---------- Экипаж ----------
  resource(app, db, {
    ...R.CREW,
    select: `SELECT c.*,
               (SELECT string_agg(m.code, ', ' ORDER BY m.code) FROM mission_crew mc JOIN missions m ON m.id = mc.mission_id
                 WHERE mc.crew_id = c.id AND m.status IN ('planning','preparation','active')) AS missions
             FROM crew_members c`,
    expand: async (row) => ({
      ...row,
      assignments: await db.many(
        `SELECT m.id, m.code, m.name, m.status, mc.role FROM mission_crew mc JOIN missions m ON m.id = mc.mission_id
          WHERE mc.crew_id = $1 ORDER BY m.start_date DESC NULLS LAST`,
        [row.id],
      ),
    }),
  });

  // ---------- Запуски ----------
  resource(app, db, {
    ...R.LAUNCHES,
    select: `SELECT l.*, s.name AS spacecraft_name, m.code AS mission_code, m.name AS mission_name
             FROM launches l LEFT JOIN spacecraft s ON s.id = l.spacecraft_id LEFT JOIN missions m ON m.id = l.mission_id`,
    beforeSave: async (v, before) => {
      const scId = R.LAUNCHES.payloadId(v, before);
      if (scId) R.LAUNCHES.checkPayload(v, before, await db.one('SELECT status, name FROM spacecraft WHERE id = $1', [scId]));
    },
    afterChange: (_, row) => hub.broadcast('launch', { action: 'updated', launch: row }),
  });
}
