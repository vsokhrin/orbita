// Обзор: транспарантное табло, живая карта, ближайший запуск, сеансы связи, состояние флота, инциденты и команды.
import { h, debounce, replace } from '../dom.js';
import { api } from '../api.js';
import { live } from '../live.js';
import { state, dict, loadFleet, can } from '../state.js';
import { navigate } from '../router.js';
import { fmt, plural } from '../format.js';
import { pageHead, panel, screen, badge, lamp, meter, colorDot, button, toastError } from '../ui/components.js';
import { WorldMap } from '../map/worldmap.js';

export default async function dashboard({ scope }) {
  const [data, fleet] = await Promise.all([api.get('/api/dashboard'), loadFleet(true)]);
  let dash = data;
  const serverSkew = dash.serverTime - Date.now();

  // ---------- табло ----------
  const tiles = {};
  const tileDefs = [
    ['link', 'Связь', '/tracking'],
    ['crit', 'Авария', '/incidents?status=open&severity=critical'],
    ['warn', 'Предупр.', '/incidents?status=open&severity=warning'],
    ['safe', 'Безоп. режим', '/spacecraft?status=safe_mode'],
    ['shadow', 'Тень', '/tracking'],
    ['queue', 'Команды', '/commands'],
    ['launch', 'Пуск', '/launches'],
  ];
  const annunciator = h(
    'div',
    { class: 'annunciator', role: 'group', 'aria-label': 'Транспарантное табло' },
    tileDefs.map(([key, legend, href]) => {
      const value = h('span', { class: 'value' });
      const hint = h('span', { class: 'hint' });
      const el = h('a', { class: 'legend-tile', href }, h('span', { class: 'legend' }, legend), value, hint);
      tiles[key] = { el, value, hint };
      return el;
    }),
  );
  function setTile(key, on, value, hint, { blink = false } = {}) {
    const t = tiles[key];
    t.el.className = ['legend-tile', on && `on-${on}`, on && blink && 'blink'].filter(Boolean).join(' ');
    t.value.textContent = value;
    t.hint.textContent = hint;
    t.el.setAttribute('aria-label', `${t.el.querySelector('.legend').textContent}: ${value}. ${hint}`);
  }
  function renderAnnunciator() {
    const items = [...live.telemetry.values()].filter((i) => !i.inactive);
    const sim = items.length || dash.live.simulated;
    const inContact = items.length ? items.filter((i) => i.link).length : dash.live.inContact;
    const shadow = items.length ? items.filter((i) => !i.sunlit).length : dash.live.inShadow;
    const safe = items.length ? items.filter((i) => i.mode === 'safe').length : dash.live.safeMode;
    const queued = items.length ? items.reduce((a, i) => a + (i.queued || 0), 0) : dash.live.queued;
    const crit = dash.incidents.critical || 0;
    const warn = dash.incidents.warning || 0;
    setTile('link', inContact ? 'green' : null, `${inContact} из ${sim}`, inContact ? 'КА в сеансе связи' : 'Нет сеансов');
    setTile('crit', crit ? 'red' : null, crit, crit ? `${plural(crit, 'открытая авария', 'открытые аварии', 'открытых аварий')}` : 'Аварий нет', { blink: crit > 0 });
    setTile('warn', warn ? 'amber' : null, warn, warn ? plural(warn, 'предупреждение', 'предупреждения', 'предупреждений') : 'Нет предупреждений');
    setTile('safe', safe ? 'amber' : null, safe, safe ? plural(safe, 'аппарат', 'аппарата', 'аппаратов') : 'Все в штатном');
    setTile('shadow', shadow ? 'white' : null, shadow, 'в тени Земли');
    setTile('queue', queued ? 'white' : null, queued, queued ? 'ждут сеанса связи' : 'Очередь пуста');
    const next = dash.nextLaunches.find((l) => l.status !== 'hold');
    const dt = next ? Date.parse(next.scheduled_at) - (Date.now() + serverSkew) : null;
    if (next && dt < 3600_000) setTile('launch', 'amber', fmt.countdown(dt).replace(/^Т./, 'Т−'), next.name.split('/').pop().trim(), { blink: dt < 300_000 });
    else setTile('launch', null, next ? fmt.relative(next.scheduled_at).replace('через ', '') : '—', next ? 'до ближайшего пуска' : 'Пусков нет');
  }

  // ---------- карта ----------
  const mapBox = h('div', { class: 'map-wrap' });
  const mapScreen = screen({
    title: 'Положение флота',
    aside: [h('span', { class: 'muted' }, 'Двойной щелчок по аппарату — карточка'), h('a', { href: '/tracking' }, 'Полноэкранное слежение')],
    body: [mapBox, mapLegend()],
  });

  // ---------- ближайший запуск ----------
  const countdownBox = h('div', { class: 'countdown' });
  function renderCountdown() {
    const next = dash.nextLaunches[0];
    if (!next) {
      replace(countdownBox, h('div', { class: 'muted' }, 'Запуски не запланированы'));
      return;
    }
    const dt = Date.parse(next.scheduled_at) - (Date.now() + serverSkew);
    replace(countdownBox, 
      h('div', { class: 'row' }, badge('launchStatuses', next.status), h('span', { class: 'muted small' }, fmt.dateTime(next.scheduled_at))),
      h('div', { class: ['t', dt < 600_000 && dt > 0 && 'soon'], 'aria-live': 'off' }, next.status === 'hold' ? 'Задержка' : fmt.countdown(dt)),
      h('div', { class: 'what' }, next.name),
      h('div', { class: 'where' }, `${next.vehicle}, ${next.site}`),
      dash.nextLaunches.length > 1
        ? h(
            'ul',
            { class: 'contact-list', style: { marginTop: '12px', borderTop: '1px solid var(--rule-soft)' } },
            dash.nextLaunches.slice(1).map((l) => h('li', { style: { padding: '8px 0' } }, h('span', null, l.name), h('span', { class: 'when' }, l.status === 'hold' ? 'задержка' : fmt.relative(l.scheduled_at)))),
          )
        : null,
    );
  }

  // ---------- сеансы связи ----------
  const contactsBox = h('ul', { class: 'contact-list' });
  function renderContacts() {
    const now = Date.now() + serverSkew;
    // идущие сеансы (не больше трёх, ближайшие к завершению) + ближайшие предстоящие
    const current = dash.contacts.filter((c) => c.aos <= now && (c.los ?? Infinity) > now).sort((a, b) => (a.los ?? Infinity) - (b.los ?? Infinity)).slice(0, 3);
    const upcoming = dash.contacts.filter((c) => c.aos > now);
    const list = [...current, ...upcoming].slice(0, 5);
    if (!list.length) {
      replace(contactsBox, h('li', { class: 'muted' }, 'В ближайшие три часа сеансов нет'));
      return;
    }
    replace(contactsBox, 
      ...list.map((c) => {
        const active = c.aos <= now;
        return h(
          'li',
          null,
          h('span', null, h('a', { href: `/spacecraft/${c.spacecraftId}` }, c.spacecraftName), h('span', { class: 'muted' }, ` → ${c.stationName}`)),
          h('span', { class: ['when', active && 'now'] }, active ? 'идёт сейчас' : fmt.relative(c.aos, now)),
          h('span', { class: 'muted small' }, `до ${fmt.num(c.maxElevation, 1)}° над горизонтом`),
          h('span', { class: 'muted small when' }, c.durationS ? fmt.duration(c.durationS) : ''),
        );
      }),
    );
  }

  // ---------- флот ----------
  const inOrbit = fleet.filter((f) => ['active', 'standby', 'safe_mode'].includes(f.status));
  const rowCells = new Map();
  const tbody = h(
    'tbody',
    null,
    inOrbit.map((sc) => {
      const cells = { status: h('td'), battery: h('td'), temp: h('td', { class: 'num' }), link: h('td'), mode: h('td'), faults: h('td') };
      rowCells.set(sc.id, { sc, cells });
      return h(
        'tr',
        { class: 'clickable', tabindex: 0, onclick: () => navigate(`/spacecraft/${sc.id}`), onkeydown: (e) => e.key === 'Enter' && navigate(`/spacecraft/${sc.id}`) },
        h('td', null, h('span', { class: 'row', style: { flexWrap: 'nowrap' } }, colorDot(sc.color), h('span', null, h('span', { class: 'title' }, sc.name), h('span', { class: 'sub' }, sc.code)))),
        cells.status,
        cells.battery,
        cells.temp,
        cells.link,
        cells.mode,
        cells.faults,
      );
    }),
  );
  const stationName = (id) => state.stations?.find((s) => s.id === id)?.name ?? '—';
  function renderFleetRows() {
    for (const { sc, cells } of rowCells.values()) {
      const t = live.telemetry.get(sc.id);
      replace(cells.status, badge('spacecraftStatuses', t?.status ?? sc.status));
      if (!t) continue;
      replace(cells.battery, meter(t.battery));
      cells.temp.textContent = `${fmt.fixed(t.temperature, 1)} °C`;
      if (t.link) replace(cells.link, h('span', { class: 'row', style: { flexWrap: 'nowrap' } }, lamp('green'), stationName(t.link.stationId), h('span', { class: 'muted small' }, `${fmt.int(t.link.elevation)}°`)));
      else {
        const next = dash.contacts.find((c) => c.spacecraftId === sc.id && c.aos > Date.now());
        replace(cells.link, h('span', { class: 'muted' }, next ? `следующий ${fmt.relative(next.aos)}` : 'вне зоны'));
      }
      const modeText = t.mode === 'reboot' ? 'перезагрузка БКУ' : t.mode === 'safe' ? 'безопасный' : t.payloadOn ? 'работа ЦА' : 'дежурный';
      replace(cells.mode, h('span', null, modeText), h('span', { class: 'sub' }, (t.pointing === 'sun' ? 'на Солнце, ' : '') + (t.sunlit ? 'освещён' : 'в тени')));
      replace(cells.faults, t.faults.length ? h('span', { class: 'row', style: { flexWrap: 'nowrap' } }, lamp('red'), t.faults.map((f) => dict('faults', f)?.short ?? f).join(', ')) : h('span', { class: 'muted' }, 'нет'));
    }
  }
  const fleetPanel = panel({
    title: 'Состояние флота',
    aside: h('a', { href: '/spacecraft' }, 'Все аппараты'),
    flush: true,
    body: h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'data' },
        h('thead', null, h('tr', null, ['Аппарат', 'Состояние', 'Заряд АКБ', 'Температура', 'Связь', 'Режим', 'Неисправности'].map((l, i) => h('th', { class: i === 3 && 'num', scope: 'col' }, l)))),
        tbody,
      ),
    ),
  });

  // ---------- инциденты и команды ----------
  const incidentsBox = h('ul', { class: 'feed' });
  const commandsBox = h('ul', { class: 'feed' });
  function renderFeeds() {
    replace(incidentsBox, 
      ...(dash.openIncidents.length
        ? dash.openIncidents.map((i) =>
            h(
              'li',
              null,
              lamp(i.severity === 'critical' ? 'red' : i.severity === 'warning' ? 'amber' : 'white', { blink: i.severity === 'critical' && i.status === 'open', title: dict('incidentSeverities', i.severity) }),
              h('div', null, h('a', { class: 'title', href: `/incidents?open=${i.id}` }, i.title), h('div', { class: 'meta' }, `${dict('incidentStatuses', i.status)} · ${fmt.relative(i.created_at)}`)),
              can.edit() && i.status === 'open'
                ? button('Принять', {
                    small: true,
                    onClick: async () => {
                      try {
                        await api.post(`/api/incidents/${i.id}/ack`);
                        refresh();
                      } catch (err) {
                        toastError(err);
                      }
                    },
                  })
                : h('span', { class: 'side' }, i.spacecraft_name || i.station_name || ''),
            ),
          )
        : [h('li', null, h('span'), h('div', { class: 'muted' }, 'Открытых инцидентов нет'), h('span'))]),
    );
    replace(commandsBox, 
      ...(dash.recentCommands.length
        ? dash.recentCommands.map((c) =>
            h(
              'li',
              null,
              lamp({ executed: 'green', failed: 'red', queued: 'white', uplinked: 'amber' }[c.status] || null),
              h('div', null, h('div', { class: 'title' }, `${dict('commandTypes', c.type)?.label ?? c.type} → ${c.spacecraft_name}`), h('div', { class: 'meta' }, c.result || (c.status === 'queued' ? 'Ждёт сеанса связи' : dict('commandStatuses', c.status)))),
              h('span', { class: 'side' }, fmt.relative(c.completed_at || c.created_at)),
            ),
          )
        : [h('li', null, h('span'), h('div', { class: 'muted' }, 'Команд ещё не было'), h('span'))]),
    );
  }

  const el = h(
    'div',
    { class: 'page' },
    pageHead({ title: 'Обзор', lede: `Смена ${fmt.date(Date.now())}. Данные обновляются в реальном времени.` }),
    annunciator,
    h(
      'div',
      { class: 'dash-top' },
      mapScreen,
      h('div', { class: 'stack' }, panel({ title: 'Ближайший пуск', flush: true, body: countdownBox }), panel({ title: 'Сеансы связи', aside: 'прогноз на 3 часа', flush: true, body: contactsBox })),
    ),
    fleetPanel,
    h('div', { class: 'grid two', style: { marginTop: '16px' } }, panel({ title: 'Открытые инциденты', aside: h('a', { href: '/incidents' }, 'Журнал'), flush: true, body: incidentsBox }), panel({ title: 'Последние команды', aside: h('a', { href: '/commands' }, 'Командный пульт'), flush: true, body: commandsBox })),
  );

  renderAnnunciator();
  renderCountdown();
  renderContacts();
  renderFleetRows();
  renderFeeds();

  // карту создаём после вставки в DOM, чтобы знать ширину
  requestAnimationFrame(() => {
    const map = new WorldMap(mapBox, {
      compact: true,
      tracks: 'all',
      onSelect: (id) => map.select(id),
      onOpen: (id) => navigate(`/spacecraft/${id}`),
    });
    map.setFleet(fleet);
    map.setStations(state.stations || []);
    map.setLive(live.telemetry);
    scope.add(() => map.destroy());
    live.on('telemetry', () => map.setLive(live.telemetry), scope);
    live.on('fleet', async () => map.setFleet(await loadFleet(true)), scope);
  });

  const refresh = debounce(async () => {
    try {
      dash = await api.get('/api/dashboard', null, { silent: true });
      renderAnnunciator();
      renderFeeds();
      renderCountdown();
      renderContacts();
    } catch {}
  }, 400);

  live.on('telemetry', () => (renderAnnunciator(), renderFleetRows()), scope);
  live.on('incident', refresh, scope);
  live.on('command', refresh, scope);
  live.on('launch', refresh, scope);
  scope.interval(() => (renderCountdown(), renderAnnunciator()), 1000);
  scope.interval(renderContacts, 30_000);
  scope.interval(refresh, 60_000);
  return el;
}

export function mapLegend() {
  return h(
    'div',
    { class: 'map-legend' },
    h('span', null, h('i', { class: 'k-track' }), 'Трасса полёта'),
    h('span', null, h('i', { class: 'k-link' }), 'Сеанс связи'),
    h('span', null, h('i', { class: 'k-station' }), 'Наземная станция'),
    h('span', null, h('i', { class: 'k-night' }), 'Ночная сторона'),
  );
}
