-- 0005_discovery_runs_sheet_sync.sql
-- Track the Google Sheet mirror (ai_scraped_educ_leads tab) in the run audit log.

alter table public.educ_discovery_runs
  add column if not exists sheet_appended integer not null default 0,
  add column if not exists sheet_error    text;
