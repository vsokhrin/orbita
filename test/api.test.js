// Интеграционные тесты: настоящий HTTP-сервер + PostgreSQL + движок симуляции.
// Нужна тестовая БД: TEST_DATABASE_URL (по умолчанию postgres://orbita:orbita@127.0.0.1:5432/orbita_test).
// Схема public в этой БД пересоздаётся — не указывайте рабочую базу!
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from '../server/db/pg.js';
import { migrate } from '../server/db/migrate.js';
import { seed } from '../server/db/seed.js';
import { buildServer } from '../server/index.js';

const URL = process.env.TEST_DATABASE_URL || 'postgres://orbita:orbita@127.0.0.1:5432/orbita_test';
let db;
let server;
let engine;
let base;
let skip = false;

before(async () => {
  db = new Pool({ connectionString: URL, max: 6 });
  try {
    await db.query('SELECT 1');
  } catch (err) {
    skip = `нет тестовой БД (${err.message})`;
    return;
  }
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');
  await migrate(db);
  await seed(db, { adminPassword: 'admin2026', demoUsers: true });
  ({ server, engine } = await buildServer({ db, withEngine: false }));
  await engine.loadStates();
  await engine.refreshQueue();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await db?.end();
});

function client() {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, headers: res.headers, text };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b, h) => call('POST', p, b, h),
    put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
    login: (u, pw) => call('POST', '/api/auth/login', { username: u, password: pw }),
    cookie: () => cookie,
  };
}

const t = (name, fn) => test(name, async (ctx) => (skip ? ctx.skip(skip) : fn(ctx)));
const deterministic = async (fn) => {
  const r = Math.random;
  Math.random = () => 0.5;
  try {
    return await fn();
  } finally {
    Math.random = r;
  }
};

t('health и справочники доступны без входа', async () => {
  const c = client();
  assert.equal((await c.get('/api/health')).data.status, 'ok');
  const meta = await c.get('/api/meta');
  assert.ok(meta.data.commandTypes.ORBIT_CORRECTION);
  assert.equal((await c.get('/api/auth/me')).data.user, null);
});

t('без входа данные закрыты', async () => {
  const c = client();
  for (const p of ['/api/dashboard', '/api/spacecraft', '/api/stream', '/api/users']) assert.equal((await c.get(p)).status, 401, p);
});

t('вход: неверный пароль, успешный вход, выход', async () => {
  const c = client();
  assert.equal((await c.login('admin', 'nope')).status, 401);
  const ok = await c.login('admin', 'admin2026');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, 'admin');
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await c.get('/api/auth/me')).data.user.username, 'admin');
  assert.equal((await c.post('/api/auth/logout')).status, 204);
  assert.equal((await c.get('/api/auth/me')).data.user, null);
});

t('права ролей: наблюдатель читает, оператор правит, удаляет только администратор', async () => {
  const obs = client();
  await obs.login('observer', 'observer2026');
  assert.equal((await obs.get('/api/spacecraft')).status, 200);
  assert.equal((await obs.post('/api/missions', { code: 'X-1', name: 'Проверка', status: 'planning' })).status, 403);
  assert.equal((await obs.get('/api/audit')).status, 403);

  const op = client();
  await op.login('operator', 'operator2026');
  const created = await op.post('/api/missions', { code: 'test-1', name: 'Тестовая миссия', status: 'planning' });
  assert.equal(created.status, 201);
  assert.equal(created.data.code, 'TEST-1');
  assert.equal((await op.del(`/api/missions/${created.data.id}`)).status, 403);

  const adm = client();
  await adm.login('admin', 'admin2026');
  assert.equal((await adm.del(`/api/missions/${created.data.id}`)).status, 204);
  const audit = await adm.get('/api/audit?entity=mission&limit=5');
  assert.deepEqual(audit.data.items.slice(0, 2).map((a) => a.action), ['delete', 'create']);
});

t('валидация, уникальность и оптимистичная блокировка', async () => {
  const c = client();
  await c.login('operator', 'operator2026');
  const bad = await c.post('/api/spacecraft', { code: 'X', name: '', type: 'nope', status: 'active', operator: 'Т', perigee_km: 50, apogee_km: 10, inclination_deg: 200 });
  assert.equal(bad.status, 422);
  for (const f of ['name', 'type', 'perigee_km', 'apogee_km', 'inclination_deg']) assert.ok(bad.data.details.fields[f], f);

  const ok = await c.post('/api/spacecraft', { code: 'T-100', name: 'Тестовый', type: 'technology', status: 'planned', operator: 'Тест', perigee_km: 500, apogee_km: 510, inclination_deg: 97.5 });
  assert.equal(ok.status, 201);
  assert.equal((await c.post('/api/spacecraft', { code: 't-100', name: 'Дубль', type: 'technology', status: 'planned', operator: 'Тест', perigee_km: 500, apogee_km: 510, inclination_deg: 97.5 })).status, 409);
  assert.equal((await c.put(`/api/spacecraft/${ok.data.id}`, { apogee_km: 300 })).status, 422);

  const v1 = await c.put(`/api/spacecraft/${ok.data.id}`, { name: 'Тестовый-2', _version: ok.data.updated_at });
  assert.equal(v1.status, 200);
  const stale = await c.put(`/api/spacecraft/${ok.data.id}`, { name: 'Тестовый-3', _version: ok.data.updated_at });
  assert.equal(stale.status, 409);
});

