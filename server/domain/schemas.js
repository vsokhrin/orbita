// Описания ресурсов ИС: схемы проверки полей, поиск, фильтры, сортировка, колонки CSV.
// Модуль без зависимостей от Node.js и от SQL: его используют и маршруты сервера,
// и демо-версия, которая работает целиком в браузере (GitHub Pages).
//
// Сортировка задаётся декларативно:
//   sortable:    { ключ_из_запроса: 'поле' | ['поле', [порядок значений]] }
//   defaultSort: [['поле', 'asc' | 'desc', [порядок значений]?], …]
// Порядок значений нужен для перечислений: приоритет «низкий → критический» и т. п.
// Пустые значения при любой сортировке идут последними.
import * as D from './dictionaries.js';
import { fieldError } from '../lib/validate.js';
import { orbitClass } from '../../shared/orbit.js';

const keys = Object.keys;
const upper = (s) => s.toUpperCase();
const label = (dict, key) => (row) => dict[row[key]] ?? row[key];

const RANK = {
  priority: ['low', 'medium', 'high', 'critical'],
  missionStatus: ['active', 'preparation', 'planning', 'completed', 'aborted'],
  crewStatus: ['in_flight', 'active', 'training', 'reserve', 'retired'],
  severityAsc: ['info', 'warning', 'critical'],
  severityDesc: ['critical', 'warning', 'info'],
  incidentStatus: ['open', 'acknowledged', 'resolved'],
};

export const SPACECRAFT = {
  path: '/api/spacecraft',
  table: 'spacecraft',
  entity: 'spacecraft',
  title: (r) => `${r.name} (${r.code})`,
  search: ['name', 'code', 'operator', 'description'],
  filters: { status: 'status', type: 'type', operator: 'operator' },
  sortable: { name: 'name', code: 'code', type: 'type', status: 'status', launch_date: 'launch_date', perigee_km: 'perigee_km', open_incidents: 'open_incidents', updated_at: 'updated_at' },
  defaultSort: [['id', 'asc']],
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
  check: (v, before) => {
    const per = v.perigee_km ?? Number(before?.perigee_km);
    const apo = v.apogee_km ?? Number(before?.apogee_km);
    if (apo < per) throw fieldError('apogee_km', 'Апогей не может быть ниже перигея');
  },
  csv: [
    { key: 'code', label: 'Код' },
    { key: 'name', label: 'Наименование' },
    { label: 'Тип', value: label(D.SPACECRAFT_TYPES, 'type') },
    { label: 'Состояние', value: label(D.SPACECRAFT_STATUSES, 'status') },
    { key: 'operator', label: 'Оператор' },
    { key: 'launch_date', label: 'Дата запуска' },
    { key: 'mass_kg', label: 'Масса, кг' },
    { key: 'perigee_km', label: 'Перигей, км' },
    { key: 'apogee_km', label: 'Апогей, км' },
    { key: 'inclination_deg', label: 'Наклонение, °' },
    { label: 'Класс орбиты', value: (r) => orbitClass(r.perigee_km, r.apogee_km, r.inclination_deg) },
    { key: 'open_incidents', label: 'Открытых инцидентов' },
  ],
};

export const STATIONS = {
  path: '/api/stations',
  table: 'ground_stations',
  entity: 'station',
  title: (r) => `${r.name} (${r.code})`,
  search: ['name', 'code', 'country'],
  filters: { status: 'status', country: 'country' },
  sortable: { name: 'name', code: 'code', country: 'country', status: 'status', latitude: 'latitude', uplinks_week: 'uplinks_week' },
  defaultSort: [['id', 'asc']],
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
    { label: 'Состояние', value: label(D.STATION_STATUSES, 'status') },
    { key: 'uplinks_week', label: 'Сеансов за неделю' },
  ],
};

export const MISSIONS = {
  path: '/api/missions',
  table: 'missions',
  entity: 'mission',
  title: (r) => `${r.name} (${r.code})`,
  search: ['name', 'code', 'objective', 'spacecraft_name', 'flight_director'],
  filters: { status: 'status', priority: 'priority', spacecraft_id: 'spacecraft_id' },
  sortable: { code: 'code', name: 'name', status: 'status', priority: ['priority', RANK.priority], start_date: 'start_date', end_date: 'end_date', progress: 'progress', budget_mln: 'budget_mln' },
  defaultSort: [['status', 'asc', RANK.missionStatus], ['start_date', 'desc']],
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
  check: (v, before) => {
    const start = v.start_date !== undefined ? v.start_date : before?.start_date;
    const end = v.end_date !== undefined ? v.end_date : before?.end_date;
    if (start && end && end < start) throw fieldError('end_date', 'Дата окончания раньше даты начала');
  },
  csv: [
    { key: 'code', label: 'Код' },
    { key: 'name', label: 'Наименование' },
    { key: 'spacecraft_name', label: 'КА' },
    { label: 'Статус', value: label(D.MISSION_STATUSES, 'status') },
    { label: 'Приоритет', value: label(D.PRIORITIES, 'priority') },
    { key: 'start_date', label: 'Начало' },
    { key: 'end_date', label: 'Окончание' },
    { key: 'progress', label: 'Выполнение, %' },
    { key: 'budget_mln', label: 'Бюджет, млн ₽' },
    { key: 'flight_director', label: 'Руководитель полёта' },
  ],
};

