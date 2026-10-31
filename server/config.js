// Конфигурация из переменных окружения (12-factor). Значения по умолчанию — для локального запуска.
const env = process.env;

const bool = (v, def = false) => (v === undefined ? def : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, def) => (v === undefined || v === '' ? def : Number.parseInt(v, 10));

export const config = {
  env: env.NODE_ENV || 'development',
  port: int(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  databaseUrl: env.DATABASE_URL || 'postgres://orbita:orbita@127.0.0.1:5432/orbita',
  dbPoolSize: int(env.DB_POOL_SIZE, 10),
  // сессии
  sessionTtlHours: int(env.SESSION_TTL_HOURS, 12),
  cookieSecure: bool(env.COOKIE_SECURE, false),
  // начальные учётные записи (создаются только при пустой БД)
  adminPassword: env.ADMIN_PASSWORD || 'admin2026',
  seedDemoUsers: bool(env.SEED_DEMO_USERS, true),
  showDemoHint: bool(env.DEMO_MODE, true),
  // симуляция
  simulation: bool(env.SIMULATION, true),
  telemetryPersistSec: int(env.TELEMETRY_PERSIST_SEC, 15),
  telemetryRetentionHours: int(env.TELEMETRY_RETENTION_HOURS, 72),
  anomalyRatePerHour: Number(env.ANOMALY_RATE_PER_HOUR ?? 0.12),
  logLevel: env.LOG_LEVEL || 'info',
  trustProxy: bool(env.TRUST_PROXY, false),
};

export const isProd = config.env === 'production';
