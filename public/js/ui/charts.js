// Графики на SVG без библиотек: временные ряды с перекрестием, ранжированные полосы, столбцы с накоплением.
// Правила: линии 2 px, заливка 10%, сетка — сплошные волосяные линии, подписи — цветом текста, у каждого графика есть таблица.
import { h, s, replace } from '../dom.js';
import { fmt } from '../format.js';
import { seg } from './components.js';

export function niceTicks(min, max, count = 4) {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { ticks, lo, hi };
}

function observeWidth(el, fn) {
  let last = 0;
  const ro = new ResizeObserver(() => {
    const w = Math.round(el.clientWidth);
    if (w && w !== last) {
      last = w;
      fn(w);
    }
  });
  ro.observe(el);
  return ro;
}

/**
 * Временной ряд одной величины.
 * points: [{ t: ISO|ms, v: number|null, shade?: bool }], format(v) → строка, color — цвет линии
 */
export function timeSeries({ points, height = 150, color = 'var(--signal)', format = (v) => fmt.num(v), yMin, yMax, label, shadeLabel = 'тень Земли', unit = '', minSpan = 0 }) {
  const root = h('div', { class: 'chart' });
  const tip = h('div', { class: 'chart-tip hidden' });
  const data = points.map((p) => ({ t: typeof p.t === 'number' ? p.t : Date.parse(p.t), v: p.v === null || p.v === undefined ? null : Number(p.v), shade: p.shade }));
  const valid = data.filter((d) => d.v !== null);

  function render(width) {
    replace(root);
    if (!valid.length) {
      root.append(h('div', { class: 'muted small', style: { padding: '24px 0', textAlign: 'center' } }, 'Нет данных за период'));
      return;
    }
    const m = { l: 44, r: 10, t: 8, b: 22 };
    const w = Math.max(200, width);
    const iw = w - m.l - m.r;
    const ih = height - m.t - m.b;
    const t0 = data[0].t;
    const t1 = data[data.length - 1].t;
    let lo = yMin ?? Math.min(...valid.map((d) => d.v));
    let hi = yMax ?? Math.max(...valid.map((d) => d.v));
    if (hi - lo < minSpan) {
      // не раздуваем шум: минимальный размах шкалы
      const mid = (hi + lo) / 2;
      if (yMin === undefined) lo = mid - minSpan / 2;
      if (yMax === undefined) hi = mid + minSpan / 2;
    }
    if (yMin === undefined || yMax === undefined) {
      const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 1;
      if (yMin === undefined) lo -= pad;
      if (yMax === undefined) hi += pad;
    }
    const { ticks, lo: tl, hi: th } = niceTicks(lo, hi, 4);
    const y0 = yMin ?? tl;
    const y1 = yMax ?? th;
    const x = (t) => m.l + ((t - t0) / Math.max(1, t1 - t0)) * iw;
    const y = (v) => m.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
    const svg = s('svg', { viewBox: `0 0 ${w} ${height}`, role: 'img', 'aria-label': label || 'График' });

    // затенение интервалов (тень Земли)
    const step = data.length > 1 ? (t1 - t0) / (data.length - 1) : 0;
    let start = null;
    data.forEach((d, i) => {
      if (d.shade && start === null) start = d.t;
      if ((!d.shade || i === data.length - 1) && start !== null) {
        const end = d.shade ? d.t + step : d.t;
        svg.append(s('rect', { x: x(start), y: m.t, width: Math.max(1, x(end) - x(start)), height: ih, fill: 'rgba(0,0,0,0.22)' }));
        start = null;
      }
    });

    const grid = s('g', { class: 'grid' });
    const axis = s('g', { class: 'axis' });
    for (const tv of ticks) {
      if (tv < y0 - 1e-9 || tv > y1 + 1e-9) continue;
      grid.append(s('line', { x1: m.l, x2: w - m.r, y1: y(tv), y2: y(tv) }));
      axis.append(s('text', { x: m.l - 6, y: y(tv) + 3.5, 'text-anchor': 'end' }, format(tv)));
    }
    // ось времени: 4–6 меток
    const span = t1 - t0;
    const hourStep = [1, 2, 3, 6, 12, 24].find((hs) => span / (hs * 3600_000) <= 6) || 24;
    const first = Math.ceil(t0 / (hourStep * 3600_000)) * hourStep * 3600_000;
    for (let tv = first; tv <= t1; tv += hourStep * 3600_000) {
      axis.append(s('text', { x: x(tv), y: height - 6, 'text-anchor': 'middle' }, span > 36 * 3600_000 ? fmt.dateShort(tv) + ' ' + fmt.time(tv) : fmt.time(tv)));
    }
    svg.append(grid, axis, s('line', { class: 'baseline', x1: m.l, x2: w - m.r, y1: m.t + ih, y2: m.t + ih }));

    // линия с разрывами на пропусках
    const gap = step * 3.5;
    let dLine = '';
    let dArea = '';
    let seg0 = null;
    let prev = null;
    const closeArea = () => {
      if (seg0 !== null && prev) dArea += `L${x(prev.t).toFixed(1)},${(m.t + ih).toFixed(1)}L${x(seg0).toFixed(1)},${(m.t + ih).toFixed(1)}Z`;
    };
    for (const d of data) {
      if (d.v === null || (prev && d.t - prev.t > gap)) {
        closeArea();
        seg0 = null;
        if (d.v === null) {
          prev = null;
          continue;
        }
      }
      const px = x(d.t).toFixed(1);
      const py = y(Math.max(y0, Math.min(y1, d.v))).toFixed(1);
      if (seg0 === null) {
        dLine += `M${px},${py}`;
        dArea += `M${px},${(m.t + ih).toFixed(1)}L${px},${py}`;
        seg0 = d.t;
      } else {
        dLine += `L${px},${py}`;
        dArea += `L${px},${py}`;
      }
      prev = d;
    }
    closeArea();
    svg.append(s('path', { d: dArea, fill: color, 'fill-opacity': 0.1, stroke: 'none' }));
    svg.append(s('path', { d: dLine, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const last = valid[valid.length - 1];
    svg.append(s('circle', { cx: x(last.t), cy: y(last.v), r: 4, fill: color, stroke: 'var(--screen)', 'stroke-width': 2 }));

    // перекрестие и подсказка
    const cross = s('line', { class: 'crosshair hidden', y1: m.t, y2: m.t + ih });
    const dot = s('circle', { r: 4, fill: color, stroke: 'var(--screen)', 'stroke-width': 2, class: 'hidden' });
    svg.append(cross, dot);
    const hit = s('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent', tabindex: 0 });
    svg.append(hit);
    const showAt = (px) => {
      const t = t0 + ((px - m.l) / iw) * (t1 - t0);
      let best = null;
      for (const d of valid) if (!best || Math.abs(d.t - t) < Math.abs(best.t - t)) best = d;
      if (!best) return;
      const cx = x(best.t);
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', y(best.v));
      cross.classList.remove('hidden');
      dot.classList.remove('hidden');
      replace(tip, h('strong', null, format(best.v) + unit), h('div', { class: 'muted small' }, fmt.dateTime(best.t), best.shade ? ` · ${shadeLabel}` : ''));
      tip.classList.remove('hidden');
      const rect = root.getBoundingClientRect();
      const scale = rect.width / w;
      const left = cx * scale;
      tip.style.left = Math.min(rect.width - 150, Math.max(0, left + 10)) + 'px';
      tip.style.top = '4px';
    };
    hit.addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      showAt(((e.clientX - rect.left) / rect.width) * w);
    });
    hit.addEventListener('pointerleave', () => {
      cross.classList.add('hidden');
      dot.classList.add('hidden');
      tip.classList.add('hidden');
    });
    let kIdx = valid.length - 1;
    hit.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      kIdx = Math.max(0, Math.min(valid.length - 1, kIdx + (e.key === 'ArrowRight' ? 1 : -1)));
      showAt(x(valid[kIdx].t));
    });
    hit.addEventListener('blur', () => hit.dispatchEvent(new Event('pointerleave')));
    root.append(svg, tip);
  }
  const ro = observeWidth(root, render);
  root.dispose = () => ro.disconnect();
  return root;
}

