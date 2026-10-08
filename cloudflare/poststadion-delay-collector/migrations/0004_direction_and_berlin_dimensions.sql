ALTER TABLE arrival_observations ADD COLUMN direction_key TEXT;
ALTER TABLE arrival_observations ADD COLUMN direction_label TEXT;
ALTER TABLE arrival_observations ADD COLUMN direction_confidence TEXT;
ALTER TABLE arrival_observations ADD COLUMN service_pattern TEXT;
ALTER TABLE arrival_observations ADD COLUMN service_date TEXT;
ALTER TABLE arrival_observations ADD COLUMN weekday INTEGER;
ALTER TABLE arrival_observations ADD COLUMN scheduled_minute INTEGER;
ALTER TABLE arrival_observations ADD COLUMN time_bin_15m INTEGER;

CREATE INDEX IF NOT EXISTS idx_arrival_observations_direction_time
  ON arrival_observations(direction_key, weekday, time_bin_15m, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_arrival_observations_service_date_direction
  ON arrival_observations(service_date, direction_key);
