// Справочник космических аппаратов.
import { h } from '../dom.js';
import { can, options, dict, invalidateFleet } from '../state.js';
import { navigate } from '../router.js';
import { fmt } from '../format.js';
import { pageHead, badge, button, colorDot, lamp } from '../ui/components.js';
import { dataTable } from '../ui/table.js';
import { spacecraftForm } from './forms.js';
import { orbitClass } from '/shared/orbit.js';

export default async function spacecraftList() {
  const table = dataTable({
    endpoint: '/api/spacecraft',
    searchPlaceholder: 'Название, код, оператор',
    filters: [
      { name: 'status', label: 'Состояние', options: options('spacecraftStatuses') },
      { name: 'type', label: 'Назначение', options: options('spacecraftTypes') },
    ],
    defaultSort: { sort: 'name', dir: 'asc' },
    rowHref: (r) => `/spacecraft/${r.id}`,
    emptyText: 'Аппаратов пока нет',
    columns: [
      { key: 'name', label: 'Аппарат', sort: true, render: (r) => h('span', { class: 'row', style: { flexWrap: 'nowrap' } }, colorDot(r.color), h('span', null, h('span', { class: 'title' }, r.name), h('span', { class: 'sub' }, r.code))) },
      { key: 'type', label: 'Назначение', sort: true, render: (r) => dict('spacecraftTypes', r.type) },
      { key: 'status', label: 'Состояние', sort: true, render: (r) => badge('spacecraftStatuses', r.status) },
      { key: 'operator', label: 'Оператор', render: (r) => h('span', { class: 'sub', style: { color: 'var(--ink-2)' } }, r.operator) },
      {
        key: 'perigee_km',
        label: 'Орбита',
        sort: true,
        render: (r) => h('span', null, h('span', { class: 'title' }, orbitClass(r.perigee_km, r.apogee_km, r.inclination_deg)), h('span', { class: 'sub tabular' }, `${fmt.int(r.perigee_km)} × ${fmt.int(r.apogee_km)} км, ${fmt.num(r.inclination_deg, 1)}°`)),
      },
      { key: 'launch_date', label: 'Запуск', sort: true, render: (r) => fmt.date(r.launch_date) },
      { key: 'open_incidents', label: 'Инциденты', sort: true, num: true, defaultDir: 'desc', render: (r) => (r.open_incidents ? h('span', { class: 'row', style: { justifyContent: 'flex-end' } }, lamp('red'), r.open_incidents) : h('span', { class: 'muted' }, '0')) },
    ],
    actions: can.edit() ? [button('Добавить аппарат', { kind: 'primary', iconName: 'plus', onClick: () => spacecraftForm({ onDone: (r) => (invalidateFleet(), navigate(`/spacecraft/${r.id}`)) }) })] : [],
  });
  return h('div', { class: 'page' }, pageHead({ title: 'Космические аппараты', lede: 'Реестр флота: назначение, состояние, орбитальные элементы. Изменения сразу учитываются движком слежения.' }), table.el);
}
