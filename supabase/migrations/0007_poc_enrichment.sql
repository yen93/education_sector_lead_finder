-- 0007_poc_enrichment.sql
-- Add point-of-contact (POC) enrichment columns. The discover-educ-orgs function
-- now runs a second pass that searches public LinkedIn (Apify actor
-- deepmine~linkedin-company-employees) by the org NAME and records one person in a
-- target POC role (name + role only; NO emails, same as the Alternate Lead Finder).
--
-- Additive + idempotent. Never truncates / drops data (global rule): an org searched
-- with no matching POC is marked via poc_searched_at so it is not re-searched forever
-- (same marker pattern as logged_to_sheet_at).

alter table public.auto_found_educ_leads
  add column if not exists poc_firstname  text,
  add column if not exists poc_lastname   text,
  add column if not exists poc_role       text,
  add column if not exists poc_searched_at timestamptz;

comment on column public.auto_found_educ_leads.poc_firstname is
  'Point-of-contact first name (Apify deepmine~linkedin-company-employees, by org name).';
comment on column public.auto_found_educ_leads.poc_lastname is
  'Point-of-contact last name.';
comment on column public.auto_found_educ_leads.poc_role is
  'Point-of-contact job title/role (the matched target role; no email is collected).';
comment on column public.auto_found_educ_leads.poc_searched_at is
  'When the POC LinkedIn search last ran for this org. NULL = not yet searched (the '
  'POC pass picks these up). Stamped even when no POC was found, so the org is not '
  're-searched; clear it to NULL to retry.';

-- Only the not-yet-searched rows are scanned each run; index the marker for that filter.
create index if not exists auto_found_educ_leads_poc_searched_at_idx
  on public.auto_found_educ_leads (poc_searched_at);

-- Per-run audit counters for the POC pass.
alter table public.educ_discovery_runs
  add column if not exists poc_searched int,
  add column if not exists poc_found    int;

comment on column public.educ_discovery_runs.poc_searched is
  'Distinct orgs a DeepMine POC search ran for this run.';
comment on column public.educ_discovery_runs.poc_found is
  'Orgs for which a target-role POC was found and stored this run.';
