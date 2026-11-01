// Декларативная валидация входных данных с приведением типов и русскими сообщениями.
// Модуль без зависимостей от Node.js: используется и в демо-версии в браузере.
import { HttpError } from '../http/errors.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkField(def, raw) {
  if (raw === undefined) return { skip: true };
  let v = raw;
  if (typeof v === 'string') v = v.trim();
  if (v === '' || v === null) {
    if (def.required) return { error: 'Обязательное поле' };
    return { value: def.type === 'bool' ? false : null };
  }
  switch (def.type) {
    case 'string':
    case 'text': {
      if (typeof v !== 'string' && typeof v !== 'number') return { error: 'Ожидается строка' };
      v = String(v);
      const max = def.max ?? (def.type === 'text' ? 5000 : 200);
      if (def.min && v.length < def.min) return { error: `Не короче ${def.min} символов` };
      if (v.length > max) return { error: `Не длиннее ${max} символов` };
      if (def.pattern && !def.pattern.test(v)) return { error: def.patternMessage || 'Неверный формат' };
      if (def.transform) v = def.transform(v);
      return { value: v };
    }
    case 'enum':
      if (!def.values.includes(v)) return { error: 'Недопустимое значение' };
      return { value: v };
    case 'int':
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').replace(/\s/g, ''));
      if (!Number.isFinite(n)) return { error: 'Ожидается число' };
      if (def.type === 'int' && !Number.isInteger(n)) return { error: 'Ожидается целое число' };
      if (def.min !== undefined && n < def.min) return { error: `Не меньше ${def.min}` };
      if (def.max !== undefined && n > def.max) return { error: `Не больше ${def.max}` };
      return { value: n };
    }
    case 'bool':
      return { value: v === true || v === 'true' || v === 1 || v === '1' };
    case 'date': {
      if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) return { error: 'Ожидается дата ГГГГ-ММ-ДД' };
      return { value: v };
    }
    case 'datetime': {
      const t = Date.parse(v);
      if (Number.isNaN(t)) return { error: 'Ожидается дата и время' };
      return { value: new Date(t).toISOString() };
    }
    case 'json':
      if (typeof v !== 'object') return { error: 'Ожидается объект' };
      return { value: v };
    default:
      return { value: v };
  }
}

/**
 * Проверяет тело запроса по схеме.
 * partial=true — для изменения: проверяются только переданные поля.
 * Возвращает объект значений или бросает HttpError(422) с ошибками по полям.
 */
export function validate(schema, body, { partial = false } = {}) {
  const values = {};
  const errors = {};
  for (const [key, def] of Object.entries(schema)) {
    if (def.readonly) continue;
    const raw = body?.[key];
    if (raw === undefined && !partial && def.required && def.default === undefined) {
      errors[key] = 'Обязательное поле';
      continue;
    }
    if (raw === undefined && !partial && def.default !== undefined) {
      values[key] = typeof def.default === 'function' ? def.default() : def.default;
      continue;
    }
    const r = checkField(def, raw);
    if (r.skip) continue;
    if (r.error) errors[key] = r.error;
    else values[key] = r.value;
  }
  if (Object.keys(errors).length) throw new HttpError(422, 'Проверьте правильность заполнения полей', { fields: errors });
  return values;
}

export function fieldError(field, message) {
  return new HttpError(422, 'Проверьте правильность заполнения полей', { fields: { [field]: message } });
}

export function parseId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new HttpError(400, 'Некорректный идентификатор');
  return n;
}

export function validatePasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Пароль должен быть не короче 8 символов';
  if (pw.length > 128) return 'Пароль слишком длинный';
  if (!/[A-Za-zА-Яа-яЁё]/.test(pw) || !/\d/.test(pw)) return 'Пароль должен содержать буквы и цифры';
  return null;
}
