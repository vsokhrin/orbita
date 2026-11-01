// API демо-версии: те же маршруты, проверки и ответы, что у сервера ОРБИТЫ (server/routes/*.js),
// только вместо SQL — запросы к данным в памяти браузера. Описания ресурсов, схемы проверки,
// справочники, выгрузка CSV и журнал изменений — общие с сервером модули.
import * as D from '../server/domain/dictionaries.js';
import * as R from '../server/domain/schemas.js';
import { validate, parseId, fieldError, validatePasswordStrength } from '../server/lib/validate.js';
import { HttpError, badRequest, notFound, forbidden } from '../server/http/errors.js';
import { diff } from '../server/lib/audit.js';
import { toCsv } from '../server/lib/csv.js';
import { orbitClass, elementsFrom, periodMinutes } from '../shared/orbit.js';
import { ConstraintError, sessionToken } from './store.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from './crypto.js';

const SESSION_TTL_MS = 12 * 3600_000;
const nowIso = () => new Date().toISOString();
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const collator = new Intl.Collator('ru');
const ISO_RE = /^\d{4}-\d{2}-\d{2}/;

// ---------- ответы ----------

class Reply {
  constructor(status, data, headers = {}) {
    this.status = status;
    this.data = data;
    this.headers = headers;
  }
}
const created = (data) => new Reply(201, data);
const noContent = () => new Reply(204, null);
const csvFile = (text, filename) => new Reply(200, text, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });

// ---------- выборки: аналог buildWhere/buildOrder из server/lib/resource.js ----------

function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  const x = String(a);
  const y = String(b);
  if (ISO_RE.test(x) && ISO_RE.test(y)) return x < y ? -1 : x > y ? 1 : 0; // даты и время
  return collator.compare(x, y);
}

const isNull = (v) => v === null || v === undefined;

/** Сортировка по описанию ресурса; пустые значения — последними (NULLS LAST), как на сервере. */
export function sorter(def, query) {
  const spec = def.sortable?.[query.sort];
  const dir = query.dir === 'desc' ? 'desc' : 'asc';
  const keys = spec
    ? [[spec, dir], ['id', dir]]
    : [...(def.defaultSort || [['id', 'desc']]).map(([column, d, rank]) => [rank ? [column, rank] : column, d]), ['id', 'asc']];
  const getters = keys.map(([s, d]) => {
    const get = Array.isArray(s)
      ? (row) => {
          const i = s[1].indexOf(row[s[0]]);
          return i < 0 ? null : i + 1;
        }
      : (row) => row[s];
    return [get, d === 'desc' ? -1 : 1];
  });
  return (a, b) => {
    for (const [get, sign] of getters) {
      const x = get(a);
      const y = get(b);
      if (isNull(x) && isNull(y)) continue;
      if (isNull(x)) return 1;
      if (isNull(y)) return -1;
      const c = compareValues(x, y);
      if (c) return c * sign;
    }
    return 0;
  };
}

/** Поиск (ILIKE по нескольким полям), фильтры через запятую, диапазон дат from/to. */
export function where(def, query) {
  const preds = [];
  if (query.q && def.search?.length) {
    const term = String(query.q).trim().slice(0, 100).toLowerCase();
    preds.push((r) => def.search.some((c) => !isNull(r[c]) && String(r[c]).toLowerCase().includes(term)));
  }
  for (const [key, column] of Object.entries(def.filters || {})) {
    const raw = query[key];
    if (raw === undefined || raw === '') continue;
    if (raw === 'null') {
      preds.push((r) => isNull(r[column]));
      continue;
    }
    const values = String(raw).split(',').filter(Boolean).slice(0, 20);
    preds.push((r) => !isNull(r[column]) && values.includes(String(r[column])));
  }
  if (def.dateField) {
    const f = def.dateField;
    if (query.from && !Number.isNaN(Date.parse(query.from))) {
      const from = new Date(query.from).toISOString();
      preds.push((r) => !isNull(r[f]) && r[f] >= from);
    }
    if (query.to && !Number.isNaN(Date.parse(query.to))) {
      const to = new Date(query.to).toISOString();
      preds.push((r) => !isNull(r[f]) && r[f] <= to);
    }
  }
  return (r) => preds.every((p) => p(r));
}

const select = (rows, def, query) => rows.filter(where(def, query)).sort(sorter(def, query));
const countBy = (rows, key) => rows.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});
const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
const byDateDesc = (key) => (a, b) => (isNull(a[key]) ? 1 : isNull(b[key]) ? -1 : a[key] < b[key] ? 1 : a[key] > b[key] ? -1 : 0);

