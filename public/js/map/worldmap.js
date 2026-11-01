// Карта орбит: равнопромежуточная проекция на canvas.
// Слои: океан, ночная сторона с сумерками, точечная матрица суши (подсвечена Солнцем), сетка,
// зоны видимости станций, трассы КА, зона обзора выбранного КА, радиолинии станция—КА, маркеры и подписи.
import * as O from '../../shared/orbit.js';
import { landPoints } from '../../shared/landmask.js';

const COLORS = {
  ocean: '#0e1b26',
  grid: 'rgba(120, 170, 200, 0.10)',
  equator: 'rgba(120, 170, 200, 0.22)',
  landDay: [86, 152, 178],
  landNight: [33, 70, 92],
  label: '#d3e4ea',
  labelDim: '#8fa9b6',
  link: '#4caf6a',
  track: '#f2a93b',
  stationOnline: '#e9f4f7',
  stationMaint: '#f2a93b',
  stationOff: '#5d7584',
  inactive: '#6f8794',
};

const DEG = Math.PI / 180;

function project(lat, lon, W, H) {
  return [((lon + 180) / 360) * W, ((90 - lat) / 180) * H];
}

export class WorldMap {
  constructor(container, opts = {}) {
    this.opts = {
      compact: false,
      labels: true,
      tracks: 'all', // all | selected | none
      footprint: true,
      stationRings: false,
      stations: true,
      links: true,
      night: true,
      ...opts,
    };
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Карта: положение космических аппаратов и наземных станций');
    this.tip = document.createElement('div');
    this.tip.className = 'map-tip hidden';
    container.append(this.canvas, this.tip);
    this.ctx = this.canvas.getContext('2d');
    this.base = document.createElement('canvas');
    this.fleet = [];
    this.stations = [];
    this.live = new Map();
    this.selected = null;
    this.hover = null;
    this.timeOffset = 0;
    this.tracks = new Map();
    this.tracksAt = 0;
    this.baseAt = 0;
    this.positions = [];
    this.stationPts = [];

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerleave', () => this.setHover(null));
    this.canvas.addEventListener('click', (e) => {
      const hit = this.hitTest(e);
      if (hit?.kind === 'sc') this.opts.onSelect?.(hit.id);
      else if (hit?.kind === 'station') this.opts.onSelectStation?.(hit.id);
      else this.opts.onSelect?.(null);
    });
    this.canvas.addEventListener('dblclick', (e) => {
      const hit = this.hitTest(e);
      if (hit?.kind === 'sc') this.opts.onOpen?.(hit.id);
    });
    this.timer = setInterval(() => this.requestDraw(), 1000);
    this.resize();
  }

  destroy() {
    clearInterval(this.timer);
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
    this.tip.remove();
  }

  now() {
    return Date.now() + this.timeOffset;
  }

  setFleet(rows) {
    this.fleet = rows
      .filter((r) => !['planned', 'lost'].includes(r.status))
      .map((r) => ({ id: r.id, name: r.name, code: r.code, color: r.color, status: r.status, el: O.elementsFrom(r), period: O.periodMinutes(O.elementsFrom(r).a) }));
    this.tracksAt = 0;
    this.requestDraw();
  }

  setStations(rows) {
    this.stations = rows.map((s) => {
      const lat = Number(s.latitude);
      const lon = Number(s.longitude);
      const altKm = Number(s.altitude_m || 0) / 1000;
      return { id: s.id, code: s.code, name: s.name, status: s.status, lat, lon, altKm, minElevation: Number(s.min_elevation_deg ?? 5), ecef: O.geoToEcef(lat, lon, altKm) };
    });
    this.baseAt = 0;
    this.requestDraw();
  }

  setLive(map) {
    this.live = map;
  }

  select(id) {
    this.selected = id ?? null;
    this.tracksAt = 0;
    this.requestDraw();
  }

  setTimeOffset(ms) {
    this.timeOffset = ms;
    this.tracksAt = 0;
    this.baseAt = 0;
    this.requestDraw();
  }

  setOptions(o) {
    Object.assign(this.opts, o);
    this.tracksAt = 0;
    this.baseAt = 0;
    this.requestDraw();
  }