t('список: поиск, фильтры, сортировка, пагинация, CSV', async () => {
  const c = client();
  await c.login('observer', 'observer2026');
  const r = await c.get('/api/spacecraft?status=active,standby&sort=name&dir=asc&limit=3&page=2');
  assert.equal(r.data.limit, 3);
  assert.equal(r.data.page, 2);
  assert.ok(r.data.items.every((s) => ['active', 'standby'].includes(s.status)));
  const names = r.data.items.map((s) => s.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'ru')));
  const s = await c.get('/api/spacecraft?q=' + encodeURIComponent('сокол'));
  assert.ok(s.data.items.length >= 3 && s.data.items.every((i) => /сокол/i.test(i.name)));
  const csv = await c.get('/api/crew.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.text.startsWith('ФИО;'), 'заголовок CSV'); // TextDecoder снимает BOM
  const raw = Buffer.from(await (await fetch(base + '/api/crew.csv', { headers: { cookie: c.cookie() } })).arrayBuffer());
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM для Excel');
});

t('экипаж миссии: назначение и единственный командир', async () => {
  const c = client();
  await c.login('operator', 'operator2026');
  const crew = (await c.get('/api/crew?status=training')).data.items[0];
  const mission = (await c.get('/api/missions?q=EXP-14')).data.items[0];
  assert.equal((await c.post(`/api/missions/${mission.id}/crew`, { crew_id: crew.id, role: 'commander' })).status, 422);
  assert.equal((await c.post(`/api/missions/${mission.id}/crew`, { crew_id: crew.id, role: 'mission_specialist' })).status, 201);
  const detail = await c.get(`/api/missions/${mission.id}`);
  assert.ok(detail.data.crew.some((m) => m.id === crew.id));
  assert.equal((await c.del(`/api/missions/${mission.id}/crew/${crew.id}`)).status, 204);
});

t('команда на геостационар уходит в сеансе и исполняется', async () => {
  const c = client();
  await c.login('operator', 'operator2026');
  const sc = (await c.get('/api/spacecraft?q=LG-5')).data.items[0];
  const cmd = await c.post('/api/commands', { spacecraft_id: sc.id, type: 'PING' });
  assert.equal(cmd.status, 201);
  assert.equal(cmd.data.status, 'queued');
  engine.tick(); // геостационар всегда в зоне станции — команда уходит на борт
  let row;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    row = await db.one('SELECT * FROM commands WHERE id = $1', [cmd.data.id]);
    if (['executed', 'failed'].includes(row.status)) break;
  }
  assert.equal(row.status, 'executed', row.result);
  assert.ok(row.station_id);
  assert.match(row.result, /Квитанция получена/);
});

t('команда-устранение закрывает инцидент', async () => {
  const sc = engine.fleet.get((await db.one(`SELECT id FROM spacecraft WHERE code = 'SK-2'`)).id);
  assert.ok(engine.states.get(sc.id).faults.has('seu'), 'неисправность из сидов загружена');
  const cmd = await db.one(`INSERT INTO commands (spacecraft_id, type, status, expires_at) VALUES ($1, 'REBOOT_OBC', 'uplinked', now() + interval '1 hour') RETURNING *`, [sc.id]);
  await deterministic(() => engine.execute(sc, cmd, { stationId: 1, elevation: 30, range: 1500 }));
  const inc = await db.one(`SELECT * FROM incidents WHERE spacecraft_id = $1 AND kind = 'seu' ORDER BY id DESC LIMIT 1`, [sc.id]);
  assert.equal(inc.status, 'resolved');
  assert.match(inc.resolution, /Перезагрузка БКУ/);
  assert.equal(engine.states.get(sc.id).faults.has('seu'), false);
});

t('коррекция орбиты меняет элементы и расходует топливо', async () => {
  const before = await db.one(`SELECT * FROM spacecraft WHERE code = 'AT-1'`);
  await db.query('UPDATE spacecraft SET fuel_kg = 500 WHERE id = $1', [before.id]);
  await engine.reloadFleet();
  const sc = engine.fleet.get(before.id);
  const cmd = await db.one(`INSERT INTO commands (spacecraft_id, type, params, status, expires_at) VALUES ($1, 'ORBIT_CORRECTION', '{"delta_km": 10}', 'uplinked', now() + interval '1 hour') RETURNING *`, [sc.id]);
  await deterministic(() => engine.execute(sc, cmd, { stationId: 1, elevation: 30, range: 1500 }));
  const after = await db.one('SELECT * FROM spacecraft WHERE id = $1', [sc.id]);
  assert.equal(Number(after.perigee_km), Number(before.perigee_km) + 10);
  assert.ok(Number(after.fuel_kg) < 500);
  assert.equal((await db.one('SELECT status FROM commands WHERE id = $1', [cmd.id])).status, 'executed');
});

