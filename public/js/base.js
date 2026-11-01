// Где развёрнут клиент: в корне сайта (сервер ОРБИТЫ) или в подкаталоге (демо на GitHub Pages: /orbita/).
// Корень вычисляется по адресу этого модуля: <корень>/js/base.js.
export const BASE = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

// Демо-версия: «сервер» работает прямо в браузере. Признак добавляет сборка для GitHub Pages.
export const DEMO = document.querySelector('meta[name="orbita-demo"]') !== null;

/** Путь из адресной строки → маршрут приложения (без BASE). Пути вне приложения не меняются. */
export function toApp(path) {
  if (!BASE) return path;
  if (path === BASE) return '/';
  if (path.startsWith(BASE + '?')) return '/' + path.slice(BASE.length);
  return path.startsWith(BASE + '/') ? path.slice(BASE.length) : path;
}

/** Маршрут приложения → адрес для ссылки и истории браузера (с BASE). */
export function toUrl(path) {
  if (!BASE || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/api/')) return path;
  if (path === BASE || path.startsWith(BASE + '/')) return path;
  return BASE + path;
}
