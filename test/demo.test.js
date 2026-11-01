// Тесты демо-версии для GitHub Pages: «сервер» ЦУП в браузере (demo/) работает в Node.js
// без базы данных. localStorage подменяется хранилищем в памяти.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  #m = new Map();
  getItem(k) {
    return this.#m.has(k) ? this.#m.get(k) : null;
  }
  setItem(k, v) {
    this.#m.set(k, String(v));
  }
  removeItem(k) {
    this.#m.delete(k);
  }
  keys() {
    return [...this.#m.keys()];
  }
}
const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });

const { createBackend } = await import('../demo/backend.js');
const { Store } = await import('../demo/store.js');
const quiet = { info() {}, warn() {}, error: console.error };

let demo;
before(async () => {
  demo = await createBackend({ run: false, logger: quiet, version: 'test' });
});

const call = (method, path, body) => demo.request(method, path, body);
const login = (username, password) => call('POST', '/api/auth/login', { username, password });
const deterministic = async (fn) => {
  const r = Math.random;
  Math.random = () => 0.5;
  try {
    return await fn();
  } finally {
    Math.random = r;
  }
};

test('демо: вход, сессия и права ролей', async () => {
  assert.equal((await call('GET', '/api/spacecraft')).status, 401);
  assert.equal((await login('admin', 'wrong-pass1')).status, 401);
  const me0 = await call('GET', '/api/auth/me');
  assert.deepEqual(me0.data, { user: null });

  const r = await login('observer', 'observer2026');
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'observer');
  assert.ok(storage.getItem('orbita-demo:v1:session'), 'токен сессии сохранён');
  assert.equal((await call('GET', '/api/spacecraft')).data.total, 15);
  assert.equal((await call('POST', '/api/incidents', { severity: 'info', title: 'нельзя' })).status, 403);
  assert.equal((await call('GET', '/api/users')).status, 403);
  assert.equal((await call('POST', '/api/auth/logout')).status, 204);
  assert.equal((await call('GET', '/api/auth/me')).data.user, null);

  assert.equal((await login('admin', 'admin2026')).status, 200);
  const users = await call('GET', '/api/users');
  assert.equal(users.data.items.length, 4);
  assert.ok(users.data.items.every((u) => !('password_hash' in u)), 'хэши паролей не отдаются');
});

test('демо: списки — поиск, фильтры, сортировка, пагинация как на сервере', async () => {
  const r = await call('GET', '/api/spacecraft?status=active,standby&sort=name&dir=asc&limit=3&page=2');
  assert.equal(r.status, 200);
  assert.equal(r.data.page, 2);
  assert.equal(r.data.items.length, 3);
  const names = r.data.items.map((s) => s.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'ru')));

  const missions = await call('GET', '/api/missions?limit=50');
  const order = ['active', 'preparation', 'planning', 'completed', 'aborted'];
  const ranks = missions.data.items.map((m) => order.indexOf(m.status));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'миссии по умолчанию: сначала активные');

  const crew = await call('GET', '/api/crew?q=ОВ');
  assert.ok(crew.data.items.length > 0 && crew.data.items.every((c) => /ов/i.test(c.full_name + c.call_sign + c.nationality + c.bio)));

  const inc = await call('GET', '/api/incidents?status=open&severity=critical');
  assert.ok(inc.data.items.every((i) => i.status === 'open' && i.severity === 'critical'));

  const sc = await call('GET', '/api/spacecraft/1');
  assert.equal(sc.data.code, 'KV-1');
  assert.ok(sc.data.period_min > 90 && sc.data.period_min < 94);
  assert.ok(Array.isArray(sc.data.missions) && Array.isArray(sc.data.commands));

  const tm = await call('GET', '/api/spacecraft/1/telemetry?hours=6');
  assert.ok(tm.data.points.length > 300, 'история телеметрии за 6 часов');
  assert.ok(tm.data.points.every((p) => p.battery >= 0 && p.battery <= 100));
});

test('демо: проверки данных и ограничения целостности', async () => {
  const sc = { code: 'TST-1', name: 'Тестовый', type: 'science', status: 'active', operator: 'Тест', perigee_km: 500, apogee_km: 520, inclination_deg: 51.6 };
  const created = await call('POST', '/api/spacecraft', sc);
  assert.equal(created.status, 201);
  assert.equal(created.data.open_incidents, 0);
  assert.equal((await call('POST', '/api/spacecraft', sc)).status, 409, 'код КА уникален');
  const bad = await call('POST', '/api/spacecraft', { ...sc, code: 'TST-2', apogee_km: 400 });
  assert.equal(bad.status, 422);
  assert.ok(bad.data.details.fields.apogee_km);

  const stale = await call('PUT', `/api/spacecraft/${created.data.id}`, { name: 'Новое имя', _version: '2000-01-01T00:00:00.000Z' });
  assert.equal(stale.status, 409, 'оптимистичная блокировка');

  // удаление КА каскадом убирает его инциденты и команды
  const id = created.data.id;
  await call('POST', '/api/incidents', { severity: 'info', title: 'Проверка каскада', spacecraft_id: id });
  await call('POST', '/api/commands', { spacecraft_id: id, type: 'PING' });
  assert.equal((await call('DELETE', `/api/spacecraft/${id}`)).status, 204);
  assert.equal(demo.store.all('incidents').filter((i) => i.spacecraft_id === id).length, 0);
  assert.equal(demo.store.all('commands').filter((c) => c.spacecraft_id === id).length, 0);
  assert.equal((await call('GET', `/api/spacecraft/${id}`)).status, 404);
});