  resize() {
    const w = Math.round(this.container.clientWidth);
    if (!w) return;
    const hgt = Math.round(w / 2);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = w;
    this.H = hgt;
    this.dpr = dpr;
    for (const c of [this.canvas, this.base]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    this.baseAt = 0;
    this.drawNow();
  }

  requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      if (document.hidden) return;
      this.drawNow();
    });
  }

  // ---------- фоновый слой: обновляется раз в минуту ----------
  drawBase(t) {
    const { W, H, dpr } = this;
    const ctx = this.base.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.ocean;
    ctx.fillRect(0, 0, W, H);
    const sub = O.subsolarPoint(t);
    const sd = Math.sin(sub.lat * DEG);
    const cd = Math.cos(sub.lat * DEG);
    const sunElev = (lat, lon) => Math.sin(lat * DEG) * sd + Math.cos(lat * DEG) * cd * Math.cos((lon - sub.lon) * DEG);

    // ночь и сумерки: растр 1°, сглаживается при масштабировании
    if (this.opts.night) {
      const img = new ImageData(360, 180);
      for (let r = 0; r < 180; r++) {
        const lat = 89.5 - r;
        for (let c = 0; c < 360; c++) {
          const e = sunElev(lat, c - 179.5);
          const a = Math.max(0, Math.min(1, (0.1 - e) / 0.3)); // сумерки ~ от +6° до −12°
          const i = (r * 360 + c) * 4;
          img.data[i] = 3;
          img.data[i + 1] = 9;
          img.data[i + 2] = 15;
          img.data[i + 3] = Math.round(a * 150);
        }
      }
      const tmp = document.createElement('canvas');
      tmp.width = 360;
      tmp.height = 180;
      tmp.getContext('2d').putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tmp, 0, 0, W, H);
    }

    // сетка 30°
    ctx.lineWidth = 1;
    for (let lon = -150; lon <= 150; lon += 30) {
      const [x] = project(0, lon, W, H);
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, H);
      ctx.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const [, y] = project(lat, 0, W, H);
      ctx.strokeStyle = lat === 0 ? COLORS.equator : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(W, Math.round(y) + 0.5);
      ctx.stroke();
    }

    // точечная матрица суши
    const spacing = this.opts.compact ? 4.4 : 5;
    const stepDeg = Math.max(0.75, (360 * spacing) / W);
    if (this.landStep !== stepDeg) {
      this.landStep = stepDeg;
      this.landPts = landPoints(stepDeg);
    }
    const r = Math.max(0.9, ((stepDeg / 360) * W) * 0.3);
    for (const [lat, lon] of this.landPts) {
      const [x, y] = project(lat, lon, W, H);
      const e = this.opts.night ? sunElev(lat, lon) : 1;
      const k = Math.max(0, Math.min(1, (e + 0.12) / 0.3));
      const c0 = COLORS.landNight;
      const c1 = COLORS.landDay;
      ctx.fillStyle = `rgb(${Math.round(c0[0] + (c1[0] - c0[0]) * k)},${Math.round(c0[1] + (c1[1] - c0[1]) * k)},${Math.round(c0[2] + (c1[2] - c0[2]) * k)})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // подсолнечная точка
    if (this.opts.night) {
      const [sx, sy] = project(sub.lat, sub.lon, W, H);
      ctx.strokeStyle = 'rgba(242, 169, 59, 0.75)';
      ctx.fillStyle = 'rgba(242, 169, 59, 0.9)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(sx, sy, 3.2, 0, Math.PI * 2);
      ctx.fill();
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        ctx.beginPath();
        ctx.moveTo(sx + Math.cos(a) * 5.5, sy + Math.sin(a) * 5.5);
        ctx.lineTo(sx + Math.cos(a) * 8, sy + Math.sin(a) * 8);
        ctx.stroke();
      }
    }

    // зоны видимости станций для низкой орбиты 500 км
    if (this.opts.stationRings) {
      for (const st of this.stations) {
        if (st.status !== 'online') continue;
        const ang = O.footprintAngle(500, st.minElevation);
        const strong = this.opts.ringEmphasis;
        this.sphericalPolygon(ctx, O.circleOnSphere(st.lat, st.lon, ang, 120), st.lat, ang, { fill: strong ? 'rgba(76, 175, 106, 0.10)' : 'rgba(233, 244, 247, 0.035)', stroke: strong ? 'rgba(76, 175, 106, 0.7)' : 'rgba(233, 244, 247, 0.16)', lineWidth: strong ? 1.5 : 1 });
      }
    }
    this.baseAt = Date.now();
    this.baseTime = t;
  }

  /** Многоугольник на сфере с учётом линии перемены дат и полюсов */
  sphericalPolygon(ctx, pts, centerLat, angle, { fill, stroke, lineWidth = 1 }) {
    const { W, H } = this;
    const un = [];
    let prev = null;
    let shift = 0;
    for (const p of pts) {
      let lon = p.lon + shift;
      if (prev !== null) {
        if (lon - prev > 180) {
          shift -= 360;
          lon -= 360;
        } else if (lon - prev < -180) {
          shift += 360;
          lon += 360;
        }
      }
      un.push([lon, p.lat]);
      prev = lon;
    }
    const pole = Math.abs(centerLat) + angle / DEG > 90 ? Math.sign(centerLat) : 0;
    for (const off of [-360, 0, 360]) {
      const path = new Path2D();
      un.forEach(([lon, lat], i) => {
        const [x, y] = project(lat, lon + off, W, H);
        if (i) path.lineTo(x, y);
        else path.moveTo(x, y);
      });
      if (fill) {
        const area = new Path2D(path);
        if (pole) {
          const py = pole > 0 ? 0 : H;
          const [lx] = project(0, un[un.length - 1][0] + off, W, H);
          const [fx] = project(0, un[0][0] + off, W, H);
          area.lineTo(lx, py);
          area.lineTo(fx, py);
        }
        area.closePath();
        ctx.fillStyle = fill;
        ctx.fill(area);
      }
      if (stroke) {
        if (!pole) path.closePath();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lineWidth;
        ctx.stroke(path);
      }
    }
  }

  computeTracks(t) {
    this.tracks.clear();
    for (const sc of this.fleet) {
      if (sc.status === 'decommissioned' && sc.id !== this.selected) continue;
      const isSel = sc.id === this.selected;
      if (this.opts.tracks === 'none' && !isSel) continue;
      if (this.opts.tracks === 'selected' && !isSel) continue;
      const periodMs = sc.period * 60_000;
      if (sc.period > 1400 && !isSel) continue; // геостационар — трасса вырождается в точку
      const past = isSel ? periodMs * 0.5 : 0;
      const future = isSel ? Math.min(periodMs * 1.5, 26 * 3600_000) : Math.min(periodMs * 0.3, 3 * 3600_000);
      const step = Math.max(15_000, Math.min(240_000, periodMs / 220));
      this.tracks.set(sc.id, {
        past: past ? O.groundTrack(sc.el, t - past, t, step) : [],
        future: O.groundTrack(sc.el, t, t + future, step),
      });
    }
    this.tracksAt = Date.now();
    this.tracksTime = t;
  }

  drawNow() {
    if (!this.W) return;
    const t = this.now();
    if (!this.baseAt || Date.now() - this.baseAt > 60_000 || Math.abs(t - (this.baseTime || 0)) > 120_000) this.drawBase(t);
    if (!this.tracksAt || Date.now() - this.tracksAt > 20_000) this.computeTracks(t);
    const { W, H, dpr, ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sun = O.sunVector(t);

    // положения КА
    this.positions = this.fleet.map((sc) => {
      const st = O.stateAt(sc.el, t, sun);
      const [x, y] = project(st.lat, st.lon, W, H);
      return { sc, st, x, y };
    });
    const selPos = this.positions.find((p) => p.sc.id === this.selected);

    // зона обзора выбранного КА
    if (selPos && this.opts.footprint) {
      const ang = O.footprintAngle(Math.max(100, selPos.st.alt), 5);
      this.sphericalPolygon(ctx, O.circleOnSphere(selPos.st.lat, selPos.st.lon, ang, 140), selPos.st.lat, ang, {
        fill: hexA(selPos.sc.color, 0.09),
        stroke: hexA(selPos.sc.color, 0.55),
      });
    }

    // трассы
    for (const p of this.positions) {
      const tr = this.tracks.get(p.sc.id);
      if (!tr) continue;
      const isSel = p.sc.id === this.selected;
      ctx.lineJoin = 'round';
      if (isSel) {
        this.polyline(tr.past, COLORS.track, 1.5, 0.35);
        this.polyline(tr.future, COLORS.track, 2, 0.95, [6, 4]);
      } else {
        this.polyline(tr.future, p.sc.color, 1.2, 0.5);
      }
    }

    // станции и радиолинии
    this.stationPts = this.stations.map((s) => {
      const [x, y] = project(s.lat, s.lon, W, H);
      return { s, x, y };
    });
    if (this.opts.links) {
      for (const p of this.positions) {
        if (p.sc.status === 'decommissioned') continue;
        const link = this.bestLink(p.st.ecef);
        p.link = link;
        if (!link) continue;
        const sp = this.stationPts.find((q) => q.s.id === link.station.id);
        if (!sp) continue;
        ctx.strokeStyle = hexA(COLORS.link, p.sc.id === this.selected ? 0.95 : 0.6);
        ctx.lineWidth = p.sc.id === this.selected ? 1.8 : 1.1;
        ctx.setLineDash([]);
        ctx.beginPath();
        // короткий путь через линию перемены дат
        let x2 = p.x;
        if (Math.abs(p.x - sp.x) > W / 2) x2 = p.x + (p.x < sp.x ? W : -W);
        ctx.moveTo(sp.x, sp.y);
        ctx.lineTo(x2, p.y);
        ctx.stroke();
        if (x2 !== p.x) {
          ctx.beginPath();
          ctx.moveTo(sp.x + (p.x - x2), sp.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
      }
    }
    if (this.opts.stations) {
      for (const { s: st, x, y } of this.stationPts) {
        const color = st.status === 'online' ? COLORS.stationOnline : st.status === 'maintenance' ? COLORS.stationMaint : COLORS.stationOff;
        const sz = this.opts.compact ? 3.6 : 4.4;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = COLORS.ocean;
        ctx.fillRect(-sz, -sz, sz * 2, sz * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(-sz, -sz, sz * 2, sz * 2);
        ctx.restore();
        if (this.opts.labels && !this.opts.compact) {
          ctx.font = '500 10px Inter, system-ui, sans-serif';
          ctx.fillStyle = COLORS.labelDim;
          ctx.fillText(st.code, x + 7, y + 11);
        }
      }
    }

    // маркеры КА и подписи
    const placed = [];
    const order = [...this.positions].sort((a, b) => (a.sc.id === this.selected ? -1 : b.sc.id === this.selected ? 1 : 0));
    for (const p of [...order].reverse()) {
      const inactive = p.sc.status === 'decommissioned';
      const isSel = p.sc.id === this.selected;
      const isHover = this.hover?.kind === 'sc' && this.hover.id === p.sc.id;
      if (isSel || isHover) {
        ctx.fillStyle = hexA(p.sc.color, 0.22);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, inactive ? 3 : isSel ? 5.5 : 4.5, 0, Math.PI * 2);
      if (inactive) {
        ctx.strokeStyle = COLORS.inactive;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = p.sc.color;
        ctx.fill();
        ctx.strokeStyle = COLORS.ocean;
        ctx.lineWidth = 2;
        ctx.stroke();
        if (!p.st.sunlit) {
          // в тени — тёмная сердцевина
          ctx.fillStyle = 'rgba(5, 12, 18, 0.65)';
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    if (this.opts.labels) {
      ctx.font = '500 11px Inter, system-ui, sans-serif';
      for (const p of order) {
        const inactive = p.sc.status === 'decommissioned';
        if (inactive && p.sc.id !== this.selected) continue;
        if (this.opts.compact && p.sc.id !== this.selected && !(this.hover?.id === p.sc.id)) {
          // на компактной карте подписываем не все, чтобы не было каши
          if (placed.some((q) => Math.abs(q.x - p.x) < 70 && Math.abs(q.y - p.y) < 14)) continue;
        }
        const tx = p.x + 8;
        const ty = p.y - 7;
        const w = ctx.measureText(p.sc.name).width;
        if (placed.some((q) => tx < q.x + q.w + 4 && tx + w + 4 > q.x && Math.abs(ty - q.y) < 13)) continue;
        placed.push({ x: tx, y: ty, w });
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(8, 16, 24, 0.85)';
        ctx.strokeText(p.sc.name, tx, ty);
        ctx.fillStyle = p.sc.id === this.selected ? '#ffffff' : COLORS.label;
        ctx.fillText(p.sc.name, tx, ty);
      }
    }
    this.opts.onFrame?.(t, this.positions);
  }

  polyline(segments, color, width, alpha, dash) {
    const { ctx, W, H } = this;
    ctx.strokeStyle = hexA(color, alpha);
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    for (const seg of segments) {
      if (seg.length < 2) continue;
      ctx.beginPath();
      seg.forEach((pt, i) => {
        const [x, y] = project(pt.lat, pt.lon, W, H);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  bestLink(ecef) {
    let best = null;
    for (const st of this.stations) {
      if (st.status !== 'online') continue;
      const la = O.lookAngles(ecef, st);
      if (la.elevation >= st.minElevation && (!best || la.elevation > best.elevation)) best = { station: st, ...la };
    }
    return best;
  }

  hitTest(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.W;
    const y = ((e.clientY - rect.top) / rect.height) * this.H;
    let best = null;
    for (const p of this.positions) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 13 && (!best || d < best.d)) best = { kind: 'sc', id: p.sc.id, d, p };
    }
    if (best) return best;
    for (const sp of this.stationPts) {
      const d = Math.hypot(sp.x - x, sp.y - y);
      if (d < 10 && (!best || d < best.d)) best = { kind: 'station', id: sp.s.id, d, sp };
    }
    return best;
  }

  onMove(e) {
    const hit = this.hitTest(e);
    this.canvas.style.cursor = hit ? 'pointer' : 'crosshair';
    this.setHover(hit, e);
  }

  setHover(hit, e) {
    const changed = (hit?.kind || null) !== (this.hover?.kind || null) || hit?.id !== this.hover?.id;
    this.hover = hit;
    if (!hit) {
      this.tip.classList.add('hidden');
      if (changed) this.requestDraw();
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const cont = this.container.getBoundingClientRect();
    const lines = [];
    if (hit.kind === 'sc') {
      const { sc, st } = hit.p;
      const lv = this.live.get(sc.id);
      lines.push(['b', sc.name]);
      lines.push(['', `Высота ${Math.round(st.alt).toLocaleString('ru-RU')} км · ${st.speed.toFixed(2)} км/с`]);
      lines.push(['', `${Math.abs(st.lat).toFixed(1)}° ${st.lat >= 0 ? 'с. ш.' : 'ю. ш.'}, ${Math.abs(st.lon).toFixed(1)}° ${st.lon >= 0 ? 'в. д.' : 'з. д.'}`]);
      if (sc.status === 'decommissioned') lines.push(['', 'Выведен из эксплуатации']);
      else {
        lines.push(['', hit.p.link ? `Связь: ${hit.p.link.station.name}, ${hit.p.link.elevation.toFixed(0)}°` : 'Вне зоны связи']);
        lines.push(['', st.sunlit ? 'На Солнце' : 'В тени Земли']);
        if (lv && this.timeOffset === 0) lines.push(['', `АКБ ${Math.round(lv.battery)}% · ${lv.temperature.toFixed(0)} °C`]);
      }
    } else {
      const { s: st } = hit.sp;
      lines.push(['b', `${st.name} (${st.code})`]);
      lines.push(['', { online: 'На связи', maintenance: 'Обслуживание', offline: 'Отключена' }[st.status]]);
      const inView = this.positions.filter((p) => p.link?.station.id === st.id).map((p) => p.sc.name);
      lines.push(['', inView.length ? 'Ведёт: ' + inView.join(', ') : 'Сеанса нет']);
    }
    this.tip.replaceChildren(
      ...lines.map(([k, txt]) => {
        const el = document.createElement(k === 'b' ? 'b' : 'div');
        el.textContent = txt;
        return el;
      }),
    );
    this.tip.classList.remove('hidden');
    const px = hit.kind === 'sc' ? hit.p.x : hit.sp.x;
    const py = hit.kind === 'sc' ? hit.p.y : hit.sp.y;
    const scale = rect.width / this.W;
    let left = rect.left - cont.left + px * scale + 14;
    let top = rect.top - cont.top + py * scale + 12;
    const tw = this.tip.offsetWidth;
    const th = this.tip.offsetHeight;
    if (left + tw > cont.width - 4) left = rect.left - cont.left + px * scale - tw - 14;
    if (top + th > cont.height - 4) top = rect.top - cont.top + py * scale - th - 12;
    this.tip.style.left = Math.max(4, left) + 'px';
    this.tip.style.top = Math.max(4, top) + 'px';
    if (changed) this.requestDraw();
  }
}

function hexA(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
