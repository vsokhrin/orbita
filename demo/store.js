// Хранилище демо-версии: таблицы ИС в памяти браузера с сохранением в localStorage.
// Повторяет схему PostgreSQL (server/db/migrations/001_init.sql): значения по умолчанию,
// уникальные ключи, внешние ключи с каскадным удалением и обновление updated_at.

const PREFIX = 'orbita-demo:v1';
const KEY_DATA = PREFIX + ':data';
const KEY_TELEMETRY = PREFIX + ':telemetry';
const KEY_TOKEN = PREFIX + ':session';
const FORMAT = 1;

export const TABLES = ['users', 'sessions', 'ground_stations', 'spacecraft', 'missions', 'crew_members', 'mission_crew', 'launches', 'incidents', 'commands', 'audit_log'];

const stamp = (now) => ({ created_at: now, updated_at: now });
const DEFAULTS = {
  users: (now) => ({ is_active: true, last_login_at: null, ...stamp(now) }),
  sessions: (now) => ({ created_at: now, last_seen_at: now, ip: null, user_agent: null }),
  ground_stations: (now) => ({ altitude_m: 0, antenna_diameter_m: null, bands: 'S', min_elevation_deg: 5, description: null, ...stamp(now) }),
  spacecraft: (now) => ({ launch_date: null, mass_kg: null, power_w: 1000, fuel_kg: 0, raan_deg: 0, arg_perigee_deg: 0, mean_anomaly_deg: 0, epoch: now, color: '#3987e5', description: null, ...stamp(now) }),
  missions: (now) => ({ objective: null, spacecraft_id: null, priority: 'medium', start_date: null, end_date: null, progress: 0, budget_mln: null, flight_director: null, description: null, ...stamp(now) }),
  crew_members: (now) => ({ call_sign: null, birth_date: null, nationality: null, flights_count: 0, hours_in_space: 0, eva_count: 0, bio: null, ...stamp(now) }),
  mission_crew: (now) => ({ assigned_at: now }),
  launches: (now) => ({ window_minutes: 0, spacecraft_id: null, mission_id: null, notes: null, ...stamp(now) }),
  incidents: (now) => ({ spacecraft_id: null, station_id: null, status: 'open', source: 'manual', kind: null, description: null, created_by: null, acknowledged_by: null, acknowledged_at: null, resolved_by: null, resolved_at: null, resolution: null, ...stamp(now) }),
  commands: (now) => ({ params: {}, status: 'queued', issued_by: null, station_id: null, incident_id: null, created_at: now, uplinked_at: null, completed_at: null, result: null }),
  audit_log: (now) => ({ ts: now, user_id: null, username: null, entity: null, entity_id: null, summary: null, details: null, ip: null }),
};

// Порядок колонок — как в таблицах PostgreSQL: строки демо-версии выглядят так же, как ответы сервера
const COLUMNS = {
  users: ['id', 'username', 'full_name', 'role', 'password_hash', 'is_active', 'last_login_at', 'created_at', 'updated_at'],
  sessions: ['id', 'user_id', 'created_at', 'expires_at', 'last_seen_at', 'ip', 'user_agent'],
  ground_stations: ['id', 'code', 'name', 'country', 'latitude', 'longitude', 'altitude_m', 'antenna_diameter_m', 'bands', 'min_elevation_deg', 'status', 'description', 'created_at', 'updated_at'],
  spacecraft: ['id', 'code', 'name', 'type', 'status', 'operator', 'launch_date', 'mass_kg', 'power_w', 'fuel_kg', 'perigee_km', 'apogee_km', 'inclination_deg', 'raan_deg', 'arg_perigee_deg', 'mean_anomaly_deg', 'epoch', 'color', 'description', 'created_at', 'updated_at'],
  missions: ['id', 'code', 'name', 'objective', 'spacecraft_id', 'status', 'priority', 'start_date', 'end_date', 'progress', 'budget_mln', 'flight_director', 'description', 'created_at', 'updated_at'],
  crew_members: ['id', 'full_name', 'call_sign', 'position', 'status', 'birth_date', 'nationality', 'flights_count', 'hours_in_space', 'eva_count', 'bio', 'created_at', 'updated_at'],
  mission_crew: ['mission_id', 'crew_id', 'role', 'assigned_at'],
  launches: ['id', 'name', 'vehicle', 'site', 'scheduled_at', 'window_minutes', 'status', 'spacecraft_id', 'mission_id', 'notes', 'created_at', 'updated_at'],
  incidents: ['id', 'spacecraft_id', 'station_id', 'severity', 'status', 'source', 'kind', 'title', 'description', 'created_by', 'acknowledged_by', 'acknowledged_at', 'resolved_by', 'resolved_at', 'resolution', 'created_at', 'updated_at'],
  commands: ['id', 'spacecraft_id', 'type', 'params', 'status', 'issued_by', 'station_id', 'incident_id', 'created_at', 'uplinked_at', 'completed_at', 'expires_at', 'result'],
  audit_log: ['id', 'ts', 'user_id', 'username', 'action', 'entity', 'entity_id', 'summary', 'details', 'ip'],
};

