// Слежение: полноэкранная карта, слои, прокрутка времени (прогноз положения) и панель выбранного КА.
import { h, replace } from '../dom.js';
import { api } from '../api.js';
import { live } from '../live.js';
import { state, loadFleet, dict, can } from '../state.js';
import { navigate, setQuery } from '../router.js';
import { fmt } from '../format.js';
import { pageHead, panel, screen, badge, lamp, meter, kv, colorDot, button } from '../ui/components.js';
import { WorldMap } from '../map/worldmap.js';
import { mapLegend } from './dashboard.js';
import { orbitClass } from '../../shared/orbit.js';

export default async function tracking({ scope, query }) {
  const fleet = await loadFleet(true);
  let selected = query.sc ? Number(query.sc) : null;
  let positions = [];
  let passes = [];
  let passesFor = null;

  const mapBox = h('div', { class: 'map-wrap' });
  const side = h('div', { class: 'stack' });
  const timeOut = h('output', { 'aria-live': 'polite' }, 'сейчас');
  const range = h('input', { type: 'range', min: -360, max: 1440, step: 5, value: 0, 'aria-label': 'Смещение времени на карте, минуты' });
  const nowBtn = button('Сейчас', { small: true, disabled: true, onClick: () => ((range.value = 0), applyTime()) });
  let map;

  function applyTime() {
    const min = Number(range.value);
    map?.setTimeOffset(min * 60_000);
    if (min === 0) timeOut.textContent = 'сейчас';
    else {
      const sign = min > 0 ? '+' : '−';
      const a = Math.abs(min);
      timeOut.textContent = `${sign}${Math.floor(a / 60)} ч ${a % 60} мин · ${fmt.time(Date.now() + min * 60_000)}`;
    }
    nowBtn.disabled = min === 0;
    renderSide();
  }
  range.addEventListener('input', applyTime);

  const layerBtn = (label, key, initial) => {
    const b = h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(initial) }, label);
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      if (key === 'tracks') map.setOptions({ tracks: on ? 'all' : 'selected' });
      else map.setOptions({ [key]: on });
    });
    return b;
  };

  const mapScreen = screen({
    title: 'Карта орбит',
    aside: h('div', { class: 'row' }, layerBtn('Все трассы', 'tracks', true), layerBtn('Зоны станций', 'stationRings', false), layerBtn('Подписи', 'labels', true), layerBtn('День и ночь', 'night', true)),
    body: [mapBox, bottomBar()],
  });

  function bottomBar() {
    const bar = mapLegend();
    range.id = 'scrub';
    bar.prepend(h('div', { class: 'time-scrub', style: { marginRight: 'auto' } }, h('label', { for: 'scrub' }, 'Время на карте'), range, timeOut, nowBtn));
    return bar;
  }

  function select(id) {
    selected = id;
    setQuery({ sc: id || '' });
    map?.select(id);
    passes = [];
    passesFor = null;
    renderSide();
    if (id) loadPasses(id);
  }

  async function loadPasses(id) {
    try {
      const r = await api.get(`/api/spacecraft/${id}/passes`, { hours: 12 }, { silent: true });
      if (selected !== id) return;
      passes = r.items;
      passesFor = id;
      renderSide();
    } catch {}
  }

  function renderSide() {
    const offset = Number(range.value) * 60_000;
    if (!selected) {
      const inOrbit = fleet.filter((f) => !['planned', 'lost'].includes(f.status));
      replace(side, 
        panel({
          title: 'Аппараты на орбите',
          aside: `${inOrbit.length}`,
          flush: true,
          body: h(
            'ul',
            { class: 'contact-list' },
            inOrbit.map((sc) => {
              const t = live.telemetry.get(sc.id);
              return h(
                'li',
                { style: { cursor: 'pointer' }, tabindex: 0, onclick: () => select(sc.id), onkeydown: (e) => e.key === 'Enter' && select(sc.id) },
                h('span', { class: 'row', style: { flexWrap: 'nowrap' } }, colorDot(sc.color), sc.name),
                h('span', { class: 'when' }, t?.link ? h('span', { class: 'row' }, lamp('green'), 'связь') : sc.status === 'decommissioned' ? h('span', { class: 'muted' }, 'пассивен') : h('span', { class: 'muted' }, 'нет связи')),
              );
            }),
          ),
        }),
        h('p', { class: 'muted small' }, 'Щёлкните аппарат на карте или в списке. Ползунок времени показывает, где аппараты будут через несколько часов — расчёт по орбитальным элементам.'),
      );
      return;
    }
    const sc = fleet.find((f) => f.id === selected);
    if (!sc) return select(null);
    const pos = positions.find((p) => p.sc.id === selected);
    const t = live.telemetry.get(selected);
    const now = Date.now() + offset;
    const upcoming = passes.filter((p) => (p.los ?? Infinity) > now).slice(0, 5);
    replace(side, 
      panel({
        title: h('span', { class: 'row', style: { flexWrap: 'nowrap' } }, colorDot(sc.color), sc.name),
        aside: button(null, { iconName: 'close', small: true, kind: 'ghost', title: 'Снять выбор', onClick: () => select(null) }),
        body: [
          h('div', { class: 'row', style: { marginBottom: '10px' } }, badge('spacecraftStatuses', t?.status ?? sc.status), h('span', { class: 'chip' }, orbitClass(sc.perigee_km, sc.apogee_km, sc.inclination_deg)), offset ? h('span', { class: 'chip' }, 'прогноз') : null),
          pos
            ? kv([
                ['Высота', `${fmt.int(pos.st.alt)} км`],
                ['Скорость', `${fmt.fixed(pos.st.speed, 3)} км/с`],
                ['Координаты', fmt.coord(pos.st.lat, pos.st.lon)],
                ['Освещённость', pos.st.sunlit ? 'на Солнце' : 'в тени Земли'],
                ['Связь', pos.link ? `${pos.link.station.name}, угол места ${fmt.int(pos.link.elevation)}°` : 'вне зоны станций'],
                !offset && t && !t.inactive ? ['Заряд АКБ', meter(t.battery)] : null,
                !offset && t && !t.inactive ? ['Температура', `${fmt.fixed(t.temperature, 1)} °C`] : null,
                !offset && t?.faults?.length ? ['Неисправности', t.faults.map((f) => dict('faults', f)?.short ?? f).join(', ')] : null,
              ])
            : h('div', { class: 'muted' }, 'Нет данных о положении'),
          h('div', { class: 'row', style: { marginTop: '12px' } }, button('Карточка аппарата', { href: `/spacecraft/${sc.id}`, small: true }), can.edit() && sc.status !== 'decommissioned' ? button('Отправить команду', { href: `/commands?sc=${sc.id}`, small: true, kind: 'primary' }) : null),
        ],
      }),
      panel({
        title: 'Сеансы связи',
        aside: 'на 12 часов',
        flush: true,
        body: passesFor !== selected
          ? h('div', { class: 'muted small', style: { padding: '12px 16px' } }, 'Расчёт…')
          : upcoming.length
            ? h(
                'ul',
                { class: 'contact-list' },
                upcoming.map((p) =>
                  h(
                    'li',
                    null,
                    h('span', null, p.stationName),
                    h('span', { class: ['when', p.aos <= now && 'now'] }, p.continuous ? 'постоянно' : p.aos <= now ? 'идёт сейчас' : fmt.time(p.aos)),
                    h('span', { class: 'muted small' }, `макс. ${fmt.num(p.maxElevation, 1)}°`),
                    h('span', { class: 'muted small when' }, p.continuous ? 'в зоне весь период' : fmt.duration(p.durationS)),
                  ),
                ),
              )
            : h('div', { class: 'muted small', style: { padding: '12px 16px' } }, 'Сеансов не ожидается'),
      }),
    );
  }

  const el = h('div', { class: 'page' }, pageHead({ title: 'Слежение', lede: 'Положение аппаратов, трассы полёта, зоны видимости и сеансы связи с наземными станциями.' }), h('div', { class: 'grid side' }, mapScreen, side));

  requestAnimationFrame(() => {
    map = new WorldMap(mapBox, {
      tracks: 'all',
      onSelect: (id) => select(id),
      onOpen: (id) => navigate(`/spacecraft/${id}`),
      onSelectStation: (id) => navigate(`/stations/${id}`),
      onFrame: (t, pos) => (positions = pos),
    });
    map.setFleet(fleet);
    map.setStations(state.stations || []);
    map.setLive(live.telemetry);
    if (selected) map.select(selected);
    scope.add(() => map.destroy());
    renderSide();
  });
  if (selected) loadPasses(selected);

  live.on('telemetry', () => (map?.setLive(live.telemetry), renderSide()), scope);
  live.on('fleet', async () => {
    const f = await loadFleet(true);
    fleet.splice(0, fleet.length, ...f);
    map?.setFleet(f);
    map?.setStations(state.stations || []);
  }, scope);
  return el;
}
