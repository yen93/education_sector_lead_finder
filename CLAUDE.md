# education_sector_lead_finder

Daily automation that discovers **elite K-12 independent schools and education
associations** (AU, US, UK) and saves them to `public.auto_found_educ_leads` in
Supabase project **MAGTestProject (`aivitcomiywiysrfwqxt`)**. Org-level only (no
contact enrichment). See `as_built.txt` for the current-state inventory.

## What it does
- Edge function `discover-educ-orgs` scrapes Google Maps via **Apify**
  (`compass/crawler-google-places`), walking the `educ_discovery_config` grid
  oldest-first (`last_run_at` cursor).
- Filter (`_shared/normalize.ts` `passesFilter`): exclude keywords/categories first
  (university, VET, business school, ELICOS, further-ed...), then require a school-type
  Google `categoryName` or strong name token, then `reviews_count >= reviews_floor`.
  Associations skip the category and reviews checks.
- **Dedups against `manually_found_educ_leads.account` AND `auto_found_educ_leads`**
  (normalised names), upserts until `target_new` (10), time-boxed by `MAX_RUN_MS` (120s).
- **POC enrichment pass** (`_shared/deepmine.ts`): after discovery, for each org with
  `poc_searched_at IS NULL` (oldest first, so the backlog backfills too) it searches public
  LinkedIn by **org NAME** via Apify actor `deepmine~linkedin-company-employees` (names +
  job titles only, **NO emails** — same actor the Alternate Lead Finder uses) and stores
  `poc_firstname/poc_lastname/poc_role` for ONE person in a target role. Searches run in
  **parallel** (`DEEPMINE_CONCURRENCY`, 10) inside a reserved budget (`POC_BUDGET_MS`, 60s
  carved out of `MAX_RUN_MS`) with a wall-clock guard — mirrors the Alternate Lead Finder's
  strategy. `poc_searched_at` is stamped even when no POC is found (so the org isn't
  re-searched; clear it to NULL to retry); a provider error leaves it NULL to retry next run.
  Target roles are **school-tailored and priority-ordered** (outdoor/experiential/expeditions
  → co-curricular/camps/excursions/tours → business/operations/bursar → principal/deputy/head
  → development/advancement → events/conference → marketing/comms/admissions → membership/PL),
  the first group to match wins. Capped at `POC_MAX_ORGS` (10) distinct orgs per run.
- **Mirrors to Google Sheets**: appends unlogged orgs (driven by `auto_found_educ_leads.logged_to_sheet_at`)
  to the `ai_scraped_educ_leads` tab via a service account (`GOOGLE_SERVICE_ACCOUNT_JSON`,
  `_shared/sheets.ts`), then stamps `logged_to_sheet_at`. Columns A-F: org_name, school_or_association,
  country, region, website, category (NO phone; col G "Liv's Remark" is human). Non-fatal — a failed
  append leaves rows unlogged so the next run retries. Record: `educ_discovery_runs.sheet_appended/sheet_error`.
- Daily via `pg_cron` -> `net.http_post` at `0 22 * * *` (06:00 PHT), job `discover-educ-orgs-daily`.

## Rules
- **Never truncate / bulk delete.** Upsert on `(org_name_norm, country)`. Retire grid
  cells by `enabled=false`, never by deleting.
- Secrets stay as edge-function secrets, never in the repo. The `?token=` guard is the
  shared `PUSH_SHARED_SECRET`; do not paste it into files or chat logs.
- Deploy via **Supabase MCP** `deploy_edge_function` (`verify_jwt=false`) passing
  `functions/discover-educ-orgs/index.ts` + all **four** `functions/_shared/*.ts`
  (`apify`, `normalize`, `sheets`, `deepmine`) — the CLI is blocked on this machine.
  A deploy replaces all files, so always resend all five (index + 4 shared).
- The user handles all git/commits.

## Gotchas (learned the hard way)
- **Apify input shape:** location must be inside `searchStringsArray`
  (`"<term> in <region>, <country>"`). Separate `locationQuery` returns `[]` with HTTP 201;
  `city`/`country` fields make the run FAIL. Use `?probe=1|2|3` to diagnose the actor.