/** Строка таблицы: значения по умолчанию, затем переданные; только колонки таблицы и в их порядке. */
function makeRow(table, values, now) {
  const merged = { ...DEFAULTS[table](now), ...values };
  return Object.fromEntries(COLUMNS[table].map((c) => [c, merged[c] ?? null]));
}

// Внешние ключи: таблица, колонка, на что ссылается, что делать при удалении
const FOREIGN = [
  ['sessions', 'user_id', 'users', 'cascade'],
  ['missions', 'spacecraft_id', 'spacecraft', 'set null'],
  ['mission_crew', 'mission_id', 'missions', 'cascade'],
  ['mission_crew', 'crew_id', 'crew_members', 'cascade'],
  ['launches', 'spacecraft_id', 'spacecraft', 'set null'],
  ['launches', 'mission_id', 'missions', 'set null'],
  ['incidents', 'spacecraft_id', 'spacecraft', 'cascade'],
  ['incidents', 'station_id', 'ground_stations', 'set null'],
  ['incidents', 'created_by', 'users', 'set null'],
  ['incidents', 'acknowledged_by', 'users', 'set null'],
  ['incidents', 'resolved_by', 'users', 'set null'],
  ['commands', 'spacecraft_id', 'spacecraft', 'cascade'],
  ['commands', 'issued_by', 'users', 'set null'],
  ['commands', 'station_id', 'ground_stations', 'set null'],
  ['commands', 'incident_id', 'incidents', 'set null'],
  ['audit_log', 'user_id', 'users', 'set null'],
];
const UNIQUE = { users: 'username', spacecraft: 'code', ground_stations: 'code', missions: 'code' };
const TOUCHED = new Set(['users', 'ground_stations', 'spacecraft', 'missions', 'crew_members', 'launches', 'incidents']);

/** Ошибка ограничения целостности — те же коды, что у PostgreSQL */
export class ConstraintError extends Error {
  constructor(code, constraint) {
    super(constraint);
    this.code = code;
    this.constraint = constraint;
  }
}

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // хранилище запрещено настройками браузера — работаем только в памяти
  }
}

// ---------- телеметрия: отдельный ряд на каждый КА, компактно в localStorage ----------

const T_FIELDS = ['ts', 'battery', 'temperature', 'power_w', 'signal_dbm', 'altitude_km', 'velocity_kms', 'lat', 'lon', 'sunlit', 'mode', 'pointing', 'payload_on', 'station_id'];

