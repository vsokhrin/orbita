// Журнал инцидентов: фильтры, карточка в боковой панели, приём в работу, закрытие, рекомендуемая команда.
import { h, debounce } from '../dom.js';
import { api } from '../api.js';
import { live } from '../live.js';
import { can, options, state } from '../state.js';
import { getQuery, setQuery } from '../router.js';
import { fmt } from '../format.js';
import { pageHead, badge, button, kv, modal, confirmDialog, toast, toastError, lamp } from '../ui/components.js';
import { dataTable } from '../ui/table.js';
import { openForm } from '../ui/form.js';
import { incidentForm } from './forms.js';
import { commandDialog } from './command-dialog.js';

export default async function incidents({ scope }) {
  let drawer = null;
  const table = dataTable({
    endpoint: '/api/incidents',
    searchPlaceholder: 'Описание, аппарат, станция',
    filters: [
      { name: 'status', label: 'Статус', options: options('incidentStatuses') },
      { name: 'severity', label: 'Важность', options: options('incidentSeverities') },
      { name: 'source', label: 'Источник', options: [{ value: 'auto', label: 'Автоматически' }, { value: 'manual', label: 'Оператор' }] },
    ],
    onRowClick: (r) => open(r.id),
    emptyText: 'Инцидентов нет',
    columns: [
      { key: 'created_at', label: 'Время', sort: true, defaultDir: 'desc', render: (r) => h('span', null, h('span', { class: 'title tabular' }, fmt.dateTime(r.created_at)), h('span', { class: 'sub' }, fmt.relative(r.created_at))) },
      { key: 'severity', label: 'Важность', sort: true, defaultDir: 'desc', render: (r) => badge('incidentSeverities', r.severity) },
      { key: 'title', label: 'Инцидент', sort: true, render: (r) => h('span', null, h('span', { class: 'title' }, r.title), h('span', { class: 'sub' }, [r.spacecraft_name, r.station_name].filter(Boolean).join(', ') || '—')) },
      { key: 'status', label: 'Статус', sort: true, render: (r) => badge('incidentStatuses', r.status) },
      { key: 'source', label: 'Источник', render: (r) => (r.source === 'auto' ? 'Автоматически' : r.created_by_name || 'Оператор') },
      { key: 'resolved_at', label: 'Закрыт', render: (r) => (r.resolved_at ? h('span', { class: 'tabular' }, fmt.dateTime(r.resolved_at)) : h('span', { class: 'muted' }, '—')) },
    ],
    actions: can.edit() ? [button('Зарегистрировать', { kind: 'primary', iconName: 'plus', onClick: () => incidentForm({ onDone: (r) => (table.reload(), open(r.id)) }) })] : [],
  });

  async function open(id) {
    setQuery({ open: id });
    let inc;
    try {
      inc = await api.get(`/api/incidents/${id}`);
    } catch (err) {
      toastError(err);
      setQuery({ open: '' });
      return;
    }
    const body = renderIncident(inc);
    if (drawer) drawer.setBody(body);
    else {
      drawer = modal({
        title: 'Инцидент №' + inc.id,
        drawer: true,
        body,
        onClose: () => {
          drawer = null;
          setQuery({ open: '' });
        },
      });
    }
  }

  function renderIncident(inc) {
    const fault = inc.kind ? state.meta.faults[inc.kind] : null;
    const fixType = fault?.fix;
    const scInOrbit = inc.spacecraft_id && (live.telemetry.get(inc.spacecraft_id) && !live.telemetry.get(inc.spacecraft_id).inactive);
    const actions = [];
    if (can.edit() && inc.status === 'open') actions.push(button('Принять в работу', { kind: 'primary', onClick: () => act(() => api.post(`/api/incidents/${inc.id}/ack`), 'Инцидент принят в работу') }));
    if (can.edit() && fixType && inc.status !== 'resolved' && scInOrbit)
      actions.push(
        button(`Команда «${state.meta.commandTypes[fixType].label}»`, {
          iconName: 'send',
          kind: inc.status === 'open' ? null : 'primary',
          onClick: async () => {
            const sc = await api.get(`/api/spacecraft/${inc.spacecraft_id}`);
            commandDialog({ spacecraft: sc, type: fixType, incidentId: inc.id });
          },
        }),
      );
    if (can.edit() && inc.status !== 'resolved')
      actions.push(
        button('Закрыть', {
          iconName: 'check',
          onClick: () =>
            openForm({
              title: 'Закрыть инцидент',
              narrow: true,
              fields: [{ name: 'resolution', label: 'Что сделано', type: 'textarea', required: true, span: 2, rows: 4, placeholder: 'Причина и принятые меры' }],
              submitLabel: 'Закрыть инцидент',
              successMessage: 'Инцидент закрыт',
              submit: (d) => api.post(`/api/incidents/${inc.id}/resolve`, d),
              onDone: () => (table.reload(), open(inc.id)),
            }),
        }),
      );
    if (can.edit()) actions.push(button(null, { iconName: 'edit', title: 'Изменить', onClick: () => incidentForm({ record: inc, onDone: () => (table.reload(), open(inc.id)) }) }));
    if (can.remove())
      actions.push(
        button(null, {
          iconName: 'trash',
          kind: 'danger',
          title: 'Удалить',
          onClick: async () => {
            if (!(await confirmDialog({ title: 'Удалить инцидент?', text: inc.title, confirmLabel: 'Удалить', danger: true }))) return;
            try {
              await api.del(`/api/incidents/${inc.id}`);
              drawer?.close();
              table.reload();
              toast({ title: 'Инцидент удалён', tone: 'green' });
            } catch (err) {
              toastError(err);
            }
          },
        }),
      );

    async function act(fn, msg) {
      try {
        await fn();
        toast({ title: msg, tone: 'green', timeout: 3000 });
        table.reload();
        open(inc.id);
      } catch (err) {
        toastError(err);
      }
    }

    return h(
      'div',
      { class: 'stack' },
      h('div', null, h('h2', { style: { fontSize: '17px', marginBottom: '8px' } }, inc.title), h('div', { class: 'row' }, badge('incidentSeverities', inc.severity), badge('incidentStatuses', inc.status), h('span', { class: 'chip' }, inc.source === 'auto' ? 'обнаружен автоматически' : 'зарегистрирован оператором'))),
      inc.description ? h('p', { class: 'desc', style: { margin: 0 } }, inc.description) : null,
      fixType && inc.status !== 'resolved'
        ? h('div', { class: 'callout' }, lamp('blue'), h('span', null, 'Рекомендуемое действие — команда ', h('b', null, `«${state.meta.commandTypes[fixType].label}»`), '. После её выполнения инцидент закроется автоматически.'))
        : null,
      actions.length ? h('div', { class: 'row' }, actions) : null,
      kv([
        ['Аппарат', inc.spacecraft_id ? h('a', { href: `/spacecraft/${inc.spacecraft_id}` }, inc.spacecraft_name) : '—'],
        ['Станция', inc.station_id ? h('a', { href: `/stations/${inc.station_id}` }, inc.station_name) : '—'],
        ['Зарегистрирован', `${fmt.dateTime(inc.created_at)}${inc.created_by_name ? ', ' + inc.created_by_name : ''}`],
        ['Принят в работу', inc.acknowledged_at ? `${fmt.dateTime(inc.acknowledged_at)}, ${inc.acknowledged_by_name || 'система'}` : '—'],
        ['Закрыт', inc.resolved_at ? `${fmt.dateTime(inc.resolved_at)}, ${inc.resolved_by_name || 'система'}` : '—'],
        ['Время реакции', inc.acknowledged_at ? fmt.duration((Date.parse(inc.acknowledged_at) - Date.parse(inc.created_at)) / 1000) : '—'],
        ['Время устранения', inc.resolved_at ? fmt.duration((Date.parse(inc.resolved_at) - Date.parse(inc.created_at)) / 1000) : '—'],
      ]),
      inc.resolution ? h('div', null, h('h3', null, 'Решение'), h('p', { class: 'desc' }, inc.resolution)) : null,
    );
  }

  const reload = debounce(() => {
    table.reload();
    const id = Number(getQuery().open);
    if (drawer && id) open(id);
  }, 600);
  live.on('incident', reload, scope);
  scope.add(() => drawer?.close());
  const q = getQuery();
  if (q.open) open(Number(q.open));
  return h('div', { class: 'page' }, pageHead({ title: 'Инциденты', lede: 'Журнал нештатных ситуаций. Система сама регистрирует отказы по телеметрии и закрывает их, когда параметры возвращаются в норму или выполнена команда-устранение.' }), table.el);
}
