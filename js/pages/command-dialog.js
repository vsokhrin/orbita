// Диалог постановки команды в очередь: описание команды, параметры, ближайшее окно связи.
import { h, replace } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { fmt } from '../format.js';
import { openForm } from '../ui/form.js';

export async function commandDialog({ spacecraft, type, incidentId, onDone }) {
  const [passes, list] = await Promise.all([
    spacecraft ? api.get(`/api/spacecraft/${spacecraft.id}/passes`, { hours: 12 }, { silent: true }).catch(() => ({ items: [] })) : { items: [] },
    spacecraft ? null : api.get('/api/spacecraft', { limit: 500, status: 'active,standby,safe_mode', sort: 'name' }, { silent: true }),
  ]);
  const types = state.meta.commandTypes;
  const desc = h('div', { class: 'cmd-desc' });
  const windowInfo = h('div', { class: 'next-window' });

  function describe(code) {
    const t = types[code];
    desc.textContent = t ? t.description : 'Выберите команду — здесь появится её описание.';
  }
  function renderWindow(items) {
    const now = Date.now();
    const current = items.find((p) => p.aos <= now && (p.los ?? Infinity) > now);
    const next = items.find((p) => p.aos > now);
    if (current) replace(windowInfo, 'Аппарат сейчас в зоне станции ', h('b', null, current.stationName), ' — команда уйдёт на борт в течение нескольких секунд.');
    else if (next) replace(windowInfo, 'Ближайший сеанс связи: ', h('b', null, next.stationName), ', ', h('b', null, fmt.relative(next.aos)), ` (${fmt.time(next.aos)}). До этого команда ждёт в очереди.`);
    else replace(windowInfo, 'В ближайшие 12 часов сеансов связи не ожидается — увеличьте срок действия команды.');
  }

  const fields = [
    spacecraft
      ? null
      : { name: 'spacecraft_id', label: 'Космический аппарат', type: 'select', numeric: true, required: true, options: list.items.map((s) => ({ value: s.id, label: `${s.name} (${s.code})` })), span: 2 },
    { name: 'type', label: 'Команда', type: 'select', required: true, options: Object.entries(types).map(([value, t]) => ({ value, label: t.label })), span: 2 },
    { name: 'delta_km', label: 'Изменение высоты орбиты, км', type: 'number', min: -100, max: 100, step: 1, default: 5, help: 'Положительное — подъём, отрицательное — снижение' },
    { name: 'ttl_hours', label: 'Срок действия, ч', type: 'number', min: 0.25, max: 48, step: 0.25, default: 6, help: 'Если сеанса не будет, команда истечёт' },
  ].filter(Boolean);

  return openForm({
    title: spacecraft ? `Команда для «${spacecraft.name}»` : 'Новая команда',
    intro: h('div', { class: 'stack', style: { gap: '10px', marginBottom: '14px' } }, desc, windowInfo),
    fields,
    values: { type: type || '', delta_km: 5, ttl_hours: 6 },
    submitLabel: 'Поставить в очередь',
    successMessage: 'Команда поставлена в очередь',
    onReady: (form) => {
      const typeSel = form.controls.type.control;
      const deltaWrap = form.querySelector('[data-field="delta_km"]');
      const sync = () => {
        describe(typeSel.value);
        deltaWrap.classList.toggle('hidden', typeSel.value !== 'ORBIT_CORRECTION');
      };
      typeSel.addEventListener('change', sync);
      sync();
      if (spacecraft) renderWindow(passes.items);
      else {
        windowInfo.textContent = 'Выберите аппарат, чтобы увидеть ближайшее окно связи.';
        form.controls.spacecraft_id.control.addEventListener('change', async (e) => {
          const id = Number(e.target.value);
          if (!id) return;
          windowInfo.textContent = 'Расчёт окна связи…';
          const r = await api.get(`/api/spacecraft/${id}/passes`, { hours: 12 }, { silent: true }).catch(() => ({ items: [] }));
          renderWindow(r.items);
        });
      }
    },
    submit: (data) =>
      api.post('/api/commands', {
        spacecraft_id: spacecraft ? spacecraft.id : data.spacecraft_id,
        type: data.type,
        params: data.type === 'ORBIT_CORRECTION' ? { delta_km: data.delta_km } : {},
        ttl_hours: data.ttl_hours,
        incident_id: incidentId,
      }),
    onDone,
  });
}
