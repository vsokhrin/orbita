// Загрузка начальных данных (seed-data.js) в пустую базу PostgreSQL.
import { hashPassword } from '../auth/passwords.js';
import { insertTelemetry } from '../sim/sql-repo.js';
import { buildSeed, SEED_TABLES, FOREIGN_KEYS } from './seed-data.js';
import { logger } from '../lib/logger.js';

export async function seed(db, { adminPassword, demoUsers = true } = {}) {
  const exists = await db.one('SELECT count(*)::int AS n FROM users');
  if (exists.n > 0) return false;
  logger.info('Пустая БД — заполняю начальными данными…');
  const data = buildSeed({ now: Date.now(), adminPassword, demoUsers });

  // локальные id из seed-data → id, выданные базой
  const ids = Object.fromEntries(SEED_TABLES.map((t) => [t, new Map()]));
  const mapRow = (table, row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === 'id') continue;
      const ref = FOREIGN_KEYS[table]?.[k];
      out[k] = ref && v !== null && v !== undefined ? ids[ref].get(v) : v;
    }
    return out;
  };

  await db.transaction(async (tx) => {
    for (const table of SEED_TABLES) {
      for (const src of data[table]) {
        const row = mapRow(table, src);
        if (table === 'users') {
          row.password_hash = await hashPassword(row.password);
          delete row.password;
        }
        const cols = Object.keys(row);
        const r = await tx.one(
          `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})${src.id ? ' RETURNING id' : ''}`,
          cols.map((c) => row[c]),
        );
        if (src.id) ids[table].set(src.id, r.id);
      }
    }
  });

  await insertTelemetry(db, data.telemetry.map((r) => mapRow('telemetry', r)));
  logger.info(`Начальные данные загружены, история телеметрии: ${data.telemetry.length} записей`);
  return true;
}
