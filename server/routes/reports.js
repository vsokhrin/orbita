// Аналитические отчёты за период: инциденты, команды, флот, загрузка станций.
import { requireAuth } from '../auth/sessions.js';
import { orbitClass } from '../../shared/orbit.js';

function range(query) {
  const to = query.to && !Number.isNaN(Date.parse(query.to)) ? new Date(query.to) : new Date();
  const from = query.from && !Number.isNaN(Date.parse(query.from)) ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
  if (to - from > 366 * 86_400_000) from.setTime(to.getTime() - 366 * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function reportRoutes(app, { db, engine }) {
  app.get('/api/reports/summary', requireAuth, async (req) => {
    const { from, to } = range(req.query);
    const p = [from, to];
    const [byDay, bySpacecraft, mttr, cmdStatus, cmdType, fleet, missions, stationUplinks, totals] = await Promise.all([
      db.many(
        `SELECT d::date AS day,
                count(i.id) FILTER (WHERE i.severity = 'info')::int AS info,
                count(i.id) FILTER (WHERE i.severity = 'warning')::int AS warning,
                count(i.id) FILTER (WHERE i.severity = 'critical')::int AS critical
           FROM generate_series(date_trunc('day', $1::timestamptz), date_trunc('day', $2::timestamptz), interval '1 day') d
           LEFT JOIN incidents i ON i.created_at >= d AND i.created_at < d + interval '1 day'
          GROUP BY d ORDER BY d`,
        p,
      ),
      db.many(
        `SELECT s.id, s.name, s.color, count(*)::int AS n,
                count(*) FILTER (WHERE i.severity = 'critical')::int AS critical
           FROM incidents i JOIN spacecraft s ON s.id = i.spacecraft_id
          WHERE i.created_at BETWEEN $1 AND $2
          GROUP BY s.id ORDER BY n DESC, s.name LIMIT 10`,
        p,
      ),
      db.many(
        `SELECT severity, count(*)::int AS n,
                round(avg(extract(epoch FROM resolved_at - created_at) / 60)::numeric, 0) AS mttr_min,
                round(avg(extract(epoch FROM acknowledged_at - created_at) / 60)::numeric, 0) AS mtta_min
           FROM incidents WHERE resolved_at IS NOT NULL AND created_at BETWEEN $1 AND $2
          GROUP BY severity`,
        p,
      ),
      db.many(`SELECT status, count(*)::int AS n FROM commands WHERE created_at BETWEEN $1 AND $2 GROUP BY status ORDER BY n DESC`, p),
      db.many(
        `SELECT type, count(*)::int AS n, count(*) FILTER (WHERE status = 'failed')::int AS failed
           FROM commands WHERE created_at BETWEEN $1 AND $2 GROUP BY type ORDER BY n DESC`,
        p,
      ),
      db.many(`SELECT type, status, perigee_km, apogee_km, inclination_deg FROM spacecraft`),
      db.many(`SELECT status, count(*)::int AS n, coalesce(sum(budget_mln), 0)::float AS budget FROM missions GROUP BY status`),
      db.many(
        `SELECT g.id, g.name, g.code, count(c.id)::int AS n
           FROM ground_stations g LEFT JOIN commands c ON c.station_id = g.id AND c.uplinked_at BETWEEN $1 AND $2
          GROUP BY g.id ORDER BY n DESC, g.name`,
        p,
      ),
      db.one(
        `SELECT (SELECT count(*) FROM incidents WHERE created_at BETWEEN $1 AND $2)::int AS incidents,
                (SELECT count(*) FROM incidents WHERE created_at BETWEEN $1 AND $2 AND severity = 'critical')::int AS critical,
                (SELECT count(*) FROM commands WHERE created_at BETWEEN $1 AND $2)::int AS commands,
                (SELECT count(*) FROM commands WHERE created_at BETWEEN $1 AND $2 AND status = 'executed')::int AS executed,
                (SELECT count(*) FROM commands WHERE created_at BETWEEN $1 AND $2 AND status IN ('executed','failed'))::int AS finished,
                (SELECT count(*) FROM launches WHERE scheduled_at BETWEEN $1 AND $2 AND status = 'success')::int AS launches`,
        p,
      ),
    ]);

    const byType = {};
    const byStatus = {};
    const byOrbit = {};
    for (const s of fleet) {
      byType[s.type] = (byType[s.type] || 0) + 1;
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
      if (s.status !== 'planned' && s.status !== 'lost') {
        const c = orbitClass(s.perigee_km, s.apogee_km, s.inclination_deg);
        byOrbit[c] = (byOrbit[c] || 0) + 1;
      }
    }
    // прогноз нагрузки станций на сутки по расчёту орбит
    const forecast = {};
    for (const c of engine.forecastContacts(Date.now(), 24)) forecast[c.stationId] = (forecast[c.stationId] || 0) + 1;

    return {
      from,
      to,
      totals: { ...totals, successRate: totals.finished ? Math.round((totals.executed / totals.finished) * 1000) / 10 : null },
      incidentsByDay: byDay,
      incidentsBySpacecraft: bySpacecraft,
      mttr,
      commandsByStatus: cmdStatus,
      commandsByType: cmdType,
      fleet: { byType, byStatus, byOrbit },
      missions,
      stations: stationUplinks.map((s) => ({ ...s, forecast24h: forecast[s.id] || 0 })),
    };
  });
}
