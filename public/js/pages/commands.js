// Командный пульт: очередь команд в реальном времени, постановка новой команды, журнал исполнения.
import { h, debounce, replace } from '../dom.js';
import { api } from '../api.js';
import { live } from '../live.js';
import { can, dict, options, state } from '../state.js';
import { getQuery, setQuery } from '../router.js';
import { fmt } from '../format.js';
import { pageHead, panel, badge, button, lamp, toast, toastError } from '../ui/components.js';
import { dataTable } from '../ui/table.js';
import { commandDialog } from './command-dialog.js';

export default async function commands({ scope }) {
  const fleet = await api.get('/api/spacecraft', { limit: 500, sort: 'name' }, { silent: true });
  const queueBox = h('ul', { class: 'feed' });

  const table = dataTable({
    endpoint: '/api/commands',
    searchPlaceholder: 'Аппарат, результат, оператор',
    filters: [
      { name: 'status', label: 'Статус', options: options('commandStatuses') },
      { name: 'type', label: 'Команда', options: Object.entries(state.meta.commandTypes).map(([value, t]) => ({ value, label: t.label })) },
      { name: 'spacecraft_id', label: 'Аппарат', options: fleet.items.map((s) => ({ value: s.id, label: s.name })) },
    ],
    defaultSort: { sort: 'created_at', dir: 'desc' },
    emptyText: 'Команд ещё не было',
    columns: [
      { key: 'id', label: '№', num: true },
      { key: 'created_at', label: 'Создана', sort: true, defaultDir: 'desc', render: (r) => h('span', { class: 'tabular' }, fmt.dateTime(r.created_at)) },
      { key: 'spacecraft_name', label: 'Аппарат', sort: true, render: (r) => h('a', { href: `/spacecraft/${r.spacecraft_id}` }, r.spacecraft_name) },
      { key: 'type', label: 'Команда', sort: true, render: (r) => h('span', null, h('span', { class: 'title' }, dict('commandTypes', r.type)?.label ?? r.type), r.params?.delta_km ? h('span', { class: 'sub' }, `${r.params.delta_km > 0 ? '+' : ''}${r.params.delta_km} км`) : null) },
      { key: 'status', label: 'Статус', sort: true, render: (r) => badge('commandStatuses', r.status) },
      { key: 'station_name', label: 'Через станцию', render: (r) => r.station_name || h('span', { class: 'muted' }, '—') },
      { key: 'result', label: 'Результат', render: (r) => h('span', { class: 'small' }, r.result || (r.status === 'queued' ? `ждёт сеанса до ${fmt.time(r.expires_at)}` : '—')) },
      { key: 'issued_by_name', label: 'Оператор', render: (r) => r.issued_by_name || '—' },
    ],
    actions: can.edit() ? [button('Новая команда', { kind: 'primary', iconName: 'send', onClick: () => commandDialog({ onDone: refresh }) })] : [],
  });

  async function renderQueue() {
    const [q, u] = await Promise.all([api.get('/api/commands', { status: 'queued', limit: 50, sort: 'created_at', dir: 'asc' }, { silent: true }), api.get('/api/commands', { status: 'uplinked', limit: 20 }, { silent: true })]);
    const items = [...u.items, ...q.items];
    if (!items.length) {
      replace(queueBox, h('li', null, h('span'), h('div', { class: 'muted' }, 'Очередь пуста. Команды уходят на борт, как только аппарат входит в зону станции.'), h('span')));
      return;
    }
    replace(queueBox, 
      ...items.map((c) => {
        const t = live.telemetry.get(c.spacecraft_id);
        const status = c.status === 'uplinked' ? 'исполняется на борту' : t?.link ? 'аппарат на связи — передача' : 'ждёт сеанса связи';
        return h(
          'li',
          null,
          lamp(c.status === 'uplinked' ? 'amber' : t?.link ? 'green' : 'white', { blink: c.status === 'uplinked' }),
          h('div', null, h('div', { class: 'title' }, `№${c.id} ${dict('commandTypes', c.type)?.label ?? c.type}`), h('div', { class: 'meta' }, `${c.spacecraft_name} · ${status} · истекает ${fmt.relative(c.expires_at)}`)),
          can.edit() && c.status === 'queued'
            ? button('Отменить', {
                small: true,
                onClick: async () => {
                  try {
                    await api.post(`/api/commands/${c.id}/cancel`);
                    toast({ title: 'Команда отменена', tone: 'green', timeout: 3000 });
                    refresh();
                  } catch (err) {
                    toastError(err);
                  }
                },
              })
            : h('span', { class: 'side' }, fmt.time(c.uplinked_at || c.created_at)),
        );
      }),
    );
  }

  const refresh = debounce(() => {
    table.reload();
    renderQueue();
  }, 300);
  live.on('command', refresh, scope);
  scope.interval(renderQueue, 15_000);
  renderQueue();

  const q = getQuery();
  if (q.sc && can.edit()) {
    const sc = fleet.items.find((s) => s.id === Number(q.sc));
    setQuery({ sc: '' });
    if (sc) commandDialog({ spacecraft: sc, onDone: refresh });
  }

  return h(
    'div',
    { class: 'page' },
    pageHead({ title: 'Командный пульт', lede: 'Команда уходит на борт только во время сеанса связи с наземной станцией. До этого она ждёт в очереди, а по истечении срока снимается.' }),
    h('div', { class: 'grid side', style: { marginBottom: '16px' } }, panel({ title: 'Очередь передачи', flush: true, body: queueBox }), howItWorks()),
    table.el,
  );
}

function howItWorks() {
  return panel({
    title: 'Как исполняется команда',
    body: h(
      'ol',
      { class: 'small', style: { margin: 0, paddingLeft: '18px', color: 'var(--ink-2)', lineHeight: 1.6 } },
      h('li', null, 'Оператор ставит команду в очередь — она получает срок действия.'),
      h('li', null, 'Когда аппарат входит в зону станции «На связи», команда уходит на борт.'),
      h('li', null, 'Через несколько секунд приходит квитанция: «Выполнена» или «Ошибка» с причиной.'),
      h('li', null, 'Команда-устранение автоматически закрывает связанный инцидент.'),
    ),
  });
}
