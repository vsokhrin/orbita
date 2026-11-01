// Хранилище движка симуляции поверх данных в памяти браузера.
// Тот же интерфейс, что у server/sim/sql-repo.js: каждый метод повторяет соответствующий SQL-запрос.

const nowIso = () => new Date().toISOString();

export class MemoryRepo {
  constructor(store) {
    this.store = store;
  }

  // ---------- чтение ----------

  async fleetRows() {
    return this.store.find('spacecraft', (s) => s.status !== 'lost').sort((a, b) => a.id - b.id);
  }

  async stationRows() {
    return [...this.store.all('ground_stations')].sort((a, b) => a.id - b.id);
  }

  async getSpacecraft(id) {
    return this.store.get('spacecraft', id);
  }

  async latestTelemetry() {
    return this.store.telemetry.latest();
  }

  async openFaultKinds() {
    return this.store.find('incidents', (i) => i.status !== 'resolved' && i.kind).map((i) => ({ spacecraft_id: i.spacecraft_id, kind: i.kind }));
  }

  async queuedCommands() {
    return this.store.find('commands', (c) => c.status === 'queued').sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
  }

  // ---------- телеметрия и состояние КА ----------

  async saveTelemetry(rows) {
    this.store.telemetry.add(rows);
    this.store.telemetryChanged();
  }

  async setSpacecraftStatus(id, status) {
    const sc = this.store.get('spacecraft', id);
    if (sc) this.store.update('spacecraft', sc, { status });
  }

  async updateOrbit(id, o) {
    const sc = this.store.get('spacecraft', id);
    if (sc) this.store.update('spacecraft', sc, o);
  }

  // ---------- инциденты ----------

  async createAutoIncident({ spacecraft_id, severity, kind, title, description }) {
    const open = this.store.find('incidents', (i) => i.spacecraft_id === spacecraft_id && i.kind === kind && i.status !== 'resolved');
    if (open.length) return null;
    return this.store.insert('incidents', { spacecraft_id, severity, source: 'auto', kind, title, description });
  }

  async resolveAutoIncidents(spacecraftId, kind, userId, resolution) {
    const rows = this.store.find('incidents', (i) => i.spacecraft_id === spacecraftId && i.kind === kind && i.status !== 'resolved');
    return rows.map((i) => this.store.update('incidents', i, { status: 'resolved', resolved_at: nowIso(), resolved_by: userId, resolution }));
  }

  // ---------- командная очередь ----------

  async failUplinkedCommands(result) {
    const rows = this.store.find('commands', (c) => c.status === 'uplinked');
    for (const c of rows) this.store.update('commands', c, { status: 'failed', completed_at: nowIso(), result });
    return rows.length;
  }

  async markUplinked(id, stationId) {
    const c = this.store.get('commands', id);
    if (!c || c.status !== 'queued') return null;
    return this.store.update('commands', c, { status: 'uplinked', uplinked_at: nowIso(), station_id: stationId });
  }

  async completeCommand(id, status, result) {
    const c = this.store.get('commands', id);
    return c ? this.store.update('commands', c, { status, completed_at: nowIso(), result }) : null;
  }

  async expireCommands(result) {
    const now = nowIso();
    return this.store
      .find('commands', (c) => c.status === 'queued' && c.expires_at < now)
      .map((c) => this.store.update('commands', c, { status: 'expired', completed_at: now, result }));
  }

  // ---------- запуски ----------

  async launchesToGo() {
    const limit = new Date(Date.now() + 15 * 60_000).toISOString();
    return this.store.find('launches', (l) => l.status === 'scheduled' && l.scheduled_at <= limit).map((l) => this.store.update('launches', l, { status: 'go' }));
  }

  async dueLaunches() {
    const now = nowIso();
    return this.store.find('launches', (l) => l.status === 'go' && l.scheduled_at <= now);
  }

  async completeLaunch(id, texts) {
    const launch = this.store.get('launches', id);
    if (!launch || launch.status !== 'go') return null;
    const now = nowIso();
    const l = this.store.update('launches', launch, { status: 'success' });
    let sc = l.spacecraft_id ? this.store.get('spacecraft', l.spacecraft_id) : null;
    if (sc && sc.status === 'planned') sc = this.store.update('spacecraft', sc, { status: 'active', launch_date: now.slice(0, 10), epoch: now, mean_anomaly_deg: 0 });
    else sc = null;
    const t = texts(l, sc);
    const inc = this.store.insert('incidents', { spacecraft_id: sc?.id ?? null, severity: 'info', source: 'auto', title: t.title, description: t.description });
    this.store.insert('audit_log', { username: 'система', action: 'launch', entity: 'launch', entity_id: String(l.id), summary: t.summary });
    return { l, sc, inc };
  }

  // ---------- обслуживание ----------

  async prune(retentionHours) {
    this.store.telemetry.prune(new Date(Date.now() - retentionHours * 3600_000).toISOString());
    const now = nowIso();
    this.store.remove('sessions', (s) => s.expires_at < now);
  }
}
