# Setup — discover-educ-orgs

Target Supabase project: **MAGTestProject** (`aivitcomiywiysrfwqxt`).
Deploys are done via the **Supabase MCP** (the CLI is blocked on this machine).

## 1. Apply migrations (creates the tables + seeds the grid)
- `0001_auto_found_educ_leads.sql`
- `0002_educ_discovery_runs.sql`
- `0003_educ_discovery_config.sql`  (grid + settings, ~180 seeded cells)

## 2. Secrets (edge-function secrets)
- `APIFY_API_TOKEN` — **already set** (used by `apify-platforms-sync`); reused here.
- `PUSH_SHARED_SECRET` — the `?token=` guard. Set a long random value and use the
  same value in the cron URL. If left unset the function runs unguarded.
- Optional overrides: `APIFY_ACTOR_GOOGLE_MAPS` (default `compass/crawler-google-places`),
  `APIFY_RUN_TIMEOUT_S` (default `95`).
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## 3. Deploy the function
Deploy `discover-educ-orgs` with `verify_jwt = false`, passing **all** files:
`discover-educ-orgs/index.ts`, `_shared/apify.ts`, `_shared/normalize.ts`.

## 4. Smoke test
- Dry run (no DB writes):
  `GET …/functions/v1/discover-educ-orgs?dry=1&sync=1&target=3&token=<secret>`
- Live run (saves up to 10 net-new):
  `GET …/functions/v1/discover-educ-orgs?sync=1&token=<secret>`
- Inspect: `select * from auto_found_educ_leads order by created_at desc;`
          `select * from educ_discovery_runs order by ran_at desc limit 5;`

## 5. Schedule
Run `schedule_discover_educ_orgs.sql` (replace `<PUSH_SHARED_SECRET>`).
Verify: `select jobname, schedule, active from cron.job;`

## Tuning (no redeploy needed)
- Change the daily target / filters: `update educ_discovery_settings set target_new = 10, reviews_floor = 20 where id = 1;`
- Add/disable search locations or terms: edit rows in `educ_discovery_config`.
- The grid rotates oldest-first (`last_run_at`), so new/edited cells get picked up next run.

## Notes / known tradeoff
Apify's Google-Maps scraper returns **no enrollment number**, so "≥600 students"
cannot be enforced from Maps data. "Big/independent enough" is approximated via
search terms + the `reviews_floor` prominence proxy + include/exclude keywords.
The `enrollment` column is kept nullable for a future enrichment pass.
