// Точка входа клиента: проверка сессии, каркас интерфейса, маршруты, живой поток и уведомления.
import { h, debounce, replace } from './dom.js';
import { api, setUnauthorizedHandler, setTransport } from './api.js';
import { live, setStreamFactory } from './live.js';
import { DEMO, toApp, toUrl } from './base.js';
import { state, can, dict, invalidateFleet } from './state.js';
import { route, startRouter, navigate } from './router.js';
import { icon, logo } from './ui/icons.js';
import { lamp, toast, confirmDialog } from './ui/components.js';
import { fmt, initials } from './format.js';

// ---------- тема ----------
const THEME_KEY = 'orbita-theme';
function applyTheme(t) {
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
function savedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}
applyTheme(savedTheme() || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

// ---------- маршруты ----------
route('/', () => import('./pages/dashboard.js'), { nav: 'dashboard' });
route('/tracking', () => import('./pages/tracking.js'), { nav: 'tracking' });
route('/spacecraft', () => import('./pages/spacecraft.js'), { nav: 'spacecraft' });
route('/spacecraft/:id', () => import('./pages/spacecraft-detail.js'), { nav: 'spacecraft' });
route('/missions', () => import('./pages/missions.js'), { nav: 'missions' });
route('/missions/:id', () => import('./pages/mission-detail.js'), { nav: 'missions' });
route('/crew', () => import('./pages/crew.js'), { nav: 'crew' });
route('/crew/:id', () => import('./pages/crew-detail.js'), { nav: 'crew' });
route('/stations', () => import('./pages/stations.js'), { nav: 'stations' });
route('/stations/:id', () => import('./pages/station-detail.js'), { nav: 'stations' });
route('/launches', () => import('./pages/launches.js'), { nav: 'launches' });
route('/incidents', () => import('./pages/incidents.js'), { nav: 'incidents' });
route('/commands', () => import('./pages/commands.js'), { nav: 'commands' });
route('/reports', () => import('./pages/reports.js'), { nav: 'reports' });
route('/users', () => import('./pages/users.js'), { nav: 'users' });
route('/audit', () => import('./pages/audit.js'), { nav: 'audit' });
route('/profile', () => import('./pages/profile.js'), { nav: 'profile' });
route('*', () => import('./pages/not-found.js'), {});

const NAV = [
  { group: null, items: [
    { id: 'dashboard', href: '/', label: 'Обзор', icon: 'dashboard' },
    { id: 'tracking', href: '/tracking', label: 'Слежение', icon: 'map' },
  ] },
  { group: 'Справочники', items: [
    { id: 'spacecraft', href: '/spacecraft', label: 'Космические аппараты', icon: 'satellite' },
    { id: 'missions', href: '/missions', label: 'Миссии', icon: 'mission' },
    { id: 'crew', href: '/crew', label: 'Экипаж', icon: 'crew' },
    { id: 'stations', href: '/stations', label: 'Наземные станции', icon: 'antenna' },
    { id: 'launches', href: '/launches', label: 'Запуски', icon: 'rocket' },
  ] },
  { group: 'Управление', items: [
    { id: 'incidents', href: '/incidents', label: 'Инциденты', icon: 'alert', counter: 'incidents' },
    { id: 'commands', href: '/commands', label: 'Командный пульт', icon: 'terminal' },
    { id: 'reports', href: '/reports', label: 'Отчёты', icon: 'chart' },
  ] },
  { group: 'Администрирование', admin: true, items: [
    { id: 'users', href: '/users', label: 'Пользователи', icon: 'users' },
    { id: 'audit', href: '/audit', label: 'Журнал аудита', icon: 'log' },
  ] },
];

const root = document.getElementById('app');
let demo = null;

/** Демо-версия: «сервер» ЦУП запускается прямо в браузере, данные хранятся в localStorage. */
async function startDemo() {
  const mod = await import(new URL('../demo/index.js', import.meta.url).href);
  demo = await mod.startDemo();
  setTransport(demo.request);
  setStreamFactory(demo.openStream);
  // выгрузки CSV: ссылки ведут на /api/…csv, отдаём файл из демо-сервера
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[download]');
    if (!a || e.button !== 0) return;
    const url = new URL(a.href, location.href);
    if (!url.pathname.startsWith('/api/')) return;
    e.preventDefault();
    demo.download(url.pathname + url.search).catch((err) => toast({ title: 'Не удалось выгрузить', body: err.message, tone: 'red' }));
  });
}

