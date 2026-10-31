-- ОРБИТА: базовая схема информационной системы ЦУП

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Пользователи и сессии ---------------------------------------------------------

CREATE TABLE users (
  id            serial PRIMARY KEY,
  username      text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_.-]{3,32}$'),
  full_name     text NOT NULL CHECK (length(full_name) BETWEEN 2 AND 120),
  role          text NOT NULL CHECK (role IN ('admin', 'operator', 'observer')),
  password_hash text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE sessions (
  id           text PRIMARY KEY,               -- SHA-256 от токена из cookie
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

-- Космические аппараты ----------------------------------------------------------

CREATE TABLE spacecraft (
  id                serial PRIMARY KEY,
  code              text NOT NULL UNIQUE CHECK (length(code) BETWEEN 2 AND 24),
  name              text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  type              text NOT NULL CHECK (type IN ('station', 'earth_observation', 'communication', 'navigation', 'science', 'cargo', 'technology')),
  status            text NOT NULL CHECK (status IN ('planned', 'active', 'standby', 'safe_mode', 'decommissioned', 'lost')),
  operator          text NOT NULL,
  launch_date       date,
  mass_kg           numeric(10,1) CHECK (mass_kg IS NULL OR mass_kg > 0),
  power_w           numeric(10,1) NOT NULL DEFAULT 1000 CHECK (power_w > 0),
  fuel_kg           numeric(10,1) NOT NULL DEFAULT 0 CHECK (fuel_kg >= 0),
  perigee_km        numeric(10,1) NOT NULL CHECK (perigee_km >= 150),
  apogee_km         numeric(10,1) NOT NULL CHECK (apogee_km >= perigee_km),
  inclination_deg   numeric(7,3) NOT NULL CHECK (inclination_deg BETWEEN 0 AND 180),
  raan_deg          numeric(7,3) NOT NULL DEFAULT 0 CHECK (raan_deg >= 0 AND raan_deg < 360),
  arg_perigee_deg   numeric(7,3) NOT NULL DEFAULT 0 CHECK (arg_perigee_deg >= 0 AND arg_perigee_deg < 360),
  mean_anomaly_deg  numeric(7,3) NOT NULL DEFAULT 0 CHECK (mean_anomaly_deg >= 0 AND mean_anomaly_deg < 360),
  epoch             timestamptz NOT NULL DEFAULT now(),
  color             text NOT NULL DEFAULT '#3987e5' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  description       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spacecraft_status_idx ON spacecraft(status);
CREATE TRIGGER spacecraft_touch BEFORE UPDATE ON spacecraft FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Наземные станции --------------------------------------------------------------

CREATE TABLE ground_stations (
  id                 serial PRIMARY KEY,
  code               text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{2,12}$'),
  name               text NOT NULL,
  country            text NOT NULL,
  latitude           numeric(8,4) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude          numeric(9,4) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  altitude_m         numeric(7,1) NOT NULL DEFAULT 0,
  antenna_diameter_m numeric(5,1) CHECK (antenna_diameter_m IS NULL OR antenna_diameter_m > 0),
  bands              text NOT NULL DEFAULT 'S',
  min_elevation_deg  numeric(4,1) NOT NULL DEFAULT 5 CHECK (min_elevation_deg BETWEEN 0 AND 45),
  status             text NOT NULL CHECK (status IN ('online', 'maintenance', 'offline')),
  description        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER stations_touch BEFORE UPDATE ON ground_stations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Миссии и экипаж ---------------------------------------------------------------

CREATE TABLE missions (
  id            serial PRIMARY KEY,
  code          text NOT NULL UNIQUE CHECK (length(code) BETWEEN 2 AND 24),
  name          text NOT NULL,
  objective     text,
  spacecraft_id integer REFERENCES spacecraft(id) ON DELETE SET NULL,
  status        text NOT NULL CHECK (status IN ('planning', 'preparation', 'active', 'completed', 'aborted')),
  priority      text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  start_date    date,
  end_date      date,
  progress      integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  budget_mln    numeric(12,2) CHECK (budget_mln IS NULL OR budget_mln >= 0),
  flight_director text,
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX missions_spacecraft_idx ON missions(spacecraft_id);
CREATE TRIGGER missions_touch BEFORE UPDATE ON missions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE crew_members (
  id             serial PRIMARY KEY,
  full_name      text NOT NULL CHECK (length(full_name) BETWEEN 3 AND 120),
  call_sign      text,
  position       text NOT NULL CHECK (position IN ('commander', 'flight_engineer', 'mission_specialist', 'payload_specialist')),
  status         text NOT NULL CHECK (status IN ('active', 'training', 'in_flight', 'reserve', 'retired')),
  birth_date     date,
  nationality    text,
  flights_count  integer NOT NULL DEFAULT 0 CHECK (flights_count >= 0),
  hours_in_space numeric(10,1) NOT NULL DEFAULT 0 CHECK (hours_in_space >= 0),
  eva_count      integer NOT NULL DEFAULT 0 CHECK (eva_count >= 0),
  bio            text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER crew_touch BEFORE UPDATE ON crew_members FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE mission_crew (
  mission_id integer NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  crew_id    integer NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('commander', 'flight_engineer', 'mission_specialist', 'payload_specialist', 'backup')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id, crew_id)
);
CREATE INDEX mission_crew_crew_idx ON mission_crew(crew_id);

-- Запуски -----------------------------------------------------------------------

CREATE TABLE launches (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  vehicle        text NOT NULL,
  site           text NOT NULL,
  scheduled_at   timestamptz NOT NULL,
  window_minutes integer NOT NULL DEFAULT 0 CHECK (window_minutes BETWEEN 0 AND 1440),
  status         text NOT NULL CHECK (status IN ('scheduled', 'go', 'hold', 'success', 'failure', 'scrubbed')),
  spacecraft_id  integer REFERENCES spacecraft(id) ON DELETE SET NULL,
  mission_id     integer REFERENCES missions(id) ON DELETE SET NULL,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX launches_scheduled_idx ON launches(scheduled_at);
CREATE TRIGGER launches_touch BEFORE UPDATE ON launches FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Инциденты ---------------------------------------------------------------------

CREATE TABLE incidents (
  id              serial PRIMARY KEY,
  spacecraft_id   integer REFERENCES spacecraft(id) ON DELETE CASCADE,
  station_id      integer REFERENCES ground_stations(id) ON DELETE SET NULL,
  severity        text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('auto', 'manual')),
  kind            text,
  title           text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  description     text,
  created_by      integer REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_by integer REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  resolved_by     integer REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  resolution      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_status_idx ON incidents(status, severity);
CREATE INDEX incidents_created_idx ON incidents(created_at DESC);
CREATE INDEX incidents_spacecraft_idx ON incidents(spacecraft_id);
-- не больше одного незакрытого автоматического инцидента одного вида на аппарат
CREATE UNIQUE INDEX incidents_open_kind_uidx ON incidents(spacecraft_id, kind) WHERE status <> 'resolved' AND kind IS NOT NULL;
CREATE TRIGGER incidents_touch BEFORE UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Командная очередь -------------------------------------------------------------

CREATE TABLE commands (
  id            serial PRIMARY KEY,
  spacecraft_id integer NOT NULL REFERENCES spacecraft(id) ON DELETE CASCADE,
  type          text NOT NULL,
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'uplinked', 'executed', 'failed', 'cancelled', 'expired')),
  issued_by     integer REFERENCES users(id) ON DELETE SET NULL,
  station_id    integer REFERENCES ground_stations(id) ON DELETE SET NULL,
  incident_id   integer REFERENCES incidents(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  uplinked_at   timestamptz,
  completed_at  timestamptz,
  expires_at    timestamptz NOT NULL,
  result        text
);
CREATE INDEX commands_status_idx ON commands(status);
CREATE INDEX commands_spacecraft_idx ON commands(spacecraft_id, created_at DESC);

-- Телеметрия --------------------------------------------------------------------

CREATE TABLE telemetry (
  spacecraft_id integer NOT NULL REFERENCES spacecraft(id) ON DELETE CASCADE,
  ts            timestamptz NOT NULL,
  battery       real NOT NULL,
  temperature   real NOT NULL,
  power_w       real NOT NULL,
  signal_dbm    real,
  altitude_km   real NOT NULL,
  velocity_kms  real NOT NULL,
  lat           real NOT NULL,
  lon           real NOT NULL,
  sunlit        boolean NOT NULL,
  mode          text NOT NULL,
  pointing      text NOT NULL,
  payload_on    boolean NOT NULL,
  station_id    integer,
  PRIMARY KEY (spacecraft_id, ts)
);

-- Журнал аудита -----------------------------------------------------------------

CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  ts        timestamptz NOT NULL DEFAULT now(),
  user_id   integer REFERENCES users(id) ON DELETE SET NULL,
  username  text,
  action    text NOT NULL,
  entity    text,
  entity_id text,
  summary   text,
  details   jsonb,
  ip        text
);
CREATE INDEX audit_ts_idx ON audit_log(ts DESC);
CREATE INDEX audit_entity_idx ON audit_log(entity, entity_id);
