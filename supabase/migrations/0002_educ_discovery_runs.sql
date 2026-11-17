-- 0002_educ_discovery_runs.sql
-- Append-only audit log: one row per discover-educ-orgs invocation.
-- Mirrors the educ_router_runs convention. Never updated/deleted.

create table if not exists public.educ_discovery_runs (
  id               bigint generated always as identity primary key,
  ran_at           timestamptz not null default now(),
  trigger          text,                       -- 'cron' | 'manual' | 'dry'
  target_new       integer,
  cells_processed  jsonb,                      -- [{country,region,search_term,found,kept}]
  places_found     integer not null default 0,
  candidates_kept  integer not null default 0,
  inserted         integer not null default 0, -- net-new rows
  updated          integer not null default 0, -- re-seen rows refreshed
  skipped_existing integer not null default 0, -- already in manual or auto table
  apify_runs       jsonb,                      -- [{actor, run_id, items}]
  ok               boolean not null default false,
  error            text,
  duration_ms      integer
);

create index if not exists educ_discovery_runs_ran_idx
  on public.educ_discovery_runs (ran_at desc);

alter table public.educ_discovery_runs enable row level security;
