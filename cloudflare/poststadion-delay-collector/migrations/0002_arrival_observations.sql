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
  platform TEXT
);

CREATE INDEX IF NOT EXISTS idx_arrival_observations_last_seen_at
  ON arrival_observations(last_seen_at);

CREATE INDEX IF NOT EXISTS idx_arrival_observations_line_scheduled_at
  ON arrival_observations(line, scheduled_at);

ALTER TABLE collector_daily_stats ADD COLUMN schedule_only_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collector_daily_stats ADD COLUMN cancelled_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collector_daily_stats ADD COLUMN candidate_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collector_daily_stats ADD COLUMN written_observations INTEGER NOT NULL DEFAULT 0;