export function createApi({ store, engine, hub, version }) {
  const all = (t) => store.all(t);
  const idMap = (t) => new Map(all(t).map((r) => [r.id, r]));

  // ---------- представления: то же, что SELECT … JOIN … в маршрутах сервера ----------

  const views = {
    spacecraft: () => {
      const inc = countBy(all('incidents').filter((i) => i.status !== 'resolved'), 'spacecraft_id');
      const act = countBy(all('missions').filter((m) => m.status === 'active'), 'spacecraft_id');
      return (s) => ({ ...s, open_incidents: inc[s.id] || 0, active_missions: act[s.id] || 0 });
    },
    ground_stations: () => {
      const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const up = countBy(all('commands').filter((c) => c.uplinked_at && c.uplinked_at > week), 'station_id');
      return (g) => ({ ...g, uplinks_week: up[g.id] || 0 });
    },
    missions: () => {
      const sc = idMap('spacecraft');
      const crew = countBy(all('mission_crew'), 'mission_id');
      return (m) => ({ ...m, spacecraft_name: sc.get(m.spacecraft_id)?.name ?? null, spacecraft_code: sc.get(m.spacecraft_id)?.code ?? null, crew_count: crew[m.id] || 0 });
    },
    crew_members: () => {
      const ms = idMap('missions');
      const current = new Map();
      for (const mc of all('mission_crew')) {
        const m = ms.get(mc.mission_id);
        if (!m || !['planning', 'preparation', 'active'].includes(m.status)) continue;
        if (!current.has(mc.crew_id)) current.set(mc.crew_id, []);
        current.get(mc.crew_id).push(m.code);
      }
      return (c) => ({ ...c, missions: current.has(c.id) ? current.get(c.id).sort(collator.compare).join(', ') : null });
    },
    launches: () => {
      const sc = idMap('spacecraft');
      const ms = idMap('missions');
      return (l) => ({ ...l, spacecraft_name: sc.get(l.spacecraft_id)?.name ?? null, mission_code: ms.get(l.mission_id)?.code ?? null, mission_name: ms.get(l.mission_id)?.name ?? null });
    },
    incidents: () => {
      const sc = idMap('spacecraft');
      const st = idMap('ground_stations');
      const us = idMap('users');
      return (i) => ({
        ...i,
        spacecraft_name: sc.get(i.spacecraft_id)?.name ?? null,
        station_name: st.get(i.station_id)?.name ?? null,
        created_by_name: us.get(i.created_by)?.full_name ?? null,
        acknowledged_by_name: us.get(i.acknowledged_by)?.full_name ?? null,
        resolved_by_name: us.get(i.resolved_by)?.full_name ?? null,
      });
    },
    commands: () => {
      const sc = idMap('spacecraft');
      const st = idMap('ground_stations');
      const us = idMap('users');
      return (c) => ({ ...c, spacecraft_name: sc.get(c.spacecraft_id)?.name ?? null, spacecraft_code: sc.get(c.spacecraft_id)?.code ?? null, station_name: st.get(c.station_id)?.name ?? null, issued_by_name: us.get(c.issued_by)?.full_name ?? null });
    },
  };
  const viewOf = (table, row) => (row ? views[table]()(row) : null);
  const viewAll = (table) => all(table).map(views[table]());

  // ---------- маршрутизатор ----------

  const routes = [];
  const add = (method) => (path, ...handlers) => {
    const keys = [];
    const regex = new RegExp('^' + path.replace(/\./g, '\\.').replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    routes.push({ method, regex, keys, handlers });
  };
  const app = { get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') };

  const requireAuth = (req) => {
    if (!req.user) throw new HttpError(401, 'Требуется вход в систему');
  };
  const requireRole = (...roles) => (req) => {
    requireAuth(req);
    if (!roles.includes(req.user.role)) throw forbidden();
  };
  const canEdit = requireRole('admin', 'operator');
  const adminOnly = requireRole('admin');

  function audit(req, { action, entity = null, entityId = null, summary = null, details = null }) {
    store.insert('audit_log', {
      user_id: req?.user?.id ?? null,
      username: req?.user?.username ?? (req ? null : 'система'),
      action,
      entity,
      entity_id: entityId === null ? null : String(entityId),
      summary,
      details: details === null ? null : JSON.parse(JSON.stringify(details)),
      ip: null,
    });
  }

  // ---------- сессии (аналог server/auth/sessions.js) ----------

  let tokenCache = { token: null, id: null };
  async function sessionId(token) {
    if (tokenCache.token !== token) tokenCache = { token, id: await sha256(token) };
    return tokenCache.id;
  }

  async function loadSession(req) {
    const token = sessionToken.get();
    if (!token || token.length > 100) return;
    const s = store.get('sessions', await sessionId(token));
    if (!s || s.expires_at <= nowIso()) return;
    const u = store.get('users', s.user_id);
    if (!u || !u.is_active) return;
    req.user = { id: u.id, username: u.username, fullName: u.full_name, role: u.role };
    req.sessionId = s.id;
    if (Date.now() - Date.parse(s.last_seen_at) > 5 * 60_000) {
      store.update('sessions', s, { last_seen_at: nowIso(), expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
    }
  }

  const attempts = new Map();
  function loginRateLimit(req) {
    const key = String(req.body?.username || '').toLowerCase();
    const now = Date.now();
    const rec = attempts.get(key) || { count: 0, reset: now + 10 * 60_000 };
    if (now > rec.reset) Object.assign(rec, { count: 0, reset: now + 10 * 60_000 });
    if (rec.count >= 8) throw new HttpError(429, `Слишком много попыток входа. Повторите через ${Math.ceil((rec.reset - now) / 60_000)} мин.`);
    rec.count++;
    attempts.set(key, rec);
    req.rateKey = key;
  }

  // ---------- универсальный ресурс (аналог server/lib/resource.js) ----------

  function resource(def, { expand, beforeSave, afterChange, writeGuard = canEdit, deleteGuard = adminOnly } = {}) {
    const { table, entity, schema } = def;
    const getOne = (id) => viewOf(table, store.get(table, id));

    app.get(def.path, requireAuth, (req) => {
      const { page, limit, offset } = R.paging(req.query);
      const rows = select(viewAll(table), def, req.query);
      return { items: rows.slice(offset, offset + limit), total: rows.length, page, limit, pages: Math.max(1, Math.ceil(rows.length / limit)) };
    });

    if (def.csv) {
      app.get(def.path + '.csv', requireAuth, (req) => {
        const rows = select(viewAll(table), def, req.query).slice(0, 20000);
        return csvFile(toCsv(rows, def.csv), `orbita-${entity}-${nowIso().slice(0, 10)}.csv`);
      });
    }

    app.get(def.path + '/:id', requireAuth, (req) => {
      const row = getOne(parseId(req.params.id));
      if (!row) throw notFound();
      return expand ? expand(row, req) : row;
    });

    app.post(def.path, writeGuard, async (req) => {
      const values = validate(schema, req.body);
      def.check?.(values, null);
      if (beforeSave) await beforeSave(values, null, req);
      const row = store.insert(table, values);
      const full = getOne(row.id);
      audit(req, { action: 'create', entity, entityId: row.id, summary: def.title(full), details: values });
      afterChange?.('create', full, req);
      return created(full);
    });

    app.put(def.path + '/:id', writeGuard, async (req) => {
      const id = parseId(req.params.id);
      const values = validate(schema, req.body, { partial: true });
      const before = store.get(table, id);
      if (!before) throw notFound();
      if (req.body._version && before.updated_at && req.body._version !== before.updated_at) {
        throw new HttpError(409, 'Запись уже изменил другой пользователь. Обновите страницу и повторите правку.');
      }
      def.check?.(values, before);
      if (beforeSave) await beforeSave(values, before, req);
      const changes = diff(before, values);
      if (!Object.keys(changes).length) return getOne(id);
      store.update(table, before, Object.fromEntries(Object.keys(changes).map((c) => [c, values[c]])));
      const full = getOne(id);
      audit(req, { action: 'update', entity, entityId: id, summary: def.title(full), details: changes });
      afterChange?.('update', full, req);
      return full;
    });

    app.delete(def.path + '/:id', deleteGuard, (req) => {
      const id = parseId(req.params.id);
      const before = getOne(id);
      if (!before) throw notFound();
      store.remove(table, (r) => r.id === id);
      audit(req, { action: 'delete', entity, entityId: id, summary: def.title(before) });
      afterChange?.('delete', before, req);
      return noContent();
    });

    return { getOne };
  }

  // ---------- вход и сессии (server/routes/auth.js) ----------

  app.post('/api/auth/login', loginRateLimit, async (req) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!username || !password) throw badRequest('Введите логин и пароль');
    const user = all('users').find((u) => u.username === username);
    const ok = user ? await verifyPassword(password, user.password_hash) : false;
    if (!ok || !user.is_active) {
      audit(req, { action: 'login_failed', entity: 'user', summary: `Неудачный вход: ${username}` });
      throw new HttpError(401, user && ok && !user.is_active ? 'Учётная запись заблокирована. Обратитесь к администратору.' : 'Неверный логин или пароль');
    }
    attempts.delete(req.rateKey);
    const token = randomToken();
    store.insert('sessions', {
      id: await sha256(token),
      user_id: user.id,
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      user_agent: String(globalThis.navigator?.userAgent || '').slice(0, 300),
    });
    sessionToken.set(token);
    store.update('users', user, { last_login_at: nowIso() });
    req.user = { id: user.id, username: user.username };
    audit(req, { action: 'login', entity: 'user', entityId: user.id, summary: `Вход в систему: ${user.full_name}` });
    return { user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role } };
  });

  app.post('/api/auth/logout', async (req) => {
    if (req.user) audit(req, { action: 'logout', entity: 'user', entityId: req.user.id, summary: `Выход из системы: ${req.user.fullName}` });
    const token = sessionToken.get();
    if (token) {
      const id = await sessionId(token);
      store.remove('sessions', (s) => s.id === id);
    }
    sessionToken.set(null);
    return noContent();
  });

  app.get('/api/auth/me', (req) => ({ user: req.user ?? null }));

  app.post('/api/auth/password', requireAuth, async (req) => {
    const { current, next } = req.body;
    const user = store.get('users', req.user.id);
    if (!(await verifyPassword(String(current || ''), user.password_hash))) throw fieldError('current', 'Текущий пароль указан неверно');
    const weak = validatePasswordStrength(next);
    if (weak) throw fieldError('next', weak);
    if (current === next) throw fieldError('next', 'Новый пароль совпадает с текущим');
    store.update('users', user, { password_hash: await hashPassword(next) });
    store.remove('sessions', (s) => s.user_id === user.id && s.id !== req.sessionId);
    audit(req, { action: 'password_change', entity: 'user', entityId: user.id, summary: 'Пользователь сменил пароль' });
    return noContent();
  });

  // ---------- служебные маршруты (server/routes/system.js) ----------

  const startedAt = Date.now();
  app.get('/api/health', () => ({ status: 'ok', db: 'ok', version, uptimeSec: Math.round((Date.now() - startedAt) / 1000), simulation: true, streamClients: hub.size }));
  app.get('/api/meta', () => ({ ...D.allDictionaries(), demo: true, version }));
  app.get('/api/telemetry/live', requireAuth, () => ({ ts: Date.now(), items: engine.snapshot() }));
  app.get('/api/contacts', requireAuth, () => ({ items: engine.contacts }));

  app.get('/api/dashboard', requireAuth, () => {
    const status = (t) => countBy(all(t), 'status');
    const sc = idMap('spacecraft');
    const st = idMap('ground_stations');
    const crew = all('crew_members');
    const open = all('incidents').filter((i) => i.status !== 'resolved');
    const sevRank = { critical: 0, warning: 1 };
    return {
      fleet: status('spacecraft'),
      missions: status('missions'),
      crew: { in_flight: crew.filter((c) => c.status === 'in_flight').length, total: crew.length },
      stations: status('ground_stations'),
      incidents: countBy(open, 'severity'),
      nextLaunches: all('launches')
        .filter((l) => ['scheduled', 'go', 'hold'].includes(l.status))
        .sort((a, b) => (a.scheduled_at < b.scheduled_at ? -1 : 1))
        .slice(0, 4)
        .map((l) => ({ ...l, spacecraft_name: sc.get(l.spacecraft_id)?.name ?? null })),
      openIncidents: open
        .sort((a, b) => (sevRank[a.severity] ?? 2) - (sevRank[b.severity] ?? 2) || byDateDesc('created_at')(a, b))
        .slice(0, 8)
        .map((i) => ({ ...i, spacecraft_name: sc.get(i.spacecraft_id)?.name ?? null, station_name: st.get(i.station_id)?.name ?? null })),
      recentCommands: [...all('commands')]
        .sort(byDateDesc('created_at'))
        .slice(0, 8)
        .map((c) => ({ ...c, spacecraft_name: sc.get(c.spacecraft_id)?.name ?? null, station_name: st.get(c.station_id)?.name ?? null })),
      contacts: engine.contacts.filter((c) => (c.los ?? Infinity) > Date.now()).slice(0, 10),
      live: engine.summary(),
      serverTime: Date.now(),
    };
  });

  app.get('/api/search', requireAuth, (req) => {
    const q = String(req.query.q || '').trim().slice(0, 60).toLowerCase();
    if (q.length < 2) return { items: [] };
    const has = (...vals) => vals.some((v) => !isNull(v) && String(v).toLowerCase().includes(q));
    const take = (table, pred, map) => all(table).filter(pred).slice(0, 5).map(map);
    return {
      items: [
        ...take('spacecraft', (s) => has(s.name, s.code), (s) => ({ kind: 'spacecraft', id: s.id, title: s.name, subtitle: `${s.code} · ${s.type}` })),
        ...take('missions', (m) => has(m.name, m.code), (m) => ({ kind: 'mission', id: m.id, title: m.name, subtitle: m.code })),
        ...take('crew_members', (c) => has(c.full_name, c.call_sign), (c) => ({ kind: 'crew', id: c.id, title: c.full_name, subtitle: c.call_sign ? `«${c.call_sign}»` : '' })),
        ...take('ground_stations', (g) => has(g.name, g.code, g.country), (g) => ({ kind: 'station', id: g.id, title: g.name, subtitle: `${g.code}, ${g.country}` })),
        ...take('launches', (l) => has(l.name, l.vehicle), (l) => ({ kind: 'launch', id: l.id, title: l.name, subtitle: l.site })),
      ],
    };
  });

  // ---------- создание команды объявляется раньше ресурса /api/commands (как на сервере) ----------

  app.post('/api/commands', canEdit, async (req) => {
    const v = validate(R.COMMAND_CREATE, req.body);
    const def = D.COMMAND_TYPES[v.type];
    const params = R.commandParams(v.type, v.params);
    const sc = store.get('spacecraft', v.spacecraft_id);
    if (!sc) throw fieldError('spacecraft_id', 'КА не найден');
    if (!R.COMMANDABLE.includes(sc.status)) {
      throw fieldError('spacecraft_id', `КА «${sc.name}» в состоянии «${D.SPACECRAFT_STATUSES[sc.status]}» — управление невозможно`);
    }
    const queued = all('commands').filter((c) => c.spacecraft_id === sc.id && c.status === 'queued').length;
    if (queued >= R.MAX_QUEUED_PER_SPACECRAFT) throw new HttpError(429, `В очереди этого КА уже ${R.MAX_QUEUED_PER_SPACECRAFT} команд — дождитесь сеанса связи`);
    const r = store.insert('commands', {
      spacecraft_id: sc.id,
      type: v.type,
      params,
      issued_by: req.user.id,
      incident_id: v.incident_id ?? null,
      expires_at: new Date(Date.now() + Math.round(v.ttl_hours * 3600) * 1000).toISOString(),
    });
    audit(req, { action: 'command', entity: 'command', entityId: r.id, summary: `${def.label} → ${sc.name}`, details: params });
    const row = viewOf('commands', r);
    await engine.refreshQueue();
    hub.broadcast('command', { action: 'created', command: row });
    return created(row);
  });

  // ---------- справочники (server/routes/entities.js) ----------

  const fleetChanged = () => {
    engine.reloadFleet().then(() => hub.broadcast('fleet', { reason: 'edit' }));
  };

  resource(R.SPACECRAFT, {
    expand: (row) => {
      const st = idMap('ground_stations');
      const us = idMap('users');
      const missions = all('missions')
        .filter((m) => m.spacecraft_id === row.id)
        .sort(byDateDesc('start_date'))
        .map((m) => pick(m, ['id', 'code', 'name', 'status', 'priority', 'progress']));
      const incidents = all('incidents').filter((i) => i.spacecraft_id === row.id).sort(byDateDesc('created_at')).slice(0, 12);
      const commands = all('commands')
        .filter((c) => c.spacecraft_id === row.id)
        .sort(byDateDesc('created_at'))
        .slice(0, 15)
        .map((c) => ({ ...c, station_name: st.get(c.station_id)?.name ?? null, issued_by_name: us.get(c.issued_by)?.full_name ?? null }));
      const el = elementsFrom(row);
      return { ...row, orbit_class: orbitClass(row.perigee_km, row.apogee_km, row.inclination_deg), period_min: +periodMinutes(el.a).toFixed(2), missions, incidents, commands };
    },
    afterChange: fleetChanged,
  });

  app.get('/api/spacecraft/:id/telemetry', requireAuth, (req) => {
    const id = parseId(req.params.id);
    const { hours, bucket } = R.telemetryWindow(req.query);
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const groups = new Map();
    for (const r of store.telemetry.since(id, since)) {
      const t = Math.floor(Date.parse(r.ts) / 1000 / bucket) * bucket;
      let g = groups.get(t);
      if (!g) groups.set(t, (g = { n: 0, battery: 0, temperature: 0, power: 0, altitude: 0, signal: 0, signals: 0, sunlit: false, link: false }));
      g.n++;
      g.battery += r.battery;
      g.temperature += r.temperature;
      g.power += r.power_w;
      g.altitude += r.altitude_km;
      if (!isNull(r.signal_dbm)) {
        g.signal += r.signal_dbm;
        g.signals++;
      }
      g.sunlit ||= r.sunlit;
      g.link ||= !isNull(r.station_id);
    }
    const points = [...groups]
      .sort((a, b) => a[0] - b[0])
      .map(([t, g]) => ({
        t: new Date(t * 1000).toISOString(),
        battery: round(g.battery / g.n, 2),
        temperature: round(g.temperature / g.n, 2),
        power: round(g.power / g.n, 1),
        signal: g.signals ? round(g.signal / g.signals, 1) : null,
        altitude: round(g.altitude / g.n, 1),
        sunlit: g.sunlit,
        link: g.link,
      }));
    return { hours, bucketSec: bucket, points };
  });

  app.get('/api/spacecraft/:id/passes', requireAuth, (req) => {
    const id = parseId(req.params.id);
    const hours = Math.min(48, Math.max(1, Number(req.query.hours) || 24));
    return { hours, items: engine.passesFor(id, hours) };
  });

  resource(R.STATIONS, { afterChange: fleetChanged });

  app.get('/api/stations/:id/schedule', requireAuth, (req) => {
    const id = parseId(req.params.id);
    const hours = Math.min(48, Math.max(1, Number(req.query.hours) || 12));
    return { hours, items: engine.scheduleFor(id, hours) };
  });

  const ROLE_RANK = ['commander', 'flight_engineer', 'mission_specialist', 'payload_specialist', 'backup'];
  resource(R.MISSIONS, {
    expand: (row) => {
      const people = idMap('crew_members');
      const crew = all('mission_crew')
        .filter((mc) => mc.mission_id === row.id && people.has(mc.crew_id))
        .map((mc) => ({ ...pick(people.get(mc.crew_id), ['id', 'full_name', 'call_sign', 'status']), role: mc.role, assigned_at: mc.assigned_at }))
        .sort((a, b) => ROLE_RANK.indexOf(a.role) - ROLE_RANK.indexOf(b.role) || collator.compare(a.full_name, b.full_name));
      const launches = all('launches')
        .filter((l) => l.mission_id === row.id)
        .sort((a, b) => (a.scheduled_at < b.scheduled_at ? -1 : a.scheduled_at > b.scheduled_at ? 1 : 0));
      return { ...row, crew, launches };
    },
  });

  app.post('/api/missions/:id/crew', canEdit, (req) => {
    const missionId = parseId(req.params.id);
    const v = validate(R.MISSION_CREW, req.body);
    const mission = store.get('missions', missionId);
    if (!mission) throw notFound('Миссия не найдена');
    const crew = store.get('crew_members', v.crew_id);
    if (!crew) throw fieldError('crew_id', 'Член экипажа не найден');
    if (crew.status === 'retired') throw fieldError('crew_id', 'Нельзя назначить космонавта, завершившего карьеру');
    const links = all('mission_crew').filter((mc) => mc.mission_id === missionId);
    if (v.role === 'commander' && links.some((mc) => mc.role === 'commander' && mc.crew_id !== v.crew_id)) throw fieldError('role', 'У миссии уже есть командир');
    const existing = links.find((mc) => mc.crew_id === v.crew_id);
    if (existing) store.update('mission_crew', existing, { role: v.role });
    else store.insert('mission_crew', { mission_id: missionId, crew_id: v.crew_id, role: v.role });
    audit(req, { action: 'assign', entity: 'mission', entityId: missionId, summary: `${crew.full_name} назначен(а) в миссию ${mission.code}: ${D.CREW_ROLES[v.role]}` });
    return created({ ok: true });
  });

  app.delete('/api/missions/:id/crew/:crewId', canEdit, (req) => {
    const missionId = parseId(req.params.id);
    const crewId = parseId(req.params.crewId);
    const link = all('mission_crew').find((mc) => mc.mission_id === missionId && mc.crew_id === crewId);
    const crew = store.get('crew_members', crewId);
    const mission = store.get('missions', missionId);
    if (!link || !crew || !mission) throw notFound('Назначение не найдено');
    store.remove('mission_crew', (mc) => mc === link);
    audit(req, { action: 'unassign', entity: 'mission', entityId: missionId, summary: `${crew.full_name} снят(а) с миссии ${mission.code}` });
    return noContent();
  });

  resource(R.CREW, {
    expand: (row) => {
      const ms = idMap('missions');
      const assignments = all('mission_crew')
        .filter((mc) => mc.crew_id === row.id && ms.has(mc.mission_id))
        .map((mc) => ({ ...pick(ms.get(mc.mission_id), ['id', 'code', 'name', 'status', 'start_date']), role: mc.role }))
        .sort(byDateDesc('start_date'))
        .map(({ start_date, ...a }) => a);
      return { ...row, assignments };
    },
  });

  resource(R.LAUNCHES, {
    beforeSave: (v, before) => {
      const scId = R.LAUNCHES.payloadId(v, before);
      if (scId) R.LAUNCHES.checkPayload(v, before, store.get('spacecraft', scId));
    },
    afterChange: (_, row) => hub.broadcast('launch', { action: 'updated', launch: row }),
  });

  // ---------- инциденты и командная очередь (server/routes/ops.js) ----------

  resource(R.INCIDENTS, {
    beforeSave: (v, before, req) => {
      if (!before) {
        v.created_by = req.user.id;
        v.source = 'manual';
      }
    },
    afterChange: (action, row) => hub.broadcast('incident', { action: action === 'create' ? 'created' : 'updated', incident: row }),
  });

  app.post('/api/incidents/:id/ack', canEdit, (req) => {
    const id = parseId(req.params.id);
    const inc = store.get('incidents', id);
    if (!inc || inc.status !== 'open') throw new HttpError(409, 'Инцидент уже принят в работу или закрыт');
    store.update('incidents', inc, { status: 'acknowledged', acknowledged_by: req.user.id, acknowledged_at: nowIso() });
    audit(req, { action: 'acknowledge', entity: 'incident', entityId: id, summary: inc.title });
    const row = viewOf('incidents', inc);
    hub.broadcast('incident', { action: 'updated', incident: row });
    return row;
  });

  app.post('/api/incidents/:id/resolve', canEdit, (req) => {
    const id = parseId(req.params.id);
    const { resolution } = validate(R.INCIDENT_RESOLVE, req.body);
    const inc = store.get('incidents', id);
    if (!inc || inc.status === 'resolved') throw new HttpError(409, 'Инцидент уже закрыт');
    const now = nowIso();
    store.update('incidents', inc, {
      status: 'resolved',
      resolved_by: req.user.id,
      resolved_at: now,
      resolution,
      acknowledged_by: inc.acknowledged_by ?? req.user.id,
      acknowledged_at: inc.acknowledged_at ?? now,
    });
    audit(req, { action: 'resolve', entity: 'incident', entityId: id, summary: inc.title, details: { resolution } });
    const row = viewOf('incidents', inc);
    if (row.kind && row.spacecraft_id) engine.clearFault(row.spacecraft_id, row.kind);
    hub.broadcast('incident', { action: 'updated', incident: row });
    return row;
  });

  resource(R.COMMANDS, {
    writeGuard: () => {
      throw new HttpError(405, 'Команды не редактируются: создайте новую или отмените команду в очереди');
    },
    deleteGuard: () => {
      throw new HttpError(405, 'Журнал команд не удаляется');
    },
  });

  app.post('/api/commands/:id/cancel', canEdit, async (req) => {
    const id = parseId(req.params.id);
    const cmd = store.get('commands', id);
    if (!cmd || cmd.status !== 'queued') throw new HttpError(409, 'Отменить можно только команду в очереди');
    store.update('commands', cmd, { status: 'cancelled', completed_at: nowIso(), result: `Отменена оператором: ${req.user.fullName}` });
    audit(req, { action: 'cancel', entity: 'command', entityId: id, summary: `${D.COMMAND_TYPES[cmd.type]?.label ?? cmd.type} — отменена` });
    const row = viewOf('commands', cmd);
    await engine.refreshQueue();
    hub.broadcast('command', { action: 'updated', command: row });
    return row;
  });

  // ---------- отчёты (server/routes/reports.js) ----------

  app.get('/api/reports/summary', requireAuth, (req) => {
    const { from, to } = R.reportRange(req.query);
    const between = (v) => !isNull(v) && v >= from && v <= to;
    const incidents = all('incidents');
    const commands = all('commands');
    const sc = idMap('spacecraft');
    const periodInc = incidents.filter((i) => between(i.created_at));
    const periodCmd = commands.filter((c) => between(c.created_at));

    const DAY = 86_400_000;
    const first = Math.floor(Date.parse(from) / DAY) * DAY;
    const last = Math.floor(Date.parse(to) / DAY) * DAY;
    const days = [];
    for (let d = first; d <= last; d += DAY) days.push({ day: new Date(d).toISOString().slice(0, 10), info: 0, warning: 0, critical: 0 });
    for (const i of incidents) {
      const t = Date.parse(i.created_at);
      if (t >= first && t < last + DAY) days[Math.floor((t - first) / DAY)][i.severity]++;
    }

    const perSc = new Map();
    for (const i of periodInc) {
      const s = sc.get(i.spacecraft_id);
      if (!s) continue;
      const rec = perSc.get(s.id) || { id: s.id, name: s.name, color: s.color, n: 0, critical: 0 };
      rec.n++;
      if (i.severity === 'critical') rec.critical++;
      perSc.set(s.id, rec);
    }

    const mttr = [];
    const resolved = periodInc.filter((i) => i.resolved_at);
    for (const severity of [...new Set(resolved.map((i) => i.severity))]) {
      const list = resolved.filter((i) => i.severity === severity);
      const acked = list.filter((i) => i.acknowledged_at);
      const avgMin = (rows, field) => (rows.length ? Math.round(rows.reduce((a, i) => a + (Date.parse(i[field]) - Date.parse(i.created_at)), 0) / rows.length / 60_000) : null);
      mttr.push({ severity, n: list.length, mttr_min: avgMin(list, 'resolved_at'), mtta_min: avgMin(acked, 'acknowledged_at') });
    }

    const groupCount = (rows, key, extra) => {
      const m = new Map();
      for (const r of rows) {
        const rec = m.get(r[key]) || { [key]: r[key], n: 0, ...(extra ? extra.init() : {}) };
        rec.n++;
        extra?.add(rec, r);
        m.set(r[key], rec);
      }
      return [...m.values()].sort((a, b) => b.n - a.n);
    };

    const byType = {};
    const byStatus = {};
    const byOrbit = {};
    for (const s of all('spacecraft')) {
      byType[s.type] = (byType[s.type] || 0) + 1;
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
      if (s.status !== 'planned' && s.status !== 'lost') {
        const c = orbitClass(s.perigee_km, s.apogee_km, s.inclination_deg);
        byOrbit[c] = (byOrbit[c] || 0) + 1;
      }
    }

    const forecast = {};
    for (const c of engine.forecastContacts(Date.now(), 24)) forecast[c.stationId] = (forecast[c.stationId] || 0) + 1;
    const uplinks = countBy(commands.filter((c) => between(c.uplinked_at)), 'station_id');

    const executed = periodCmd.filter((c) => c.status === 'executed').length;
    const finished = periodCmd.filter((c) => c.status === 'executed' || c.status === 'failed').length;
    const totals = {
      incidents: periodInc.length,
      critical: periodInc.filter((i) => i.severity === 'critical').length,
      commands: periodCmd.length,
      executed,
      finished,
      launches: all('launches').filter((l) => l.status === 'success' && between(l.scheduled_at)).length,
    };

    return {
      from,
      to,
      totals: { ...totals, successRate: finished ? Math.round((executed / finished) * 1000) / 10 : null },
      incidentsByDay: days,
      incidentsBySpacecraft: [...perSc.values()].sort((a, b) => b.n - a.n || collator.compare(a.name, b.name)).slice(0, 10),
      mttr,
      commandsByStatus: groupCount(periodCmd, 'status'),
      commandsByType: groupCount(periodCmd, 'type', { init: () => ({ failed: 0 }), add: (rec, c) => c.status === 'failed' && rec.failed++ }),
      fleet: { byType, byStatus, byOrbit },
      missions: groupCount(all('missions'), 'status', { init: () => ({ budget: 0 }), add: (rec, m) => (rec.budget += Number(m.budget_mln || 0)) }),
      stations: all('ground_stations')
        .map((g) => ({ id: g.id, name: g.name, code: g.code, n: uplinks[g.id] || 0 }))
        .sort((a, b) => b.n - a.n || collator.compare(a.name, b.name))
        .map((s) => ({ ...s, forecast24h: forecast[s.id] || 0 })),
    };
  });

  // ---------- администрирование (server/routes/admin.js) ----------

  const USER_FIELDS = ['id', 'username', 'full_name', 'role', 'is_active', 'last_login_at', 'created_at', 'updated_at'];
  const userOut = (u) => pick(u, USER_FIELDS);

  app.get('/api/users', adminOnly, () => {
    const now = nowIso();
    const sessions = countBy(all('sessions').filter((s) => s.expires_at > now), 'user_id');
    return {
      items: [...all('users')]
        .sort((a, b) => Number(b.is_active) - Number(a.is_active) || R.ROLE_ORDER.indexOf(a.role) - R.ROLE_ORDER.indexOf(b.role) || compareValues(a.username, b.username))
        .map((u) => ({ ...userOut(u), sessions: sessions[u.id] || 0 })),
    };
  });

  app.post('/api/users', adminOnly, async (req) => {
    const v = validate(R.USER_CREATE, { ...req.body, username: String(req.body.username || '').toLowerCase() });
    const weak = validatePasswordStrength(v.password);
    if (weak) throw fieldError('password', weak);
    const r = store.insert('users', { username: v.username, full_name: v.full_name, role: v.role, password_hash: await hashPassword(v.password) });
    audit(req, { action: 'create', entity: 'user', entityId: r.id, summary: `${r.full_name} (${r.username}), роль: ${D.ROLES[r.role]}` });
    return created(userOut(r));
  });

  app.put('/api/users/:id', adminOnly, (req) => {
    const id = parseId(req.params.id);
    const v = validate(R.USER_UPDATE, req.body, { partial: true });
    if (id === req.user.id && v.role && v.role !== 'admin') throw fieldError('role', 'Нельзя снять с себя роль администратора');
    if (id === req.user.id && v.is_active === false) throw fieldError('is_active', 'Нельзя заблокировать собственную учётную запись');
    const user = store.get('users', id);
    if (!user) throw notFound('Пользователь не найден');
    const before = userOut(user);
    const changes = diff(before, v);
    if (!Object.keys(changes).length) return before;
    store.update('users', user, Object.fromEntries(Object.keys(changes).map((c) => [c, v[c]])));
    if (v.is_active === false || (v.role && v.role !== before.role)) store.remove('sessions', (s) => s.user_id === id);
    audit(req, { action: 'update', entity: 'user', entityId: id, summary: `${user.full_name} (${user.username})`, details: changes });
    if (v.is_active === false || v.role) hub.disconnectUser(id);
    return userOut(user);
  });

  app.post('/api/users/:id/password', adminOnly, async (req) => {
    const id = parseId(req.params.id);
    const weak = validatePasswordStrength(req.body.password);
    if (weak) throw fieldError('password', weak);
    const user = store.get('users', id);
    if (!user) throw notFound('Пользователь не найден');
    store.update('users', user, { password_hash: await hashPassword(req.body.password) });
    store.remove('sessions', (s) => s.user_id === id);
    audit(req, { action: 'password_reset', entity: 'user', entityId: id, summary: `Пароль сброшен: ${user.full_name} (${user.username})` });
    hub.disconnectUser(id);
    return noContent();
  });

  app.delete('/api/users/:id', adminOnly, (req) => {
    const id = parseId(req.params.id);
    if (id === req.user.id) throw new HttpError(409, 'Нельзя удалить собственную учётную запись');
    const user = store.get('users', id);
    if (!user) throw notFound('Пользователь не найден');
    store.remove('users', (u) => u.id === id);
    audit(req, { action: 'delete', entity: 'user', entityId: id, summary: `${user.full_name} (${user.username})` });
    hub.disconnectUser(id);
    return noContent();
  });

  app.get('/api/audit', adminOnly, (req) => {
    const { page, limit, offset } = R.paging(req.query, { max: 200, def: 50 });
    const rows = select(all('audit_log'), R.AUDIT, req.query);
    return { items: rows.slice(offset, offset + limit), total: rows.length, page, limit, pages: Math.max(1, Math.ceil(rows.length / limit)) };
  });

  app.get('/api/audit.csv', adminOnly, (req) => {
    const rows = all('audit_log').filter(where(R.AUDIT, req.query)).sort(byDateDesc('ts')).slice(0, 50000);
    return csvFile(toCsv(rows, R.AUDIT.csv), `orbita-audit-${nowIso().slice(0, 10)}.csv`);
  });

  // ---------- обработка запроса ----------

  function translate(err) {
    if (err instanceof ConstraintError) {
      if (err.code === '23505') return new HttpError(409, 'Такая запись уже существует', { constraint: err.constraint });
      if (err.code === '23503') return new HttpError(409, 'Запись связана с другими данными или ссылается на несуществующую запись', { constraint: err.constraint });
    }
    return err;
  }

  /** Обработать запрос; возвращает Reply { status, data, headers }. */
  async function handle(method, url, body) {
    const u = new URL(url, 'http://orbita.demo');
    const req = { method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: body ?? {}, params: {}, user: null };
    try {
      await loadSession(req);
      let pathMatched = false;
      for (const route of routes) {
        const m = route.regex.exec(req.path);
        if (!m) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        route.keys.forEach((k, i) => (req.params[k] = m[i + 1]));
        let result;
        for (const fn of route.handlers) result = await fn(req);
        return result instanceof Reply ? result : result === undefined ? noContent() : new Reply(200, result);
      }
      throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Метод не поддерживается' : 'Ресурс не найден');
    } catch (raw) {
      const err = translate(raw);
      if (!(err instanceof HttpError)) {
        console.error(`ОРБИТА демо: ${method} ${req.path}`, raw);
        return new Reply(500, { error: 'Внутренняя ошибка сервера' });
      }
      return new Reply(err.status, err.details ? { error: err.message, details: err.details } : { error: err.message });
    }
  }

  return { handle };
}
