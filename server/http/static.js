// Раздача статики с ETag, кэшированием в памяти и gzip. Защита от выхода за пределы корня.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { isProd } from '../config.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.webmanifest']);

const cache = new Map();

async function load(file, stat) {
  const key = file;
  const hit = cache.get(key);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  const body = await fs.promises.readFile(file);
  const ext = path.extname(file).toLowerCase();
  const entry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    body,
    gzip: COMPRESSIBLE.has(ext) && body.length > 1024 ? zlib.gzipSync(body, { level: 9 }) : null,
    etag: `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
    type: TYPES[ext] || 'application/octet-stream',
  };
  cache.set(key, entry);
  return entry;
}

/**
 * Возвращает обработчик, отдающий файлы из root по URL-префиксу prefix.
 * Возвращает false, если файл не найден (чтобы роутер мог попробовать дальше).
 */
export function serveStatic(root, { prefix = '/', immutable = false } = {}) {
  const absRoot = path.resolve(root);
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (!req.path.startsWith(prefix)) return false;
    const rel = req.path.slice(prefix.length);
    const file = path.resolve(absRoot, '.' + path.posix.normalize('/' + rel));
    if (!file.startsWith(absRoot + path.sep) && file !== absRoot) return false;
    let stat;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    const entry = await load(file, stat);
    return sendEntry(req, res, entry, immutable);
  };
}

export function sendEntry(req, res, entry, immutable = false) {
  const headers = {
    'Content-Type': entry.type,
    ETag: entry.etag,
    'Cache-Control': immutable && isProd ? 'public, max-age=86400' : 'no-cache',
    Vary: 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  let body = entry.body;
  if (entry.gzip && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    body = entry.gzip;
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

/** Отдаёт index.html для клиентских маршрутов SPA. */
export function spaFallback(indexFile) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (req.path.startsWith('/api/') || path.extname(req.path)) return false;
    if (!(req.headers.accept || '').includes('text/html')) return false;
    const stat = await fs.promises.stat(indexFile);
    const entry = await load(indexFile, stat);
    return sendEntry(req, res, entry);
  };
}
