// «Сервер» ЦУП демо-версии: хранилище, движок симуляции, поток событий и API — без DOM,
// поэтому то же ядро проверяется тестами в Node.js (test/demo.test.js).
import * as O from '../shared/orbit.js';
import { Engine } from '../server/sim/engine.js';
import { step, telemetryRecord } from '../server/sim/model.js';
import { buildSeed } from '../server/db/seed-data.js';
import { Store } from './store.js';
import { MemoryRepo } from './memory-repo.js';
import { DemoHub } from './hub.js';
import { createApi } from './api.js';
import { hashPassword } from './crypto.js';

export const DEMO_CONFIG = {
  simulation: true,
  telemetryPersistSec: 60,
  telemetryRetentionHours: 24,
  anomalyRatePerHour: 0.3,
};

const quietLogger = {
  info: (m) => console.debug('ОРБИТА демо:', m),
  warn: (m) => console.warn('ОРБИТА демо:', m),
  error: (m) => console.error('ОРБИТА демо:', m),
};

/** Новый мир ЦУП: начальные данные сервера, пароли — в хэшах PBKDF2. */
export async function seedStore(now = Date.now()) {
  const seed = buildSeed({ now });
  seed.users = await Promise.all(seed.users.map(async ({ password, ...u }) => ({ ...u, password_hash: await hashPassword(password) })));
  return Store.fromSeed(seed, now);
}

/** Пока вкладка была закрыта, полёт продолжался: досчитываем историю телеметрии моделью. */
function catchUp(engine, store, now, retentionHours) {
  const stepMs = 60_000;
  const rows = [];
  for (const sc of engine.fleet.values()) {
    if (!sc.simulated) continue;
    const st = engine.states.get(sc.id);
    const last = store.telemetry.lastTime(sc.id);
    const from = Math.max(last === null ? -Infinity : last + stepMs, now - retentionHours * 3600_000);
    for (let t = from; t <= now - stepMs; t += stepMs) {
      rows.push(telemetryRecord(sc.id, t, st, step(sc, st, t, stepMs / 1000, O.sunVector(t), engine.stations)));
    }
  }
  store.telemetry.add(rows);
  return rows.length;
}

/**
 * Запуск демо-сервера. store — сохранённые данные или null (тогда мир создаётся заново).
 * run=false — без таймеров движка (для тестов).
 */
export async function createBackend({ store = null, version = 'demo', config = DEMO_CONFIG, logger = quietLogger, run = true } = {}) {
  store ||= Store.load() || (await seedStore());
  const hub = new DemoHub();
  const engine = new Engine({ repo: new MemoryRepo(store), hub, logger, config });
  await engine.reloadFleet();
  await engine.loadStates();
  const caught = catchUp(engine, store, Date.now(), config.telemetryRetentionHours);
  if (caught) logger.info(`досчитано записей телеметрии: ${caught}`);
  if (run) await engine.start();
  else await engine.refreshQueue();
  store.flush();
  const api = createApi({ store, engine, hub, version });

  return {
    store,
    engine,
    hub,
    api,
    /** Транспорт для клиента: как fetch, только без сети. Данные проходят через JSON. */
    async request(method, url, body) {
      await new Promise((r) => setTimeout(r, 0));
      const reply = await api.handle(method, url, body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
      return { status: reply.status, data: reply.data === null ? null : JSON.parse(JSON.stringify(reply.data)), headers: reply.headers };
    },
    openStream: () => hub.open(),
    async stop() {
      await engine.stop();
      store.flush();
    },
    reset() {
      engine.stop().catch(() => {});
      store.clear();
    },
  };
}
