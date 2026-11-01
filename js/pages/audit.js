// Журнал аудита (только администратор): кто, что и когда изменил.
import { h } from '../dom.js';
import { can } from '../state.js';
import { fmt } from '../format.js';
import { pageHead, kv, modal, errorView } from '../ui/components.js';
import { dataTable } from '../ui/table.js';

const ACTIONS = {
  login: 'Вход',
  logout: 'Выход',
  login_failed: 'Неудачный вход',
  password_change: 'Смена пароля',
  password_reset: 'Сброс пароля',
  create: 'Создание',
  update: 'Изменение',
  delete: 'Удаление',
  assign: 'Назначение',
  unassign: 'Снятие назначения',
  acknowledge: 'Приём инцидента',
  resolve: 'Закрытие инцидента',
  command: 'Команда на борт',
  cancel: 'Отмена команды',
  launch: 'Запуск',
  seed: 'Инициализация',
};
const ENTITIES = { spacecraft: 'КА', station: 'Станция', mission: 'Миссия', crew: 'Экипаж', launch: 'Запуск', incident: 'Инцидент', command: 'Команда', user: 'Пользователь' };

export default async function audit() {
  if (!can.admin()) return errorView({ status: 403, message: 'Раздел доступен только администратору.' });
  const table = dataTable({
    endpoint: '/api/audit',
    pageSize: 50,
    searchPlaceholder: 'Пользователь, описание',
    filters: [
      { name: 'action', label: 'Действие', options: Object.entries(ACTIONS).map(([value, label]) => ({ value, label })) },
      { name: 'entity', label: 'Объект', options: Object.entries(ENTITIES).map(([value, label]) => ({ value, label })) },
    ],
    defaultSort: { sort: 'ts', dir: 'desc' },
    compact: true,
    onRowClick: (r) => details(r),
    columns: [
      { key: 'ts', label: 'Время', sort: true, defaultDir: 'desc', render: (r) => h('span', { class: 'tabular nowrap' }, fmt.dateTime(r.ts)) },
      { key: 'username', label: 'Пользователь', sort: true, render: (r) => r.username || h('span', { class: 'muted' }, '—') },
      { key: 'action', label: 'Действие', sort: true, render: (r) => h('span', { class: r.action === 'login_failed' ? 'badge crit' : r.action === 'delete' ? 'badge warn' : 'badge' }, ACTIONS[r.action] || r.action) },
      { key: 'entity', label: 'Объект', render: (r) => (r.entity ? `${ENTITIES[r.entity] || r.entity}${r.entity_id ? ' №' + r.entity_id : ''}` : '—') },
      { key: 'summary', label: 'Описание', render: (r) => r.summary || '—' },
      { key: 'ip', label: 'IP', render: (r) => h('span', { class: 'muted small' }, r.ip || '—') },
    ],
  });

  function details(r) {
    const changes = r.details && typeof r.details === 'object' ? Object.entries(r.details) : [];
    const isDiff = r.action === 'update' && changes.every(([, v]) => Array.isArray(v) && v.length === 2);
    modal({
      title: `${ACTIONS[r.action] || r.action}: запись №${r.id}`,
      body: h(
        'div',
        { class: 'stack' },
        kv([
          ['Время', fmt.dateTime(r.ts)],
          ['Пользователь', r.username || '—'],
          ['Объект', r.entity ? `${ENTITIES[r.entity] || r.entity} №${r.entity_id ?? '—'}` : '—'],
          ['Описание', r.summary || '—'],
          ['IP-адрес', r.ip || '—'],
        ]),
        changes.length
          ? h(
              'div',
              { class: 'table-wrap' },
              h(
                'table',
                { class: 'data compact' },
                h('thead', null, h('tr', null, h('th', null, 'Поле'), isDiff ? [h('th', null, 'Было'), h('th', null, 'Стало')] : h('th', null, 'Значение'))),
                h('tbody', null, changes.map(([k, v]) => h('tr', null, h('td', null, k), isDiff ? [h('td', { class: 'muted' }, fmtVal(v[0])), h('td', null, fmtVal(v[1]))] : h('td', null, fmtVal(v))))),
              ),
            )
          : null,
      ),
    });
  }
  const fmtVal = (v) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

  return h('div', { class: 'page' }, pageHead({ title: 'Журнал аудита', lede: 'Все входы в систему, изменения справочников, команды и работа с инцидентами. Щёлкните строку, чтобы увидеть изменённые поля.' }), table.el);
}
