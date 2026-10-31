// Карточка космического аппарата: живые показания, паспорт, телеметрия, орбита, сеансы, команды, инциденты.
import { h, replace } from '../dom.js';
import { api } from '../api.js';
import { live } from '../live.js';
import { state, can, dict, invalidateFleet, loadFleet } from '../state.js';
import { navigate, getQuery, setQuery } from '../router.js';
import { fmt } from '../format.js';
import { pageHead, panel, screen, badge, kv, button, tabs, seg, empty, confirmDialog, toast, toastError, colorDot, progress } from '../ui/components.js';
import { timeSeries, simpleTable } from '../ui/charts.js';
import { WorldMap } from '../map/worldmap.js';
import { spacecraftForm } from './forms.js';
import { commandDialog } from './command-dialog.js';
import { periodMinutes, elementsFrom } from '/shared/orbit.js';

export default async function spacecraftDetail({ params, scope }) {
  const sc = await api.get(`/api/spacecraft/${params.id}`);
  await loadFleet();
  const inOrbit = ['active', 'standby', 'safe_mode'].includes(sc.status);
  const el = elementsFrom(sc);

  // ---------- живые показания ----------
  const readout = (k) => {
    const v = h('div', { class: 'v' }, '—');
    return { node: h('div', { class: 'readout' }, h('div', { class: 'k' }, k), v), v };
  };
  const R = {
    alt: readout('Высота'),
    speed: readout('Скорость'),
    battery: readout('Заряд АКБ'),
    temp: readout('Температура'),
    power: readout('Генерация'),
    link: readout('Связь'),
  };
  const unit = (val, u) => [val, h('small', null, u)];
  function renderReadouts() {
    const t = live.telemetry.get(sc.id);
    if (!t) return;
    replace(R.alt.v, ...unit(fmt.int(t.alt), 'км'));
    replace(R.speed.v, ...unit(fmt.fixed(t.speed, 2), 'км/с'));
    if (t.inactive) {
      for (const k of ['battery', 'temp', 'power', 'link']) replace(R[k].v, '—');
      return;
    }
    replace(R.battery.v, ...unit(fmt.fixed(t.battery, 1), '%'));
    R.battery.v.className = 'v ' + (t.battery < 15 ? 'crit' : t.battery < 35 ? 'warn' : 'ok');
    replace(R.temp.v, ...unit(fmt.fixed(t.temperature, 1), '°C'));
    R.temp.v.className = 'v ' + (t.temperature > 50 || t.temperature < -20 ? 'crit' : t.temperature > 40 ? 'warn' : '');
    replace(R.power.v, ...unit(t.sunlit ? fmt.compact(t.power) : 'тень', t.sunlit ? 'Вт' : ''));
    const st = state.stations?.find((s) => s.id === t.link?.stationId);
    replace(R.link.v, ...(t.link ? unit(st?.code ?? '—', `${fmt.int(t.link.elevation)}°`) : ['нет']));
    R.link.v.className = 'v ' + (t.link ? 'ok' : '');
    replace(modeLine, 
      h('span', null, `Режим: ${t.mode === 'safe' ? 'безопасный' : t.mode === 'reboot' ? 'перезагрузка БКУ' : 'штатный'}`),
      h('span', null, `Ориентация: ${t.pointing === 'sun' ? 'на Солнце' : 'в надир'}`),
      h('span', null, `Целевая аппаратура: ${t.payloadOn ? 'включена' : 'выключена'}`),
      h('span', null, `Топливо: ${fmt.num(t.fuel, 1)} кг`),
      t.queued ? h('span', null, `В очереди команд: ${t.queued}`) : null,
      t.faults.length ? h('span', { style: { color: '#ff8a7d' } }, 'Неисправности: ' + t.faults.map((f) => dict('faults', f)?.short ?? f).join(', ')) : null,
    );
  }
  const modeLine = h('div', { class: 'map-legend', style: { gap: '18px' } });

  const liveScreen = screen({
    title: 'Показания в реальном времени',
    aside: h('span', { class: 'muted' }, inOrbit ? 'обновление каждые 2 с' : sc.status === 'decommissioned' ? 'аппарат пассивен — только положение' : 'аппарат не на орбите'),
    body: [h('div', { class: 'readouts' }, Object.values(R).map((r) => r.node)), inOrbit ? modeLine : null],
  });

  const passport = panel({
    title: 'Паспорт',
    body: [
      kv([
        ['Назначение', dict('spacecraftTypes', sc.type)],
        ['Оператор', sc.operator],
        ['Дата запуска', fmt.date(sc.launch_date)],
        ['Масса', sc.mass_kg ? `${fmt.num(sc.mass_kg, 1)} кг` : '—'],
        ['Мощность СЭС', `${fmt.int(sc.power_w)} Вт`],
        ['Запас топлива', `${fmt.num(sc.fuel_kg, 1)} кг`],
        ['Цвет на карте', h('span', { class: 'row' }, colorDot(sc.color), sc.color)],
      ]),
      sc.description ? h('p', { class: 'desc', style: { marginTop: '12px', marginBottom: 0 } }, sc.description) : null,
    ],
  });

  // ---------- вкладки ----------
  const tabItems = [
    { id: 'telemetry', label: 'Телеметрия', render: telemetryTab },
    { id: 'orbit', label: 'Орбита', render: orbitTab },
    { id: 'passes', label: 'Сеансы связи', render: passesTab },
    { id: 'commands', label: 'Команды', count: sc.commands.length, render: commandsTab },
    { id: 'incidents', label: 'Инциденты', count: sc.incidents.filter((i) => i.status !== 'resolved').length || undefined, render: incidentsTab },
    { id: 'missions', label: 'Миссии', count: sc.missions.length, render: missionsTab },
  ];

  async function telemetryTab() {
    if (!inOrbit) return empty('Телеметрия не поступает', 'Аппарат не на орбите или выведен из эксплуатации.');
    const host = h('div');
    let hours = Number(getQuery().hours) || 6;
    const charts = [];
    async function load() {
      if (charts.length && !host.isConnected) return; // вкладку уже закрыли
      const data = await api.get(`/api/spacecraft/${sc.id}/telemetry`, { hours }, { silent: true });
      for (const c of charts.splice(0)) c.dispose?.();
      const pts = data.points;
      const mk = (title, key, opts) => {
        const last = [...pts].reverse().find((p) => p[key] !== null);
        const c = timeSeries({ points: pts.map((p) => ({ t: p.t, v: p[key], shade: opts.shade ? !p.sunlit : false })), label: title, ...opts });
        charts.push(c);
        return h('div', { class: 'chart-cell' }, h('h3', null, title, h('b', null, last ? opts.format(last[key]) + (opts.unit || '') : '—')), c);
      };
      replace(host, 
        h(
          'div',
          { class: 'charts-grid' },
          mk('Заряд АКБ, %', 'battery', { format: (v) => fmt.num(v, 0), yMin: 0, yMax: 100, shade: true, unit: '%' }),
          mk('Температура приборного отсека, °C', 'temperature', { format: (v) => fmt.num(v, 1), unit: ' °C', color: '#e87ba4', minSpan: 20 }),
          mk('Генерация солнечных батарей, Вт', 'power', { format: (v) => fmt.compact(v), unit: ' Вт', shade: true, color: '#86b6ef', yMin: 0 }),
          mk('Уровень сигнала, дБм', 'signal', { format: (v) => fmt.num(v, 0), unit: ' дБм', color: '#4caf6a', minSpan: 30 }),
        ),
        h('div', { class: 'map-legend' }, h('span', null, h('i', { class: 'k-night' }), 'Затенение — аппарат в тени Земли'), h('span', null, 'Пропуски на графике сигнала — нет сеанса связи')),
      );
    }
    scope.add(() => charts.forEach((c) => c.dispose?.()));
    const wrap = screen({
      title: 'История телеметрии',
      aside: seg(
        [
          { value: 6, label: '6 ч' },
          { value: 24, label: '24 ч' },
          { value: 72, label: '72 ч' },
        ],
        hours,
        (v) => {
          hours = v;
          setQuery({ hours: v });
          load();
        },
        { label: 'Период' },
      ),
      body: host,
    });
    await load();
    scope.interval(load, 60_000);
    return wrap;
  }

  async function orbitTab() {
    const mapBox = h('div', { class: 'map-wrap' });
    const out = h(
      'div',
      { class: 'grid side' },
      screen({ title: 'Трасса полёта', aside: h('span', { class: 'muted' }, 'пунктир — прогноз, сплошная — пройденный путь'), body: mapBox }),
      panel({
        title: 'Орбитальные элементы',
        body: kv([
          ['Высота перигея', `${fmt.num(sc.perigee_km, 1)} км`],
          ['Высота апогея', `${fmt.num(sc.apogee_km, 1)} км`],
          ['Наклонение', `${fmt.num(sc.inclination_deg, 3)}°`],
          ['ДВУ', `${fmt.num(sc.raan_deg, 3)}°`],
          ['Аргумент перигея', `${fmt.num(sc.arg_perigee_deg, 3)}°`],
          ['Средняя аномалия', `${fmt.num(sc.mean_anomaly_deg, 3)}°`],
          ['Эпоха', fmt.dateTime(sc.epoch)],
          ['Большая полуось', `${fmt.num(el.a, 1)} км`],
          ['Эксцентриситет', el.e.toFixed(5)],
          ['Период обращения', `${fmt.num(periodMinutes(el.a), 2)} мин`],
          ['Класс орбиты', sc.orbit_class],
        ]),
      }),
    );
    requestAnimationFrame(() => {
      const map = new WorldMap(mapBox, { tracks: 'selected', compact: false });
      map.setFleet(state.fleet || [sc]);
      map.setStations(state.stations || []);
      map.select(sc.id);
      scope.add(() => map.destroy());
    });
    return out;
  }

  async function passesTab() {
    if (!inOrbit) return empty('Сеансы не планируются', 'Аппарат не на орбите или выведен из эксплуатации.');
    const r = await api.get(`/api/spacecraft/${sc.id}/passes`, { hours: 24 });
    if (!r.items.length) return panel({ body: empty('В ближайшие сутки сеансов нет', 'Ни одна станция в состоянии «На связи» не увидит аппарат.') });
    return panel({
      title: 'Прогноз сеансов связи на 24 часа',
      aside: `${r.items.length} сеансов`,
      flush: true,
      body: simpleTable(
        [{ label: 'Станция' }, { label: 'Начало' }, { label: 'Конец' }, { label: 'Длительность', num: true }, { label: 'Макс. угол места', num: true }],
        r.items.map((p) => [
          p.stationName,
          p.inProgress ? 'идёт сейчас' : fmt.dateTime(p.aos),
          p.los ? fmt.time(p.los) : 'за горизонтом прогноза',
          p.continuous ? 'постоянно' : fmt.duration(p.durationS),
          `${fmt.num(p.maxElevation, 1)}°`,
        ]),
      ),
    });
  }

  async function commandsTab() {
    const fresh = await api.get('/api/commands', { spacecraft_id: sc.id, limit: 20, sort: 'created_at', dir: 'desc' });
    return panel({
      title: 'Последние команды',
      aside: h('a', { href: `/commands?spacecraft_id=${sc.id}` }, 'Вся история'),
      flush: true,
      body: fresh.items.length
        ? simpleTable(
            [{ label: 'Создана' }, { label: 'Команда' }, { label: 'Статус' }, { label: 'Станция' }, { label: 'Результат' }],
            fresh.items.map((c) => [fmt.dateTime(c.created_at), dict('commandTypes', c.type)?.label ?? c.type, badge('commandStatuses', c.status), c.station_name || '—', h('span', { class: 'small' }, c.result || '—')]),
          )
        : empty('Команд ещё не было'),
    });
  }

  async function incidentsTab() {
    return panel({
      title: 'Инциденты',
      aside: h('a', { href: `/incidents?spacecraft_id=${sc.id}` }, 'Журнал инцидентов'),
      flush: true,
      body: sc.incidents.length
        ? simpleTable(
            [{ label: 'Создан' }, { label: 'Важность' }, { label: 'Инцидент' }, { label: 'Статус' }],
            sc.incidents.map((i) => [fmt.dateTime(i.created_at), badge('incidentSeverities', i.severity), h('a', { href: `/incidents?open=${i.id}` }, i.title), badge('incidentStatuses', i.status)]),
          )
        : empty('Инцидентов не было'),
    });
  }

  async function missionsTab() {
    return panel({
      title: 'Миссии аппарата',
      flush: true,
      body: sc.missions.length
        ? simpleTable(
            [{ label: 'Код' }, { label: 'Миссия' }, { label: 'Статус' }, { label: 'Приоритет' }, { label: 'Выполнение' }],
            sc.missions.map((m) => [m.code, h('a', { href: `/missions/${m.id}` }, m.name), badge('missionStatuses', m.status), badge('priorities', m.priority, { lamp: false }), h('div', { class: 'row' }, progress(m.progress), `${m.progress}%`)]),
          )
        : empty('Аппарат не задействован в миссиях'),
    });
  }

  // ---------- действия ----------
  const actions = [];
  if (can.edit() && inOrbit) actions.push(button('Отправить команду', { kind: 'primary', iconName: 'send', onClick: () => commandDialog({ spacecraft: sc, onDone: () => navigate(`/spacecraft/${sc.id}?tab=commands`, { replace: true }) }) }));
  if (can.edit()) actions.push(button('Изменить', { iconName: 'edit', onClick: () => spacecraftForm({ record: sc, onDone: () => (invalidateFleet(), navigate(location.pathname + location.search, { replace: true })) }) }));
  if (can.remove())
    actions.push(
      button(null, {
        iconName: 'trash',
        kind: 'danger',
        title: 'Удалить аппарат',
        onClick: async () => {
          const ok = await confirmDialog({ title: `Удалить «${sc.name}»?`, text: 'Будут удалены телеметрия, история команд и инцидентов аппарата. Миссии и запуски останутся, но потеряют ссылку на него. Действие необратимо.', confirmLabel: 'Удалить', danger: true });
          if (!ok) return;
          try {
            await api.del(`/api/spacecraft/${sc.id}`);
            invalidateFleet();
            toast({ title: 'Аппарат удалён', tone: 'green' });
            navigate('/spacecraft');
          } catch (err) {
            toastError(err);
          }
        },
      }),
    );

  const page = h(
    'div',
    { class: 'page' },
    pageHead({
      crumbs: [{ label: 'Космические аппараты', href: '/spacecraft' }, { label: sc.code }],
      title: sc.name,
      extra: h('div', { class: 'row', style: { marginTop: '8px' } }, badge('spacecraftStatuses', sc.status), h('span', { class: 'chip' }, dict('spacecraftTypes', sc.type)), h('span', { class: 'chip' }, `${sc.orbit_class}, ${fmt.num(periodMinutes(el.a), 1)} мин`)),
      actions,
    }),
    h('div', { class: 'hero-sc' }, liveScreen, passport),
    tabs(tabItems, getQuery().tab || (inOrbit ? 'telemetry' : 'orbit'), (id) => setQuery({ tab: id })),
  );
  renderReadouts();
  live.on('telemetry', renderReadouts, scope);
  live.on('fleet', (d) => {
    if (d.id === sc.id && d.reason !== 'edit') toast({ title: 'Параметры аппарата изменились', body: 'Обновите страницу, чтобы увидеть новую орбиту или состояние.', tone: 'white' });
  }, scope);
  return page;
}
