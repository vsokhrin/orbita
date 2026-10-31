// Служебные маршруты: здоровье, справочники, поток событий, сводка ЦУП, глобальный поиск.
import { requireAuth } from '../auth/sessions.js';
import { allDictionaries } from '../domain/dictionaries.js';
import { config } from '../config.js';

const startedAt = Date.now();

export function systemRoutes(app, { db, engine, hub, version }) {
  app.get('/api/health', async (req, res) => {
    let dbOk = true;
    try {
      await db.query('SELECT 1');
    } catch {
      dbOk = false;
    }
    res.json(
      {
        status: dbOk ? 'ok' : 'degraded',
        db: dbOk ? 'ok' : 'unavailable',
        version,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        simulation: config.simulation,
        streamClients: hub.size,
      },
      dbOk ? 200 : 503,
    );
  });

  app.get('/api/meta', () => ({ ...allDictionaries(), demo: config.showDemoHint, version }));

  app.get('/api/stream', requireAuth, hub.handler());

  app.get('/api/telemetry/live', requireAuth, () => ({ ts: Date.now(), items: engine.snapshot() }));

  app.get('/api/contacts', requireAuth, () => ({ items: engine.contacts }));

  app.get('/api/dashboard', requireAuth, async () => {
    const [fleet, missions, crew, stations, incidents, nextLaunches, openIncidents, recentCommands] = await Promise.all([
      db.many(`SELECT status, count(*)::int AS n FROM spacecraft GROUP BY status`),
      db.many(`SELECT status, count(*)::int AS n FROM missions GROUP BY status`),
      db.one(`SELECT count(*) FILTER (WHERE status = 'in_flight')::int AS in_flight, count(*)::int AS total FROM crew_members`),
      db.many(`SELECT status, count(*)::int AS n FROM ground_stations GROUP BY status`),
      db.many(`SELECT severity, count(*)::int AS n FROM incidents WHERE status <> 'resolved' GROUP BY severity`),
      db.many(`SELECT l.*, s.name AS spacecraft_name FROM launches l LEFT JOIN spacecraft s ON s.id = l.spacecraft_id
                WHERE l.status IN ('scheduled', 'go', 'hold') ORDER BY l.scheduled_at LIMIT 4`),
      db.many(`SELECT i.*, s.name AS spacecraft_name, g.name AS station_name FROM incidents i
                 LEFT JOIN spacecraft s ON s.id = i.spacecraft_id LEFT JOIN ground_stations g ON g.id = i.station_id
                WHERE i.status <> 'resolved'
                ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, i.created_at DESC LIMIT 8`),
      db.many(`SELECT c.*, s.name AS spacecraft_name, g.name AS station_name FROM commands c
                 JOIN spacecraft s ON s.id = c.spacecraft_id LEFT JOIN ground_stations g ON g.id = c.station_id
                ORDER BY c.created_at DESC LIMIT 8`),
    ]);
    const toMap = (rows) => Object.fromEntries(rows.map((r) => [r.status ?? r.severity, r.n]));
    return {
      fleet: toMap(fleet),
      missions: toMap(missions),
      crew,
      stations: toMap(stations),
      incidents: toMap(incidents),
      nextLaunches,
      openIncidents,
      recentCommands,
      contacts: engine.contacts.filter((c) => (c.los ?? Infinity) > Date.now()).slice(0, 10),
      live: engine.summary(),
      serverTime: Date.now(),
    };
  });

  app.get('/api/search', requireAuth, async (req) => {
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q.length < 2) return { items: [] };
    const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    const rows = await db.many(
      `(SELECT 'spacecraft' AS kind, id, name AS title, code || ' · ' || type AS subtitle FROM spacecraft WHERE name ILIKE $1 OR code ILIKE $1 LIMIT 5)
       UNION ALL
       (SELECT 'mission', id, name, code FROM missions WHERE name ILIKE $1 OR code ILIKE $1 LIMIT 5)
       UNION ALL
       (SELECT 'crew', id, full_name, coalesce('«' || call_sign || '»', '') FROM crew_members WHERE full_name ILIKE $1 OR call_sign ILIKE $1 LIMIT 5)
       UNION ALL
       (SELECT 'station', id, name, code || ', ' || country FROM ground_stations WHERE name ILIKE $1 OR code ILIKE $1 OR country ILIKE $1 LIMIT 5)
       UNION ALL
       (SELECT 'launch', id, name, site FROM launches WHERE name ILIKE $1 OR vehicle ILIKE $1 LIMIT 5)`,
      [like],
    );
    return { items: rows };
  });
}
