// Построение DOM без innerHTML: все строки вставляются как текст, поэтому XSS невозможен.
import { toUrl } from './base.js';

/**
 * h('div', { class: 'x', onclick: fn, style: { color: 'red' }, dataset: {id: 1} }, 'текст', child, [children])
 * Атрибут false/null/undefined пропускается; true — булев атрибут.
 */
export function h(tag, attrs, ...children) {
  const el = tag === 'svg' || attrs?.ns === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined || k === 'ns') continue;
      if (k === 'class' || k === 'className') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' && 'value' in el && !(el instanceof SVGElement)) el.value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'indeterminate') el[k] = !!v;
      else if (k === 'href' && tag === 'a') el.setAttribute('href', toUrl(v)); // маршруты приложения — с учётом подкаталога
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** SVG-элемент: s('path', { d: '…' }) */
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  return append(el, children);
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Набор ресурсов страницы, освобождаемых при уходе: таймеры, подписки, слушатели. */
export class Scope {
  constructor() {
    this.items = [];
  }
  add(dispose) {
    if (this.disposed) {
      dispose();
      return dispose;
    }
    this.items.push(dispose);
    return dispose;
  }
  interval(fn, ms) {
    const id = setInterval(fn, ms);
    this.add(() => clearInterval(id));
    return id;
  }
  timeout(fn, ms) {
    const id = setTimeout(fn, ms);
    this.add(() => clearTimeout(id));
    return id;
  }
  listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.add(() => target.removeEventListener(type, fn, opts));
  }
  dispose() {
    this.disposed = true;
    for (const d of this.items.splice(0)) {
      try {
        d();
      } catch (e) {
        console.error(e);
      }
    }
  }
}
