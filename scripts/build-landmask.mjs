// Строит растровую маску суши из контуров scripts/world-src.mjs → shared/landmask.js
// Запуск: node scripts/build-landmask.mjs [--preview out.pgm]
import { writeFileSync } from 'node:fs';
import { LAND, WATER } from './world-src.mjs';

const RES = 0.5; // градусов на ячейку
const W = 360 / RES;
const H = 180 / RES;

function inside(poly, lon, lat) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
const insideWrapped = (poly, lon, lat) => inside(poly, lon, lat) || inside(poly, lon + 360, lat) || inside(poly, lon - 360, lat);

const grid = new Uint8Array(W * H);
for (let r = 0; r < H; r++) {
  const lat = 90 - (r + 0.5) * RES;
  for (let c = 0; c < W; c++) {
    const lon = -180 + (c + 0.5) * RES;
    let land = LAND.some((p) => insideWrapped(p, lon, lat));
    if (land && WATER.some((p) => inside(p, lon, lat))) land = false;
    grid[r * W + c] = land ? 1 : 0;
  }
}

// RLE по строкам: длины чередующихся отрезков (вода, суша, вода …) в base36
const rows = [];
for (let r = 0; r < H; r++) {
  const runs = [];
  let cur = 0;
  let len = 0;
  for (let c = 0; c < W; c++) {
    const v = grid[r * W + c];
    if (v === cur) len++;
    else {
      runs.push(len);
      cur = v;
      len = 1;
    }
  }
  runs.push(len);
  rows.push(runs.map((n) => n.toString(36)).join(','));
}

const land = grid.reduce((a, b) => a + b, 0);
const out = `// Сгенерировано scripts/build-landmask.mjs — не редактировать вручную.
// Маска суши ${W}×${H} (шаг ${RES}°), RLE по строкам с севера на юг, отрезки в base36.
const W = ${W};
const H = ${H};
const RES = ${RES};
const DATA = '${rows.join(';')}';

let bits = null;
function decode() {
  if (bits) return bits;
  bits = new Uint8Array(W * H);
  DATA.split(';').forEach((row, r) => {
    let c = 0;
    let v = 0;
    for (const token of row.split(',')) {
      const n = parseInt(token, 36);
      if (v) bits.fill(1, r * W + c, r * W + c + n);
      c += n;
      v ^= 1;
    }
  });
  return bits;
}

/** Суша ли в точке (широта, долгота в градусах). */
export function isLand(lat, lon) {
  const b = decode();
  const r = Math.min(H - 1, Math.max(0, Math.floor((90 - lat) / RES)));
  let x = ((((lon + 180) % 360) + 360) % 360) / RES;
  const c = Math.min(W - 1, Math.floor(x));
  return b[r * W + c] === 1;
}

/** Узлы регулярной сетки (шаг stepDeg), попадающие на сушу: [[lat, lon], …]. */
export function landPoints(stepDeg = 2) {
  const pts = [];
  for (let lat = 90 - stepDeg / 2; lat > -90; lat -= stepDeg) {
    for (let lon = -180 + stepDeg / 2; lon < 180; lon += stepDeg) {
      if (isLand(lat, lon)) pts.push([lat, lon]);
    }
  }
  return pts;
}

export const LANDMASK_INFO = { width: W, height: H, resolution: RES };
`;
writeFileSync(new URL('../shared/landmask.js', import.meta.url), out);
console.log(`landmask: ${W}x${H}, суша ${(100 * land / grid.length).toFixed(1)}% ячеек, ${(out.length / 1024).toFixed(1)} КБ`);

const pi = process.argv.indexOf('--preview');
if (pi > 0) {
  const header = `P5\n${W} ${H}\n255\n`;
  const px = Buffer.alloc(W * H);
  for (let i = 0; i < grid.length; i++) px[i] = grid[i] ? 30 : 230;
  writeFileSync(process.argv[pi + 1], Buffer.concat([Buffer.from(header), px]));
}