/** Назначение члена экипажа на миссию */
export const MISSION_CREW = {
  crew_id: { type: 'int', required: true, min: 1 },
  role: { type: 'enum', values: keys(D.CREW_ROLES), required: true },
};

export const CREW = {
  path: '/api/crew',
  table: 'crew_members',
  entity: 'crew',
  title: (r) => r.full_name,
  search: ['full_name', 'call_sign', 'nationality', 'bio'],
  filters: { status: 'status', position: 'position' },
  sortable: { full_name: 'full_name', position: 'position', status: 'status', flights_count: 'flights_count', hours_in_space: 'hours_in_space', eva_count: 'eva_count', birth_date: 'birth_date' },
  defaultSort: [['status', 'asc', RANK.crewStatus], ['full_name', 'asc']],
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
  check: (v) => {
    if (v.birth_date && (v.birth_date > new Date().toISOString().slice(0, 10) || v.birth_date < '1920-01-01')) throw fieldError('birth_date', 'Проверьте дату рождения');
  },
  csv: [
    { key: 'full_name', label: 'ФИО' },
    { key: 'call_sign', label: 'Позывной' },
    { label: 'Должность', value: label(D.CREW_POSITIONS, 'position') },
    { label: 'Статус', value: label(D.CREW_STATUSES, 'status') },
    { key: 'nationality', label: 'Гражданство' },
    { key: 'flights_count', label: 'Полётов' },
    { key: 'hours_in_space', label: 'Часов в космосе' },
    { key: 'eva_count', label: 'Выходов в открытый космос' },
    { key: 'missions', label: 'Текущие миссии' },
  ],
};

export const LAUNCHES = {
  path: '/api/launches',
  table: 'launches',
  entity: 'launch',
  title: (r) => r.name,
  search: ['name', 'vehicle', 'site', 'spacecraft_name', 'mission_code'],
  filters: { status: 'status', site: 'site' },
  dateField: 'scheduled_at',
  sortable: { scheduled_at: 'scheduled_at', name: 'name', status: 'status', site: 'site', vehicle: 'vehicle' },
  defaultSort: [['scheduled_at', 'desc']],
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
  check: (v, before) => {
    const status = v.status ?? before?.status;
    const at = v.scheduled_at ?? before?.scheduled_at;
    if (['success', 'failure'].includes(status) && Date.parse(at) > Date.now() + 60_000) {
      throw fieldError('status', 'Итог запуска можно указать только после времени старта');
    }
  },
  /** Аппарат для предстоящего запуска должен ещё быть на Земле. sc — строка КА или null. */
  checkPayload: (v, before, sc) => {
    const status = v.status ?? before?.status;
    const at = v.scheduled_at ?? before?.scheduled_at;
    if (sc && ['scheduled', 'go'].includes(status) && Date.parse(at) > Date.now() && sc.status !== 'planned') {
      throw fieldError('spacecraft_id', `КА «${sc.name}» уже на орбите — выберите аппарат в статусе «Готовится к запуску»`);
    }
  },
  /** id КА, который нужно проверить checkPayload, или null */
  payloadId: (v, before) => {
    const status = v.status ?? before?.status;
    const at = v.scheduled_at ?? before?.scheduled_at;
    const id = v.spacecraft_id !== undefined ? v.spacecraft_id : before?.spacecraft_id;
    return id && ['scheduled', 'go'].includes(status) && Date.parse(at) > Date.now() ? id : null;
  },
  csv: [
    { key: 'scheduled_at', label: 'Время старта (UTC)' },
    { key: 'name', label: 'Запуск' },
    { key: 'vehicle', label: 'Ракета-носитель' },
    { key: 'site', label: 'Космодром' },
    { label: 'Статус', value: label(D.LAUNCH_STATUSES, 'status') },
    { key: 'spacecraft_name', label: 'Полезная нагрузка' },
    { key: 'mission_code', label: 'Миссия' },
  ],
};