test('демо: команда уходит на борт в сеансе связи и исполняется', async () => {
  const lg5 = demo.store.all('spacecraft').find((s) => s.code === 'LG-5');
  const events = [];
  const stream = demo.openStream();
  stream.addEventListener('command', (e) => events.push(JSON.parse(e.data).command));
  await new Promise((r) => setTimeout(r, 5));
  const r = await call('POST', '/api/commands', { spacecraft_id: lg5.id, type: 'PING' });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'queued');
  demo.engine.tick(); // геостационар всегда в зоне станции
  await Promise.all([...demo.engine.pendingOps]);
  const deadline = Date.now() + 9000;
  while (!events.some((c) => c.id === r.data.id && c.status === 'executed') && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
  stream.close();
  const statuses = events.filter((c) => c.id === r.data.id).map((c) => c.status);
  assert.deepEqual(statuses, ['queued', 'uplinked', 'executed']);
  const done = await call('GET', `/api/commands/${r.data.id}`);
  assert.match(done.data.result, /Квитанция получена/);
  assert.ok(done.data.station_name);
});

test('демо: неисправность устраняется командой, инцидент закрывается автоматически', async () => {
  const sk2 = demo.engine.fleet.get(demo.store.all('spacecraft').find((s) => s.code === 'SK-2').id);
  assert.ok(demo.engine.states.get(sk2.id).faults.has('seu'), 'неисправность из начальных данных загружена');
  const cmd = await call('POST', '/api/commands', { spacecraft_id: sk2.id, type: 'REBOOT_OBC' });
  await deterministic(() => demo.engine.execute(sk2, demo.store.get('commands', cmd.data.id), { stationId: 1, elevation: 30, range: 1500 }));
  assert.equal(demo.engine.states.get(sk2.id).faults.has('seu'), false);
  const incidents = await call('GET', `/api/incidents?spacecraft_id=${sk2.id}&status=resolved&sort=created_at&dir=desc&limit=1`);
  assert.match(incidents.data.items[0].resolution, /Устранено командой/);
});

test('демо: инцидент принимается и закрывается, действия попадают в аудит', async () => {
  const inc = await call('POST', '/api/incidents', { severity: 'warning', title: 'Проверка журнала' });
  assert.equal(inc.data.source, 'manual');
  assert.equal((await call('POST', `/api/incidents/${inc.data.id}/ack`)).data.status, 'acknowledged');
  assert.equal((await call('POST', `/api/incidents/${inc.data.id}/ack`)).status, 409);
  const res = await call('POST', `/api/incidents/${inc.data.id}/resolve`, { resolution: 'Проверено' });
  assert.equal(res.data.status, 'resolved');
  assert.equal(res.data.resolved_by_name, 'Администратор системы');
  const audit = await call('GET', '/api/audit?entity=incident&limit=3');
  assert.deepEqual(audit.data.items.map((a) => a.action), ['resolve', 'acknowledge', 'create']);
});

test('демо: отчёт, сводка и CSV', async () => {
  const rep = await call('GET', '/api/reports/summary');
  assert.equal(rep.status, 200);
  assert.ok(rep.data.incidentsByDay.length >= 30);
  assert.ok(rep.data.totals.commands > 0);
  assert.ok(rep.data.stations.some((s) => s.forecast24h > 0), 'прогноз сеансов по орбитам');
  const dash = await call('GET', '/api/dashboard');
  assert.equal(dash.data.fleet.active + dash.data.fleet.standby + dash.data.fleet.safe_mode, 12);
  const csv = await demo.api.handle('GET', '/api/crew.csv');
  assert.equal(csv.status, 200);
  assert.ok(csv.data.startsWith('﻿ФИО;'), 'CSV для Excel: BOM и «;»');
  assert.match(csv.headers['Content-Disposition'], /orbita-crew-\d{4}-\d{2}-\d{2}\.csv/);
});

test('демо: данные и сессия переживают перезагрузку, пропущенная телеметрия досчитывается', async () => {
  await call('POST', '/api/missions', { code: 'SAVE-1', name: 'Проверка сохранения', status: 'planning' });
  demo.store.flush();
  // имитируем закрытую на полчаса вкладку: у сохранённой телеметрии нет последних 30 минут
  const saved = JSON.parse(storage.getItem('orbita-demo:v1:telemetry'));
  const cut = Date.now() - 30 * 60_000;
  for (const id of Object.keys(saved)) saved[id] = saved[id].filter((row) => row[0] < cut);
  storage.setItem('orbita-demo:v1:telemetry', JSON.stringify(saved));

  const again = await createBackend({ store: Store.load(), run: false, logger: quiet, version: 'test' });
  const me = await again.request('GET', '/api/auth/me');
  assert.equal(me.data.user?.username, 'admin', 'сессия сохранилась');
  const m = await again.request('GET', '/api/missions?q=SAVE-1');
  assert.equal(m.data.total, 1, 'созданная миссия сохранилась');
  const kv1 = again.store.all('spacecraft').find((s) => s.code === 'KV-1').id;
  assert.ok(Date.now() - again.store.telemetry.lastTime(kv1) < 3 * 60_000, 'история досчитана до текущего момента');

  again.store.clear();
  assert.equal(storage.getItem('orbita-demo:v1:data'), null);
  assert.equal(storage.getItem('orbita-demo:v1:session'), null);
});
