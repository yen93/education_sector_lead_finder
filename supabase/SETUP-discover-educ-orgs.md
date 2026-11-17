# Setup — discover-educ-orgs

Target Supabase project: **MAGTestProject** (`aivitcomiywiysrfwqxt`).
Deploys are done via the **Supabase MCP** (the CLI is blocked on this machine).

## 1. Apply migrations (creates the tables + seeds the grid)
- `0001_auto_found_educ_leads.sql`
- `0002_educ_discovery_runs.sql`
- `0003_educ_discovery_config.sql`  (grid + settings seed)
- `0004_elite_k12_tuning.sql`      (category filters, elite-K12 search terms, reviews_floor 15)
- `0005_discovery_runs_sheet_sync.sql` (sheet_appended / sheet_error on the run log)
- `0006_logged_to_sheet_at.sql`    (per-row Google Sheet sync marker)

## 2. Secrets (edge-function secrets)
- `APIFY_API_TOKEN` — **already set** (used by `apify-platforms-sync`); reused here.
- `PUSH_SHARED_SECRET` — the `?token=` guard. Set a long random value and use the
  same value in the cron URL. If left unset the function runs unguarded.
- `GOOGLE_SERVICE_ACCOUNT_JSON` — **already set** (used by `alternate-lead-finder`); must have
  editor access to the target spreadsheet. Without it the sheet mirror is skipped and
  rows stay unlogged (retried once it is set).
- Optional overrides: `APIFY_ACTOR_GOOGLE_MAPS` (default `compass/crawler-google-places`),
  `APIFY_RUN_TIMEOUT_S` (default `95`), `MAX_RUN_MS` (default `120000`),
  `SHEETS_SPREADSHEET_ID`, `SHEETS_TAB` (default `ai_scraped_educ_leads`).
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## 3. Deploy the function
Deploy `discover-educ-orgs` with `verify_jwt = false`, passing **all** files:
`functions/discover-educ-orgs/index.ts`, `functions/_shared/apify.ts`,
`functions/_shared/normalize.ts`, `functions/_shared/sheets.ts`.

## 4. Smoke test
- Trigger a live run the way cron does (a shell curl with the token may be blocked):
  `select net.http_post(url := '.../functions/v1/discover-educ-orgs?region=Sydney&target=3&token=<secret>', ...);`
  then read `educ_discovery_runs`. (`?sync=1` runs inline and returns JSON; `?dry=1` writes nothing.)
- Inspect: `select * from auto_found_educ_leads order by created_at desc;`
          `select * from educ_discovery_runs order by ran_at desc limit 5;`
          `select count(*) filter (where logged_to_sheet_at is null) from auto_found_educ_leads;`

## 5. Schedule
Run `schedule_discover_educ_orgs.sql` (replace `<PUSH_SHARED_SECRET>`).
Verify: `select jobname, schedule, active from cron.job;`

## Google Sheet mirror
Rows with `logged_to_sheet_at IS NULL` are appended to the `ai_scraped_educ_leads` tab, columns
A-F: org_name | school_or_association | country | region | website | category, then stamped.
Column G ("Liv's Remark") is human-owned. If the tab's columns change, edit the row mapping in
`index.ts` and redeploy.

## Tuning (no redeploy needed)
- Change the daily target / filters: `update educ_discovery_settings set target_new = 10, reviews_floor = 20 where id = 1;`
- Add/disable search locations or terms: edit rows in `educ_discovery_config`.
- The grid rotates oldest-first (`last_run_at`), so new/edited cells get picked up next run.

## Notes / known tradeoff
Apify's Google-Maps scraper returns **no enrollment number**, so ">=600 students"
cannot be enforced from Maps data. "Big/independent enough" is approximated via
search terms + the category filter + the `reviews_floor` prominence proxy + include/exclude
keywords. The `enrollment` column is kept nullable for a future enrichment pass.
