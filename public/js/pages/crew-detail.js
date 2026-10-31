// Карточка члена экипажа.
import { h } from '../dom.js';
import { api } from '../api.js';
import { can, dict } from '../state.js';
import { navigate } from '../router.js';
import { fmt } from '../format.js';
import { pageHead, panel, badge, kv, button, empty, confirmDialog, toast, toastError } from '../ui/components.js';
import { simpleTable } from '../ui/charts.js';
import { crewForm } from './forms.js';

export default async function crewDetail({ params }) {
  const c = await api.get(`/api/crew/${params.id}`);
  const actions = [];
  if (can.edit()) actions.push(button('Изменить', { iconName: 'edit', onClick: () => crewForm({ record: c, onDone: () => navigate(location.pathname, { replace: true }) }) }));
  if (can.remove())
    actions.push(
      button(null, {
        iconName: 'trash',
        kind: 'danger',
        title: 'Удалить',
        onClick: async () => {
          if (!(await confirmDialog({ title: `Удалить ${c.full_name}?`, text: 'Карточка и все назначения на миссии будут удалены.', confirmLabel: 'Удалить', danger: true }))) return;
          try {
            await api.del(`/api/crew/${c.id}`);
            toast({ title: 'Карточка удалена', tone: 'green' });
            navigate('/crew');
          } catch (err) {
            toastError(err);
          }
        },
      }),
    );
  return h(
    'div',
    { class: 'page' },
    pageHead({
      crumbs: [{ label: 'Экипаж', href: '/crew' }, { label: c.full_name }],
      title: c.full_name,
      extra: h('div', { class: 'row', style: { marginTop: '8px' } }, badge('crewStatuses', c.status), h('span', { class: 'chip' }, dict('crewPositions', c.position)), c.call_sign ? h('span', { class: 'chip' }, `позывной «${c.call_sign}»`) : null),
      actions,
    }),
    h('div', { class: 'tiles' }, tile('Космических полётов', fmt.int(c.flights_count)), tile('Часов в космосе', fmt.int(c.hours_in_space), c.hours_in_space ? `≈ ${fmt.num(c.hours_in_space / 24, 0)} сут.` : null), tile('Выходов в открытый космос', fmt.int(c.eva_count)), tile('Возраст', fmt.age(c.birth_date), c.birth_date ? `род. ${fmt.date(c.birth_date)}` : null)),
    h(
      'div',
      { class: 'grid two' },
      panel({ title: 'Анкета', body: [kv([['Гражданство', c.nationality], ['Квалификация', dict('crewPositions', c.position)], ['Статус', dict('crewStatuses', c.status)], ['Дата рождения', fmt.date(c.birth_date)]]), c.bio ? h('p', { class: 'desc', style: { marginTop: '12px' } }, c.bio) : null] }),
      panel({
        title: 'Назначения на миссии',
        flush: true,
        body: c.assignments.length
          ? simpleTable(
              [{ label: 'Миссия' }, { label: 'Роль' }, { label: 'Статус миссии' }],
              c.assignments.map((a) => [h('a', { href: `/missions/${a.id}` }, `${a.code} — ${a.name}`), dict('crewRoles', a.role), badge('missionStatuses', a.status)]),
            )
          : h('div', { class: 'panel-body' }, empty('Назначений нет')),
      }),
    ),
  );
}

function tile(label, value, delta) {
  return h('div', { class: 'tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), delta ? h('div', { class: 'delta' }, delta) : null);
}
