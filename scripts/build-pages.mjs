// Сборка демо-версии ОРБИТЫ для GitHub Pages: статический сайт в _site/.
// Клиент — тот же, что у сервера; вместо сети запросы обрабатывает «сервер» внутри браузера (demo/),
// который использует общие с сервером модули (симуляция, схемы, справочники, начальные данные).
//
//   node scripts/build-pages.mjs                 → _site/ для https://<user>.github.io/orbita/
//   PAGES_BASE=/ node scripts/build-pages.mjs    → для сайта в корне домена
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.env.PAGES_OUT || '_site');
const BASE = ('/' + (process.env.PAGES_BASE ?? '/orbita/').replace(/^\/+|\/+$/g, '') + '/').replace('//', '/');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/** Все модули, которые статически импортирует демо-версия, — ровно они попадут на сайт из server/. */
function moduleGraph(entries) {
  const seen = new Set();
  const stack = [...entries];
  const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^'"`]*?\sfrom\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const code = fs.readFileSync(file, 'utf8');
    for (const m of code.matchAll(IMPORT_RE)) {
      const spec = m[1] || m[2] || m[3];
      if (!spec.startsWith('.')) throw new Error(`${rel(file)}: демо-версия не может импортировать «${spec}» — в браузере нет модулей Node.js`);
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) throw new Error(`${rel(file)}: не найден модуль ${spec}`);
      stack.push(target);
    }
  }
  return [...seen];
}

fs.rmSync(OUT, { recursive: true, force: true });
copyDir(path.join(ROOT, 'public'), OUT);
copyDir(path.join(ROOT, 'shared'), path.join(OUT, 'shared'));
copyDir(path.join(ROOT, 'demo'), path.join(OUT, 'demo'));

const demoEntries = fs.readdirSync(path.join(ROOT, 'demo')).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'demo', f));
const serverModules = moduleGraph(demoEntries).filter((f) => rel(f).startsWith('server/'));
for (const file of serverModules) {
  const dst = path.join(OUT, rel(file));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(file, dst);
}

// index.html: корень сайта и признак демо-версии; 404.html — та же страница для прямых ссылок на разделы
const html = fs
  .readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
  .replace('<base href="/" />', `<base href="${BASE}" />`)
  .replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta name="orbita-demo" content="${version}" />`)
  .replace(/<meta name="description" content="[^"]*" \/>/, '<meta name="description" content="ОРБИТА — информационная система центра управления полётами. Демо-версия: сервер ЦУП работает прямо в браузере." />');
if (!html.includes(`<base href="${BASE}" />`) || !html.includes('orbita-demo')) throw new Error('index.html: не найдены <base href="/"> или <meta charset>');
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, '404.html'), html);
// разделы верхнего уровня — отдельными страницами: GitHub Pages отдаёт /orbita/tracking из tracking.html с кодом 200
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const sections = [...appJs.matchAll(/route\('\/([a-z-]+)'/g)].map((m) => m[1]);
for (const name of sections) fs.writeFileSync(path.join(OUT, `${name}.html`), html);
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

let files = 0;
let bytes = 0;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : (files++, (bytes += fs.statSync(path.join(d, e.name)).size))));
walk(OUT);
console.log(`Демо-версия ${version} собрана в ${rel(OUT)}/ для ${BASE}: ${files} файлов, ${(bytes / 1024).toFixed(0)} КБ`);
console.log(`Модули сервера в сборке: ${serverModules.map(rel).sort().join(', ')}`);
console.log(`Страницы разделов: ${sections.join(', ')}`);
