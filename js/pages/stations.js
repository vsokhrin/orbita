// Справочник наземных станций.
import { h } from '../dom.js';
import { can, options, invalidateFleet } from '../state.js';
import { navigate } from '../router.js';
import { fmt } from '../format.js';
import { pageHead, badge, button } from '../ui/components.js';
import { dataTable } from '../ui/table.js';
import { stationForm } from './forms.js';

export default async function stationsList() {
  const table = dataTable({
    endpoint: '/api/stations',
    searchPlaceholder: 'Название, код, страна',
    filters: [{ name: 'status', label: 'Состояние', options: options('stationStatuses') }],
    rowHref: (r) => `/stations/${r.id}`,
    emptyText: 'Станций пока нет',
    columns: [
      { key: 'name', label: 'Станция', sort: true, render: (r) => h('span', null, h('span', { class: 'title' }, r.name), h('span', { class: 'sub' }, `${r.code}, ${r.country}`)) },
      { key: 'status', label: 'Состояние', sort: true, render: (r) => badge('stationStatuses', r.status) },
      { key: 'latitude', label: 'Координаты', sort: true, render: (r) => h('span', { class: 'tabular' }, fmt.coord(Number(r.latitude), Number(r.longitude))) },
      { key: 'antenna_diameter_m', label: 'Антенна', num: true, render: (r) => (r.antenna_diameter_m ? `${fmt.num(r.antenna_diameter_m, 1)} м` : '—') },
      { key: 'bands', label: 'Диапазоны' },
      { key: 'min_elevation_deg', label: 'Мин. угол места', num: true, render: (r) => `${fmt.num(r.min_elevation_deg, 1)}°` },
      { key: 'uplinks_week', label: 'Сеансов за неделю', sort: true, num: true, defaultDir: 'desc' },
    ],
    actions: can.edit() ? [button('Добавить станцию', { kind: 'primary', iconName: 'plus', onClick: () => stationForm({ onDone: (r) => (invalidateFleet(), navigate(`/stations/${r.id}`)) }) })] : [],
  });
  return h('div', { class: 'page' }, pageHead({ title: 'Наземные станции', lede: 'Сеть командно-измерительных пунктов. Через станции в состоянии «На связи» уходят команды и принимается телеметрия.' }), table.el);
}