async function boot() {
  if (DEMO) {
    replace(root, h('div', { class: 'boot-splash', role: 'status' }, logo(44), h('div', null, 'Запуск ЦУП в браузере…')));
    try {
      await startDemo();
    } catch (err) {
      console.error(err);
      replace(root, h('div', { class: 'not-found' }, h('h1', null, 'Демо-версия не запустилась'), h('p', { class: 'muted' }, err.message), h('button', { class: 'btn', onclick: () => location.reload() }, 'Повторить')));
      return;
    }
  }
  try {
    state.meta = await api.get('/api/meta', null, { silent: true });
  } catch (err) {
    replace(root, h('div', { class: 'not-found' }, h('h1', null, 'Сервер ЦУП недоступен'), h('p', { class: 'muted' }, err.message), h('button', { class: 'btn', onclick: () => location.reload() }, 'Повторить')));
    return;
  }
  try {
    const me = await api.get('/api/auth/me', null, { silent: true });
    state.user = me.user;
  } catch {
    state.user = null;
  }
  if (!state.user) return showLogin();
  mountShell();
}

async function showLogin(message) {
  live.disconnect();
  const { renderLogin } = await import('./pages/login.js');
  replace(root, 
    renderLogin({
      message,
      onSuccess: (user) => {
        state.user = user;
        if (toApp(location.pathname) === '/login') history.replaceState({}, '', toUrl('/'));
        mountShell();
      },
    }),
  );
  document.title = 'Вход — ОРБИТА';
}

setUnauthorizedHandler(() => {
  if (!state.user) return;
  state.user = null;
  showLogin('Сессия истекла. Войдите снова.');
});

let counters = { incidents: 0 };

