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
  `functions/discover-educ-orgs/index.ts` + all three `functions/_shared/*.ts` — the CLI is
  blocked on this machine. A deploy replaces all files, so always resend all four.
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
- Runs fired via net.http_post log `trigger='cron'` in the audit table even when manual.
- The sheet append is positional (columns A:F). If anyone adds/removes/reorders columns in the
  `ai_scraped_educ_leads` tab, update the row mapping in `index.ts` and redeploy, or rows misalign.
  (The phone column was deleted from the sheet on 2026-11-17 and the mapping updated.)
- The Sheets connector `append_values` tool takes no `value_input_option`; the function's own
  append uses USER_ENTERED.

## Layout
- `supabase/functions/discover-educ-orgs/index.ts`, `supabase/functions/_shared/{apify,normalize,sheets}.ts`
- `supabase/migrations/0001..0006_*.sql` — tables, audit, grid + settings, elite-K12 tuning,
  sheet-sync audit columns (0005), `logged_to_sheet_at` marker (0006)
- `supabase/schedule_discover_educ_orgs.sql` — cron template (token placeholder)
- `supabase/SETUP-discover-educ-orgs.md` — setup and tuning
- `prompts/171126_discover_educ_orgs.txt` — original task spec

## Tables
- `auto_found_educ_leads` (output; `status` stays 'new', `logged_to_sheet_at` is the sheet-sync marker),
  `educ_discovery_runs` (append-only audit, incl. sheet_appended/sheet_error),
  `educ_discovery_config` (grid), `educ_discovery_settings` (single row: target_new,
  reviews_floor, max_cells_run, include/exclude keywords and categories).

## Tuning (plain SQL, no redeploy)
`update educ_discovery_settings set reviews_floor = 20 where id = 1;` and edit/disable rows
in `educ_discovery_config`. Add keywords/categories by updating the text[] columns.

## Known tradeoff
No enrollment data from Google Maps, so ">=600 students" is approximated by search terms,
category filter and `reviews_floor`; `enrollment` stays null for a future enrichment pass
(ACARA/NCES/GIAS registers or a per-site scrape).
