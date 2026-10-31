// Базовые компоненты интерфейса: значки, лампы, панели, модальные окна, уведомления.
import { h, replace } from '../dom.js';
import { icon } from './icons.js';
import { dict, tone } from '../state.js';
import { initials } from '../format.js';

export function badge(dictName, key, { lamp = true } = {}) {
  const t = tone(dictName, key);
  return h('span', { class: ['badge', t] }, lamp ? h('i', { class: 'lamp' }) : null, dict(dictName, key));
}

export function lamp(color, { blink = false, title } = {}) {
  return h('i', { class: ['lamp', color, blink && 'blink'], title, role: title ? 'img' : null, 'aria-label': title });
}

export function meter(value, { warn = 35, crit = 15, suffix = '%' } = {}) {
  if (value === null || value === undefined) return h('span', { class: 'muted' }, '—');
  const v = Math.max(0, Math.min(100, value));
  const cls = v < crit ? 'crit' : v < warn ? 'warn' : '';
  return h(
    'div',
    { class: ['meter', cls], role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(v) },
    h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: v + '%' } })),
    h('span', { class: 'val' }, `${Math.round(v)}${suffix}`),
  );
}

export function progress(value) {
  return h('div', { class: 'progress', title: `${value}%` }, h('i', { style: { width: `${value}%` } }));
}

export function pageHead({ crumbs, title, lede, actions, extra }) {
  return h(
    'header',
    { class: 'page-head' },
    h(
      'div',
      { class: 'titles' },
      crumbs ? h('div', { class: 'crumbs' }, crumbs.flatMap((c, i) => [i ? ' / ' : null, c.href ? h('a', { href: c.href }, c.label) : c.label])) : null,
      h('h1', null, title),
      lede ? h('p', { class: 'lede' }, lede) : null,
      extra,
    ),
    actions?.length ? h('div', { class: 'actions' }, actions) : null,
  );
}

export function panel({ title, aside, body, flush = false, className, headExtra }) {
  return h(
    'section',
    { class: ['panel', className] },
    title ? h('div', { class: 'panel-head' }, h('h2', null, title), aside || headExtra ? h('div', { class: 'aside' }, aside, headExtra) : null) : null,
    h('div', { class: ['panel-body', flush && 'flush'] }, body),
  );
}

export function screen({ title, aside, body, className }) {
  return h(
    'section',
    { class: ['screen', className] },
    title ? h('div', { class: 'screen-head' }, h('h2', null, title), aside ? h('div', { class: 'aside' }, aside) : null) : null,
    body,
  );
}

export function kv(pairs, { cols2 = false } = {}) {
  return h(
    'dl',
    { class: ['kv', cols2 && 'cols-2'] },
    pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v === null || v === undefined || v === '' ? '—' : v)]),
  );
}

export function empty(title, text, action) {
  return h('div', { class: 'empty' }, h('strong', null, title), text ? h('div', null, text) : null, action ? h('div', { style: { marginTop: '12px' } }, action) : null);
}

export function errorView(err) {
  const status = err?.status;
  const title = status === 404 ? 'Запись не найдена' : status === 403 ? 'Недостаточно прав' : 'Не удалось открыть страницу';
  return h(
    'div',
    { class: 'page not-found' },
    h('h1', null, title),
    h('p', { class: 'muted' }, err?.message || 'Неизвестная ошибка'),
    h('a', { class: 'btn', href: '/' }, 'Вернуться на обзор'),
  );
}

export function button(label, { onClick, kind, iconName, small, title, type = 'button', disabled, href, download } = {}) {
  const cls = ['btn', kind, small && 'small', !label && iconName && 'icon'];
  const content = [iconName ? icon(iconName, small ? 16 : 18) : null, label];
  if (href) return h('a', { class: cls, href, title, download: download ? true : null, 'data-external': download ? '' : null }, content);
  return h('button', { class: cls, type, onclick: onClick, title, 'aria-label': !label ? title : null, disabled }, content);
}

