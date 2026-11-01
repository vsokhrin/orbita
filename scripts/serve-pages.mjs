// Локальный просмотр сборки для GitHub Pages так, как её отдаст GitHub:
// сайт в подкаталоге /orbita/, неизвестные адреса — 404.html (клиентский роутер покажет нужный раздел).
//   npm run demo   →   http://localhost:4000/orbita/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.env.PAGES_OUT || '_site');
const BASE = ('/' + (process.env.PAGES_BASE ?? '/orbita/').replace(/^\/+|\/+$/g, '') + '/').replace('//', '/');
const PORT = Number(process.env.PORT || 4000);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };

if (!fs.existsSync(path.join(OUT, 'index.html'))) {
  console.error(`Нет сборки в ${OUT}. Сначала: npm run pages:build`);
  process.exit(1);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, file) => {
      res.writeHead(status, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    };
    if (url.pathname + '/' === BASE) {
      res.writeHead(301, { Location: BASE });
      return res.end();
    }
    if (!url.pathname.startsWith(BASE)) return send(404, path.join(OUT, '404.html'));
    let file = path.resolve(OUT, '.' + decodeURIComponent(url.pathname.slice(BASE.length - 1)));
    if (!file.startsWith(OUT)) return send(404, path.join(OUT, '404.html'));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html'; // как GitHub Pages: /tracking → tracking.html
    if (!fs.existsSync(file)) return send(404, path.join(OUT, '404.html'));
    send(200, file);
  })
  .listen(PORT, () => console.log(`Демо-версия: http://localhost:${PORT}${BASE}`));
