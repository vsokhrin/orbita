// Справочники ИС: космические аппараты, наземные станции, миссии, экипаж, запуски.
import { resource } from '../lib/resource.js';
import { requireAuth, canEdit } from '../auth/sessions.js';
import { fieldError, parseId, validate } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../http/app.js';
import * as D from '../domain/dictionaries.js';
import { orbitClass, elementsFrom, periodMinutes } from '../../shared/orbit.js';

const keys = Object.keys;
const upper = (s) => s.toUpperCase();
const label = (dict) => (key) => (row) => dict[row[key]] ?? row[key];

export function entityRoutes(app, { db, engine, hub }) {
  const fleetChanged = () => {
    engine.reloadFleet().then(() => hub.broadcast('fleet', { reason: 'edit' }));
  };

  // ---------- Космические аппараты ----------
  resource(app, db, {
    path: '/api/spacecraft',
    table: 'spacecraft',
    entity: 'spacecraft',
    title: (r) => `${r.name} (${r.code})`,
    select: `SELECT s.*,
               (SELECT count(*) FROM incidents i WHERE i.spacecraft_id = s.id AND i.status <> 'resolved')::int AS open_incidents,
               (SELECT count(*) FROM missions m WHERE m.spacecraft_id = s.id AND m.status = 'active')::int AS active_missions
             FROM spacecraft s`,
    search: ['name', 'code', 'operator', 'description'],
    filters: { status: 'status', type: 'type', operator: 'operator' },
    sortable: { name: 'name', code: 'code', type: 'type', status: 'status', launch_date: 'launch_date', perigee_km: 'perigee_km', open_incidents: 'open_incidents', updated_at: 'updated_at' },
    defaultSort: 'id',
    schema: {
      code: { type: 'string', required: true, min: 2, max: 24, pattern: /^[A-Za-zА-Яа-яЁё0-9-]+$/, patternMessage: 'Буквы, цифры и дефис', transform: upper },
      name: { type: 'string', required: true, min: 2, max: 80 },
      type: { type: 'enum', values: keys(D.SPACECRAFT_TYPES), required: true },
      status: { type: 'enum', values: keys(D.SPACECRAFT_STATUSES), required: true },
      operator: { type: 'string', required: true, max: 120 },
      launch_date: { type: 'date' },
      mass_kg: { type: 'number', min: 0.1, max: 1_000_000 },
      power_w: { type: 'number', min: 1, max: 200_000, default: 1000 },
      fuel_kg: { type: 'number', min: 0, max: 100_000, default: 0 },
      perigee_km: { type: 'number', required: true, min: 150, max: 400_000 },
      apogee_km: { type: 'number', required: true, min: 150, max: 400_000 },
      inclination_deg: { type: 'number', required: true, min: 0, max: 180 },
      raan_deg: { type: 'number', min: 0, max: 359.999, default: 0 },
      arg_perigee_deg: { type: 'number', min: 0, max: 359.999, default: 0 },
      mean_anomaly_deg: { type: 'number', min: 0, max: 359.999, default: 0 },
      epoch: { type: 'datetime', default: () => new Date().toISOString() },
      color: { type: 'string', pattern: /^#[0-9a-fA-F]{6}$/, patternMessage: 'Цвет в формате #RRGGBB', default: '#3987e5' },
      description: { type: 'text', max: 2000 },
    },
    beforeSave: (v, before) => {
      const per = v.perigee_km ?? Number(before?.perigee_km);
      const apo = v.apogee_km ?? Number(before?.apogee_km);
      if (apo < per) throw fieldError('apogee_km', 'Апогей не может быть ниже перигея');
    },
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
    csv: [
      { key: 'code', label: 'Код' },
      { key: 'name', label: 'Наименование' },
      { label: 'Тип', value: label(D.SPACECRAFT_TYPES)('type') },
      { label: 'Состояние', value: label(D.SPACECRAFT_STATUSES)('status') },
      { key: 'operator', label: 'Оператор' },
      { key: 'launch_date', label: 'Дата запуска' },
      { key: 'mass_kg', label: 'Масса, кг' },
      { key: 'perigee_km', label: 'Перигей, км' },
      { key: 'apogee_km', label: 'Апогей, км' },
      { key: 'inclination_deg', label: 'Наклонение, °' },
      { label: 'Класс орбиты', value: (r) => orbitClass(r.perigee_km, r.apogee_km, r.inclination_deg) },
      { key: 'open_incidents', label: 'Открытых инцидентов' },
    ],
    afterChange: fleetChanged,
  });

  app.get('/api/spacecraft/:id/telemetry', requireAuth, async (req) => {
    const id = parseId(req.params.id);
    const hours = Math.min(72, Math.max(1, Number(req.query.hours) || 6));
    const bucket = Math.max(15, Math.round((hours * 3600) / 360));
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
    path: '/api/stations',
    table: 'ground_stations',
    entity: 'station',
    title: (r) => `${r.name} (${r.code})`,
    select: `SELECT g.*,
               (SELECT count(*) FROM commands c WHERE c.station_id = g.id AND c.uplinked_at > now() - interval '7 days')::int AS uplinks_week
             FROM ground_stations g`,
    search: ['name', 'code', 'country'],
    filters: { status: 'status', country: 'country' },
    sortable: { name: 'name', code: 'code', country: 'country', status: 'status', latitude: 'latitude', uplinks_week: 'uplinks_week' },
    defaultSort: 'id',
    schema: {
      code: { type: 'string', required: true, pattern: /^[A-Za-z0-9-]{2,12}$/, patternMessage: '2–12 латинских букв, цифр или дефисов', transform: upper },
      name: { type: 'string', required: true, min: 2, max: 80 },
      country: { type: 'string', required: true, max: 80 },
      latitude: { type: 'number', required: true, min: -90, max: 90 },
      longitude: { type: 'number', required: true, min: -180, max: 180 },
      altitude_m: { type: 'number', min: -500, max: 9000, default: 0 },
      antenna_diameter_m: { type: 'number', min: 0.1, max: 100 },
      bands: { type: 'string', max: 40, default: 'S', pattern: /^[A-Za-z]{1,3}(,[A-Za-z]{1,3})*$/, patternMessage: 'Диапазоны через запятую: S,X,Ka', transform: (s) => s.replace(/\s/g, '') },
      min_elevation_deg: { type: 'number', min: 0, max: 45, default: 5 },
      status: { type: 'enum', values: keys(D.STATION_STATUSES), required: true },
      description: { type: 'text', max: 2000 },
    },
    csv: [
      { key: 'code', label: 'Код' },
      { key: 'name', label: 'Название' },
      { key: 'country', label: 'Страна' },
      { key: 'latitude', label: 'Широта' },
      { key: 'longitude', label: 'Долгота' },
      { key: 'antenna_diameter_m', label: 'Антенна, м' },
      { key: 'bands', label: 'Диапазоны' },
      { label: 'Состояние', value: label(D.STATION_STATUSES)('status') },
      { key: 'uplinks_week', label: 'Сеансов за неделю' },
    ],
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
    path: '/api/missions',
    table: 'missions',
    entity: 'mission',
    title: (r) => `${r.name} (${r.code})`,
    select: missionSelect,
    search: ['name', 'code', 'objective', 'spacecraft_name', 'flight_director'],
    filters: { status: 'status', priority: 'priority', spacecraft_id: 'spacecraft_id' },
    sortable: { code: 'code', name: 'name', status: 'status', priority: "array_position(ARRAY['low','medium','high','critical'], priority)", start_date: 'start_date', end_date: 'end_date', progress: 'progress', budget_mln: 'budget_mln' },
    defaultSort: "array_position(ARRAY['active','preparation','planning','completed','aborted'], status), start_date DESC NULLS LAST",
    schema: {
      code: { type: 'string', required: true, min: 2, max: 24, pattern: /^[A-Za-zА-Яа-яЁё0-9-]+$/, patternMessage: 'Буквы, цифры и дефис', transform: upper },
      name: { type: 'string', required: true, min: 3, max: 160 },
      objective: { type: 'text', max: 2000 },
      spacecraft_id: { type: 'int', min: 1 },
      status: { type: 'enum', values: keys(D.MISSION_STATUSES), required: true },
      priority: { type: 'enum', values: keys(D.PRIORITIES), default: 'medium' },
      start_date: { type: 'date' },
      end_date: { type: 'date' },
      progress: { type: 'int', min: 0, max: 100, default: 0 },
      budget_mln: { type: 'number', min: 0, max: 1_000_000 },
      flight_director: { type: 'string', max: 120 },
      description: { type: 'text', max: 4000 },
    },
    beforeSave: (v, before) => {
      const start = v.start_date !== undefined ? v.start_date : before?.start_date;
      const end = v.end_date !== undefined ? v.end_date : before?.end_date;
      if (start && end && end < start) throw fieldError('end_date', 'Дата окончания раньше даты начала');
    },
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
    csv: [
      { key: 'code', label: 'Код' },
      { key: 'name', label: 'Наименование' },
      { key: 'spacecraft_name', label: 'КА' },
      { label: 'Статус', value: label(D.MISSION_STATUSES)('status') },
      { label: 'Приоритет', value: label(D.PRIORITIES)('priority') },
      { key: 'start_date', label: 'Начало' },
      { key: 'end_date', label: 'Окончание' },
      { key: 'progress', label: 'Выполнение, %' },
      { key: 'budget_mln', label: 'Бюджет, млн ₽' },
      { key: 'flight_director', label: 'Руководитель полёта' },
    ],
  });

  // Назначение экипажа на миссию (связь многие-ко-многим)
  app.post('/api/missions/:id/crew', canEdit, async (req, res) => {
    const missionId = parseId(req.params.id);
    const v = validate({ crew_id: { type: 'int', required: true, min: 1 }, role: { type: 'enum', values: keys(D.CREW_ROLES), required: true } }, req.body);
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
    path: '/api/crew',
    table: 'crew_members',
    entity: 'crew',
    title: (r) => r.full_name,
    select: `SELECT c.*,
               (SELECT string_agg(m.code, ', ' ORDER BY m.code) FROM mission_crew mc JOIN missions m ON m.id = mc.mission_id
                 WHERE mc.crew_id = c.id AND m.status IN ('planning','preparation','active')) AS missions
             FROM crew_members c`,
    search: ['full_name', 'call_sign', 'nationality', 'bio'],
    filters: { status: 'status', position: 'position' },
    sortable: { full_name: 'full_name', position: 'position', status: 'status', flights_count: 'flights_count', hours_in_space: 'hours_in_space', eva_count: 'eva_count', birth_date: 'birth_date' },
    defaultSort: "array_position(ARRAY['in_flight','active','training','reserve','retired'], status), full_name",
    schema: {
      full_name: { type: 'string', required: true, min: 3, max: 120 },
      call_sign: { type: 'string', max: 40 },
      position: { type: 'enum', values: keys(D.CREW_POSITIONS), required: true },
      status: { type: 'enum', values: keys(D.CREW_STATUSES), required: true },
      birth_date: { type: 'date' },
      nationality: { type: 'string', max: 60 },
      flights_count: { type: 'int', min: 0, max: 50, default: 0 },
      hours_in_space: { type: 'number', min: 0, max: 100_000, default: 0 },
      eva_count: { type: 'int', min: 0, max: 100, default: 0 },
      bio: { type: 'text', max: 4000 },
    },
    beforeSave: (v) => {
      if (v.birth_date && (v.birth_date > new Date().toISOString().slice(0, 10) || v.birth_date < '1920-01-01')) throw fieldError('birth_date', 'Проверьте дату рождения');
    },
    expand: async (row) => ({
      ...row,
      assignments: await db.many(
        `SELECT m.id, m.code, m.name, m.status, mc.role FROM mission_crew mc JOIN missions m ON m.id = mc.mission_id
          WHERE mc.crew_id = $1 ORDER BY m.start_date DESC NULLS LAST`,
        [row.id],
      ),
    }),
    csv: [
      { key: 'full_name', label: 'ФИО' },
      { key: 'call_sign', label: 'Позывной' },
      { label: 'Должность', value: label(D.CREW_POSITIONS)('position') },
      { label: 'Статус', value: label(D.CREW_STATUSES)('status') },
      { key: 'nationality', label: 'Гражданство' },
      { key: 'flights_count', label: 'Полётов' },
      { key: 'hours_in_space', label: 'Часов в космосе' },
      { key: 'eva_count', label: 'Выходов в открытый космос' },
      { key: 'missions', label: 'Текущие миссии' },
    ],
  });

  // ---------- Запуски ----------
  resource(app, db, {
    path: '/api/launches',
    table: 'launches',
    entity: 'launch',
    title: (r) => r.name,
    select: `SELECT l.*, s.name AS spacecraft_name, m.code AS mission_code, m.name AS mission_name
             FROM launches l LEFT JOIN spacecraft s ON s.id = l.spacecraft_id LEFT JOIN missions m ON m.id = l.mission_id`,
    search: ['name', 'vehicle', 'site', 'spacecraft_name', 'mission_code'],
    filters: { status: 'status', site: 'site' },
    dateField: 'scheduled_at',
    sortable: { scheduled_at: 'scheduled_at', name: 'name', status: 'status', site: 'site', vehicle: 'vehicle' },
    defaultSort: 'scheduled_at DESC',
    schema: {
      name: { type: 'string', required: true, min: 3, max: 120 },
      vehicle: { type: 'string', required: true, max: 80 },
      site: { type: 'string', required: true, max: 80 },
      scheduled_at: { type: 'datetime', required: true },
      window_minutes: { type: 'int', min: 0, max: 1440, default: 0 },
      status: { type: 'enum', values: keys(D.LAUNCH_STATUSES), required: true },
      spacecraft_id: { type: 'int', min: 1 },
      mission_id: { type: 'int', min: 1 },
      notes: { type: 'text', max: 2000 },
    },
    beforeSave: async (v, before) => {
      const status = v.status ?? before?.status;
      const at = v.scheduled_at ?? before?.scheduled_at;
      if (['success', 'failure'].includes(status) && Date.parse(at) > Date.now() + 60_000) {
        throw fieldError('status', 'Итог запуска можно указать только после времени старта');
      }
      const scId = v.spacecraft_id !== undefined ? v.spacecraft_id : before?.spacecraft_id;
      if (scId && ['scheduled', 'go'].includes(status) && Date.parse(at) > Date.now()) {
        const sc = await db.one('SELECT status, name FROM spacecraft WHERE id = $1', [scId]);
        if (sc && sc.status !== 'planned') throw fieldError('spacecraft_id', `КА «${sc.name}» уже на орбите — выберите аппарат в статусе «Готовится к запуску»`);
      }
    },
    csv: [
      { key: 'scheduled_at', label: 'Время старта (UTC)' },
      { key: 'name', label: 'Запуск' },
      { key: 'vehicle', label: 'Ракета-носитель' },
      { key: 'site', label: 'Космодром' },
      { label: 'Статус', value: label(D.LAUNCH_STATUSES)('status') },
      { key: 'spacecraft_name', label: 'Полезная нагрузка' },
      { key: 'mission_code', label: 'Миссия' },
    ],
    afterChange: (_, row) => hub.broadcast('launch', { action: 'updated', launch: row }),
  });
}
