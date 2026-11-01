// Орбитальная механика ОРБИТЫ. Модуль общий для сервера и браузера (ES-модуль без зависимостей).
// Модель: задача двух тел (Кеплер) + вековые возмущения от сжатия Земли (J2):
// прецессия долготы восходящего узла и аргумента перигея. Для учебной ИС точности
// хватает с запасом: трассы, сеансы связи и тень Земли ведут себя как у реальных КА.

export const MU = 398600.4418; // гравитационный параметр Земли, км³/с²
export const RE = 6378.137; // экваториальный радиус Земли, км
export const J2 = 1.08262668e-3;
export const OMEGA_EARTH = 7.2921150e-5; // угловая скорость вращения Земли, рад/с
export const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

const wrap2pi = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
export const wrapLon = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;

/** Элементы орбиты из записи КА (поля как в таблице spacecraft). */
export function elementsFrom(sc) {
  const perigee = Number(sc.perigee_km);
  const apogee = Number(sc.apogee_km);
  const rp = RE + Math.min(perigee, apogee);
  const ra = RE + Math.max(perigee, apogee);
  const a = (rp + ra) / 2;
  return {
    a,
    e: (ra - rp) / (ra + rp),
    i: Number(sc.inclination_deg) * DEG,
    raan: Number(sc.raan_deg || 0) * DEG,
    argp: Number(sc.arg_perigee_deg || 0) * DEG,
    m0: Number(sc.mean_anomaly_deg || 0) * DEG,
    epochMs: typeof sc.epoch === 'number' ? sc.epoch : Date.parse(sc.epoch),
  };
}

export const meanMotion = (a) => Math.sqrt(MU / (a * a * a)); // рад/с
export const periodMinutes = (a) => (TWO_PI / meanMotion(a)) / 60;

/** Классификация орбиты по высотам и наклонению. */
export function orbitClass(perigeeKm, apogeeKm, inclinationDeg) {
  const p = Number(perigeeKm);
  const a = Number(apogeeKm);
  const inc = Number(inclinationDeg);
  if (a - p > 5000) return 'HEO';
  const mid = (a + p) / 2;
  if (Math.abs(mid - 35786) < 300 && inc < 5) return 'GEO';
  if (mid > 2000 && mid < 35000) return 'MEO';
  if (mid >= 35000) return 'GSO';
  if (inc > 95 && inc < 105) return 'SSO';
  return 'LEO';
}

