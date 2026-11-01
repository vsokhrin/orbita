// Общее состояние клиента: справочники, текущий пользователь, права, кэш флота и станций.
import { api } from './api.js';

export const state = {
  meta: null,
  user: null,
  fleet: null,
  stations: null,
};

export const can = {
  edit: () => ['admin', 'operator'].includes(state.user?.role),
  remove: () => state.user?.role === 'admin',
  admin: () => state.user?.role === 'admin',
};

/** Подпись значения справочника: dict('spacecraftStatuses', 'active') */
export function dict(name, key) {
  return state.meta?.[name]?.[key] ?? key ?? '—';
}

export function options(name) {
  return Object.entries(state.meta?.[name] || {}).map(([value, label]) => ({ value, label: typeof label === 'object' ? label.label : label }));
}

export async function loadFleet(force = false) {
  if (!force && state.fleet) return state.fleet;
  const [sc, st] = await Promise.all([api.get('/api/spacecraft', { limit: 500 }, { silent: true }), api.get('/api/stations', { limit: 500 }, { silent: true })]);
  state.fleet = sc.items;
  state.stations = st.items;
  return state.fleet;
}

export function invalidateFleet() {
  state.fleet = null;
  state.stations = null;
}

// Тона статусов для значков: ok | warn | crit | info | neutral
const TONES = {
  spacecraftStatuses: { active: 'ok', standby: 'info', safe_mode: 'warn', planned: 'neutral', decommissioned: 'neutral', lost: 'crit' },
  stationStatuses: { online: 'ok', maintenance: 'warn', offline: 'neutral' },
  missionStatuses: { active: 'ok', preparation: 'info', planning: 'neutral', completed: 'neutral', aborted: 'crit' },
  priorities: { low: 'neutral', medium: 'info', high: 'warn', critical: 'crit' },
  crewStatuses: { in_flight: 'ok', active: 'info', training: 'info', reserve: 'neutral', retired: 'neutral' },
  launchStatuses: { scheduled: 'info', go: 'ok', hold: 'warn', success: 'ok', failure: 'crit', scrubbed: 'neutral' },
  incidentSeverities: { info: 'info', warning: 'warn', critical: 'crit' },
  incidentStatuses: { open: 'crit', acknowledged: 'warn', resolved: 'neutral' },
  commandStatuses: { queued: 'info', uplinked: 'warn', executed: 'ok', failed: 'crit', cancelled: 'neutral', expired: 'neutral' },
  roles: { admin: 'crit', operator: 'info', observer: 'neutral' },
};
export const tone = (name, key) => TONES[name]?.[key] || 'neutral';
