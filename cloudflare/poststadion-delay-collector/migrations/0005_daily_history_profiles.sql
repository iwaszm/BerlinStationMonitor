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

CREATE INDEX IF NOT EXISTS idx_daily_history_profiles_lookup
  ON daily_history_profiles(profile_date, direction_key, time_bin_15m);

CREATE INDEX IF NOT EXISTS idx_arrival_observations_direction_bin_date
  ON arrival_observations(direction_key, time_bin_15m, service_date);
