// Конструктор форм: поля по описанию, сбор значений, показ ошибок валидации сервера.
import { h } from '../dom.js';
import { modal, button, toast } from './components.js';
import { toLocalInput } from '../format.js';

let uid = 0;

/**
 * Описание поля: { name, label, type, required, options, span, help, min, max, step, placeholder, section, rows, list }
 * type: text | number | select | date | datetime | textarea | color | password | checkbox
 */
export function buildForm(fields, values = {}, { onSubmit } = {}) {
  const form = h('form', { class: 'form-grid', novalidate: true });
  const controls = {};
  for (const f of fields) {
    if (f.section) {
      form.append(h('div', { class: 'form-section' }, h('h3', null, f.section), f.presets ? h('div', { class: 'presets' }, f.presets) : null));
      if (!f.name) continue;
    }
    const id = `f${++uid}-${f.name}`;
    const value = values[f.name] ?? f.default ?? '';
    let control;
    switch (f.type) {
      case 'select': {
        const opts = typeof f.options === 'function' ? f.options(values) : f.options;
        control = h(
          'select',
          { id, name: f.name, required: f.required },
          f.required && value !== '' ? null : h('option', { value: '' }, f.placeholder || '— не выбрано —'),
          opts.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)),
        );
        break;
      }
      case 'textarea':
        control = h('textarea', { id, name: f.name, rows: f.rows || 3, maxlength: f.max, placeholder: f.placeholder }, value);
        break;
      case 'checkbox':
        control = h('input', { id, name: f.name, type: 'checkbox', checked: !!value });
        break;
      case 'datetime':
        control = h('input', { id, name: f.name, type: 'datetime-local', value: toLocalInput(value), required: f.required });
        break;
      case 'date':
        control = h('input', { id, name: f.name, type: 'date', value: value ? String(value).slice(0, 10) : '', required: f.required });
        break;
      case 'number':
        control = h('input', { id, name: f.name, type: 'number', value, min: f.min, max: f.max, step: f.step ?? 'any', required: f.required, inputmode: 'decimal', placeholder: f.placeholder });
        break;
      case 'color':
        control = h('input', { id, name: f.name, type: 'color', value: value || '#3987e5' });
        break;
      default:
        control = h('input', { id, name: f.name, type: f.type === 'password' ? 'password' : 'text', value, required: f.required, maxlength: f.max, placeholder: f.placeholder, autocomplete: f.autocomplete || (f.type === 'password' ? 'new-password' : 'off'), list: f.list ? id + '-list' : null });
    }
    controls[f.name] = { control, def: f };
    const errorEl = h('div', { class: 'error', id: id + '-err', role: 'alert' });
    control.setAttribute('aria-describedby', id + '-err');
    const label = h('label', { for: id }, f.label, f.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null);
    const wrap =
      f.type === 'checkbox'
        ? h('div', { class: ['field', f.span === 2 && 'span-2'] }, h('label', { class: 'check', for: id }, control, f.label), errorEl)
        : h('div', { class: ['field', f.span === 2 && 'span-2'] }, label, control, f.list ? h('datalist', { id: id + '-list' }, f.list.map((v) => h('option', { value: v }))) : null, f.help ? h('div', { class: 'help' }, f.help) : null, errorEl);
    wrap.dataset.field = f.name;
    form.append(wrap);
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    onSubmit?.();
  });
  form.controls = controls;
  return form;
}

export function collect(form) {
  const out = {};
  for (const [name, { control, def }] of Object.entries(form.controls)) {
    if (def.readonly) continue;
    let v;
    if (def.type === 'checkbox') v = control.checked;
    else if (def.type === 'number') v = control.value === '' ? null : Number(control.value);
    else if (def.type === 'datetime') v = control.value ? new Date(control.value).toISOString() : null;
    else if (def.type === 'select' && def.numeric) v = control.value === '' ? null : Number(control.value);
    else v = control.value.trim() === '' ? null : control.value.trim();
    out[name] = v;
  }
  return out;
}

export function setValues(form, values) {
  for (const [name, v] of Object.entries(values)) {
    const c = form.controls[name]?.control;
    if (!c) continue;
    if (c.type === 'checkbox') c.checked = !!v;
    else c.value = v ?? '';
  }
}

export function showErrors(form, fields = {}) {
  for (const wrap of form.querySelectorAll('.field')) {
    const msg = fields[wrap.dataset.field] || fields[`params.${wrap.dataset.field}`];
    wrap.classList.toggle('invalid', !!msg);
    const el = wrap.querySelector('.error');
    if (el) el.textContent = msg || '';
  }
  const first = form.querySelector('.field.invalid input, .field.invalid select, .field.invalid textarea');
  first?.focus();
}

/**
 * Модальная форма создания/изменения. submit(data) должен вернуть результат или бросить ApiError.
 */
export function openForm({ title, fields, values = {}, submit, submitLabel = 'Сохранить', successMessage, onDone, intro, drawer = false, narrow = false, onReady }) {
  const errorBox = h('div', { class: 'form-error hidden', role: 'alert' });
  const saveBtn = button(submitLabel, { kind: 'primary', type: 'submit' });
  const form = buildForm(fields, values, { onSubmit: () => doSubmit() });
  saveBtn.setAttribute('form', (form.id = 'form-' + ++uid));
  const m = modal({
    title,
    drawer,
    narrow,
    body: h('div', null, intro, errorBox, form),
    footer: [button('Отмена', { onClick: () => m.close() }), saveBtn],
  });
  onReady?.(form);
  async function doSubmit() {
    saveBtn.disabled = true;
    errorBox.classList.add('hidden');
    try {
      const result = await submit(collect(form), form);
      m.close();
      if (successMessage) toast({ title: successMessage, tone: 'green', timeout: 3500 });
      onDone?.(result);
    } catch (err) {
      showErrors(form, err.fields || {});
      if (!err.fields) {
        errorBox.textContent = err.message;
        errorBox.classList.remove('hidden');
      }
    } finally {
      saveBtn.disabled = false;
    }
  }
  return { modal: m, form };
}