/** Ранжированные горизонтальные полосы (HTML). items: [{ label, value, color?, note? }] */
export function rankedBars(items, { format = (v) => fmt.int(v), color = 'var(--series-1)', max } = {}) {
  if (!items.length) return h('div', { class: 'muted small' }, 'Нет данных за период');
  const top = max ?? Math.max(...items.map((i) => i.value), 1);
  return h(
    'div',
    { class: 'bars', role: 'list' },
    items.map((it) =>
      h(
        'div',
        { class: 'bar-row', role: 'listitem', title: `${it.label}: ${format(it.value)}${it.note ? ' — ' + it.note : ''}` },
        h('span', { class: 'name' }, it.label),
        h('span', { class: 'track' }, h('span', { class: 'bar', style: { width: `${(it.value / top) * 100}%`, background: it.color || color } }), h('span', { class: 'val' }, format(it.value), it.note ? h('span', { class: 'muted' }, ' · ' + it.note) : null)),
      ),
    ),
  );
}

/**
 * Столбцы с накоплением по категориям (например, инциденты по дням и важности).
 * rows: [{ label, values: { key: n } }], series: [{ key, label, color }]
 */
export function stackedColumns({ rows, series, height = 200, label }) {
  const root = h('div', { class: 'chart' });
  const legend = h('div', { class: 'chart-legend' }, series.map((sr) => h('span', null, h('i', { class: 'swatch', style: { background: sr.color } }), sr.label)));
  const tip = h('div', { class: 'chart-tip hidden' });
  const holder = h('div');
  root.append(legend, holder, tip);
  function render(width) {
    replace(holder);
    const m = { l: 34, r: 6, t: 8, b: 24 };
    const w = Math.max(240, width);
    const iw = w - m.l - m.r;
    const ih = height - m.t - m.b;
    const totals = rows.map((r) => series.reduce((a, sr) => a + (r.values[sr.key] || 0), 0));
    const { ticks, hi } = niceTicks(0, Math.max(1, ...totals), 4);
    const y = (v) => m.t + ih - (v / hi) * ih;
    const band = iw / rows.length;
    const bw = Math.min(24, Math.max(3, band - 2));
    const svg = s('svg', { viewBox: `0 0 ${w} ${height}`, role: 'img', 'aria-label': label || 'Диаграмма' });
    const grid = s('g', { class: 'grid' });
    const axis = s('g', { class: 'axis' });
    for (const tv of ticks) {
      grid.append(s('line', { x1: m.l, x2: w - m.r, y1: y(tv), y2: y(tv) }));
      axis.append(s('text', { x: m.l - 6, y: y(tv) + 3.5, 'text-anchor': 'end' }, fmt.int(tv)));
    }
    svg.append(grid, axis);
    const every = Math.ceil(rows.length / Math.max(2, Math.floor(iw / 64)));
    rows.forEach((r, i) => {
      const cx = m.l + band * i + band / 2;
      let acc = 0;
      const g = s('g', { tabindex: 0, role: 'img', 'aria-label': `${r.label}: ` + series.map((sr) => `${sr.label} ${r.values[sr.key] || 0}`).join(', ') });
      const visible = series.filter((sr) => r.values[sr.key] > 0);
      visible.forEach((sr, k) => {
        const v = r.values[sr.key];
        const yTop = y(acc + v);
        const yBot = y(acc);
        const gapPx = k > 0 ? 2 : 0;
        const hgt = Math.max(1, yBot - yTop - gapPx);
        const isTop = k === visible.length - 1;
        const rx = isTop ? Math.min(4, bw / 2, hgt / 2) : 0;
        // скругление только у верхнего конца столбца
        const x0 = cx - bw / 2;
        const top = yTop;
        const bot = yTop + hgt;
        const d = rx
          ? `M${x0},${bot}V${top + rx}Q${x0},${top} ${x0 + rx},${top}H${x0 + bw - rx}Q${x0 + bw},${top} ${x0 + bw},${top + rx}V${bot}Z`
          : `M${x0},${bot}V${top}H${x0 + bw}V${bot}Z`;
        g.append(s('path', { d, fill: sr.color }));
        acc += v;
      });
      g.append(s('rect', { x: m.l + band * i, y: m.t, width: band, height: ih, fill: 'transparent' }));
      const show = () => {
        replace(tip, 
          h('div', null, h('strong', null, fmt.int(totals[i])), ' ', h('span', { class: 'muted' }, r.label)),
          ...series.map((sr) => h('div', null, h('i', { class: 'key', style: { background: sr.color } }), `${sr.label}: ${r.values[sr.key] || 0}`)),
        );
        tip.classList.remove('hidden');
        const rect = root.getBoundingClientRect();
        const scale = rect.width / w;
        tip.style.left = Math.min(rect.width - 170, Math.max(0, cx * scale + 12)) + 'px';
        tip.style.top = '28px';
        g.style.opacity = '0.82';
      };
      const hide = () => {
        tip.classList.add('hidden');
        g.style.opacity = '';
      };
      g.addEventListener('pointerenter', show);
      g.addEventListener('pointerleave', hide);
      g.addEventListener('focus', show);
      g.addEventListener('blur', hide);
      svg.append(g);
      if (i % every === 0) axis.append(s('text', { x: cx, y: height - 6, 'text-anchor': 'middle' }, r.label));
    });
    svg.append(s('line', { class: 'baseline', x1: m.l, x2: w - m.r, y1: m.t + ih, y2: m.t + ih }));
    holder.append(svg);
  }
  const ro = observeWidth(holder, render);
  root.dispose = () => ro.disconnect();
  return root;
}

/** Переключатель «График / Таблица» — у каждой диаграммы есть табличный двойник. */
export function withTable(chartNode, tableBuilder) {
  const host = h('div', null, chartNode);
  const toggle = seg(
    [
      { value: 'chart', label: 'График' },
      { value: 'table', label: 'Таблица' },
    ],
    'chart',
    (v) => replace(host, v === 'chart' ? chartNode : tableBuilder()),
    { label: 'Вид' },
  );
  toggle.classList.add('view-toggle');
  return { toggle, body: host };
}

export function simpleTable(head, rows) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'data compact' },
      h('thead', null, h('tr', null, head.map((c) => h('th', { class: c.num && 'num' }, c.label)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((v, i) => h('td', { class: head[i].num && 'num' }, v))))),
    ),
  );
}