function mountShell() {
  const outlet = h('main', { id: 'main', tabindex: -1 });
  const navEl = h('nav', { class: 'nav', 'aria-label': 'Разделы' });
  const shell = h('div', { class: 'shell' });
  const closeNav = () => shell.classList.remove('nav-open');

  function renderNav(activeId) {
    replace(navEl, 
      ...NAV.filter((g) => !g.admin || can.admin()).flatMap((g) => [
        g.group ? h('div', { class: 'nav-group' }, g.group) : [],
        ...g.items.map((it) =>
          h(
            'a',
            { href: it.href, 'aria-current': it.id === activeId ? 'page' : null, onclick: closeNav },
            icon(it.icon),
            it.label,
            it.counter && counters[it.counter] ? h('span', { class: 'count', title: 'Открытые инциденты' }, counters[it.counter]) : null,
          ),
        ),
      ]),
    );
  }
  let activeNav = null;

  // часы UTC и МСК
  const utc = h('b');
  const msk = h('b');
  const tickClock = () => {
    const now = Date.now();
    utc.textContent = fmt.utc(now);
    msk.textContent = fmt.msk(now);
  };
  tickClock();
  setInterval(tickClock, 1000);

  // состояние потока
  const linkLamp = h('span');
  const linkText = h('span', { class: 'txt' });
  const renderLink = () => {
    const s = live.state;
    replace(linkLamp, lamp(s === 'online' ? 'green' : s === 'connecting' ? 'amber' : 'red', { blink: s === 'connecting' }));
    linkText.textContent = s === 'online' ? 'Поток телеметрии' : s === 'connecting' ? 'Подключение…' : 'Нет потока';
  };
  live.addEventListener('state', renderLink);
  renderLink();

  const userMenu = buildUserMenu();
  const search = buildSearch();

  shell.append(
    h(
      'aside',
      { class: 'sidebar' },
      h('a', { class: 'brand', href: '/', onclick: closeNav }, logo(30), h('div', null, h('div', { class: 'brand-name' }, 'ОРБИТА'), h('div', { class: 'brand-sub' }, 'Информационная система ЦУП'))),
      navEl,
      h('div', { class: 'sidebar-foot' }, DEMO ? demoNote() : `Версия ${state.meta.version}`),
    ),
    h(
      'div',
      { class: 'main' },
      h(
        'header',
        { class: 'topbar' },
        h('button', { class: 'btn ghost icon menu-btn', type: 'button', 'aria-label': 'Меню', onclick: () => shell.classList.toggle('nav-open') }, icon('menu')),
        search,
        h(
          'div',
          { class: 'clocks', 'aria-label': 'Время' },
          h('div', { class: 'clock utc' }, utc, h('span', null, 'UTC')),
          h('div', { class: 'clock moscow' }, msk, h('span', null, 'Москва')),
        ),
        h('div', { class: 'link-state', title: 'Состояние потока данных с сервера ЦУП' }, linkLamp, linkText),
        userMenu,
      ),
      outlet,
    ),
  );
  replace(root, shell);
  renderNav(null);

  startRouter(outlet, {
    onChange: (match) => {
      activeNav = match?.meta?.nav ?? null;
      renderNav(activeNav);
    },
  });
  live.connect();

  // счётчик открытых инцидентов в меню
  const refreshCounters = debounce(async () => {
    try {
      const r = await api.get('/api/incidents', { status: 'open', limit: 1 }, { silent: true });
      counters.incidents = r.total;
      renderNav(activeNav);
    } catch {}
  }, 500);
  refreshCounters();

  live.addEventListener('incident', (e) => {
    const { action, incident } = e.detail;
    refreshCounters();
    if (action === 'created' && incident.severity === 'critical') {
      toast({ title: 'Авария', body: incident.title, tone: 'red', link: { href: `/incidents?status=open`, label: 'Открыть инциденты' }, timeout: 12000 });
    } else if (action === 'created' && incident.severity === 'warning') {
      toast({ title: 'Предупреждение', body: incident.title, tone: 'amber' });
    } else if (action === 'created' && incident.severity === 'info' && incident.source === 'auto') {
      toast({ title: incident.title, body: incident.description, tone: 'white', timeout: 9000 });
    }
  });
  live.addEventListener('command', (e) => {
    const { command } = e.detail;
    if (command.issued_by !== state.user?.id) return;
    const label = dict('commandTypes', command.type)?.label ?? command.type;
    if (command.status === 'uplinked') toast({ title: 'Команда передана на борт', body: `№${command.id} «${label}»`, tone: 'white', timeout: 4000 });
    if (command.status === 'executed') toast({ title: 'Команда выполнена', body: `№${command.id} «${label}»: ${command.result}`, tone: 'green' });
    if (command.status === 'failed') toast({ title: 'Команда не выполнена', body: `№${command.id} «${label}»: ${command.result}`, tone: 'red', timeout: 10000 });
    if (command.status === 'expired') toast({ title: 'Срок команды истёк', body: `№${command.id} «${label}»`, tone: 'amber' });
  });
  live.addEventListener('fleet', () => invalidateFleet());
  live.addEventListener('launch', (e) => {
    const l = e.detail.launch;
    if (l.status === 'go') toast({ title: 'Готовность к пуску', body: `${l.name}: старт ${fmt.relative(l.scheduled_at)}`, tone: 'amber' });
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      search.querySelector('input').focus();
    }
  });
}

function demoNote() {
  return [
    h('div', null, `Демо-версия ${state.meta.version}. Сервер ЦУП работает в этом браузере, изменения сохраняются только здесь.`),
    h(
      'div',
      { class: 'demo-actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'link',
          onclick: async () => {
            const ok = await confirmDialog({ title: 'Сбросить демо-данные?', text: 'Все изменения в этом браузере будут удалены, мир ЦУП начнётся заново.', confirmLabel: 'Сбросить', danger: true });
            if (!ok) return;
            demo.reset();
            location.assign(toUrl('/'));
          },
        },
        'Сбросить данные',
      ),
      h('a', { href: 'https://github.com/vsokhrin/orbita', target: '_blank', rel: 'noopener' }, 'Исходный код'),
    ),
  ];
}

