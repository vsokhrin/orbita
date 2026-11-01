// Набор линейных иконок 18×18 (stroke), рисуются как inline SVG.
import { s } from '../dom.js';

const P = {
  dashboard: 'M3 3h5v7H3zM10 3h5v4h-5zM10 9h5v6h-5zM3 12h5v3H3z',
  map: 'M2 4.5l4.5-2 5 2 4.5-2v11l-4.5 2-5-2-4.5 2zM6.5 2.5v11M11.5 4.5v11',
  satellite: 'M7.5 10.5l-3 3M5 7l6 6M7 5l6 6M11 3l4 4-2 2-4-4zM3 11l4 4-2 2-4-4zM12.5 12.5c1 1 1 2.5 0 3.5',
  mission: 'M9 2l2.2 4.6 5 .7-3.6 3.5.9 5L9 13.4 4.5 15.8l.9-5L1.8 7.3l5-.7z',
  crew: 'M6.5 8a3 3 0 100-6 3 3 0 000 6zM1.5 16c0-2.8 2.2-5 5-5s5 2.2 5 5M12 2.3a3 3 0 010 5.4M14 11.3c1.5.7 2.5 2.4 2.5 4.7',
  antenna: 'M9 9l-4 7h8zM9 9l6-6M5.5 5.5a5 5 0 017 7M3 3a8.5 8.5 0 0112 12',
  rocket: 'M10.5 2.5c3 0 5 2 5 5L9 14l-5-5zM4 9l-2 1 2.5 2.5M9 14l-1 2-2.5-2.5M6.5 11.5L3 15M11 7a1 1 0 100-2 1 1 0 000 2z',
  alert: 'M9 2L1.5 15h15zM9 7v4M9 13v.5',
  terminal: 'M2 3h14v12H2zM5 7l2.5 2L5 11M9 11h4',
  chart: 'M2.5 15.5h13M4.5 13V8M8 13V4M11.5 13V9.5M15 13V6',
  users: 'M9 8a3 3 0 100-6 3 3 0 000 6zM3 16c0-3.3 2.7-6 6-6s6 2.7 6 6',
  log: 'M4 2h7l3 3v11H4zM11 2v3h3M6.5 8.5h5M6.5 11h5M6.5 13.5h3',
  search: 'M8 13A5 5 0 108 3a5 5 0 000 10zM11.6 11.6L15.5 15.5',
  plus: 'M9 3.5v11M3.5 9h11',
  edit: 'M11.5 3l3.5 3.5-8.5 8.5H3v-3.5zM9.5 5l3.5 3.5',
  trash: 'M3 5h12M7 5V3h4v2M4.5 5l.8 10.5h7.4L13.5 5M7.5 8v5M10.5 8v5',
  download: 'M9 2.5v9M5.5 8L9 11.5 12.5 8M3 13.5v2h12v-2',
  close: 'M4 4l10 10M14 4L4 14',
  menu: 'M2.5 4.5h13M2.5 9h13M2.5 13.5h13',
  logout: 'M7 15.5H3v-13h4M11.5 12.5L15 9l-3.5-3.5M15 9H7',
  key: 'M6 11.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7zM9.3 9.3L15.5 15.5M12.5 12.5l1.8-1.8',
  moon: 'M14.5 11A6 6 0 017 3.5a6 6 0 107.5 7.5z',
  sun: 'M9 12.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM9 1v2M9 15v2M1 9h2M15 9h2M3.3 3.3l1.4 1.4M13.3 13.3l1.4 1.4M3.3 14.7l1.4-1.4M13.3 4.7l1.4-1.4',
  check: 'M3.5 9.5l3.5 3.5 7.5-8',
  send: 'M2 9l14-6.5L9.5 16 8 10.5z',
  print: 'M5 6.5V2h8v4.5M5 13H2.5V7h13v6H13M5 11h8v5H5z',
  link: 'M7.5 10.5a3 3 0 004.2 0l2.5-2.5a3 3 0 00-4.2-4.2L9 4.8M10.5 7.5a3 3 0 00-4.2 0L3.8 10a3 3 0 004.2 4.2l1-1',
  orbit: 'M9 11a2 2 0 100-4 2 2 0 000 4zM16.5 9c0 2.2-3.4 4-7.5 4S1.5 11.2 1.5 9 4.9 5 9 5s7.5 1.8 7.5 4z',
  clock: 'M9 16A7 7 0 109 2a7 7 0 000 14zM9 5v4l2.5 2.5',
  refresh: 'M15 4v4h-4M3 14v-4h4M14.4 8A5.5 5.5 0 004.5 5.5L3 7M3.6 10a5.5 5.5 0 009.9 2.5L15 11',
  undo: 'M6 4L2.5 7.5 6 11M3 7.5h7.5a4.5 4.5 0 010 9H8',
};

export function icon(name, size = 18) {
  return s(
    'svg',
    { width: size, height: size, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    s('path', { d: P[name] || P.dashboard }),
  );
}

/** Логотип ОРБИТЫ: Земля с наклонённой орбитой и аппаратом */
export function logo(size = 30) {
  return s(
    'svg',
    { width: size, height: size, viewBox: '0 0 32 32', 'aria-hidden': 'true' },
    s('circle', { cx: 16, cy: 16, r: 8.5, fill: 'var(--screen)' }),
    s('path', { d: 'M9.5 13.5c2 1 3.5-.5 5 1s3 1 4.5 0M10 19c2-.8 3.5.4 5-.4s2.6.2 3.8 1', stroke: '#4f8fa8', 'stroke-width': 1.3, fill: 'none', 'stroke-linecap': 'round' }),
    s('ellipse', { cx: 16, cy: 16, rx: 14.5, ry: 5.2, transform: 'rotate(-28 16 16)', fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.3 }),
    s('circle', { cx: 27.6, cy: 9.6, r: 2.2, fill: 'var(--signal)' }),
  );
}
