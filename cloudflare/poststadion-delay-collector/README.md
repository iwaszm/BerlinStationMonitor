# Poststadion delay collector

This Worker continuously records near-arrival observations for buses `123` and `142` at Poststadion. It uses the project's normalized `bsm.zhang-meng.com` departure API and keeps a rolling 28-day window: records and daily health statistics older than 28 days are deleted automatically.

The collector runs every minute. A vehicle is written when all of the following are true:

- its line is in `LINE_FILTER`;
- its effective arrival time, `rt_datetime ?? sched_datetime`, is between one minute before and two minutes after the current time.

The observation status is `realtime`, `schedule_only`, or `cancelled`. The API reports `delay` in minutes; when it is present, the Worker derives `scheduled_at` as `arrivalAt - delay * 60`. Only `realtime` observations have a usable `delay_seconds`; schedule-only data is not treated as punctual. The unique key is `line + direction group + scheduled_at`, so a temporary terminal change remains in the same direction group and repeat polls update the same trip instance. Responses older than 150 seconds according to `fetchedAt` are rejected to prevent cached data from being recorded as current.

`arrival_observations` records the raw destination alongside direction metadata. The four stable groups are `123_to_hauptbahnhof` (platform `1`), `123_to_maeckeritzwiesen` (platform `2`), `142_to_ostbahnhof` (platform `1`), and `142_to_leopoldplatz` (platform `2`). Every new observation also stores Berlin-local `service_date`, ISO `weekday` (`1` Monday through `7` Sunday), `scheduled_minute`, and `time_bin_15m`. The complete official station sequences and temporary-terminal matching rules live in `src/lineDirections.mjs`.

`collector_daily_stats.stat_date` and the daily prune marker also use the `Europe/Berlin` calendar date, so dashboard health totals reset at Berlin midnight rather than UTC midnight.

## Deploy

Run these commands from the repository root after logging into the intended Cloudflare account:

```powershell
npx wrangler whoami
npx wrangler d1 create poststadion-delay-history
```

Copy the returned database ID into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`. Then create the schema and deploy:

```powershell
npx wrangler d1 execute poststadion-delay-history --file cloudflare/poststadion-delay-collector/schema.sql --remote
npm.cmd run deploy:collector
```

The health endpoint returns the latest daily collection totals:

```text
https://poststadion-delay-collector.<your-subdomain>.workers.dev/healthz
```

`realtime_rows` is the key source-quality measurement. A low value means the upstream feed is returning schedules without realtime predictions; those near-arrival records are still retained as `schedule_only`.

To collect every bus at Poststadion, set `LINE_FILTER` to `*`. To change retention, set `RETENTION_DAYS`; the default is `28`.