function buildUserMenu() {
  const u = state.user;
  let open = false;
  const menu = h('div', { class: 'dropdown hidden', role: 'menu' });
  const themeLabel = () => (document.documentElement.dataset.theme === 'dark' ? 'Дневная смена' : 'Ночная смена');
  const themeBtn = h('button', { type: 'button', role: 'menuitem' });
  const renderThemeBtn = () => replace(themeBtn, icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'), themeLabel());
  renderThemeBtn();
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    renderThemeBtn();
  });
  menu.append(
    h('div', { style: { padding: '6px 10px 8px' } }, h('div', { style: { fontWeight: 600 } }, u.fullName), h('div', { class: 'muted small' }, `${u.username} · ${dict('roles', u.role)}`)),
    h('hr'),
    h('a', { href: '/profile', role: 'menuitem', onclick: () => toggle(false) }, icon('key'), 'Профиль и пароль'),
    themeBtn,
    h('hr'),
    h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        onclick: async () => {
          try {
            await api.post('/api/auth/logout');
          } catch {}
          state.user = null;
          invalidateFleet();
          history.replaceState({}, '', toUrl('/'));
          showLogin();
        },
      },
      icon('logout'),
      'Выйти',
    ),
  );
  const btn = h(
    'button',
    { class: 'user-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => toggle() },
    h('span', { class: 'avatar' }, initials(u.fullName)),
    h('span', { class: 'who' }, u.fullName, h('small', null, dict('roles', u.role))),
  );
  function toggle(v = !open) {
    open = v;
    menu.classList.toggle('hidden', !open);
    btn.setAttribute('aria-expanded', String(open));
  }
  document.addEventListener('click', (e) => {
    if (open && !wrap.contains(e.target)) toggle(false);
  });
  const wrap = h('div', { class: 'user-menu' }, btn, menu);
  return wrap;
}

const SEARCH_KIND = {
  spacecraft: ['КА', (id) => `/spacecraft/${id}`],
  mission: ['Миссия', (id) => `/missions/${id}`],
  crew: ['Экипаж', (id) => `/crew/${id}`],
  station: ['Станция', (id) => `/stations/${id}`],
  launch: ['Запуск', () => `/launches`],
};

function buildSearch() {
  const results = h('div', { class: 'search-results hidden', role: 'listbox', id: 'search-results' });
  let items = [];
  let active = -1;
  const input = h('input', {
    type: 'search',
    placeholder: 'Найти аппарат, миссию, станцию…',
    'aria-label': 'Глобальный поиск',
    'aria-controls': 'search-results',
    autocomplete: 'off',
    oninput: debounce(async () => {
      const q = input.value.trim();
      if (q.length < 2) return hide();
      try {
        const r = await api.get('/api/search', { q }, { silent: true });
        items = r.items;
        active = items.length ? 0 : -1;
        render();
      } catch {}
    }, 220),
    onkeydown: (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        active = Math.min(items.length - 1, active + 1);
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        active = Math.max(0, active - 1);
        render();
      } else if (e.key === 'Enter' && items[active]) {
        e.preventDefault();
        go(items[active]);
      } else if (e.key === 'Escape') hide();
    },
    onblur: () => setTimeout(hide, 150),
  });
  function go(it) {
    const [, href] = SEARCH_KIND[it.kind];
    hide();
    input.value = '';
    navigate(href(it.id));
  }
  function hide() {
    results.classList.add('hidden');
  }
  function render() {
    if (!items.length) {
      replace(results, h('div', { class: 'muted small', style: { padding: '8px' } }, 'Ничего не найдено'));
    } else {
      replace(results, 
        ...items.map((it, i) => {
          const [kind, href] = SEARCH_KIND[it.kind];
          return h(
            'a',
            { href: href(it.id), role: 'option', 'aria-selected': String(i === active), onmousedown: (e) => (e.preventDefault(), go(it)) },
            h('span', { class: 'kind' }, kind),
            h('span', null, it.title, it.subtitle ? h('span', { class: 'sub' }, it.subtitle) : null),
          );
        }),
      );
    }
    results.classList.remove('hidden');
  }
  return h('div', { class: 'search', role: 'search' }, icon('search', 16), input, h('kbd', null, 'Ctrl K'), results);
}

boot();
