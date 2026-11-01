// Справочник миссий.
import { h } from '../dom.js';
import { can, options } from '../state.js';
import { navigate } from '../router.js';
import { fmt } from '../format.js';
import { pageHead, badge, button, progress } from '../ui/components.js';
import { dataTable } from '../ui/table.js';
import { missionForm } from './forms.js';

export default async function missionsList() {
  const table = dataTable({
    endpoint: '/api/missions',
    searchPlaceholder: 'Код, название, аппарат, руководитель',
    filters: [
      { name: 'status', label: 'Статус', options: options('missionStatuses') },
      { name: 'priority', label: 'Приоритет', options: options('priorities') },
    ],
    rowHref: (r) => `/missions/${r.id}`,
    emptyText: 'Миссий пока нет',
    columns: [
      { key: 'code', label: 'Миссия', sort: true, render: (r) => h('span', null, h('span', { class: 'title' }, r.name), h('span', { class: 'sub' }, r.code)) },
      { key: 'spacecraft_name', label: 'Аппарат', render: (r) => (r.spacecraft_id ? h('a', { href: `/spacecraft/${r.spacecraft_id}` }, r.spacecraft_name) : h('span', { class: 'muted' }, '—')) },
      { key: 'status', label: 'Статус', sort: true, render: (r) => badge('missionStatuses', r.status) },
      { key: 'priority', label: 'Приоритет', sort: true, defaultDir: 'desc', render: (r) => badge('priorities', r.priority, { lamp: false }) },
      { key: 'start_date', label: 'Сроки', sort: true, render: (r) => h('span', { class: 'tabular' }, `${fmt.date(r.start_date)} — ${r.end_date ? fmt.date(r.end_date) : 'бессрочно'}`) },
      { key: 'progress', label: 'Выполнение', sort: true, defaultDir: 'desc', render: (r) => h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, progress(r.progress), h('span', { class: 'tabular small' }, `${r.progress}%`)) },
      { key: 'crew_count', label: 'Экипаж', num: true, render: (r) => (r.crew_count ? r.crew_count : h('span', { class: 'muted' }, '—')) },
      { key: 'budget_mln', label: 'Бюджет, млн ₽', sort: true, num: true, defaultDir: 'desc', render: (r) => fmt.num(r.budget_mln, 1) },
    ],
    actions: can.edit() ? [button('Новая миссия', { kind: 'primary', iconName: 'plus', onClick: () => missionForm({ onDone: (r) => navigate(`/missions/${r.id}`) }) })] : [],
  });
  return h('div', { class: 'page' }, pageHead({ title: 'Миссии', lede: 'Программы полётов: цели, аппараты, экипажи, сроки и бюджет.' }), table.el);
}
