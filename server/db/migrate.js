// Применение SQL-миграций по порядку. Защищено advisory-блокировкой от параллельного запуска.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_KEY = 727274;

export async function migrate(pool) {
  const conn = await pool.acquire();
  try {
    await conn.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await conn.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    const files = (await fs.readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      const sql = await fs.readFile(path.join(DIR, file), 'utf8');
      logger.info(`Миграция ${version}…`);
      try {
        await conn.simpleQuery('BEGIN');
        await conn.simpleQuery(sql);
        await conn.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
        await conn.simpleQuery('COMMIT');
      } catch (err) {
        await conn.simpleQuery('ROLLBACK').catch(() => {});
        throw new Error(`Миграция ${version} не применена: ${err.message}`);
      }
    }
  } finally {
    await conn.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    pool.release(conn);
  }
}
