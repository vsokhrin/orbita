// Простой структурированный логгер: в production — JSON-строки, в разработке — читаемый текст.
import { config, isProd } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? 20;

function write(level, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  if (isProd) {
    const line = { ts, level, msg, ...(extra || {}) };
    (level === 'error' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');
  } else {
    const tail = extra && Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '';
    const color = { debug: 90, info: 36, warn: 33, error: 31 }[level];
    (level === 'error' ? process.stderr : process.stdout).write(`\x1b[90m${ts.slice(11, 19)}\x1b[0m \x1b[${color}m${level.padEnd(5)}\x1b[0m ${msg}${tail}\n`);
  }
}

export const logger = {
  debug: (m, e) => write('debug', m, e),
  info: (m, e) => write('info', m, e),
  warn: (m, e) => write('warn', m, e),
  error: (m, e) => write('error', m, e),
};
