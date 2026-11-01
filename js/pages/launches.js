// Расписание запусков: предстоящие и прошедшие пуски, изменение статуса.
import { h } from '../dom.js';
import { api } from '../api.js';
import { can, options } from '../state.js';
import { getQuery, setQuery } from '../router.js';
import { fmt } from '../format.js';
import { pageHead, badge, button, seg, confirmDialog, toast, toastError } from '../ui/components.js';
import { dataTable } from '../ui/table.js';
import { launchForm } from './forms.js';

export default async function launches({ scope }) {
  const extra = {};
  const when = getQuery().when || 'upcoming';
  const applyWhen = (w) => {
    delete extra.from;
    delete extra.to;
    if (w === 'upcoming') extra.from = new Date(Date.now() - 3600_000).toISOString();
    if (w === 'past') extra.to = new Date().toISOString();
    if (table) {
      table.query.sort = 'scheduled_at';
      table.query.dir = w === 'upcoming' ? 'asc' : 'desc';
    }
  };
  let table = null;
  applyWhen(when);

  const edit = (row) => launchForm({ record: row, onDone: () => table.reload() });
  table = dataTable({
    endpoint: '/api/launches',
    searchPlaceholder: 'Название, ракета, космодром',
    filters: [{ name: 'status', label: 'Статус', options: options('launchStatuses') }],
    defaultSort: { sort: 'scheduled_at', dir: when === 'upcoming' ? 'asc' : 'desc' },
    extraQuery: extra,
    onRowClick: can.edit() ? edit : null,
    emptyText: when === 'upcoming' ? 'Предстоящих запусков нет' : 'Запусков нет',
    columns: [
      { key: 'scheduled_at', label: 'Старт', sort: true, render: (r) => h('span', null, h('span', { class: 'title tabular' }, fmt.dateTime(r.scheduled_at)), h('span', { class: 'sub' }, ['scheduled', 'go', 'hold'].includes(r.status) ? fmt.relative(r.scheduled_at) : r.window_minutes ? `окно ${r.window_minutes} мин` : '')) },
      { key: 'name', label: 'Запуск', sort: true, render: (r) => h('span', null, h('span', { class: 'title' }, r.name), h('span', { class: 'sub' }, r.vehicle)) },
      { key: 'site', label: 'Космодром', sort: true },
      { key: 'spacecraft_name', label: 'Полезная нагрузка', render: (r) => (r.spacecraft_id ? h('a', { href: `/spacecraft/${r.spacecraft_id}` }, r.spacecraft_name) : h('span', { class: 'muted' }, '—')) },
      { key: 'mission_code', label: 'Миссия', render: (r) => (r.mission_id ? h('a', { href: `/missions/${r.mission_id}` }, r.mission_code) : h('span', { class: 'muted' }, '—')) },
      { key: 'status', label: 'Статус', sort: true, render: (r) => badge('launchStatuses', r.status) },
      {
        key: 'actions',
        label: '',
        render: (r) =>
          can.remove()
            ? button(null, {
                iconName: 'trash',
                small: true,
                kind: 'ghost',
                title: 'Удалить запуск',
                onClick: async () => {
                  if (!(await confirmDialog({ title: 'Удалить запуск?', text: r.name, confirmLabel: 'Удалить', danger: true }))) return;
                  try {
                    await api.del(`/api/launches/${r.id}`);
                    toast({ title: 'Запуск удалён', tone: 'green' });
                    table.reload();
                  } catch (err) {
                    toastError(err);
                  }
                },
              })
            : null,
      },
    ],
    actions: [
      seg(
        [
          { value: 'upcoming', label: 'Предстоящие' },
          { value: 'past', label: 'Прошедшие' },
          { value: 'all', label: 'Все' },
        ],
        when,
        (w) => {
          applyWhen(w);
          setQuery({ when: w });
          table.reload();
        },
        { label: 'Период' },
      ),
      can.edit() ? button('Запланировать', { kind: 'primary', iconName: 'plus', onClick: () => launchForm({ onDone: () => table.reload() }) }) : null,
    ],
  });
  const { live } = await import('../live.js');
  live.on('launch', () => table.reload(), scope);
  return h('div', { class: 'page' }, pageHead({ title: 'Запуски', lede: 'Расписание пусков. За 15 минут до старта система объявляет готовность, в момент старта аппарат выводится на орбиту и начинает передавать телеметрию.' }), table.el);
}