/** Решение уравнения Кеплера E − e·sinE = M методом Ньютона. */
export function solveKepler(M, e) {
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 30; k++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

/** Положение и скорость в инерциальной системе (ECI, км и км/с) на момент tMs. */
export function propagate(el, tMs) {
  const dt = (tMs - el.epochMs) / 1000;
  const n = meanMotion(el.a);
  const p = el.a * (1 - el.e * el.e);
  const k = 1.5 * J2 * (RE / p) ** 2 * n;
  const cosI = Math.cos(el.i);
  const raan = el.raan - k * cosI * dt;
  const argp = el.argp + 0.5 * k * (5 * cosI * cosI - 1) * dt;
  const M = wrap2pi(el.m0 + n * dt);
  const E = solveKepler(M, el.e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const sq = Math.sqrt(1 - el.e * el.e);
  const r = el.a * (1 - el.e * cosE);
  const xp = el.a * (cosE - el.e);
  const yp = el.a * sq * sinE;
  const f = Math.sqrt(MU * el.a) / r;
  const vxp = -f * sinE;
  const vyp = f * sq * cosE;

  const cO = Math.cos(raan), sO = Math.sin(raan);
  const ci = cosI, si = Math.sin(el.i);
  const cw = Math.cos(argp), sw = Math.sin(argp);
  const r11 = cO * cw - sO * sw * ci, r12 = -cO * sw - sO * cw * ci;
  const r21 = sO * cw + cO * sw * ci, r22 = -sO * sw + cO * cw * ci;
  const r31 = sw * si, r32 = cw * si;
  return {
    r: [r11 * xp + r12 * yp, r21 * xp + r22 * yp, r31 * xp + r32 * yp],
    v: [r11 * vxp + r12 * vyp, r21 * vxp + r22 * vyp, r31 * vxp + r32 * vyp],
    radius: r,
    meanAnomaly: M,
  };
}

export function julianDate(tMs) {
  return tMs / 86400000 + 2440587.5;
}

/** Среднее звёздное время по Гринвичу, рад. */
export function gmst(tMs) {
  const jd = julianDate(tMs);
  const d = jd - 2451545.0;
  const T = d / 36525;
  const deg = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - (T * T * T) / 38710000;
  return wrap2pi(deg * DEG);
}

export function eciToEcef(r, tMs) {
  const th = gmst(tMs);
  const c = Math.cos(th), s = Math.sin(th);
  return [c * r[0] + s * r[1], -s * r[0] + c * r[1], r[2]];
}

/** Подспутниковая точка: широта/долгота (град), высота (км). Сферическая модель Земли. */
export function ecefToGeo(x) {
  const rho = Math.hypot(x[0], x[1]);
  return {
    lat: Math.atan2(x[2], rho) / DEG,
    lon: Math.atan2(x[1], x[0]) / DEG,
    alt: Math.hypot(x[0], x[1], x[2]) - RE,
  };
}

export function geoToEcef(latDeg, lonDeg, altKm = 0) {
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const r = RE + altKm;
  return [r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)];
}

/** Единичный вектор на Солнце в ECI (упрощённая формула Астрономического ежегодника). */
export function sunVector(tMs) {
  const n = julianDate(tMs) - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  return [Math.cos(lambda), Math.cos(eps) * Math.sin(lambda), Math.sin(eps) * Math.sin(lambda)];
}

/** Подсолнечная точка (для терминатора день/ночь). */
export function subsolarPoint(tMs) {
  const s = eciToEcef(sunVector(tMs), tMs);
  return { lat: Math.asin(s[2]) / DEG, lon: Math.atan2(s[1], s[0]) / DEG };
}

/** Освещён ли КА Солнцем (цилиндрическая модель тени Земли). */
export function isSunlit(rEci, sun) {
  const proj = rEci[0] * sun[0] + rEci[1] * sun[1] + rEci[2] * sun[2];
  if (proj > 0) return true;
  const px = rEci[0] - proj * sun[0];
  const py = rEci[1] - proj * sun[1];
  const pz = rEci[2] - proj * sun[2];
  return Math.hypot(px, py, pz) > RE;
}

/** Угол места, азимут и дальность КА относительно наземной точки. */
export function lookAngles(satEcef, station) {
  const st = station.ecef || geoToEcef(station.lat, station.lon, (station.altKm || 0));
  const dx = satEcef[0] - st[0], dy = satEcef[1] - st[1], dz = satEcef[2] - st[2];
  const range = Math.hypot(dx, dy, dz);
  const lat = station.lat * DEG, lon = station.lon * DEG;
  const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const north = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const u = (dx * up[0] + dy * up[1] + dz * up[2]) / range;
  const e = (dx * east[0] + dy * east[1]) / range;
  const nn = (dx * north[0] + dy * north[1] + dz * north[2]) / range;
  let az = Math.atan2(e, nn) / DEG;
  if (az < 0) az += 360;
  return { elevation: Math.asin(u) / DEG, azimuth: az, range };
}

/** Полное состояние КА на момент времени. */
export function stateAt(el, tMs, sun = sunVector(tMs)) {
  const { r, v } = propagate(el, tMs);
  const ecef = eciToEcef(r, tMs);
  const geo = ecefToGeo(ecef);
  return {
    eci: r,
    ecef,
    lat: geo.lat,
    lon: geo.lon,
    alt: geo.alt,
    speed: Math.hypot(v[0], v[1], v[2]),
    sunlit: isSunlit(r, sun),
  };
}

/** Трасса (подспутниковые точки) на интервале. Возвращает массив отрезков без разрыва по линии перемены дат. */
export function groundTrack(el, fromMs, toMs, stepMs = 30_000) {
  const segments = [];
  let seg = [];
  let prevLon = null;
  for (let t = fromMs; t <= toMs; t += stepMs) {
    const { r } = propagate(el, t);
    const g = ecefToGeo(eciToEcef(r, t));
    if (prevLon !== null && Math.abs(g.lon - prevLon) > 180) {
      // пересекли ±180°: замыкаем отрезок на краю карты и начинаем новый
      const edge = prevLon > 0 ? 180 : -180;
      const nextUnwrapped = prevLon > 0 ? g.lon + 360 : g.lon - 360;
      const last = seg[seg.length - 1];
      const frac = (edge - prevLon) / (nextUnwrapped - prevLon);
      const latEdge = last.lat + (g.lat - last.lat) * Math.max(0, Math.min(1, frac));
      seg.push({ lat: latEdge, lon: edge, t });
      segments.push(seg);
      seg = [{ lat: latEdge, lon: -edge, t }];
    }
    seg.push({ lat: g.lat, lon: g.lon, t });
    prevLon = g.lon;
  }
  if (seg.length) segments.push(seg);
  return segments;
}

/** Центральный угол зоны видимости КА на высоте altKm при минимальном угле места, рад. */
export function footprintAngle(altKm, minElevationDeg = 0) {
  const el = minElevationDeg * DEG;
  return Math.acos((RE / (RE + altKm)) * Math.cos(el)) - el;
}

/** Окружность на сфере вокруг точки с угловым радиусом (рад) — для зон видимости. */
export function circleOnSphere(latDeg, lonDeg, angle, points = 96) {
  const lat1 = latDeg * DEG, lon1 = lonDeg * DEG;
  const out = [];
  for (let k = 0; k <= points; k++) {
    const brg = (k / points) * TWO_PI;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angle) + Math.cos(lat1) * Math.sin(angle) * Math.cos(brg));
    const lon2 = lon1 + Math.atan2(Math.sin(brg) * Math.sin(angle) * Math.cos(lat1), Math.cos(angle) - Math.sin(lat1) * Math.sin(lat2));
    out.push({ lat: lat2 / DEG, lon: wrapLon(lon2 / DEG) });
  }
  return out;
}

