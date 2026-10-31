// Управление пользователями (только администратор).
import { h, replace } from '../dom.js';
import { api } from '../api.js';
import { can, options, state, dict } from '../state.js';
import { fmt } from '../format.js';
import { pageHead, panel, badge, button, confirmDialog, toast, toastError, errorView, monogramOf } from '../ui/components.js';
import { openForm } from '../ui/form.js';

export default async function users() {
  if (!can.admin()) return errorView({ status: 403, message: 'Раздел доступен только администратору.' });
  const host = h('div');

  async function load() {
    const r = await api.get('/api/users');
    replace(host, 
      panel({
        flush: true,
        body: h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'data' },
            h('thead', null, h('tr', null, ['Пользователь', 'Роль', 'Состояние', 'Последний вход', 'Активных сессий', ''].map((l, i) => h('th', { class: i === 4 && 'num', scope: 'col' }, l)))),
            h(
              'tbody',
              null,
              r.items.map((u) =>
                h(
                  'tr',
                  null,
                  h('td', null, h('span', { class: 'row', style: { flexWrap: 'nowrap' } }, monogramOf(u.full_name), h('span', null, h('span', { class: 'title' }, u.full_name), h('span', { class: 'sub' }, u.username + (u.id === state.user.id ? ' — это вы' : ''))))),
                  h('td', null, badge('roles', u.role, { lamp: false })),
                  h('td', null, u.is_active ? h('span', { class: 'badge ok' }, h('i', { class: 'lamp' }), 'Активен') : h('span', { class: 'badge crit' }, h('i', { class: 'lamp' }), 'Заблокирован')),
                  h('td', { class: 'tabular' }, u.last_login_at ? fmt.dateTime(u.last_login_at) : h('span', { class: 'muted' }, 'не входил')),
                  h('td', { class: 'num' }, u.sessions),
                  h(
                    'td',
                    null,
                    h(
                      'div',
                      { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
                      button(null, { iconName: 'edit', small: true, kind: 'ghost', title: `Изменить ${u.username}`, onClick: () => editUser(u) }),
                      button(null, { iconName: 'key', small: true, kind: 'ghost', title: `Сбросить пароль ${u.username}`, onClick: () => resetPassword(u) }),
                      u.id !== state.user.id ? button(null, { iconName: 'trash', small: true, kind: 'ghost', title: `Удалить ${u.username}`, onClick: () => removeUser(u) }) : null,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      }),
      panel({
        title: 'Права ролей',
        className: 'roles-panel',
        body: h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'data compact' },
            h('thead', null, h('tr', null, h('th', null, 'Действие'), ['observer', 'operator', 'admin'].map((r) => h('th', null, dict('roles', r))))),
            h(
              'tbody',
              null,
              [
                ['Просмотр справочников, карты, телеметрии и отчётов', 1, 1, 1],
                ['Создание и изменение записей справочников', 0, 1, 1],
                ['Команды на борт, работа с инцидентами', 0, 1, 1],
                ['Удаление записей', 0, 0, 1],
                ['Пользователи и журнал аудита', 0, 0, 1],
              ].map(([label, ...v]) => h('tr', null, h('td', null, label), v.map((x) => h('td', null, x ? '✓' : h('span', { class: 'muted' }, '—'))))),
            ),
          ),
        ),
      }),
    );
    host.querySelector('.roles-panel').style.marginTop = '16px';
  }

  function editUser(u) {
    openForm({
      title: `Изменить: ${u.username}`,
      narrow: true,
      fields: [
        { name: 'full_name', label: 'Имя', required: true, span: 2 },
        { name: 'role', label: 'Роль', type: 'select', required: true, options: options('roles'), span: 2, help: u.id === state.user.id ? 'Свою роль администратора снять нельзя' : 'При смене роли пользователь будет разлогинен' },
        { name: 'is_active', label: 'Учётная запись активна', type: 'checkbox', span: 2 },
      ],
      values: u,
      successMessage: 'Пользователь обновлён',
      submit: (d) => api.put(`/api/users/${u.id}`, d),
      onDone: load,
    });
  }

  function resetPassword(u) {
    openForm({
      title: `Новый пароль: ${u.username}`,
      narrow: true,
      fields: [{ name: 'password', label: 'Новый пароль', type: 'password', required: true, span: 2, help: 'Не короче 8 символов, буквы и цифры. Все сессии пользователя будут завершены.' }],
      submitLabel: 'Сменить пароль',
      successMessage: 'Пароль изменён',
      submit: (d) => api.post(`/api/users/${u.id}/password`, d),
      onDone: load,
    });
  }

  async function removeUser(u) {
    if (!(await confirmDialog({ title: `Удалить ${u.username}?`, text: 'Записи журналов сохранятся с именем пользователя. Чтобы временно закрыть доступ, лучше заблокировать учётную запись.', confirmLabel: 'Удалить', danger: true }))) return;
    try {
      await api.del(`/api/users/${u.id}`);
      toast({ title: 'Пользователь удалён', tone: 'green' });
      load();
    } catch (err) {
      toastError(err);
    }
  }

  function createUser() {
    openForm({
      title: 'Новый пользователь',
      fields: [
        { name: 'full_name', label: 'Имя', required: true },
        { name: 'username', label: 'Логин', required: true, help: 'Латиница, цифры, «_», «.», «-»' },
        { name: 'role', label: 'Роль', type: 'select', required: true, options: options('roles'), default: 'observer' },
        { name: 'password', label: 'Пароль', type: 'password', required: true, help: 'Не короче 8 символов, буквы и цифры' },
      ],
      submitLabel: 'Создать',
      successMessage: 'Пользователь создан',
      submit: (d) => api.post('/api/users', d),
      onDone: load,
    });
  }

  await load();
  return h('div', { class: 'page' }, pageHead({ title: 'Пользователи', lede: 'Учётные записи и роли. Пароли хранятся только в виде хэша scrypt.', actions: [button('Добавить пользователя', { kind: 'primary', iconName: 'plus', onClick: createUser })] }), host);
}
