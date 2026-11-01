// Хранилище движка симуляции на PostgreSQL.
// Движок (engine.js) обращается к данным только через этот интерфейс. Демо-версия для GitHub Pages
// реализует тот же интерфейс поверх данных в памяти браузера (demo/memory-repo.js) — поэтому
// логика полёта, неисправностей, командной очереди и запусков у обеих версий общая.

const TELEMETRY_COLUMNS = ['spacecraft_id', 'ts', 'battery', 'temperature', 'power_w', 'signal_dbm', 'altitude_km', 'velocity_kms', 'lat', 'lon', 'sunlit', 'mode', 'pointing', 'payload_on', 'station_id'];

/** Пакетная вставка записей телеметрии (объекты с полями таблицы telemetry). */
export async function insertTelemetry(db, rows) {
  const n = TELEMETRY_COLUMNS.length;
  for (let start = 0; start < rows.length; start += 500) {
    const chunk = rows.slice(start, start + 500);
    const values = chunk.map((_, r) => '(' + TELEMETRY_COLUMNS.map((_, c) => '$' + (r * n + c + 1)).join(',') + ')').join(',');
    await db.query(
      `INSERT INTO telemetry (${TELEMETRY_COLUMNS.join(', ')}) VALUES ${values} ON CONFLICT DO NOTHING`,
      chunk.flatMap((row) => TELEMETRY_COLUMNS.map((c) => row[c] ?? null)),
    );
  }
}

export class SqlRepo {
  constructor(db) {
    this.db = db;
  }

  // ---------- чтение ----------

  fleetRows() {
    return this.db.many(`SELECT * FROM spacecraft WHERE status <> 'lost' ORDER BY id`);
  }

  stationRows() {
    return this.db.many('SELECT * FROM ground_stations ORDER BY id');
  }

  getSpacecraft(id) {
    return this.db.one('SELECT * FROM spacecraft WHERE id = $1', [id]);
  }

  latestTelemetry() {
    return this.db.many(`SELECT DISTINCT ON (spacecraft_id) * FROM telemetry ORDER BY spacecraft_id, ts DESC`);
  }

  openFaultKinds() {
    return this.db.many(`SELECT spacecraft_id, kind FROM incidents WHERE status <> 'resolved' AND kind IS NOT NULL`);
  }

  queuedCommands() {
    return this.db.many(`SELECT * FROM commands WHERE status = 'queued' ORDER BY created_at, id`);
  }

  // ---------- телеметрия и состояние КА ----------

  saveTelemetry(rows) {
    return insertTelemetry(this.db, rows);
  }

  setSpacecraftStatus(id, status) {
    return this.db.query('UPDATE spacecraft SET status = $2 WHERE id = $1', [id, status]);
  }

  updateOrbit(id, o) {
    return this.db.query(
      `UPDATE spacecraft SET perigee_km = $2, apogee_km = $3, raan_deg = $4, arg_perigee_deg = $5,
              mean_anomaly_deg = $6, epoch = $7, fuel_kg = $8 WHERE id = $1`,
      [id, o.perigee_km, o.apogee_km, o.raan_deg, o.arg_perigee_deg, o.mean_anomaly_deg, o.epoch, o.fuel_kg],
    );
  }

  // ---------- инциденты ----------

  /** Автоматический инцидент; null, если незакрытый инцидент того же вида у КА уже есть. */
  createAutoIncident({ spacecraft_id, severity, kind, title, description }) {
    return this.db.one(
      `INSERT INTO incidents (spacecraft_id, severity, source, kind, title, description)
       VALUES ($1, $2, 'auto', $3, $4, $5)
       ON CONFLICT (spacecraft_id, kind) WHERE status <> 'resolved' AND kind IS NOT NULL DO NOTHING
       RETURNING *`,
      [spacecraft_id, severity, kind, title, description],
    );
  }

  resolveAutoIncidents(spacecraftId, kind, userId, resolution) {
    return this.db.many(
      `UPDATE incidents SET status = 'resolved', resolved_at = now(), resolved_by = $3, resolution = $4
        WHERE spacecraft_id = $1 AND kind = $2 AND status <> 'resolved' RETURNING *`,
      [spacecraftId, kind, userId, resolution],
    );
  }

  // ---------- командная очередь ----------

  async failUplinkedCommands(result) {
    const r = await this.db.query(`UPDATE commands SET status = 'failed', completed_at = now(), result = $1 WHERE status = 'uplinked'`, [result]);
    return r.rowCount;
  }

  markUplinked(id, stationId) {
    return this.db.one(
      `UPDATE commands SET status = 'uplinked', uplinked_at = now(), station_id = $2
        WHERE id = $1 AND status = 'queued' RETURNING *`,
      [id, stationId],
    );
  }

  completeCommand(id, status, result) {
    return this.db.one(`UPDATE commands SET status = $2, completed_at = now(), result = $3 WHERE id = $1 RETURNING *`, [id, status, result]);
  }

  expireCommands(result) {
    return this.db.many(
      `UPDATE commands SET status = 'expired', completed_at = now(), result = $1
        WHERE status = 'queued' AND expires_at < now() RETURNING *`,
      [result],
    );
  }

  // ---------- запуски ----------

  /** За 15 минут до старта — автоматическое решение о готовности. */
  launchesToGo() {
    return this.db.many(`UPDATE launches SET status = 'go' WHERE status = 'scheduled' AND scheduled_at <= now() + interval '15 minutes' RETURNING *`);
  }

  dueLaunches() {
    return this.db.many(`SELECT * FROM launches WHERE status = 'go' AND scheduled_at <= now()`);
  }

  /**
   * Успешный старт: запуск → success, КА → на орбите, инцидент-уведомление и запись аудита — одной транзакцией.
   * texts(launch, spacecraft) возвращает { title, description, summary }. Результат: { l, sc, inc } или null.
   */
  completeLaunch(id, texts) {
    return this.db.transaction(async (tx) => {
      const l = await tx.one(`UPDATE launches SET status = 'success' WHERE id = $1 AND status = 'go' RETURNING *`, [id]);
      if (!l) return null;
      let sc = null;
      if (l.spacecraft_id) {
        sc = await tx.one(
          `UPDATE spacecraft SET status = 'active', launch_date = (now() AT TIME ZONE 'UTC')::date, epoch = now(), mean_anomaly_deg = 0
            WHERE id = $1 AND status = 'planned' RETURNING *`,
          [l.spacecraft_id],
        );
      }
      const t = texts(l, sc);
      const inc = await tx.one(
        `INSERT INTO incidents (spacecraft_id, severity, source, title, description) VALUES ($1, 'info', 'auto', $2, $3) RETURNING *`,
        [sc?.id ?? null, t.title, t.description],
      );
      await tx.query(`INSERT INTO audit_log (username, action, entity, entity_id, summary) VALUES ('система', 'launch', 'launch', $1, $2)`, [String(l.id), t.summary]);
      return { l, sc, inc };
    });
  }

  // ---------- обслуживание ----------

  async prune(retentionHours) {
    await this.db.query(`DELETE FROM telemetry WHERE ts < now() - make_interval(hours => $1)`, [retentionHours]);
    await this.db.query(`DELETE FROM sessions WHERE expires_at < now()`);
  }
}
