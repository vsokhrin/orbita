// Описания форм справочников (используются в списках и карточках).
import { h } from '../dom.js';
import { api } from '../api.js';
import { options, state } from '../state.js';
import { openForm, setValues } from '../ui/form.js';
import { button } from '../ui/components.js';
import { periodMinutes, elementsFrom, orbitClass, meanAnomalyForLongitude } from '../../shared/orbit.js';
import { fmt } from '../format.js';

const ORBIT_PRESETS = [
  { label: 'Станция, 51,6°', v: { perigee_km: 410, apogee_km: 420, inclination_deg: 51.64, arg_perigee_deg: 0 } },
  { label: 'ССО 700 км', v: { perigee_km: 698, apogee_km: 704, inclination_deg: 98.2, arg_perigee_deg: 0 } },
  { label: 'Навигация', v: { perigee_km: 19100, apogee_km: 19140, inclination_deg: 64.8, arg_perigee_deg: 0 } },
  { label: '«Молния»', v: { perigee_km: 650, apogee_km: 39500, inclination_deg: 63.4, arg_perigee_deg: 270 } },
  { label: 'Геостационар', v: { perigee_km: 35786, apogee_km: 35786, inclination_deg: 0.05, raan_deg: 0, arg_perigee_deg: 0 }, geo: true },
];

export function spacecraftForm({ record, onDone }) {
  const isEdit = !!record;
  let formRef;
  const derived = h('div', { class: 'help', 'aria-live': 'polite' });
  const presets = ORBIT_PRESETS.map((p) =>
    button(p.label, {
      small: true,
      onClick: () => {
        setValues(formRef, p.v);
        if (p.geo) formRef.controls.geo_lon.control.focus();
        updateDerived();
      },
    }),
  );
  const fields = [
    { section: 'Основные сведения' },
    { name: 'name', label: 'Наименование', required: true, max: 80 },
    { name: 'code', label: 'Код', required: true, max: 24, help: 'Буквы, цифры, дефис. Например, SK-4' },
    { name: 'type', label: 'Назначение', type: 'select', required: true, options: options('spacecraftTypes') },
    { name: 'status', label: 'Состояние', type: 'select', required: true, options: options('spacecraftStatuses'), default: 'planned' },
    { name: 'operator', label: 'Оператор', required: true, max: 120, list: [...new Set((state.fleet || []).map((f) => f.operator))] },
    { name: 'launch_date', label: 'Дата запуска', type: 'date' },
    { name: 'mass_kg', label: 'Масса, кг', type: 'number', min: 0.1 },
    { name: 'power_w', label: 'Мощность СЭС, Вт', type: 'number', min: 1, default: 1000 },
    { name: 'fuel_kg', label: 'Запас топлива, кг', type: 'number', min: 0, default: 0 },
    { name: 'color', label: 'Цвет на карте', type: 'color', default: '#3987e5' },
    { section: 'Орбита', presets },
    { name: 'perigee_km', label: 'Высота перигея, км', type: 'number', required: true, min: 150 },
    { name: 'apogee_km', label: 'Высота апогея, км', type: 'number', required: true, min: 150 },
    { name: 'inclination_deg', label: 'Наклонение, °', type: 'number', required: true, min: 0, max: 180 },
    { name: 'raan_deg', label: 'Долгота восходящего узла, °', type: 'number', min: 0, max: 359.999, default: 0 },
    { name: 'arg_perigee_deg', label: 'Аргумент перигея, °', type: 'number', min: 0, max: 359.999, default: 0 },
    { name: 'mean_anomaly_deg', label: 'Средняя аномалия на эпоху, °', type: 'number', min: 0, max: 359.999, default: 0 },
    { name: 'epoch', label: 'Эпоха элементов', type: 'datetime', default: new Date().toISOString() },
    { name: 'geo_lon', label: 'Точка стояния ГСО, ° в. д.', type: 'number', min: -180, max: 180, readonly: true, help: 'Для геостационара: пересчитает среднюю аномалию', placeholder: 'например, 95' },
    { name: 'description', label: 'Описание', type: 'textarea', span: 2, max: 2000 },
  ];

  function updateDerived() {
    const v = Object.fromEntries(Object.entries(formRef.controls).map(([k, c]) => [k, c.control.value]));
    const per = Number(v.perigee_km);
    const apo = Number(v.apogee_km);
    if (!per || !apo || apo < per) {
      derived.textContent = '';
      return;
    }
    const el = elementsFrom({ perigee_km: per, apogee_km: apo, inclination_deg: Number(v.inclination_deg) || 0, epoch: Date.now() });
    derived.textContent = `Класс орбиты: ${orbitClass(per, apo, Number(v.inclination_deg) || 0)} · период ${fmt.num(periodMinutes(el.a), 1)} мин · эксцентриситет ${el.e.toFixed(4)}`;
  }

  return openForm({
    title: isEdit ? `Изменить: ${record.name}` : 'Новый космический аппарат',
    fields,
    values: record || {},
    submitLabel: isEdit ? 'Сохранить' : 'Добавить аппарат',
    successMessage: isEdit ? 'Изменения сохранены' : 'Аппарат добавлен',
    onReady: (form) => {
      formRef = form;
      const anchor = form.querySelector('[data-field="perigee_km"]');
      anchor.before(h('div', { class: 'span-2' }, derived));
      for (const k of ['perigee_km', 'apogee_km', 'inclination_deg']) form.controls[k].control.addEventListener('input', updateDerived);
      form.controls.geo_lon.control.addEventListener('change', () => {
        const lon = Number(form.controls.geo_lon.control.value);
        const epochVal = form.controls.epoch.control.value;
        const epoch = epochVal ? new Date(epochVal).getTime() : Date.now();
        if (Number.isFinite(lon)) {
          const m = meanAnomalyForLongitude(lon, Number(form.controls.raan_deg.control.value) || 0, Number(form.controls.arg_perigee_deg.control.value) || 0, epoch);
          form.controls.mean_anomaly_deg.control.value = m.toFixed(3);
        }
      });
      updateDerived();
    },
    submit: (data) => {
      delete data.geo_lon;
      return isEdit ? api.put(`/api/spacecraft/${record.id}`, { ...data, _version: record.updated_at }) : api.post('/api/spacecraft', data);
    },
    onDone,
  });
}

