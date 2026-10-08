CREATE TABLE IF NOT EXISTS arrival_observations (
  trip_instance_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  scheduled_at INTEGER NOT NULL,
  realtime_at INTEGER,
  effective_arrival_at INTEGER NOT NULL,
  delay_seconds INTEGER,
  observation_status TEXT NOT NULL CHECK (
    observation_status IN ('realtime', 'schedule_only', 'cancelled')
  ),
  is_cancelled INTEGER NOT NULL DEFAULT 0 CHECK (is_cancelled IN (0, 1)),
  line TEXT NOT NULL,
  destination TEXT,
  origin TEXT,
  platform TEXT,
  direction_key TEXT,
  direction_label TEXT,
  direction_confidence TEXT,
  service_pattern TEXT,
  service_date TEXT,
  weekday INTEGER,
  scheduled_minute INTEGER,
  time_bin_15m INTEGER
);

CREATE INDEX IF NOT EXISTS idx_arrival_observations_last_seen_at ON arrival_observations(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_arrival_observations_line_scheduled_at ON arrival_observations(line, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_arrival_observations_direction_time ON arrival_observations(direction_key, weekday, time_bin_15m, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_arrival_observations_service_date_direction ON arrival_observations(service_date, direction_key);

CREATE TABLE IF NOT EXISTS collector_daily_stats (
  stat_date TEXT PRIMARY KEY,
  last_run_at INTEGER NOT NULL,
  polls INTEGER NOT NULL DEFAULT 0,
  fetch_errors INTEGER NOT NULL DEFAULT 0,
  source_rows INTEGER NOT NULL DEFAULT 0,
  realtime_rows INTEGER NOT NULL DEFAULT 0,
  qualifying_rows INTEGER NOT NULL DEFAULT 0,
  inserted_events INTEGER NOT NULL DEFAULT 0,
  schedule_only_rows INTEGER NOT NULL DEFAULT 0,
  cancelled_rows INTEGER NOT NULL DEFAULT 0,
  candidate_rows INTEGER NOT NULL DEFAULT 0,
  written_observations INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collector_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_history_profiles (
  profile_date TEXT NOT NULL,
  direction_key TEXT NOT NULL,
  time_bin_15m INTEGER NOT NULL,
  typical_delay_min REAL,
  mean_delay_min REAL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  basis TEXT NOT NULL,
  source_data_through TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_date, direction_key, time_bin_15m)
);

CREATE INDEX IF NOT EXISTS idx_daily_history_profiles_lookup ON daily_history_profiles(profile_date, direction_key, time_bin_15m);
CREATE INDEX IF NOT EXISTS idx_arrival_observations_direction_bin_date ON arrival_observations(direction_key, time_bin_15m, service_date);
