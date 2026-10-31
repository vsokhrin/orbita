// Движок ЦУП: каждую секунду рассчитывает положение и состояние всех КА, сеансы связи
// с наземными станциями, исполняет командную очередь, обнаруживает неисправности,
// проводит запуски по расписанию и раздаёт поток телеметрии по SSE.
import * as O from '../../shared/orbit.js';
import { FAULTS, COMMAND_TYPES } from '../domain/dictionaries.js';
import { SIMULATED_STATUSES, initialState, stationsForModel, step, osculatingAngles, fuelForAltitudeChange } from './model.js';

const RANDOM_FAULTS = [
  ['seu', 0.55],
  ['thermal', 0.3],
  ['attitude', 0.15],
];

const round = (v, d = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

export class Engine {
  constructor({ db, hub, logger, config }) {
    this.db = db;
    this.hub = hub;
    this.log = logger;
    this.cfg = config;
    this.fleet = new Map();
    this.states = new Map();
    this.last = new Map();
    this.stations = [];
    this.queue = new Map();
    this.busy = new Set();
    this.contacts = [];
    this.timers = [];
    this.pendingOps = new Set();
    this.lastRetention = 0;
    this.lastContacts = 0;
  }

  // ---------- жизненный цикл ----------

  async start() {
    await this.reloadFleet();
    await this.loadStates();
    const recovered = await this.db.query(
      `UPDATE commands SET status = 'failed', completed_at = now(), result = 'Квитанция не получена: перезапуск ЦУП'
        WHERE status = 'uplinked'`,
    );
    if (recovered.rowCount) this.log.warn(`Команд без квитанции после перезапуска: ${recovered.rowCount}`);
    await this.refreshQueue();
    const every = (ms, fn) => this.timers.push(setInterval(() => this.safe(fn), ms));
    every(1000, () => this.tick());
    every(2000, () => this.broadcast());
    every(this.cfg.telemetryPersistSec * 1000, () => this.persist());
    every(5000, () => this.processLaunches());
    every(30_000, () => this.housekeeping());
    this.safe(() => this.housekeeping());
    this.log.info(`Движок запущен: ${this.fleet.size} КА, ${this.stations.length} станций`);
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.allSettled([...this.pendingOps]);
    await this.persist().catch(() => {});
  }

  safe(fn) {
    try {
      const r = fn();
      if (r && typeof r.then === 'function') {
        this.pendingOps.add(r);
        r.catch((err) => this.log.error('Движок: ' + (err.stack || err.message))).finally(() => this.pendingOps.delete(r));
      }
    } catch (err) {
      this.log.error('Движок: ' + (err.stack || err.message));
    }
  }

  // ---------- загрузка данных ----------

  async reloadFleet() {
    const rows = await this.db.many(`SELECT * FROM spacecraft WHERE status <> 'lost' ORDER BY id`);
    const next = new Map();
    for (const r of rows) {
      next.set(r.id, {
        id: r.id,
        code: r.code,
        name: r.name,
        type: r.type,
        status: r.status,
        color: r.color,
        powerMax: Number(r.power_w),
        massKg: Number(r.mass_kg || 1000),
        fuelKg: Number(r.fuel_kg),
        el: O.elementsFrom(r),
        simulated: SIMULATED_STATUSES.has(r.status),
      });
      if (SIMULATED_STATUSES.has(r.status) && !this.states.has(r.id)) {
        this.states.set(r.id, initialState(r));
      }
      const st = this.states.get(r.id);
      if (st) st.mode = r.status === 'safe_mode' ? 'safe' : st.mode === 'safe' ? 'nominal' : st.mode;
    }
    for (const id of this.states.keys()) if (!next.get(id)?.simulated) this.states.delete(id);
    this.fleet = next;
    this.stations = stationsForModel(await this.db.many('SELECT * FROM ground_stations ORDER BY id'));
    this.lastContacts = 0;
  }

  async loadStates() {
    const rows = await this.db.many(
      `SELECT DISTINCT ON (spacecraft_id) * FROM telemetry ORDER BY spacecraft_id, ts DESC`,
    );
    for (const r of rows) {
      const st = this.states.get(r.spacecraft_id);
      if (!st) continue;
      st.battery = r.battery;
      st.temperature = r.temperature;
      st.mode = r.mode === 'reboot' ? 'nominal' : r.mode;
      st.pointing = r.pointing;
      st.payloadOn = r.payload_on;
    }
    const open = await this.db.many(`SELECT spacecraft_id, kind FROM incidents WHERE status <> 'resolved' AND kind IS NOT NULL`);
    for (const { spacecraft_id: id, kind } of open) {
      const st = this.states.get(id);
      if (!st) continue;
      if (['seu', 'attitude', 'thermal'].includes(kind)) st.faults.add(kind);
      else st.alarms.add(kind);
    }
  }

  async refreshQueue() {
    const rows = await this.db.many(`SELECT * FROM commands WHERE status = 'queued' ORDER BY created_at, id`);
    const q = new Map();
    for (const c of rows) {
      if (!q.has(c.spacecraft_id)) q.set(c.spacecraft_id, []);
      q.get(c.spacecraft_id).push(c);
    }
    this.queue = q;
  }

  // ---------- основной цикл ----------

  tick(now = Date.now()) {
    const sun = O.sunVector(now);
    for (const sc of this.fleet.values()) {
      if (!sc.simulated) {
        // выведенные из эксплуатации КА остаются на орбите — показываем положение без телеметрии
        if (sc.status === 'decommissioned') {
          const p = O.stateAt(sc.el, now, sun);
          this.last.set(sc.id, { id: sc.id, lat: p.lat, lon: p.lon, alt: p.alt, speed: p.speed, sunlit: p.sunlit, inactive: true });
        } else this.last.delete(sc.id);
        continue;
      }
      const st = this.states.get(sc.id);
      const dt = st.lastT ? Math.min(10, Math.max(0, (now - st.lastT) / 1000)) : 1;
      const out = step(sc, st, now, dt, sun, this.stations);
      this.last.set(sc.id, { id: sc.id, ...out, st });
      this.checkThresholds(sc, st);
      this.maybeInjectFault(sc, st, dt);
      if (out.link && !this.busy.has(sc.id) && this.queue.get(sc.id)?.length) {
        this.safe(() => this.uplink(sc, out.link));
      }
    }
  }

  snapshot() {
    const items = [];
    for (const [id, v] of this.last) {
      const sc = this.fleet.get(id);
      if (!sc) continue;
      if (v.inactive) {
        items.push({ id, lat: round(v.lat, 3), lon: round(v.lon, 3), alt: round(v.alt), speed: round(v.speed, 3), sunlit: v.sunlit, status: sc.status, inactive: true });
        continue;
      }
      const st = v.st;
      items.push({
        id,
        status: sc.status,
        lat: round(v.lat, 3),
        lon: round(v.lon, 3),
        alt: round(v.alt),
        speed: round(v.speed, 3),
        sunlit: v.sunlit,
        battery: round(st.battery),
        temperature: round(st.temperature),
        power: round(v.generation, 0),
        load: round(v.load, 0),
        signal: round(v.signal),
        link: v.link ? { stationId: v.link.stationId, elevation: round(v.link.elevation), azimuth: round(v.link.azimuth, 0) } : null,
        mode: v.rebooting ? 'reboot' : st.mode,
        pointing: st.pointing,
        payloadOn: st.payloadOn,
        faults: [...st.faults],
        fuel: round(sc.fuelKg),
        queued: this.queue.get(id)?.length || 0,
      });
    }
    return items;
  }

  broadcast() {
    this.hub.broadcast('telemetry', { ts: Date.now(), items: this.snapshot() });
  }

  async persist() {
    const rows = [];
    const ts = new Date().toISOString();
    for (const [id, v] of this.last) {
      if (v.inactive || !v.st) continue;
      const st = v.st;
      rows.push([id, ts, round(st.battery, 2), round(st.temperature, 2), round(v.generation, 1), v.signal === null ? null : round(v.signal, 1),
        round(v.alt, 1), round(v.speed, 3), round(v.lat, 3), round(v.lon, 3), v.sunlit, v.rebooting ? 'reboot' : st.mode, st.pointing, st.payloadOn, v.link?.stationId ?? null]);
    }
    if (!rows.length) return;
    await insertTelemetry(this.db, rows);
  }

  // ---------- неисправности и инциденты ----------

  checkThresholds(sc, st) {
    const b = st.battery;
    const t = st.temperature;
    if (b < 25 && !st.alarms.has('battery_low')) this.raise(sc, st, 'battery_low', `Заряд АКБ ${b.toFixed(1)}% при норме не ниже 25%.`);
    if (b > 45 && st.alarms.has('battery_low')) this.autoResolve(sc, st, 'battery_low');
    if (b < 8 && !st.alarms.has('battery_critical')) {
      this.raise(sc, st, 'battery_critical', `Заряд АКБ ${b.toFixed(1)}%. Бортовая логика отключила целевую аппаратуру и перевела КА в безопасный режим.`);
      st.mode = 'safe';
      st.payloadOn = false;
      this.safe(() => this.setStatus(sc, 'safe_mode'));
    }
    if (b > 30 && st.alarms.has('battery_critical')) this.autoResolve(sc, st, 'battery_critical');
    if (t > 50 && !st.alarms.has('overheat')) this.raise(sc, st, 'overheat', `Температура приборного отсека ${t.toFixed(1)} °C при допуске до +50 °C.`);
    if (t < 35 && st.alarms.has('overheat')) this.autoResolve(sc, st, 'overheat');
  }

  maybeInjectFault(sc, st, dt) {
    if (sc.status !== 'active' || this.cfg.anomalyRatePerHour <= 0) return;
    if (Math.random() > (this.cfg.anomalyRatePerHour / 3600) * dt) return;
    let r = Math.random();
    for (const [kind, w] of RANDOM_FAULTS) {
      if ((r -= w) <= 0) {
        if (st.faults.has(kind)) return;
        st.faults.add(kind);
        const details = {
          seu: 'Контроль чётности ОЗУ бортового компьютера зафиксировал одиночный сбой. Возможна потеря данных целевой аппаратуры.',
          thermal: 'Температура блока целевой аппаратуры растёт быстрее расчётной. Возможен отказ системы терморегулирования.',
          attitude: 'Датчики угловой скорости показывают нештатное вращение. Солнечные батареи ушли с Солнца, генерация упала.',
        }[kind];
        this.raise(sc, st, kind, details);
        return;
      }
    }
  }

  raise(sc, st, kind, description) {
    const f = FAULTS[kind];
    if (['battery_low', 'battery_critical', 'overheat'].includes(kind)) st.alarms.add(kind);
    const recommendation = f.fix ? ` Рекомендуемое действие: команда «${COMMAND_TYPES[f.fix].label}».` : '';
    this.safe(async () => {
      const row = await this.db.one(
        `INSERT INTO incidents (spacecraft_id, severity, source, kind, title, description)
         VALUES ($1, $2, 'auto', $3, $4, $5)
         ON CONFLICT (spacecraft_id, kind) WHERE status <> 'resolved' AND kind IS NOT NULL DO NOTHING
         RETURNING *`,
        [sc.id, f.severity, kind, `${sc.name}: ${f.title.charAt(0).toLowerCase()}${f.title.slice(1)}`, description + recommendation],
      );
      if (row) this.hub.broadcast('incident', { action: 'created', incident: { ...row, spacecraft_name: sc.name } });
    });
  }

  autoResolve(sc, st, kind) {
    st.alarms.delete(kind);
    this.safe(() => this.resolveIncidents(sc.id, kind, null, 'Параметр вернулся в норму — закрыт автоматически.'));
  }

  async resolveIncidents(scId, kind, userId, resolution) {
    const rows = await this.db.many(
      `UPDATE incidents SET status = 'resolved', resolved_at = now(), resolved_by = $3, resolution = $4
        WHERE spacecraft_id = $1 AND kind = $2 AND status <> 'resolved' RETURNING *`,
      [scId, kind, userId, resolution],
    );
    for (const row of rows) this.hub.broadcast('incident', { action: 'updated', incident: row });
    return rows;
  }

  /** Вызывается, когда оператор закрыл инцидент вручную. */
  clearFault(scId, kind) {
    const st = this.states.get(scId);
    if (!st) return;
    st.faults.delete(kind);
    st.alarms.delete(kind);
  }

  async setStatus(sc, status) {
    if (sc.status === status) return;
    sc.status = status;
    sc.simulated = SIMULATED_STATUSES.has(status);
    await this.db.query('UPDATE spacecraft SET status = $2 WHERE id = $1', [sc.id, status]);
    this.hub.broadcast('fleet', { reason: 'status', id: sc.id, status });
  }

  // ---------- командная очередь ----------

  async uplink(sc, link) {
    const cmd = this.queue.get(sc.id)?.[0];
    if (!cmd) return;
    this.busy.add(sc.id);
    try {
      const row = await this.db.one(
        `UPDATE commands SET status = 'uplinked', uplinked_at = now(), station_id = $2
          WHERE id = $1 AND status = 'queued' RETURNING *`,
        [cmd.id, link.stationId],
      );
      const list = this.queue.get(sc.id) || [];
      this.queue.set(sc.id, list.filter((c) => c.id !== cmd.id));
      if (!row) {
        this.busy.delete(sc.id);
        return;
      }
      this.hub.broadcast('command', { action: 'updated', command: row });
      const delay = 2500 + Math.random() * 3500;
      setTimeout(() => {
        this.safe(() => this.execute(sc, row, link).finally(() => this.busy.delete(sc.id)));
      }, delay);
    } catch (err) {
      this.busy.delete(sc.id);
      throw err;
    }
  }

  async execute(sc, cmd, link) {
    const st = this.states.get(sc.id);
    const fresh = this.fleet.get(sc.id);
    let ok = true;
    let result = '';
    const fail = (msg) => {
      ok = false;
      result = msg;
    };
    if (!st || !fresh?.simulated) fail('КА недоступен для управления');
    else if (cmd.type !== 'PING' && Math.random() < 0.03) fail('Квитанция об исполнении не получена. Повторите команду в следующем сеансе.');
    else {
      switch (cmd.type) {
        case 'PING':
          result = `Квитанция получена: задержка ${Math.round((link.range / 299792.458) * 2000 + 180 + Math.random() * 60)} мс, угол места ${link.elevation.toFixed(1)}°.`;
          break;
        case 'SUN_POINTING':
          st.pointing = 'sun';
          result = 'Панели развёрнуты на Солнце, генерация максимальная.';
          if (st.faults.delete('attitude')) {
            result += ' Ориентация восстановлена.';
            await this.resolveIncidents(sc.id, 'attitude', cmd.issued_by, `Устранено командой №${cmd.id} «${COMMAND_TYPES.SUN_POINTING.label}».`);
          }
          break;
        case 'NADIR_POINTING':
          if (st.faults.has('attitude')) fail('Ориентация потеряна: сначала выполните ориентацию на Солнце.');
          else {
            st.pointing = 'nadir';
            result = 'КА ориентирован в надир.';
          }
          break;
        case 'PAYLOAD_ON':
          if (st.mode === 'safe') fail('В безопасном режиме целевая аппаратура не включается.');
          else if (st.battery < 30) fail(`Недостаточный заряд АКБ: ${st.battery.toFixed(0)}%, требуется не менее 30%.`);
          else {
            st.payloadOn = true;
            result = 'Целевая аппаратура включена.';
          }
          break;
        case 'PAYLOAD_OFF':
          st.payloadOn = false;
          result = 'Целевая аппаратура выключена.';
          if (st.faults.delete('thermal')) {
            result += ' Нагрев прекратился.';
            await this.resolveIncidents(sc.id, 'thermal', cmd.issued_by, `Устранено командой №${cmd.id} «${COMMAND_TYPES.PAYLOAD_OFF.label}».`);
          }
          break;
        case 'REBOOT_OBC':
          st.rebootUntil = Date.now() + 20_000;
          result = 'БКУ перезапущен, контрольные суммы памяти в норме.';
          if (st.faults.delete('seu')) {
            await this.resolveIncidents(sc.id, 'seu', cmd.issued_by, `Устранено командой №${cmd.id} «${COMMAND_TYPES.REBOOT_OBC.label}».`);
          }
          break;
        case 'ORBIT_CORRECTION':
          result = await this.correctOrbit(fresh, cmd, fail);
          break;
        case 'SAFE_MODE':
          st.mode = 'safe';
          st.payloadOn = false;
          await this.setStatus(fresh, 'safe_mode');
          result = 'КА переведён в безопасный режим.';
          break;
        case 'NOMINAL_MODE': {
          const critical = [...st.faults].filter((k) => FAULTS[k].severity === 'critical');
          if (critical.length) fail('Активны критические неисправности: ' + critical.map((k) => FAULTS[k].title.toLowerCase()).join(', ') + '.');
          else if (st.battery < 20) fail(`Заряд АКБ ${st.battery.toFixed(0)}% — недостаточно для штатного режима.`);
          else {
            st.mode = 'nominal';
            await this.setStatus(fresh, 'active');
            result = 'КА переведён в штатный режим.';
          }
          break;
        }
        default:
          fail('Неизвестная команда');
      }
    }
    const row = await this.db.one(
      `UPDATE commands SET status = $2, completed_at = now(), result = $3 WHERE id = $1 RETURNING *`,
      [cmd.id, ok ? 'executed' : 'failed', result],
    );
    if (row) this.hub.broadcast('command', { action: 'updated', command: row });
  }

  async correctOrbit(sc, cmd, fail) {
    const delta = Number(cmd.params?.delta_km || 0);
    const now = Date.now();
    const row = await this.db.one('SELECT * FROM spacecraft WHERE id = $1', [sc.id]);
    const newPerigee = Number(row.perigee_km) + delta;
    const newApogee = Number(row.apogee_km) + delta;
    if (newPerigee < 160) {
      fail(`Перигей опустился бы до ${newPerigee.toFixed(0)} км — ниже допустимых 160 км.`);
      return '';
    }
    const fuel = fuelForAltitudeChange(sc.el, delta, sc.massKg);
    if (fuel > Number(row.fuel_kg)) {
      fail(`Недостаточно топлива: требуется ${fuel.toFixed(1)} кг, на борту ${Number(row.fuel_kg).toFixed(1)} кг.`);
      return '';
    }
    const ang = osculatingAngles(sc.el, now);
    await this.db.query(
      `UPDATE spacecraft SET perigee_km = $2, apogee_km = $3, raan_deg = $4, arg_perigee_deg = $5,
              mean_anomaly_deg = $6, epoch = $7, fuel_kg = $8 WHERE id = $1`,
      [sc.id, newPerigee.toFixed(1), newApogee.toFixed(1), ang.raanDeg.toFixed(3), ang.argpDeg.toFixed(3), ang.meanAnomalyDeg.toFixed(3),
        new Date(now).toISOString(), (Number(row.fuel_kg) - fuel).toFixed(1)],
    );
    await this.reloadFleet();
    this.hub.broadcast('fleet', { reason: 'orbit', id: sc.id });
    const sign = delta > 0 ? '+' : '';
    return `Импульс выполнен: высота орбиты ${sign}${delta} км (перигей ${newPerigee.toFixed(0)} км, апогей ${newApogee.toFixed(0)} км), израсходовано ${fuel.toFixed(2)} кг топлива.`;
  }

  // ---------- запуски по расписанию ----------

  async processLaunches() {
    // за 15 минут до старта — автоматическое решение о готовности
    const ready = await this.db.many(
      `UPDATE launches SET status = 'go' WHERE status = 'scheduled' AND scheduled_at <= now() + interval '15 minutes' RETURNING *`,
    );
    for (const l of ready) this.hub.broadcast('launch', { action: 'updated', launch: l });

    const due = await this.db.many(`SELECT * FROM launches WHERE status = 'go' AND scheduled_at <= now()`);
    for (const launch of due) {
      const result = await this.db.transaction(async (tx) => {
        const l = await tx.one(`UPDATE launches SET status = 'success' WHERE id = $1 AND status = 'go' RETURNING *`, [launch.id]);
        if (!l) return null;
        let sc = null;
        if (l.spacecraft_id) {
          sc = await tx.one(
            `UPDATE spacecraft SET status = 'active', launch_date = (now() AT TIME ZONE 'UTC')::date, epoch = now(), mean_anomaly_deg = 0
              WHERE id = $1 AND status = 'planned' RETURNING *`,
            [l.spacecraft_id],
          );
        }
        const inc = await tx.one(
          `INSERT INTO incidents (spacecraft_id, severity, source, title, description)
           VALUES ($1, 'info', 'auto', $2, $3) RETURNING *`,
          [sc?.id ?? null, `Успешный запуск: ${l.name}`, `Ракета-носитель «${l.vehicle}», космодром ${l.site}.` + (sc ? ` КА «${sc.name}» выведен на расчётную орбиту, телеметрия поступает.` : '')],
        );
        await tx.query(
          `INSERT INTO audit_log (username, action, entity, entity_id, summary) VALUES ('система', 'launch', 'launch', $1, $2)`,
          [String(l.id), `Запуск «${l.name}» выполнен`],
        );
        return { l, sc, inc };
      });
      if (!result) continue;
      this.log.info(`Запуск выполнен: ${result.l.name}`);
      this.hub.broadcast('launch', { action: 'updated', launch: result.l });
      this.hub.broadcast('incident', { action: 'created', incident: result.inc });
      if (result.sc) {
        await this.reloadFleet();
        this.hub.broadcast('fleet', { reason: 'launch', id: result.sc.id });
      }
    }
  }

  // ---------- обслуживание ----------

  async housekeeping() {
    const expired = await this.db.many(
      `UPDATE commands SET status = 'expired', completed_at = now(), result = 'Срок действия истёк: не было сеанса связи'
        WHERE status = 'queued' AND expires_at < now() RETURNING *`,
    );
    if (expired.length) {
      await this.refreshQueue();
      for (const c of expired) this.hub.broadcast('command', { action: 'updated', command: c });
    }
    const now = Date.now();
    if (now - this.lastRetention > 3600_000) {
      this.lastRetention = now;
      await this.db.query(`DELETE FROM telemetry WHERE ts < now() - make_interval(hours => $1)`, [this.cfg.telemetryRetentionHours]);
      await this.db.query(`DELETE FROM sessions WHERE expires_at < now()`);
    }
    if (now - this.lastContacts > 60_000) {
      this.lastContacts = now;
      this.contacts = this.forecastContacts(now, 3);
    }
  }

  /** Прогноз ближайших сеансов связи всего флота на hours часов вперёд. */
  forecastContacts(from, hours) {
    const out = [];
    const to = from + hours * 3600_000;
    for (const sc of this.fleet.values()) {
      if (!sc.simulated) continue;
      for (const st of this.stations) {
        if (st.status !== 'online') continue;
        for (const p of O.predictPasses(sc.el, st, from, to, { stepMs: 30_000 })) {
          if (p.continuous) continue;
          out.push({ spacecraftId: sc.id, spacecraftName: sc.name, stationId: st.id, stationName: st.name, stationCode: st.code, ...p });
        }
      }
    }
    return out.sort((a, b) => a.aos - b.aos).slice(0, 60);
  }

  /** Сеансы связи конкретного КА со всеми станциями. */
  passesFor(scId, hours = 24) {
    const sc = this.fleet.get(scId);
    if (!sc) return [];
    const from = Date.now();
    const out = [];
    for (const st of this.stations) {
      if (st.status !== 'online') continue;
      for (const p of O.predictPasses(sc.el, st, from, from + hours * 3600_000)) {
        out.push({ stationId: st.id, stationName: st.name, stationCode: st.code, ...p });
      }
    }
    return out.sort((a, b) => a.aos - b.aos);
  }

  /** График станции: какие КА и когда пройдут в зоне видимости. */
  scheduleFor(stationId, hours = 12) {
    const st = this.stations.find((s) => s.id === stationId);
    if (!st) return [];
    const from = Date.now();
    const out = [];
    for (const sc of this.fleet.values()) {
      if (!sc.simulated) continue;
      for (const p of O.predictPasses(sc.el, st, from, from + hours * 3600_000)) {
        out.push({ spacecraftId: sc.id, spacecraftName: sc.name, color: sc.color, ...p });
      }
    }
    return out.sort((a, b) => a.aos - b.aos);
  }

  summary() {
    const items = this.snapshot().filter((i) => !i.inactive);
    return {
      tracked: this.last.size,
      simulated: items.length,
      inContact: items.filter((i) => i.link).length,
      inShadow: items.filter((i) => !i.sunlit).length,
      safeMode: items.filter((i) => i.mode === 'safe').length,
      queued: [...this.queue.values()].reduce((a, l) => a + l.length, 0),
      lowBattery: items.filter((i) => i.battery < 30).length,
      faults: items.reduce((a, i) => a + i.faults.length, 0),
    };
  }
}

export async function insertTelemetry(db, rows) {
  const COLS = 15;
  for (let start = 0; start < rows.length; start += 500) {
    const chunk = rows.slice(start, start + 500);
    const values = chunk.map((_, r) => '(' + Array.from({ length: COLS }, (_, c) => '$' + (r * COLS + c + 1)).join(',') + ')').join(',');
    await db.query(
      `INSERT INTO telemetry (spacecraft_id, ts, battery, temperature, power_w, signal_dbm, altitude_km, velocity_kms, lat, lon,
                              sunlit, mode, pointing, payload_on, station_id)
       VALUES ${values} ON CONFLICT DO NOTHING`,
      chunk.flat(),
    );
  }
}
