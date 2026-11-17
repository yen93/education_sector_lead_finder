-- 0006_logged_to_sheet_at.sql
-- Per-row marker: when an org was mirrored into the ai_scraped_educ_leads sheet.
-- NULL = not yet in the sheet (the function appends these and stamps them, so a
-- failed append is retried on the next run instead of being lost).

alter table public.auto_found_educ_leads
  add column if not exists logged_to_sheet_at timestamptz;

create index if not exists auto_found_educ_leads_unlogged_idx
  on public.auto_found_educ_leads (id) where logged_to_sheet_at is null;

-- All rows that currently exist are already in the sheet (25 backfilled + run 4's 3),
-- so mark them logged to avoid re-appending them.
update public.auto_found_educ_leads
  set logged_to_sheet_at = now()
  where logged_to_sheet_at is null;