export function stationForm({ record, onDone }) {
  const isEdit = !!record;
  return openForm({
    title: isEdit ? `Изменить: ${record.name}` : 'Новая наземная станция',
    fields: [
      { name: 'name', label: 'Название', required: true },
      { name: 'code', label: 'Код', required: true, help: '2–12 латинских букв и цифр' },
      { name: 'country', label: 'Страна', required: true },
      { name: 'status', label: 'Состояние', type: 'select', required: true, options: options('stationStatuses'), default: 'online' },
      { section: 'Расположение и аппаратура' },
      { name: 'latitude', label: 'Широта, °', type: 'number', required: true, min: -90, max: 90, help: 'Северная — положительная' },
      { name: 'longitude', label: 'Долгота, °', type: 'number', required: true, min: -180, max: 180, help: 'Восточная — положительная' },
      { name: 'altitude_m', label: 'Высота над морем, м', type: 'number', default: 0 },
      { name: 'antenna_diameter_m', label: 'Диаметр антенны, м', type: 'number', min: 0.1 },
      { name: 'bands', label: 'Частотные диапазоны', default: 'S', help: 'Через запятую: S,X,Ka' },
      { name: 'min_elevation_deg', label: 'Мин. угол места, °', type: 'number', min: 0, max: 45, default: 5, help: 'Ниже этого угла связь не устанавливается' },
      { name: 'description', label: 'Примечание', type: 'textarea', span: 2 },
    ],
    values: record || {},
    submitLabel: isEdit ? 'Сохранить' : 'Добавить станцию',
    successMessage: isEdit ? 'Изменения сохранены' : 'Станция добавлена',
    submit: (data) => (isEdit ? api.put(`/api/stations/${record.id}`, { ...data, _version: record.updated_at }) : api.post('/api/stations', data)),
    onDone,
  });
}

export async function missionForm({ record, onDone }) {
  const isEdit = !!record;
  const sc = await api.get('/api/spacecraft', { limit: 500, sort: 'name' }, { silent: true });
  return openForm({
    title: isEdit ? `Изменить: ${record.code}` : 'Новая миссия',
    fields: [
      { name: 'name', label: 'Наименование', required: true, span: 2 },
      { name: 'code', label: 'Код', required: true, help: 'Например, EXP-15' },
      { name: 'spacecraft_id', label: 'Космический аппарат', type: 'select', numeric: true, options: sc.items.map((s) => ({ value: s.id, label: `${s.name} (${s.code})` })) },
      { name: 'status', label: 'Статус', type: 'select', required: true, options: options('missionStatuses'), default: 'planning' },
      { name: 'priority', label: 'Приоритет', type: 'select', required: true, options: options('priorities'), default: 'medium' },
      { name: 'start_date', label: 'Начало', type: 'date' },
      { name: 'end_date', label: 'Окончание', type: 'date' },
      { name: 'progress', label: 'Выполнение, %', type: 'number', min: 0, max: 100, step: 1, default: 0 },
      { name: 'budget_mln', label: 'Бюджет, млн ₽', type: 'number', min: 0 },
      { name: 'flight_director', label: 'Руководитель полёта', span: 2 },
      { name: 'objective', label: 'Цель', type: 'textarea', span: 2 },
      { name: 'description', label: 'Описание', type: 'textarea', span: 2 },
    ],
    values: record || {},
    submitLabel: isEdit ? 'Сохранить' : 'Создать миссию',
    successMessage: isEdit ? 'Изменения сохранены' : 'Миссия создана',
    submit: (data) => (isEdit ? api.put(`/api/missions/${record.id}`, { ...data, _version: record.updated_at }) : api.post('/api/missions', data)),
    onDone,
  });
}