/**
 * Прогноз сеансов связи КА с наземной станцией.
 * Возвращает [{ aos, los, maxElevation, maxAt, continuous }], время — в мс.
 */
export function predictPasses(el, station, fromMs, toMs, { stepMs = 20_000, minElevation = station.minElevation ?? 5 } = {}) {
  const st = { ...station, ecef: station.ecef || geoToEcef(station.lat, station.lon, station.altKm || 0) };
  const elevAt = (t) => lookAngles(eciToEcef(propagate(el, t).r, t), st).elevation;
  const refine = (t0, t1, rising) => {
    // бисекция момента пересечения порога угла места
    for (let k = 0; k < 14; k++) {
      const mid = (t0 + t1) / 2;
      const above = elevAt(mid) >= minElevation;
      if (above === rising) t1 = mid;
      else t0 = mid;
    }
    return Math.round((t0 + t1) / 2);
  };

  const passes = [];
  let prevT = fromMs;
  let prevEl = elevAt(fromMs);
  let current = prevEl >= minElevation ? { aos: fromMs, inProgress: true, maxElevation: prevEl, maxAt: fromMs } : null;
  for (let t = fromMs + stepMs; t <= toMs; t += stepMs) {
    const e = elevAt(t);
    if (!current && e >= minElevation) {
      current = { aos: refine(prevT, t, true), maxElevation: e, maxAt: t };
    } else if (current) {
      if (e > current.maxElevation) {
        current.maxElevation = e;
        current.maxAt = t;
      }
      if (e < minElevation) {
        current.los = refine(prevT, t, false);
        passes.push(current);
        current = null;
      }
    }
    prevT = t;
    prevEl = e;
  }
  if (current) {
    current.los = null; // сеанс продолжается за горизонтом прогноза
    current.continuous = current.inProgress === true;
    passes.push(current);
  }
  return passes.map((p) => ({
    aos: p.aos,
    los: p.los,
    maxElevation: Math.round(p.maxElevation * 10) / 10,
    maxAt: p.maxAt,
    inProgress: !!p.inProgress,
    continuous: !!p.continuous,
    durationS: p.los ? Math.round((p.los - p.aos) / 1000) : null,
  }));
}

/**
 * Средняя аномалия на эпоху, при которой КА на круговой экваториальной орбите
 * окажется над долготой lonDeg (нужно для точки стояния геостационара).
 */
export function meanAnomalyForLongitude(lonDeg, raanDeg, argpDeg, epochMs) {
  const deg = lonDeg + gmst(epochMs) / DEG - raanDeg - argpDeg;
  return ((deg % 360) + 360) % 360;
}
