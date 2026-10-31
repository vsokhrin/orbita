// Модульные тесты орбитальной механики: сверка с известными значениями реальных орбит.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as O from '../shared/orbit.js';

const EPOCH = Date.parse('2026-10-31T17:00:00Z');
const el = (p, a, i, extra = {}) => O.elementsFrom({ perigee_km: p, apogee_km: a, inclination_deg: i, epoch: EPOCH, ...extra });

test('период и скорость низкой орбиты как у МКС', () => {
  const iss = el(415, 422, 51.64);
  assert.ok(Math.abs(O.periodMinutes(iss.a) - 92.9) < 0.3, 'период ≈ 92,9 мин');
  const s = O.stateAt(iss, EPOCH);
  assert.ok(Math.abs(s.speed - 7.66) < 0.02, 'скорость ≈ 7,66 км/с');
  assert.ok(Math.abs(s.alt - 415) < 10, 'высота в перигее');
});

test('максимальная широта трассы равна наклонению', () => {
  const iss = el(415, 422, 51.64);
  let max = -90;
  for (let t = EPOCH; t < EPOCH + 95 * 60_000; t += 20_000) max = Math.max(max, O.stateAt(iss, t).lat);
  assert.ok(Math.abs(max - 51.64) < 0.3);
});

test('геостационар висит над заданной долготой', () => {
  const m0 = O.meanAnomalyForLongitude(95, 0, 0, EPOCH);
  const geo = el(35786, 35786, 0.05, { mean_anomaly_deg: m0 });
  for (const h of [0, 6, 12, 24, 48]) {
    const s = O.stateAt(geo, EPOCH + h * 3600_000);
    assert.ok(Math.abs(s.lon - 95) < 0.2, `долгота через ${h} ч: ${s.lon}`);
    assert.ok(Math.abs(s.lat) < 0.1);
  }
});

test('орбита «Молния» — полусуточная, перигей не прецессирует', () => {
  const m = el(650, 39500, 63.4, { arg_perigee_deg: 270 });
  assert.ok(Math.abs(O.periodMinutes(m.a) / 60 - 11.97) < 0.1);
  // при критическом наклонении 63,4° скорость поворота линии апсид близка к нулю
  const p = m.a * (1 - m.e ** 2);
  const n = O.meanMotion(m.a);
  const dArgp = 0.75 * n * O.J2 * (O.RE / p) ** 2 * (5 * Math.cos(m.i) ** 2 - 1) * 86400 / O.DEG;
  assert.ok(Math.abs(dArgp) < 0.01, `дрейф аргумента перигея ${dArgp}°/сут`);
});

test('солнечно-синхронная орбита: прецессия узла ≈ +0,9856°/сут', () => {
  const sso = el(698, 704, 98.2);
  const p = sso.a * (1 - sso.e ** 2);
  const n = O.meanMotion(sso.a);
  const dRaan = -1.5 * n * O.J2 * (O.RE / p) ** 2 * Math.cos(sso.i) * 86400 / O.DEG;
  assert.ok(Math.abs(dRaan - 0.9856) < 0.01, `прецессия ${dRaan}`);
});

test('уравнение Кеплера решается для больших эксцентриситетов', () => {
  for (const e of [0, 0.1, 0.5, 0.74, 0.9]) {
    for (const M of [0.1, 1, 2, 3, 5]) {
      const E = O.solveKepler(M, e);
      assert.ok(Math.abs(E - e * Math.sin(E) - M) < 1e-9);
    }
  }
});

test('подсолнечная точка 31 октября', () => {
  const p = O.subsolarPoint(EPOCH);
  assert.ok(Math.abs(p.lat - -14.3) < 0.3, `склонение Солнца ${p.lat}`);
  assert.ok(Math.abs(p.lon - -79.1) < 1, `долгота ${p.lon}`);
});

test('на низкой орбите аппарат часть витка проводит в тени', () => {
  const iss = el(415, 422, 51.64, { raan_deg: 120 });
  let lit = 0;
  let n = 0;
  for (let t = EPOCH; t < EPOCH + 93 * 60_000; t += 10_000, n++) if (O.stateAt(iss, t).sunlit) lit++;
  assert.ok(lit / n > 0.55 && lit / n < 1, `доля освещённости ${lit / n}`);
});

test('прогноз сеансов: низкая орбита — короткие пролёты, геостационар — постоянная связь', () => {
  const station = { lat: 55.87, lon: 37.95, minElevation: 5 };
  const iss = el(415, 422, 51.64, { raan_deg: 120 });
  const passes = O.predictPasses(iss, station, EPOCH, EPOCH + 24 * 3600_000);
  assert.ok(passes.length >= 3);
  for (const p of passes.filter((x) => x.los && !x.inProgress)) {
    assert.ok(p.durationS > 30 && p.durationS < 15 * 60, `длительность ${p.durationS} с`);
    assert.ok(p.maxElevation >= 5);
  }
  const geo = el(35786, 35786, 0.05, { mean_anomaly_deg: O.meanAnomalyForLongitude(60, 0, 0, EPOCH) });
  const gp = O.predictPasses(geo, station, EPOCH, EPOCH + 12 * 3600_000);
  assert.equal(gp.length, 1);
  assert.equal(gp[0].continuous, true);
});

test('трасса разбивается на отрезки на линии перемены дат', () => {
  const iss = el(415, 422, 51.64);
  const segs = O.groundTrack(iss, EPOCH, EPOCH + 3 * 92 * 60_000, 30_000);
  assert.ok(segs.length >= 3);
  for (const s of segs) for (let i = 1; i < s.length; i++) assert.ok(Math.abs(s[i].lon - s[i - 1].lon) < 180);
});

test('классификация орбит', () => {
  assert.equal(O.orbitClass(415, 422, 51.6), 'LEO');
  assert.equal(O.orbitClass(700, 705, 98.2), 'SSO');
  assert.equal(O.orbitClass(19100, 19140, 64.8), 'MEO');
  assert.equal(O.orbitClass(35786, 35786, 0.05), 'GEO');
  assert.equal(O.orbitClass(650, 39500, 63.4), 'HEO');
});
