// Карточка миссии: сведения, назначение экипажа (многие-ко-многим), связанные запуски.
import { h } from '../dom.js';
import { api } from '../api.js';
import { can, dict, options } from '../state.js';
import { navigate } from '../router.js';
import { fmt } from '../format.js';
import { pageHead, panel, badge, kv, button, empty, confirmDialog, toast, toastError, progress, monogramOf } from '../ui/components.js';
import { openForm } from '../ui/form.js';
import { simpleTable } from '../ui/charts.js';
import { missionForm } from './forms.js';

export default async function missionDetail({ params }) {
  const m = await api.get(`/api/missions/${params.id}`);
  const reload = () => navigate(location.pathname, { replace: true });

  const crewPanel = panel({
    title: 'Экипаж миссии',
    aside: can.edit() ? button('Назначить', { small: true, iconName: 'plus', onClick: assign }) : null,
    flush: true,
    body: m.crew.length
      ? h(
          'ul',
          { class: 'feed' },
          m.crew.map((c) =>
            h(
              'li',
              null,
              monogramOf(c.full_name),
              h('div', null, h('a', { class: 'title', href: `/crew/${c.id}` }, c.full_name), h('div', { class: 'meta' }, `${dict('crewRoles', c.role)}${c.call_sign ? ` · позывной «${c.call_sign}»` : ''}`)),
              can.edit()
                ? button(null, {
                    iconName: 'close',
                    small: true,
                    kind: 'ghost',
                    title: `Снять ${c.full_name} с миссии`,
                    onClick: async () => {
                      if (!(await confirmDialog({ title: 'Снять с миссии?', text: `${c.full_name} будет исключён(а) из экипажа миссии ${m.code}.`, confirmLabel: 'Снять', danger: true }))) return;
                      try {
                        await api.del(`/api/missions/${m.id}/crew/${c.id}`);
                        reload();
                      } catch (err) {
                        toastError(err);
                      }
                    },
                  })
                : h('span', { class: 'side' }, dict('crewStatuses', c.status)),
            ),
          ),
        )
      : h('div', { class: 'panel-body' }, empty('Экипаж не назначен', m.status === 'completed' ? null : 'Для пилотируемой миссии назначьте командира и бортинженеров.')),
  });

  async function assign() {
    const crew = await api.get('/api/crew', { limit: 500, sort: 'full_name' });
    const assigned = new Set(m.crew.map((c) => c.id));
    openForm({
      title: `Назначить в миссию ${m.code}`,
      narrow: true,
      fields: [
        { name: 'crew_id', label: 'Член экипажа', type: 'select', numeric: true, required: true, span: 2, options: crew.items.filter((c) => c.status !== 'retired' && !assigned.has(c.id)).map((c) => ({ value: c.id, label: `${c.full_name} — ${dict('crewStatuses', c.status).toLowerCase()}` })) },
        { name: 'role', label: 'Роль в миссии', type: 'select', required: true, span: 2, options: options('crewRoles') },
      ],
      submitLabel: 'Назначить',
      successMessage: 'Назначение сохранено',
      submit: (data) => api.post(`/api/missions/${m.id}/crew`, data),
      onDone: reload,
    });
  }

  const actions = [];
  if (can.edit()) actions.push(button('Изменить', { iconName: 'edit', onClick: () => missionForm({ record: m, onDone: reload }) }));
  if (can.remove())
    actions.push(
      button(null, {
        iconName: 'trash',
        kind: 'danger',
        title: 'Удалить миссию',
        onClick: async () => {
          if (!(await confirmDialog({ title: `Удалить миссию ${m.code}?`, text: 'Назначения экипажа будут удалены, запуски потеряют ссылку на миссию.', confirmLabel: 'Удалить', danger: true }))) return;
          try {
            await api.del(`/api/missions/${m.id}`);
            toast({ title: 'Миссия удалена', tone: 'green' });
            navigate('/missions');
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
      crumbs: [{ label: 'Миссии', href: '/missions' }, { label: m.code }],
      title: m.name,
      extra: h('div', { class: 'row', style: { marginTop: '8px' } }, badge('missionStatuses', m.status), badge('priorities', m.priority, { lamp: false }), h('span', { class: 'chip' }, m.code)),
      actions,
    }),
    h(
      'div',
      { class: 'grid side' },
      h(
        'div',
        { class: 'stack' },
        panel({
          title: 'Сведения',
          body: [
            kv(
              [
                ['Аппарат', m.spacecraft_id ? h('a', { href: `/spacecraft/${m.spacecraft_id}` }, `${m.spacecraft_name} (${m.spacecraft_code})`) : '—'],
                ['Руководитель полёта', m.flight_director],
                ['Начало', fmt.date(m.start_date)],
                ['Окончание', m.end_date ? fmt.date(m.end_date) : 'бессрочно'],
                ['Выполнение', h('div', { class: 'row' }, progress(m.progress), `${m.progress}%`)],
                ['Бюджет', m.budget_mln !== null ? `${fmt.num(m.budget_mln, 2)} млн ₽` : '—'],
              ],
              { cols2: true },
            ),
            m.objective ? h('div', { style: { marginTop: '14px' } }, h('h3', null, 'Цель'), h('p', { class: 'desc' }, m.objective)) : null,
            m.description ? h('div', { style: { marginTop: '10px' } }, h('h3', null, 'Описание'), h('p', { class: 'desc' }, m.description)) : null,
          ],
        }),
        panel({
          title: 'Запуски миссии',
          flush: true,
          body: m.launches.length
            ? simpleTable(
                [{ label: 'Старт' }, { label: 'Запуск' }, { label: 'Космодром' }, { label: 'Статус' }],
                m.launches.map((l) => [fmt.dateTime(l.scheduled_at), l.name, l.site, badge('launchStatuses', l.status)]),
              )
            : h('div', { class: 'panel-body' }, empty('Запусков нет')),
        }),
      ),
      crewPanel,
    ),
  );
}