export function crewForm({ record, onDone }) {
  const isEdit = !!record;
  return openForm({
    title: isEdit ? `Изменить: ${record.full_name}` : 'Новый член экипажа',
    fields: [
      { name: 'full_name', label: 'Фамилия и имя', required: true },
      { name: 'call_sign', label: 'Позывной' },
      { name: 'position', label: 'Квалификация', type: 'select', required: true, options: options('crewPositions') },
      { name: 'status', label: 'Статус', type: 'select', required: true, options: options('crewStatuses'), default: 'training' },
      { name: 'birth_date', label: 'Дата рождения', type: 'date' },
      { name: 'nationality', label: 'Гражданство', default: 'Россия' },
      { section: 'Опыт' },
      { name: 'flights_count', label: 'Космических полётов', type: 'number', min: 0, step: 1, default: 0 },
      { name: 'hours_in_space', label: 'Часов в космосе', type: 'number', min: 0, default: 0 },
      { name: 'eva_count', label: 'Выходов в открытый космос', type: 'number', min: 0, step: 1, default: 0 },
      { name: 'bio', label: 'Биография', type: 'textarea', span: 2 },
    ],
    values: record || {},
    submitLabel: isEdit ? 'Сохранить' : 'Добавить',
    successMessage: isEdit ? 'Изменения сохранены' : 'Член экипажа добавлен',
    submit: (data) => (isEdit ? api.put(`/api/crew/${record.id}`, { ...data, _version: record.updated_at }) : api.post('/api/crew', data)),
    onDone,
  });
}

export async function launchForm({ record, onDone }) {
  const isEdit = !!record;
  const [sc, ms] = await Promise.all([api.get('/api/spacecraft', { limit: 500, sort: 'name' }, { silent: true }), api.get('/api/missions', { limit: 500, sort: 'code' }, { silent: true })]);
  return openForm({
    title: isEdit ? `Изменить: ${record.name}` : 'Новый запуск',
    fields: [
      { name: 'name', label: 'Название', required: true, span: 2, placeholder: 'Ракета / полезная нагрузка' },
      { name: 'vehicle', label: 'Ракета-носитель', required: true, list: ['Ангара-А5', 'Ангара-1.2', 'Союз-2.1а', 'Союз-2.1б', 'Протон-М'] },
      { name: 'site', label: 'Космодром', required: true, list: state.meta.launchSites },
      { name: 'scheduled_at', label: 'Время старта', type: 'datetime', required: true, help: 'В вашем часовом поясе' },
      { name: 'window_minutes', label: 'Стартовое окно, мин', type: 'number', min: 0, step: 1, default: 0 },
      { name: 'status', label: 'Статус', type: 'select', required: true, options: options('launchStatuses'), default: 'scheduled' },
      { name: 'spacecraft_id', label: 'Полезная нагрузка (КА)', type: 'select', numeric: true, options: sc.items.map((s) => ({ value: s.id, label: `${s.name} — ${s.status === 'planned' ? 'готовится' : 'на орбите'}` })), help: 'После успешного пуска КА перейдёт в состояние «Работает штатно»' },
      { name: 'mission_id', label: 'Миссия', type: 'select', numeric: true, options: ms.items.map((m) => ({ value: m.id, label: `${m.code} — ${m.name}` })) },
      { name: 'notes', label: 'Примечания', type: 'textarea', span: 2 },
    ],
    values: record || {},
    submitLabel: isEdit ? 'Сохранить' : 'Запланировать',
    successMessage: isEdit ? 'Изменения сохранены' : 'Запуск запланирован',
    submit: (data) => (isEdit ? api.put(`/api/launches/${record.id}`, { ...data, _version: record.updated_at }) : api.post('/api/launches', data)),
    onDone,
  });
}

export async function incidentForm({ record, onDone, preset = {} }) {
  const isEdit = !!record;
  const [sc, st] = await Promise.all([api.get('/api/spacecraft', { limit: 500, sort: 'name' }, { silent: true }), api.get('/api/stations', { limit: 500, sort: 'name' }, { silent: true })]);
  return openForm({
    title: isEdit ? 'Изменить инцидент' : 'Зарегистрировать инцидент',
    fields: [
      { name: 'title', label: 'Что произошло', required: true, span: 2 },
      { name: 'severity', label: 'Важность', type: 'select', required: true, options: options('incidentSeverities'), default: 'warning' },
      { name: 'spacecraft_id', label: 'Космический аппарат', type: 'select', numeric: true, options: sc.items.map((s) => ({ value: s.id, label: s.name })) },
      { name: 'station_id', label: 'Наземная станция', type: 'select', numeric: true, options: st.items.map((s) => ({ value: s.id, label: s.name })) },
      { name: 'description', label: 'Подробности', type: 'textarea', span: 2, rows: 4 },
    ],
    values: record || preset,
    submitLabel: isEdit ? 'Сохранить' : 'Зарегистрировать',
    successMessage: isEdit ? 'Изменения сохранены' : 'Инцидент зарегистрирован',
    submit: (data) => (isEdit ? api.put(`/api/incidents/${record.id}`, { ...data, _version: record.updated_at }) : api.post('/api/incidents', data)),
    onDone,
  });
}
