// Модель бортовых систем КА: энергобаланс, тепловой режим, радиосвязь.
// Чистые функции без ввода-вывода — используются и движком, и при генерации истории телеметрии.
import * as O from '../../shared/orbit.js';

export const SIMULATED_STATUSES = new Set(['active', 'standby', 'safe_mode']);

export function initialState(sc, overrides = {}) {
  return {
    battery: 85 + Math.random() * 10,
    temperature: 12 + Math.random() * 6,
    mode: sc.status === 'safe_mode' ? 'safe' : 'nominal',
    pointing: 'nadir',
    payloadOn: sc.status === 'active' && sc.type !== 'cargo',
    faults: new Set(),
    alarms: new Set(),
    lastT: null,
    rebootUntil: 0,
    phase: Math.random() * Math.PI * 2,
    ...overrides,
  };
}

export function stationsForModel(rows) {
  return rows.map((s) => {
    const lat = Number(s.latitude);
    const lon = Number(s.longitude);
    const altKm = Number(s.altitude_m || 0) / 1000;
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      status: s.status,
      lat,
      lon,
      altKm,
      minElevation: Number(s.min_elevation_deg ?? 5),
      ecef: O.geoToEcef(lat, lon, altKm),
    };
  });
}

/** Лучшая доступная станция (максимальный угол места) или null. */
export function bestLink(ecef, stations) {
  let best = null;
  for (const st of stations) {
    if (st.status !== 'online') continue;
    const la = O.lookAngles(ecef, st);
    if (la.elevation >= st.minElevation && (!best || la.elevation > best.elevation)) {
      best = { stationId: st.id, elevation: la.elevation, azimuth: la.azimuth, range: la.range };
    }
  }
  return best;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Один шаг модели. Изменяет st, возвращает мгновенные значения телеметрии.
 * sc — { el, powerMax, type }, t — мс, dt — с.
 */
export function step(sc, st, t, dt, sun, stations, rand = Math.random) {
  const pos = O.stateAt(sc.el, t, sun);
  const rebooting = st.rebootUntil > t;

  // Энергетика: генерация зависит от освещённости, ориентации и исправности системы ориентации.
  // Баланс подобран так, чтобы на НОО за виток АКБ разряжалась в тени на 20–30% и восстанавливалась на Солнце.
  let pointingFactor = st.pointing === 'sun' ? 1 : 0.82 + 0.08 * Math.sin(t / 900_000 + st.phase);
  if (st.faults.has('attitude')) pointingFactor *= 0.3;
  const generation = pos.sunlit ? sc.powerMax * pointingFactor : 0;
  let loadFactor = st.mode === 'safe' ? 0.18 : 0.3;
  if (st.payloadOn && st.mode !== 'safe') loadFactor += 0.16;
  if (st.temperature < -5) loadFactor += 0.05; // обогреватели
  if (rebooting) loadFactor = 0.15;
  const load = sc.powerMax * loadFactor * (0.97 + 0.06 * rand());
  const capacityWh = sc.powerMax * 1.15;
  st.battery = clamp(st.battery + ((generation - load) * dt) / 3600 / capacityWh * 100, 0, 100);

  // Тепловой режим: релаксация к равновесной температуре
  let target = pos.sunlit ? 19 : -7;
  if (st.payloadOn && st.mode !== 'safe') target += 9;
  if (st.faults.has('thermal')) target += 46;
  if (st.mode === 'safe') target -= 3;
  if (st.temperature < -5) target += 8;
  st.temperature += (target - st.temperature) * (1 - Math.exp(-dt / 900)) + (rand() - 0.5) * 0.08 * Math.sqrt(dt);

  // Радиолиния
  const link = rebooting ? null : bestLink(pos.ecef, stations);
  const signal = link ? -128 + 52 * Math.sin((link.elevation * Math.PI) / 180) - (st.faults.has('seu') ? 6 : 0) + (rand() - 0.5) * 2 : null;

  st.lastT = t;
  return {
    lat: pos.lat,
    lon: pos.lon,
    alt: pos.alt,
    speed: pos.speed,
    sunlit: pos.sunlit,
    generation,
    load,
    link,
    signal,
    rebooting,
  };
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** Запись для таблицы telemetry: состояние st и результат шага out в момент t (мс). */
export function telemetryRecord(spacecraftId, t, st, out) {
  return {
    spacecraft_id: spacecraftId,
    ts: new Date(t).toISOString(),
    battery: round(st.battery, 2),
    temperature: round(st.temperature, 2),
    power_w: round(out.generation, 1),
    signal_dbm: out.signal === null ? null : round(out.signal, 1),
    altitude_km: round(out.alt, 1),
    velocity_kms: round(out.speed, 3),
    lat: round(out.lat, 3),
    lon: round(out.lon, 3),
    sunlit: out.sunlit,
    mode: out.rebooting ? 'reboot' : st.mode,
    pointing: st.pointing,
    payload_on: st.payloadOn,
    station_id: out.link?.stationId ?? null,
  };
}

/** Средняя аномалия, RAAN и аргумент перигея на момент t — для пересчёта эпохи после манёвра. */
export function osculatingAngles(el, t) {
  const dt = (t - el.epochMs) / 1000;
  const n = O.meanMotion(el.a);
  const p = el.a * (1 - el.e * el.e);
  const k = 1.5 * O.J2 * (O.RE / p) ** 2 * n;
  const cosI = Math.cos(el.i);
  const norm = (rad) => ((((rad / O.DEG) % 360) + 360) % 360);
  return {
    raanDeg: norm(el.raan - k * cosI * dt),
    argpDeg: norm(el.argp + 0.5 * k * (5 * cosI * cosI - 1) * dt),
    meanAnomalyDeg: norm(el.m0 + n * dt),
  };
}

/** Расход топлива на изменение высоты орбиты на deltaKm (приближение малого импульса, Isp = 300 с). */
export function fuelForAltitudeChange(el, deltaKm, massKg) {
  const n = O.meanMotion(el.a); // рад/с
  const dv = (n / 2) * Math.abs(deltaKm) * 1000; // суммарно два импульса Гомана, м/с
  return massKg * (1 - Math.exp(-dv / (300 * 9.80665)));
}
