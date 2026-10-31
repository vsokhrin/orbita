// Модель бортовых систем: энергобаланс должен быть устойчивым, неисправности — влиять на параметры.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as O from '../shared/orbit.js';
import { initialState, step, fuelForAltitudeChange } from '../server/sim/model.js';

const EPOCH = Date.parse('2026-10-31T17:00:00Z');

function simulate(st, hours, { perigee = 412, apogee = 421, inc = 51.64, power = 2000 } = {}) {
  const el = O.elementsFrom({ perigee_km: perigee, apogee_km: apogee, inclination_deg: inc, raan_deg: 210, epoch: EPOCH });
  let min = 100;
  for (let t = EPOCH; t < EPOCH + hours * 3600_000; t += 30_000) {
    step({ el, powerMax: power }, st, t, 30, O.sunVector(t), [], () => 0.5);
    min = Math.min(min, st.battery);
  }
  return min;
}

test('исправный аппарат на низкой орбите не разряжает АКБ за двое суток', () => {
  const st = initialState({ status: 'active', type: 'earth_observation' }, { battery: 80 });
  const min = simulate(st, 48);
  assert.ok(min > 45, `минимальный заряд ${min}`);
  assert.ok(st.battery > 60, `заряд в конце ${st.battery}`);
});

test('потеря ориентации в штатном режиме разряжает АКБ', () => {
  const st = initialState({ status: 'active', type: 'earth_observation' }, { battery: 80 });
  st.faults.add('attitude');
  simulate(st, 12);
  assert.ok(st.battery < 25, `заряд ${st.battery}`);
});

test('отказ терморегулирования перегревает аппарат', () => {
  const st = initialState({ status: 'active', type: 'earth_observation' }, { battery: 90, temperature: 15 });
  st.faults.add('thermal');
  simulate(st, 4);
  assert.ok(st.temperature > 45, `температура ${st.temperature}`);
});

test('расход топлива на коррекцию орбиты реалистичен', () => {
  const el = O.elementsFrom({ perigee_km: 412, apogee_km: 421, inclination_deg: 51.6, epoch: EPOCH });
  const kg = fuelForAltitudeChange(el, 10, 1500);
  // Δv ≈ 5,7 м/с, Isp = 300 с → около 2,9 кг на 1,5 т
  assert.ok(kg > 2 && kg < 4, `топливо ${kg}`);
  assert.equal(fuelForAltitudeChange(el, -10, 1500).toFixed(6), kg.toFixed(6));
});