/** Сегментированный переключатель */
export function seg(items, value, onChange, { label } = {}) {
  const root = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const render = (v) => {
    replace(root, 
      ...items.map((it) =>
        h('button', { type: 'button', 'aria-pressed': String(it.value === v), onclick: () => (render(it.value), onChange(it.value)) }, it.label),
      ),
    );
  };
  render(value);
  return root;
}

/** Вкладки: [{id, label, render: () => Node}] */
export function tabs(items, active, onChange) {
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const body = h('div', { role: 'tabpanel' });
  const show = async (id) => {
    replace(bar, 
      ...items.map((t) =>
        h('button', { role: 'tab', type: 'button', 'aria-selected': String(t.id === id), onclick: () => show(t.id) }, t.label, t.count !== undefined ? h('span', { class: 'muted' }, ` ${t.count}`) : null),
      ),
    );
    const it = items.find((t) => t.id === id) || items[0];
    replace(body, h('div', { class: 'muted small' }, 'Загрузка…'));
    replace(body, await it.render());
    onChange?.(it.id);
  };
  show(items.some((t) => t.id === active) ? active : items[0].id);
  return h('div', null, bar, body);
}

// ---------- Модальные окна ----------

const openStack = [];
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openStack.length) openStack[openStack.length - 1].close();
});

export function modal({ title, body, footer, narrow = false, drawer = false, onClose }) {
  const prevFocus = document.activeElement;
  const box = h(
    'div',
    { class: drawer ? 'drawer' : ['modal', narrow && 'narrow'], role: 'dialog', 'aria-modal': 'true', 'aria-label': typeof title === 'string' ? title : 'Окно' },
    h('div', { class: 'modal-head' }, h('h2', null, title), button(null, { iconName: 'close', kind: 'ghost', title: 'Закрыть', onClick: () => api.close() })),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  box.querySelector('.modal-head .btn').classList.add('close');
  const overlay = h('div', { class: ['overlay', drawer && 'drawer-overlay'], onmousedown: (e) => e.target === overlay && api.close() }, box);
  const api = {
    el: box,
    close() {
      if (!overlay.isConnected) return;
      overlay.remove();
      openStack.splice(openStack.indexOf(api), 1);
      prevFocus?.focus?.();
      onClose?.();
    },
    setBody(node) {
      replace(box.querySelector('.modal-body'), node);
    },
  };
  openStack.push(api);
  document.body.append(overlay);
  // ловушка фокуса
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...box.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex="0"]')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) {
      e.preventDefault();
      f[f.length - 1].focus();
    } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
      e.preventDefault();
      f[0].focus();
    }
  });
  requestAnimationFrame(() => (box.querySelector('[autofocus], input, select, textarea, .modal-foot .btn.primary') || box.querySelector('.close'))?.focus());
  return api;
}

export function confirmDialog({ title, text, confirmLabel = 'Подтвердить', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const m = modal({
      title,
      narrow: true,
      body: h('p', { class: 'desc' }, text),
      footer: [
        button('Отмена', { onClick: () => finish(false) }),
        button(confirmLabel, { kind: danger ? 'danger solid' : 'primary', onClick: () => finish(true) }),
      ],
      onClose: () => finish(false),
    });
  });
}

// ---------- Уведомления ----------

let toastBox;
export function toast({ title, body, tone: t = 'white', link, timeout = 6000 }) {
  toastBox ||= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const el = h(
    'div',
    { class: 'toast' },
    lamp(t),
    h('div', null, h('b', null, title), body ? h('div', { class: 't-body' }, body) : null, link ? h('a', { href: link.href, onclick: () => el.remove() }, link.label) : null),
    h('button', { type: 'button', 'aria-label': 'Закрыть уведомление', onclick: () => el.remove() }, '×'),
  );
  toastBox.append(el);
  while (toastBox.children.length > 4) toastBox.firstChild.remove();
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

export function toastError(err) {
  return toast({ title: 'Не выполнено', body: err?.message || String(err), tone: 'red', timeout: 8000 });
}

export function colorDot(color) {
  return h('span', { class: 'swatch', style: { background: color, borderRadius: '50%' }, 'aria-hidden': 'true' });
}

export function monogramOf(name) {
  return h('span', { class: 'monogram', 'aria-hidden': 'true' }, initials(name));
}
