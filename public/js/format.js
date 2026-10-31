// Форматирование чисел, дат и интервалов для русской локали.
const nf = new Intl.NumberFormat('ru-RU');
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const dateF = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
const dateShort = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const dtF = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dtYF = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const timeF = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const timeSF = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const utcTimeF = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' });
const mskTimeF = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Moscow' });

const toDate = (v) => (v instanceof Date ? v : new Date(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T00:00:00' : v));

export const fmt = {
  int: (v) => (v === null || v === undefined || v === '' ? '—' : nf.format(Math.round(Number(v)))),
  num: (v, digits = 1) => (v === null || v === undefined || v === '' ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(Number(v))),
  fixed: (v, digits = 1) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(v))),
  compact: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    if (Math.abs(n) >= 1e6) return nf1.format(n / 1e6) + ' млн';
    if (Math.abs(n) >= 1e4) return nf1.format(n / 1e3) + ' тыс.';
    return nf.format(n);
  },
  date: (v) => (v ? dateF.format(toDate(v)).replace(' г.', '') : '—'),
  dateShort: (v) => (v ? dateShort.format(toDate(v)) : '—'),
  dateTime: (v) => {
    if (!v) return '—';
    const d = toDate(v);
    return (d.getFullYear() === new Date().getFullYear() ? dtF : dtYF).format(d).replace(' г.', '');
  },
  time: (v) => (v ? timeF.format(toDate(v)) : '—'),
  timeSec: (v) => (v ? timeSF.format(toDate(v)) : '—'),
  utc: (v) => utcTimeF.format(toDate(v)),
  msk: (v) => mskTimeF.format(toDate(v)),
  /** «через 12 мин», «5 ч назад» */
  relative: (v, now = Date.now()) => {
    if (!v) return '—';
    const diff = toDate(v).getTime() - now;
    const abs = Math.abs(diff);
    const past = diff < 0;
    const m = Math.round(abs / 60000);
    let s;
    if (abs < 45_000) return past ? 'только что' : 'сейчас';
    if (m < 60) s = `${m} мин`;
    else if (m < 60 * 24) s = `${Math.floor(m / 60)} ч ${m % 60 ? (m % 60) + ' мин' : ''}`.trim();
    else s = `${Math.round(m / 1440)} ${plural(Math.round(m / 1440), 'день', 'дня', 'дней')}`;
    return past ? `${s} назад` : `через ${s}`;
  },
  /** Длительность в секундах: «4 мин 35 с» */
  duration: (sec) => {
    if (sec === null || sec === undefined) return '—';
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h) return `${h} ч ${m} мин`;
    if (m) return `${m} мин ${String(s).padStart(2, '0')} с`;
    return `${s} с`;
  },
  /** Т−ЧЧ:ММ:СС или Т−Д д ЧЧ:ММ */
  countdown: (ms) => {
    const neg = ms < 0;
    let t = Math.abs(Math.round(ms / 1000));
    const d = Math.floor(t / 86400);
    t %= 86400;
    const hh = String(Math.floor(t / 3600)).padStart(2, '0');
    const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
    const ss = String(t % 60).padStart(2, '0');
    const sign = neg ? 'Т+' : 'Т−';
    return d ? `${sign}${d} д ${hh}:${mm}:${ss}` : `${sign}${hh}:${mm}:${ss}`;
  },
  coord: (lat, lon) => {
    if (lat === null || lat === undefined) return '—';
    const f2 = (v) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v));
    const la = `${f2(lat)}° ${lat >= 0 ? 'с. ш.' : 'ю. ш.'}`;
    const lo = `${f2(lon)}° ${lon >= 0 ? 'в. д.' : 'з. д.'}`;
    return `${la}, ${lo}`;
  },
  age: (birth) => {
    if (!birth) return '—';
    const b = toDate(birth);
    const n = new Date();
    let a = n.getFullYear() - b.getFullYear();
    if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--;
    return `${a} ${plural(a, 'год', 'года', 'лет')}`;
  },
};

export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Значение для <input type="datetime-local"> в локальном времени браузера */
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function initials(name = '') {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
}
