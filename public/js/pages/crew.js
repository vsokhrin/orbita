// Отряд космонавтов: таблица с поиском и фильтрами.
import { h } from '../dom.js';
import { can, options, dict } from '../state.js';
import { navigate } from '../router.js';
import { fmt } from '../format.js';
import { pageHead, badge, button, monogramOf } from '../ui/components.js';
import { dataTable } from '../ui/table.js';
import { crewForm } from './forms.js';

export default async function crewList() {
  const table = dataTable({
    endpoint: '/api/crew',
    searchPlaceholder: 'ФИО, позывной, гражданство',
    filters: [
      { name: 'status', label: 'Статус', options: options('crewStatuses') },
      { name: 'position', label: 'Квалификация', options: options('crewPositions') },
    ],
    rowHref: (r) => `/crew/${r.id}`,
    emptyText: 'В отряде пока никого нет',
    columns: [
      { key: 'full_name', label: 'Член экипажа', sort: true, render: (r) => h('span', { class: 'row', style: { flexWrap: 'nowrap' } }, monogramOf(r.full_name), h('span', null, h('span', { class: 'title' }, r.full_name), h('span', { class: 'sub' }, r.call_sign ? `позывной «${r.call_sign}»` : r.nationality || ''))) },
      { key: 'position', label: 'Квалификация', sort: true, render: (r) => dict('crewPositions', r.position) },
      { key: 'status', label: 'Статус', sort: true, render: (r) => badge('crewStatuses', r.status) },
      { key: 'birth_date', label: 'Возраст', sort: true, defaultDir: 'desc', render: (r) => fmt.age(r.birth_date) },
      { key: 'flights_count', label: 'Полётов', sort: true, num: true, defaultDir: 'desc' },
      { key: 'hours_in_space', label: 'Налёт, ч', sort: true, num: true, defaultDir: 'desc', render: (r) => fmt.int(r.hours_in_space) },
      { key: 'eva_count', label: 'Выходов', sort: true, num: true, defaultDir: 'desc' },
      { key: 'missions', label: 'Текущие миссии', render: (r) => r.missions || h('span', { class: 'muted' }, '—') },
    ],
    actions: can.edit() ? [button('Добавить', { kind: 'primary', iconName: 'plus', onClick: () => crewForm({ onDone: (r) => navigate(`/crew/${r.id}`) }) })] : [],
  });
  return h('div', { class: 'page' }, pageHead({ title: 'Экипаж', lede: 'Отряд космонавтов: квалификация, налёт, выходы в открытый космос и назначения на миссии.' }), table.el);
}