t('критический разряд АКБ переводит аппарат в безопасный режим', async () => {
  const id = (await db.one(`SELECT id FROM spacecraft WHERE code = 'PL-7'`)).id;
  const sc = engine.fleet.get(id);
  const st = engine.states.get(id);
  st.battery = 5;
  engine.checkThresholds(sc, st);
  await Promise.all([...engine.pendingOps]);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(st.mode, 'safe');
  assert.equal((await db.one('SELECT status FROM spacecraft WHERE id = $1', [id])).status, 'safe_mode');
  const inc = await db.one(`SELECT * FROM incidents WHERE spacecraft_id = $1 AND kind = 'battery_critical' AND status = 'open'`, [id]);
  assert.equal(inc.severity, 'critical');
});

t('запуск по расписанию выводит аппарат на орбиту', async () => {
  const sc = await db.one(`SELECT * FROM spacecraft WHERE code = 'PI-L'`);
  assert.equal(sc.status, 'planned');
  const l = await db.one(
    `INSERT INTO launches (name, vehicle, site, scheduled_at, status, spacecraft_id) VALUES ('Тест / «Пионер-Л»', 'Тест', 'Байконур', now() - interval '1 minute', 'go', $1) RETURNING *`,
    [sc.id],
  );
  await engine.processLaunches();
  assert.equal((await db.one('SELECT status FROM launches WHERE id = $1', [l.id])).status, 'success');
  assert.equal((await db.one('SELECT status FROM spacecraft WHERE id = $1', [sc.id])).status, 'active');
  assert.ok(engine.fleet.get(sc.id).simulated);
});

t('инцидент: регистрация, приём в работу, закрытие', async () => {
  const c = client();
  await c.login('operator', 'operator2026');
  const inc = await c.post('/api/incidents', { severity: 'warning', title: 'Проверка ручного инцидента', station_id: 1 });
  assert.equal(inc.status, 201);
  assert.equal(inc.data.source, 'manual');
  assert.equal((await c.post(`/api/incidents/${inc.data.id}/ack`)).data.status, 'acknowledged');
  assert.equal((await c.post(`/api/incidents/${inc.data.id}/resolve`, {})).status, 422);
  const res = await c.post(`/api/incidents/${inc.data.id}/resolve`, { resolution: 'Проверено' });
  assert.equal(res.data.status, 'resolved');
  assert.equal((await c.post(`/api/incidents/${inc.data.id}/resolve`, { resolution: 'Повторно' })).status, 409);
});

t('защита от CSRF: запрос с чужого Origin отклоняется', async () => {
  const c = client();
  await c.login('operator', 'operator2026');
  const r = await c.post('/api/incidents', { severity: 'info', title: 'Чужой сайт' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

t('пользователи: слабый пароль, блокировка завершает сессии', async () => {
  const adm = client();
  await adm.login('admin', 'admin2026');
  assert.equal((await adm.post('/api/users', { username: 'tester', full_name: 'Тест', role: 'observer', password: 'short' })).status, 422);
  const u = await adm.post('/api/users', { username: 'tester', full_name: 'Тест Тестов', role: 'observer', password: 'secret123' });
  assert.equal(u.status, 201);
  const usr = client();
  assert.equal((await usr.login('tester', 'secret123')).status, 200);
  assert.equal((await adm.put(`/api/users/${u.data.id}`, { is_active: false })).status, 200);
  assert.equal((await usr.get('/api/spacecraft')).status, 401);
  assert.equal((await client().login('tester', 'secret123')).status, 401);
  assert.equal((await adm.put(`/api/users/1`, { is_active: false })).status, 422);
});

t('смена собственного пароля', async () => {
  const c = client();
  await c.login('observer', 'observer2026');
  assert.equal((await c.post('/api/auth/password', { current: 'wrong', next: 'newpass123' })).status, 422);
  assert.equal((await c.post('/api/auth/password', { current: 'observer2026', next: 'newpass123' })).status, 204);
  assert.equal((await client().login('observer', 'newpass123')).status, 200);
});

t('сводка ЦУП и отчёт за период', async () => {
  const c = client();
  await c.login('observer', 'newpass123');
  const d = await c.get('/api/dashboard');
  assert.ok(d.data.fleet.active > 0);
  assert.ok(Array.isArray(d.data.nextLaunches));
  const r = await c.get('/api/reports/summary');
  assert.equal(r.data.incidentsByDay.length, 31);
  assert.ok(r.data.totals.incidents > 0);
  assert.ok(Object.keys(r.data.fleet.byOrbit).includes('GEO'));
  const passes = await c.get(`/api/spacecraft/1/passes?hours=12`);
  assert.ok(passes.data.items.length > 0);
  const tel = await c.get(`/api/spacecraft/1/telemetry?hours=6`);
  assert.ok(tel.data.points.length > 100);
});