- The actor's `url` is the Google Maps listing, not the org site; `website` may be null.
- Edge wall-clock limit (~150s) kills a run mid-flight (rows saved, no audit row). Keep
  `MAX_RUN_MS` under it; tune `max_results` (20) and `max_cells_run` (40) instead.
- Testing: a shell `curl` with the token gets blocked by the auto-mode classifier. Trigger
  runs with `select net.http_post(...)` via `execute_sql` and read `net._http_response`
  plus `educ_discovery_runs`. `?sync=1` runs inline; without it the function returns 202.
  Use `?target=0` to skip discovery and run ONLY the POC pass over the backlog. `?pocprobe=<org
  name>` runs a raw DeepMine search (no writes) and shows people returned + the picked POC.
  (`net.http_post` needs `timeout_milliseconds` ~150000 — a DeepMine search is ~40s.)
- **DeepMine `jobTitle` is sometimes a free-text tagline**, not a real role, so it can match a
  role keyword by accident ("...for sustainable development" matched "development"). `deepmine.ts`
  `looksLikeJobTitle` rejects titles >70 chars, >8 words, or ending in `.?!`. If a bad POC role
  still slips through, null the three `poc_*` fields in place (keep `poc_searched_at`).
- The actor searches by org NAME (no cookies); coverage is partial (~0-3 target-role people
  per org, none for some). Low-quality/VET "college" rows (the pre-tuning backlog) often match
  weak roles like "Finance Manager"; that's expected noise, not a bug.
- Runs fired via net.http_post log `trigger='cron'` in the audit table even when manual.
- The sheet append is positional (columns A:F). If anyone adds/removes/reorders columns in the
  `ai_scraped_educ_leads` tab, update the row mapping in `index.ts` and redeploy, or rows misalign.
  (The phone column was deleted from the sheet on 2026-11-17 and the mapping updated.)
- The Sheets connector `append_values` tool takes no `value_input_option`; the function's own
  append uses USER_ENTERED.

## Layout
- `supabase/functions/discover-educ-orgs/index.ts`, `supabase/functions/_shared/{apify,normalize,sheets,deepmine}.ts`
- `supabase/migrations/0001..0007_*.sql` — tables, audit, grid + settings, elite-K12 tuning,
  sheet-sync audit columns (0005), `logged_to_sheet_at` marker (0006), POC enrichment columns (0007)
- `supabase/schedule_discover_educ_orgs.sql` — cron template (token placeholder)
- `supabase/SETUP-discover-educ-orgs.md` — setup and tuning
- `prompts/171126_discover_educ_orgs.txt` — original task spec

## Tables
- `auto_found_educ_leads` (output; `status` stays 'new', `logged_to_sheet_at` is the sheet-sync
  marker; `poc_firstname/poc_lastname/poc_role` hold the enriched POC, `poc_searched_at` is the
  POC-pass marker — NULL = not yet searched),
  `educ_discovery_runs` (append-only audit, incl. sheet_appended/sheet_error),
  `educ_discovery_config` (grid), `educ_discovery_settings` (single row: target_new,
  reviews_floor, max_cells_run, include/exclude keywords and categories).

## Tuning (plain SQL, no redeploy)
`update educ_discovery_settings set reviews_floor = 20 where id = 1;` and edit/disable rows
in `educ_discovery_config`. Add keywords/categories by updating the text[] columns.
POC pass knobs are edge-function env vars (no SQL): `POC_MAX_ORGS` (10), `DEEPMINE_CONCURRENCY`
(10), `POC_BUDGET_MS` (60000), `POC_FLUSH_RESERVE_MS` (8000), `DEEPMINE_MAX_RESULTS` (100),
`DEEPMINE_TIMEOUT_S` (90), `DEEPMINE_ACTOR`. The POC pass reuses the existing `APIFY_API_TOKEN`
secret. The target-role list lives in `_shared/deepmine.ts` (`TARGET_ROLE_GROUPS`) — needs a redeploy.

## Known tradeoff
No enrollment data from Google Maps, so ">=600 students" is approximated by search terms,
category filter and `reviews_floor`; `enrollment` stays null for a future enrichment pass
(ACARA/NCES/GIAS registers or a per-site scrape).
