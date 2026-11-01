// Отчёты за период: показатели, инциденты по дням и аппаратам, команды, флот, нагрузка станций, бюджет миссий.
import { h, replace } from '../dom.js';
import { api } from '../api.js';
import { dict, state } from '../state.js';
import { getQuery, setQuery } from '../router.js';
import { fmt, plural } from '../format.js';
import { pageHead, panel, seg, button } from '../ui/components.js';
import { stackedColumns, rankedBars, withTable, simpleTable } from '../ui/charts.js';

const SEVERITY_SERIES = [
  { key: 'info', label: 'Информация', color: 'var(--status-info)' },
  { key: 'warning', label: 'Предупреждение', color: 'var(--status-warning)' },
  { key: 'critical', label: 'Авария', color: 'var(--status-critical)' },
];
const ORBIT_NAMES = { LEO: 'Низкая (НОО)', SSO: 'Солнечно-синхронная', MEO: 'Средняя (СОО)', GEO: 'Геостационарная', GSO: 'Геосинхронная', HEO: 'Высокоэллиптическая' };

export default async function reports({ scope }) {
  let days = Number(getQuery().days) || 30;
  const body = h('div');
  const csvLink = button('Инциденты за период, CSV', { iconName: 'download', href: '#', download: true });

  async function load() {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    csvLink.href = api.url('/api/incidents.csv', { from: from.toISOString(), to: to.toISOString(), sort: 'created_at', dir: 'desc' });
    body.style.opacity = body.childNodes.length ? '0.55' : '1';
    const r = await api.get('/api/reports/summary', { from: from.toISOString(), to: to.toISOString() });
    body.style.opacity = '1';
    render(r);
  }

  function render(r) {
    const charts = [];
    const totalMttr = r.mttr.reduce((a, m) => a + m.mttr_min * m.n, 0) / Math.max(1, r.mttr.reduce((a, m) => a + m.n, 0));
    const totalMtta = r.mttr.reduce((a, m) => a + (m.mtta_min || 0) * m.n, 0) / Math.max(1, r.mttr.reduce((a, m) => a + m.n, 0));

    const byDay = stackedColumns({
      rows: r.incidentsByDay.map((d) => ({ label: fmt.dateShort(d.day), values: { info: d.info, warning: d.warning, critical: d.critical } })),
      series: SEVERITY_SERIES,
      label: 'Инциденты по дням',
    });
    charts.push(byDay);
    const dayView = withTable(byDay, () =>
      simpleTable(
        [{ label: 'День' }, { label: 'Информация', num: true }, { label: 'Предупреждения', num: true }, { label: 'Аварии', num: true }],
        r.incidentsByDay.map((d) => [fmt.date(d.day), d.info, d.warning, d.critical]),
      ),
    );

    const bySc = rankedBars(r.incidentsBySpacecraft.map((s) => ({ label: s.name, value: s.n, note: s.critical ? `${s.critical} авар.` : null })));
    const scView = withTable(bySc, () => simpleTable([{ label: 'Аппарат' }, { label: 'Всего', num: true }, { label: 'Аварий', num: true }], r.incidentsBySpacecraft.map((s) => [s.name, s.n, s.critical])));

    const cmdTypes = rankedBars(
      r.commandsByType.map((c) => ({ label: dict('commandTypes', c.type)?.label ?? c.type, value: c.n, note: c.failed ? `${c.failed} с ошибкой` : null })),
    );
    const typeView = withTable(cmdTypes, () => simpleTable([{ label: 'Команда' }, { label: 'Всего', num: true }, { label: 'С ошибкой', num: true }], r.commandsByType.map((c) => [dict('commandTypes', c.type)?.label ?? c.type, c.n, c.failed])));

    const orbit = Object.entries(r.fleet.byOrbit).sort((a, b) => b[1] - a[1]);
    const orbitBars = rankedBars(orbit.map(([k, n]) => ({ label: ORBIT_NAMES[k] || k, value: n })));
    const orbitView = withTable(orbitBars, () => simpleTable([{ label: 'Класс орбиты' }, { label: 'Аппаратов', num: true }], orbit.map(([k, n]) => [ORBIT_NAMES[k] || k, n])));

    const maxSt = Math.max(1, ...r.stations.map((s) => Math.max(s.n, s.forecast24h)));
    const stationsTable = simpleTable(
      [{ label: 'Станция' }, { label: 'Передач команд за период', num: true }, { label: 'Сеансов в ближайшие сутки', num: true }],
      r.stations.map((s) => [
        h('a', { href: `/stations/${s.id}` }, s.name),
        h('span', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } }, h('span', { class: 'bar', style: { display: 'inline-block', height: '8px', borderRadius: '0 4px 4px 0', background: 'var(--series-1)', width: `${(s.n / maxSt) * 90}px` } }), fmt.int(s.n)),
        fmt.int(s.forecast24h),
      ]),
    );

    const budget = r.missions.filter((m) => m.budget > 0).sort((a, b) => b.budget - a.budget);
    const budgetBars = rankedBars(budget.map((m) => ({ label: dict('missionStatuses', m.status), value: m.budget, note: `${m.n} ${plural(m.n, 'миссия', 'миссии', 'миссий')}` })), { format: (v) => `${fmt.num(v, 0)} млн ₽` });

    const mttrTable = simpleTable(
      [{ label: 'Важность' }, { label: 'Закрыто', num: true }, { label: 'Реакция, мин', num: true }, { label: 'Устранение, мин', num: true }],
      ['critical', 'warning', 'info'].map((sev) => {
        const m = r.mttr.find((x) => x.severity === sev);
        return [dict('incidentSeverities', sev), m ? m.n : 0, m?.mtta_min ?? '—', m?.mttr_min ?? '—'];
      }),
    );

    const tile = (label, value, delta) => h('div', { class: 'tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), delta ? h('div', { class: 'delta' }, delta) : null);
    const panelWith = (title, view, aside) => panel({ title, headExtra: view.toggle, aside, body: view.body });

    replace(body, 
      h(
        'div',
        { class: 'tiles' },
        tile('Инцидентов', fmt.int(r.totals.incidents), `из них аварий: ${fmt.int(r.totals.critical)}`),
        tile('Среднее время реакции', Number.isFinite(totalMtta) ? fmt.duration(totalMtta * 60) : '—', 'от регистрации до приёма в работу'),
        tile('Среднее время устранения', Number.isFinite(totalMttr) ? fmt.duration(totalMttr * 60) : '—', 'от регистрации до закрытия'),
        tile('Команд выполнено', r.totals.successRate !== null ? `${fmt.num(r.totals.successRate, 1)}%` : '—', `${fmt.int(r.totals.executed)} из ${fmt.int(r.totals.finished)} с квитанцией`),
        tile('Успешных пусков', fmt.int(r.totals.launches), `за ${days} ${plural(days, 'день', 'дня', 'дней')}`),
      ),
      h('div', { class: 'stack' }, panelWith('Инциденты по дням и важности', dayView)),
      h('div', { class: 'grid two', style: { marginTop: '16px' } }, panelWith('Инциденты по аппаратам', scView, 'топ-10'), panelWith('Команды по типам', typeView), panelWith('Флот по классам орбит', orbitView, 'на орбите'), panel({ title: 'Время реакции и устранения', body: mttrTable })),
      h('div', { class: 'grid two', style: { marginTop: '16px' } }, panel({ title: 'Нагрузка наземных станций', flush: true, body: stationsTable }), panel({ title: 'Бюджет миссий по статусам', body: budgetBars })),
      h('p', { class: 'muted small', style: { marginTop: '16px' } }, `Период: ${fmt.dateTime(r.from)} — ${fmt.dateTime(r.to)}. Сформировано: ${state.user.fullName}, ${fmt.dateTime(Date.now())}.`),
    );
    scope.add(() => charts.forEach((c) => c.dispose?.()));
  }

  const el = h(
    'div',
    { class: 'page' },
    pageHead({
      title: 'Отчёты',
      lede: 'Сводная аналитика ЦУП за выбранный период. У каждой диаграммы есть табличный вид; отчёт можно распечатать.',
      actions: [csvLink, button('Печать', { iconName: 'print', onClick: () => window.print() })],
    }),
    h(
      'div',
      { class: 'toolbar' },
      h('span', { class: 'muted' }, 'Период'),
      seg(
        [
          { value: 7, label: '7 дней' },
          { value: 30, label: '30 дней' },
          { value: 90, label: '90 дней' },
        ],
        days,
        (v) => {
          days = v;
          setQuery({ days: v });
          load();
        },
        { label: 'Период отчёта' },
      ),
    ),
    body,
  );
  await load();
  return el;
}