export class TelemetryLog {
  constructor() {
    this.series = new Map(); // id КА → записи по возрастанию времени
  }
  add(rows) {
    for (const r of rows) {
      let s = this.series.get(r.spacecraft_id);
      if (!s) this.series.set(r.spacecraft_id, (s = []));
      if (s.length && s[s.length - 1].ts >= r.ts) continue; // как ON CONFLICT DO NOTHING
      s.push(r);
    }
  }
  latest() {
    return [...this.series.values()].filter((s) => s.length).map((s) => s[s.length - 1]);
  }
  lastTime(id) {
    const s = this.series.get(id);
    return s?.length ? Date.parse(s[s.length - 1].ts) : null;
  }
  /** Записи КА позже момента sinceIso */
  since(id, sinceIso) {
    const s = this.series.get(id) || [];
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].ts <= sinceIso) lo = mid + 1;
      else hi = mid;
    }
    return s.slice(lo);
  }
  prune(beforeIso) {
    for (const s of this.series.values()) {
      let n = 0;
      while (n < s.length && s[n].ts < beforeIso) n++;
      if (n) s.splice(0, n);
    }
  }
  drop(id) {
    this.series.delete(id);
  }
  get size() {
    let n = 0;
    for (const s of this.series.values()) n += s.length;
    return n;
  }
  toJSON() {
    const out = {};
    for (const [id, s] of this.series) {
      out[id] = s.map((r) => T_FIELDS.map((f) => (f === 'ts' ? Date.parse(r.ts) : typeof r[f] === 'boolean' ? +r[f] : r[f])));
    }
    return out;
  }
  static fromJSON(obj) {
    const log = new TelemetryLog();
    for (const [id, rows] of Object.entries(obj || {})) {
      log.series.set(
        Number(id),
        rows.map((a) => {
          const r = { spacecraft_id: Number(id) };
          T_FIELDS.forEach((f, i) => (r[f] = f === 'ts' ? new Date(a[i]).toISOString() : f === 'sunlit' || f === 'payload_on' ? !!a[i] : a[i]));
          return r;
        }),
      );
    }
    return log;
  }
}

// ---------- таблицы ----------

export class Store {
  constructor({ tables, seq, telemetry, seededAt }) {
    this.t = tables;
    this.seq = seq;
    this.telemetry = telemetry;
    this.seededAt = seededAt;
    this.disabled = false;
    this.saveTimer = null;
    this.telemetryTimer = null;
    this.lastTelemetrySave = 0;
  }

