-- 0001_auto_found_educ_leads.sql
-- New table holding schools/associations discovered automatically by the
-- discover-educ-orgs edge function. Org-level only (no contact enrichment).
-- UPSERT-ONLY target: unique (org_name_norm, country) is the conflict key.
-- RLS enabled with NO policies => service_role access only (matches house pattern).

create table if not exists public.auto_found_educ_leads (
  id                    bigint generated always as identity primary key,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  org_name              text not null,
  org_name_norm         text not null,
  school_or_association text not null default 'school',
  country               text,                 -- 'AU' | 'US' | 'UK'
  region                text,                 -- metro / state used in the search
  website               text,
  domain                text,
  address               text,
  phone                 text,
  category              text,
  rating                numeric,
  reviews_count         integer,
  enrollment            integer,              -- nullable; not available from Google Maps
  sector                text,                 -- 'independent' | ... (inferred, nullable)
  status                text not null default 'new',
  source                text not null default 'apify_google_maps',
  source_query          text,
  apify_run_id          text,
  place_id              text,
  raw                   jsonb
);

-- Dedup / upsert conflict target.
create unique index if not exists auto_found_educ_leads_norm_country_uidx
  on public.auto_found_educ_leads (org_name_norm, country);

-- Helpful lookups.
create index if not exists auto_found_educ_leads_status_idx
  on public.auto_found_educ_leads (status);
create index if not exists auto_found_educ_leads_created_idx
  on public.auto_found_educ_leads (created_at desc);

alter table public.auto_found_educ_leads enable row level security;