export const INCIDENTS = {
  path: '/api/incidents',
  table: 'incidents',
  entity: 'incident',
  title: (r) => r.title,
  search: ['title', 'description', 'spacecraft_name', 'station_name'],
  filters: { status: 'status', severity: 'severity', spacecraft_id: 'spacecraft_id', station_id: 'station_id', source: 'source' },
  dateField: 'created_at',
  sortable: { created_at: 'created_at', severity: ['severity', RANK.severityAsc], status: 'status', title: 'title', spacecraft_name: 'spacecraft_name' },
  defaultSort: [['status', 'asc', RANK.incidentStatus], ['severity', 'asc', RANK.severityDesc], ['created_at', 'desc']],
  schema: {
    spacecraft_id: { type: 'int', min: 1 },
    station_id: { type: 'int', min: 1 },
    severity: { type: 'enum', values: keys(D.INCIDENT_SEVERITIES), required: true },
    title: { type: 'string', required: true, min: 3, max: 200 },
    description: { type: 'text', max: 4000 },
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
};

export const INCIDENT_RESOLVE = { resolution: { type: 'text', required: true, min: 3, max: 2000 } };

export const COMMANDS = {
  path: '/api/commands',
  table: 'commands',
  entity: 'command',
  title: (r) => `${D.COMMAND_TYPES[r.type]?.label ?? r.type} → ${r.spacecraft_name}`,
  search: ['spacecraft_name', 'type', 'result', 'issued_by_name'],
  filters: { status: 'status', spacecraft_id: 'spacecraft_id', type: 'type', station_id: 'station_id' },
  dateField: 'created_at',
  sortable: { created_at: 'created_at', status: 'status', type: 'type', spacecraft_name: 'spacecraft_name' },
  defaultSort: [['created_at', 'desc']],
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
};

export const COMMAND_CREATE = {
  spacecraft_id: { type: 'int', required: true, min: 1 },
  type: { type: 'enum', values: keys(D.COMMAND_TYPES), required: true },
  params: { type: 'json' },
  ttl_hours: { type: 'number', min: 0.25, max: 48, default: 6 },
  incident_id: { type: 'int', min: 1 },
};

/** Проверка параметров команды по описанию типа; возвращает нормализованные параметры. */
export function commandParams(type, raw) {
  const params = {};
  for (const [key, p] of Object.entries(D.COMMAND_TYPES[type].params || {})) {
    const n = Number(raw?.[key] ?? p.default);
    if (!Number.isFinite(n) || n < p.min || n > p.max) throw fieldError(`params.${key}`, `${p.label}: от ${p.min} до ${p.max}`);
    if (key === 'delta_km' && n === 0) throw fieldError(`params.${key}`, 'Изменение высоты не может быть нулевым');
    params[key] = n;
  }
  return params;
}

/** Состояния КА, в которых он принимает команды */
export const COMMANDABLE = ['active', 'standby', 'safe_mode'];
export const MAX_QUEUED_PER_SPACECRAFT = 20;

export const AUDIT = {
  search: ['username', 'summary', 'entity', 'action'],
  filters: { action: 'action', entity: 'entity', user_id: 'user_id' },
  dateField: 'ts',
  sortable: { ts: 'ts', username: 'username', action: 'action' },
  defaultSort: [['ts', 'desc']],
  csv: [
    { key: 'ts', label: 'Время (UTC)' },
    { key: 'username', label: 'Пользователь' },
    { key: 'action', label: 'Действие' },
    { key: 'entity', label: 'Объект' },
    { key: 'entity_id', label: 'ID' },
    { key: 'summary', label: 'Описание' },
    { key: 'ip', label: 'IP' },
  ],
};

export const USER_CREATE = {
  username: { type: 'string', required: true, pattern: /^[a-z0-9_.-]{3,32}$/, patternMessage: '3–32 символа: латиница в нижнем регистре, цифры, «_», «.», «-»', transform: (s) => s.toLowerCase() },
  full_name: { type: 'string', required: true, min: 2, max: 120 },
  role: { type: 'enum', values: keys(D.ROLES), required: true },
  password: { type: 'string', required: true, max: 128 },
};

export const USER_UPDATE = {
  full_name: { type: 'string', min: 2, max: 120 },
  role: { type: 'enum', values: keys(D.ROLES) },
  is_active: { type: 'bool' },
};

/** Порядок ролей в списке пользователей */
export const ROLE_ORDER = ['admin', 'operator', 'observer'];

/** Границы периода отчёта: по умолчанию последние 30 дней, не длиннее года. */
export function reportRange(query) {
  const to = query.to && !Number.isNaN(Date.parse(query.to)) ? new Date(query.to) : new Date();
  const from = query.from && !Number.isNaN(Date.parse(query.from)) ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
  if (to - from > 366 * 86_400_000) from.setTime(to.getTime() - 366 * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Окно и шаг агрегации графиков телеметрии */
export function telemetryWindow(query) {
  const hours = Math.min(72, Math.max(1, Number(query.hours) || 6));
  return { hours, bucket: Math.max(15, Math.round((hours * 3600) / 360)) };
}

/** Параметры пагинации списка */
export function paging(query, { max = 500, def = 25 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(max, Math.max(1, Number.parseInt(query.limit, 10) || def));
  return { page, limit, offset: (page - 1) * limit };
}
