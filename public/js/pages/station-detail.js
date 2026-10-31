// Карточка наземной станции: сведения, карта с зоной видимости, график сеансов.
import { h } from '../dom.js';
import { api } from '../api.js';
import { state, can, loadFleet, invalidateFleet } from '../state.js';
import { navigate } from '../router.js';
import { fmt } from '../format.js';
import { pageHead, panel, screen, badge, kv, button, empty, confirmDialog, toast, toastError, colorDot } from '../ui/components.js';
import { simpleTable } from '../ui/charts.js';
import { WorldMap } from '../map/worldmap.js';
import { stationForm } from './forms.js';

export default async function stationDetail({ params, scope }) {
  const [st, sched] = await Promise.all([api.get(`/api/stations/${params.id}`), api.get(`/api/stations/${params.id}/schedule`, { hours: 12 })]);
  await loadFleet();
  const mapBox = h('div', { class: 'map-wrap' });
  const actions = [];
  if (can.edit()) actions.push(button('Изменить', { iconName: 'edit', onClick: () => stationForm({ record: st, onDone: () => (invalidateFleet(), navigate(location.pathname, { replace: true })) }) }));
  if (can.remove())
    actions.push(
      button(null, {
        iconName: 'trash',
        kind: 'danger',
        title: 'Удалить станцию',
        onClick: async () => {
          if (!(await confirmDialog({ title: `Удалить станцию ${st.name}?`, text: 'История команд сохранится, но потеряет ссылку на станцию.', confirmLabel: 'Удалить', danger: true }))) return;
          try {
            await api.del(`/api/stations/${st.id}`);
            invalidateFleet();
            toast({ title: 'Станция удалена', tone: 'green' });
            navigate('/stations');
          } catch (err) {
            toastError(err);
          }
        },
      }),
    );
  const page = h(
    'div',
    { class: 'page' },
    pageHead({
      crumbs: [{ label: 'Наземные станции', href: '/stations' }, { label: st.code }],
      title: st.name,
      extra: h('div', { class: 'row', style: { marginTop: '8px' } }, badge('stationStatuses', st.status), h('span', { class: 'chip' }, st.country), h('span', { class: 'chip' }, `диапазоны ${st.bands}`)),
      actions,
    }),
    h(
      'div',
      { class: 'grid side' },
      screen({ title: 'Зона видимости для низкой орбиты 500 км', body: mapBox }),
      panel({
        title: 'Сведения',
        body: [
          kv([
            ['Код', st.code],
            ['Координаты', fmt.coord(Number(st.latitude), Number(st.longitude))],
            ['Высота над морем', `${fmt.int(st.altitude_m)} м`],
            ['Антенна', st.antenna_diameter_m ? `${fmt.num(st.antenna_diameter_m, 1)} м` : '—'],
            ['Мин. угол места', `${fmt.num(st.min_elevation_deg, 1)}°`],
            ['Сеансов за неделю', fmt.int(st.uplinks_week)],
          ]),
          st.description ? h('p', { class: 'desc', style: { marginTop: '12px', marginBottom: 0 } }, st.description) : null,
          st.status !== 'online' ? h('div', { class: 'callout warn', style: { marginTop: '12px' } }, 'Станция не участвует в сеансах связи, пока её состояние не «На связи».') : null,
        ],
      }),
    ),
    panel({
      title: 'График сеансов на 12 часов',
      aside: `${sched.items.length} сеансов`,
      flush: true,
      className: 'mt',
      body: sched.items.length
        ? simpleTable(
            [{ label: 'Аппарат' }, { label: 'Начало' }, { label: 'Конец' }, { label: 'Длительность', num: true }, { label: 'Макс. угол места', num: true }],
            sched.items.map((p) => [
              h('a', { href: `/spacecraft/${p.spacecraftId}`, class: 'row', style: { flexWrap: 'nowrap' } }, colorDot(p.color), p.spacecraftName),
              p.inProgress ? h('b', { style: { color: 'var(--ok)' } }, 'идёт сейчас') : fmt.dateTime(p.aos),
              p.los ? fmt.time(p.los) : '—',
              p.continuous ? 'постоянно' : fmt.duration(p.durationS),
              `${fmt.num(p.maxElevation, 1)}°`,
            ]),
          )
        : h('div', { class: 'panel-body' }, empty(st.status === 'online' ? 'В ближайшие 12 часов аппараты не пролетают' : 'Станция выведена из графика')),
    }),
  );
  page.querySelector('.mt').style.marginTop = '16px';
  requestAnimationFrame(() => {
    const map = new WorldMap(mapBox, { tracks: 'all', stationRings: false, onOpen: (id) => navigate(`/spacecraft/${id}`), onSelect: (id) => map.select(id) });
    map.setFleet(state.fleet || []);
    map.setStations((state.stations || []).filter((s) => s.id === st.id).map((s) => ({ ...s })));
    map.setOptions({ stationRings: true, ringEmphasis: true });
    scope.add(() => map.destroy());
  });
  return page;
}
