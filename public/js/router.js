// Клиентский роутер на History API: маршруты с параметрами, перехват ссылок, жизненный цикл страниц.
import { Scope } from './dom.js';

const routes = [];
let outlet = null;
let current = null;
let onNavigate = null;
let navId = 0;

export function route(path, loader, meta = {}) {
  const keys = [];
  const regex = path === '*' ? /^$/ : new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  routes.push({ path, regex, keys, loader, meta });
}

export function startRouter(el, { onChange } = {}) {
  outlet = el;
  onNavigate = onChange;
  window.addEventListener('popstate', () => render(location.pathname + location.search, { restoreScroll: true }));
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download') || a.dataset.external !== undefined) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
    e.preventDefault();
    navigate(url.pathname + url.search);
  });
  render(location.pathname + location.search);
}

export function navigate(to, { replace = false } = {}) {
  if (to === location.pathname + location.search) return render(to);
  history[replace ? 'replaceState' : 'pushState']({}, '', to);
  return render(to);
}

/** Обновить параметры адресной строки без перерисовки страницы (фильтры, вкладки) */
export function setQuery(params) {
  const sp = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') sp.delete(k);
    else sp.set(k, v);
  }
  const qs = sp.toString();
  history.replaceState({}, '', location.pathname + (qs ? '?' + qs : ''));
}

export function getQuery() {
  return Object.fromEntries(new URLSearchParams(location.search));
}

async function render(url, { restoreScroll = false } = {}) {
  const id = ++navId;
  const [pathname] = url.split('?');
  let match = null;
  let params = {};
  for (const r of routes) {
    const m = r.regex.exec(pathname);
    if (m) {
      match = r;
      params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      break;
    }
  }
  current?.scope.dispose();
  const scope = new Scope();
  current = { scope };
  if (!match) match = routes.find((r) => r.path === '*');
  onNavigate?.(match, pathname);
  try {
    const mod = await match.loader();
    if (id !== navId) return;
    const el = await mod.default({ params, query: getQuery(), scope, meta: match.meta });
    if (id !== navId) {
      scope.dispose();
      return;
    }
    outlet.replaceChildren(el);
    if (!restoreScroll) window.scrollTo(0, 0);
    const h1 = outlet.querySelector('h1');
    document.title = (h1?.textContent ? h1.textContent + ' — ' : '') + 'ОРБИТА';
  } catch (err) {
    if (id !== navId) return;
    console.error(err);
    const { errorView } = await import('./ui/components.js');
    outlet.replaceChildren(errorView(err));
  }
}
