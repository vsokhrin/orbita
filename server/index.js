// Точка входа ОРБИТЫ: подключение к БД, миграции, начальные данные, HTTP-сервер, движок симуляции.
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { Pool } from './db/pg.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { createApp } from './http/app.js';
import { serveStatic, spaFallback } from './http/static.js';
import { SseHub } from './http/sse.js';
import { loadSession, sameOriginGuard } from './auth/sessions.js';
import { Engine } from './sim/engine.js';
import { SqlRepo } from './sim/sql-repo.js';
import { authRoutes } from './routes/auth.js';
import { systemRoutes } from './routes/system.js';
import { entityRoutes } from './routes/entities.js';
import { opsRoutes, commandCreateRoute } from './routes/ops.js';
import { reportRoutes } from './routes/reports.js';
import { adminRoutes } from './routes/admin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

async function connectWithRetry(pool, attempts = 30) {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      logger.warn(`БД недоступна (${err.code || err.message}), повтор ${i}/${attempts} через 2 с…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function buildServer({ db, withEngine = config.simulation } = {}) {
  const hub = new SseHub();
  const engine = new Engine({ repo: new SqlRepo(db), hub, logger, config });
  const app = createApp({ trustProxy: config.trustProxy });

  app.use((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  });
  app.use(sameOriginGuard);
  app.use(loadSession(db));

  const ctx = { db, engine, hub, version };
  authRoutes(app, ctx);
  systemRoutes(app, ctx);
  commandCreateRoute(app, ctx);
  entityRoutes(app, ctx);
  opsRoutes(app, ctx);
  reportRoutes(app, ctx);
  adminRoutes(app, ctx);

  const sharedFiles = serveStatic(path.join(ROOT, 'shared'), { prefix: '/shared/' });
  const publicFiles = serveStatic(path.join(ROOT, 'public'), { prefix: '/', immutable: true });
  const spa = spaFallback(path.join(ROOT, 'public', 'index.html'));
  app.setFallback(async (req, res) => {
    if (await sharedFiles(req, res)) return true;
    if (await publicFiles(req, res)) return true;
    if (await spa(req, res)) return true;
    return false;
  });

  if (withEngine) await engine.start();
  else await engine.reloadFleet();
  const server = http.createServer((req, res) => app.handle(req, res));
  server.keepAliveTimeout = 65_000;
  return { server, engine, hub };
}

async function main() {
  logger.info(`ОРБИТА ${version} — запуск (${config.env})`);
  const db = new Pool({ connectionString: config.databaseUrl, max: config.dbPoolSize, logger });
  await connectWithRetry(db);
  await migrate(db);
  await seed(db, { adminPassword: config.adminPassword, demoUsers: config.seedDemoUsers });
  const { server, engine, hub } = await buildServer({ db });
  server.listen(config.port, config.host, () => logger.info(`HTTP: http://localhost:${config.port}`));

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal}: останавливаюсь…`);
    hub.close();
    server.close();
    await engine.stop();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    logger.error('Не удалось запустить сервер: ' + (err.stack || err.message));
    process.exit(1);
  });
}