  static load() {
    const ls = storage();
    if (!ls) return null;
    try {
      const raw = ls.getItem(KEY_DATA);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data.format !== FORMAT || !data.tables) return null;
      for (const name of TABLES) data.tables[name] ||= [];
      let telemetry = new TelemetryLog();
      try {
        telemetry = TelemetryLog.fromJSON(JSON.parse(ls.getItem(KEY_TELEMETRY) || '{}'));
      } catch {
        // повреждённая телеметрия не страшна: история будет досчитана моделью
      }
      return new Store({ tables: data.tables, seq: data.seq || {}, telemetry, seededAt: data.seededAt });
    } catch (err) {
      console.warn('ОРБИТА демо: сохранённые данные не прочитаны, начинаю заново', err);
      return null;
    }
  }

  /** Новое хранилище из начальных данных (server/db/seed-data.js); строки уже с id. */
  static fromSeed(seed, now) {
    const tables = Object.fromEntries(TABLES.map((name) => [name, []]));
    const seq = {};
    const iso = new Date(now).toISOString();
    for (const name of TABLES) {
      for (const row of seed[name] || []) tables[name].push(makeRow(name, row, iso));
      seq[name] = tables[name].reduce((m, r) => Math.max(m, r.id || 0), 0);
    }
    const telemetry = new TelemetryLog();
    telemetry.add(seed.telemetry || []);
    return new Store({ tables, seq, telemetry, seededAt: iso });
  }

  all(table) {
    return this.t[table];
  }

  get(table, id) {
    return this.t[table].find((r) => r.id === id) || null;
  }

  find(table, pred) {
    return this.t[table].filter(pred);
  }

  insert(table, values) {
    const row = makeRow(table, values, new Date().toISOString());
    if (row.id === null && COLUMNS[table][0] === 'id' && table !== 'sessions') row.id = ++this.seq[table];
    this.checkUnique(table, row);
    this.checkRefs(table, row);
    this.t[table].push(row);
    this.changed();
    return row;
  }

  /** Изменение строки (как UPDATE … RETURNING *); updated_at обновляется, как триггером в PostgreSQL. */
  update(table, row, changes) {
    const next = { ...row, ...changes };
    if (TOUCHED.has(table)) next.updated_at = new Date().toISOString();
    this.checkUnique(table, next);
    this.checkRefs(table, next);
    Object.assign(row, next);
    this.changed();
    return row;
  }

  /** Удаление строк с каскадом по внешним ключам */
  remove(table, pred) {
    const list = this.t[table];
    const removed = list.filter(pred);
    if (!removed.length) return [];
    this.t[table] = list.filter((r) => !removed.includes(r));
    for (const [child, column, parent, action] of FOREIGN) {
      if (parent !== table) continue;
      const ids = new Set(removed.map((r) => r.id));
      if (action === 'cascade') this.remove(child, (r) => ids.has(r[column]));
      else for (const r of this.t[child]) if (ids.has(r[column])) r[column] = null;
    }
    if (table === 'spacecraft') for (const r of removed) this.telemetry.drop(r.id);
    this.changed();
    return removed;
  }

  checkUnique(table, row) {
    const col = UNIQUE[table];
    if (table === 'mission_crew') {
      if (this.t.mission_crew.some((r) => r !== row && r.mission_id === row.mission_id && r.crew_id === row.crew_id)) throw new ConstraintError('23505', 'mission_crew_pkey');
      return;
    }
    if (col && this.t[table].some((r) => r.id !== row.id && r[col] === row[col])) throw new ConstraintError('23505', `${table}_${col}_key`);
  }

  checkRefs(table, row) {
    for (const [child, column, parent] of FOREIGN) {
      if (child !== table || row[column] === null || row[column] === undefined) continue;
      if (!this.get(parent, row[column])) throw new ConstraintError('23503', `${table}_${column}_fkey`);
    }
  }

  // ---------- сохранение ----------

  changed() {
    if (this.disabled || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.saveData(), 1000);
  }

  telemetryChanged() {
    if (this.disabled || this.telemetryTimer) return;
    // телеметрия объёмная — пишем не чаще раза в 30 с
    const wait = Math.max(1000, 30_000 - (Date.now() - this.lastTelemetrySave));
    this.telemetryTimer = setTimeout(() => this.saveTelemetry(), wait);
  }

  saveData() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.disabled) return;
    write(KEY_DATA, JSON.stringify({ format: FORMAT, seededAt: this.seededAt, savedAt: new Date().toISOString(), seq: this.seq, tables: this.t }));
  }

  saveTelemetry() {
    clearTimeout(this.telemetryTimer);
    this.telemetryTimer = null;
    if (this.disabled) return;
    this.lastTelemetrySave = Date.now();
    // если места не хватит — не беда: недостающую историю досчитает модель при следующем открытии
    if (!write(KEY_TELEMETRY, JSON.stringify(this.telemetry))) {
      try {
        storage()?.removeItem(KEY_TELEMETRY);
      } catch {}
    }
  }

  flush() {
    if (this.disabled) return;
    this.saveData();
    this.saveTelemetry();
  }

  /** Полный сброс демо-данных этого браузера */
  clear() {
    this.disabled = true;
    clearTimeout(this.saveTimer);
    clearTimeout(this.telemetryTimer);
    sessionToken.set(null);
    try {
      for (const key of [KEY_DATA, KEY_TELEMETRY]) storage()?.removeItem(key);
    } catch {}
  }
}

function write(key, value) {
  try {
    storage()?.setItem(key, value);
    return true;
  } catch (err) {
    console.warn(`ОРБИТА демо: не удалось сохранить ${key} (${err.name})`);
    return false;
  }
}

// ---------- токен сессии (аналог cookie) ----------

let memoryToken = null;
export const sessionToken = {
  get() {
    try {
      return storage()?.getItem(KEY_TOKEN) ?? memoryToken;
    } catch {
      return memoryToken;
    }
  },
  set(token) {
    memoryToken = token || null;
    try {
      if (token) storage()?.setItem(KEY_TOKEN, token);
      else storage()?.removeItem(KEY_TOKEN);
    } catch {}
  },
};
