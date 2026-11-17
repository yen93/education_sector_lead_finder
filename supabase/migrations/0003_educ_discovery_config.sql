-- 0003_educ_discovery_config.sql
-- The region x search-term grid the finder rotates through (editable without a
-- redeploy), plus a single-row settings table for tunable thresholds.

-- ---------- grid ----------
create table if not exists public.educ_discovery_config (
  id          bigint generated always as identity primary key,
  country     text not null,                 -- 'AU' | 'US' | 'UK'
  region      text not null,                 -- metro / state passed to Apify as "{region}, {country}"
  search_term text not null,
  max_results integer not null default 20,   -- maxCrawledPlacesPerSearch per cell
  enabled     boolean not null default true,
  last_run_at timestamptz,                   -- rotating cursor: oldest runs first
  unique (country, region, search_term)
);

create index if not exists educ_discovery_config_cursor_idx
  on public.educ_discovery_config (enabled, last_run_at nulls first);

-- Seed the grid: every (region) x (search_term) combination.
insert into public.educ_discovery_config (country, region, search_term)
select r.country, r.region, t.term
from (values
  -- Australia
  ('AU','Sydney NSW'), ('AU','Melbourne VIC'), ('AU','Brisbane QLD'),
  ('AU','Perth WA'), ('AU','Adelaide SA'), ('AU','Canberra ACT'),
  ('AU','Gold Coast QLD'), ('AU','Hobart TAS'), ('AU','Newcastle NSW'),
  ('AU','Geelong VIC'),
  -- United States
  ('US','New York NY'), ('US','Los Angeles CA'), ('US','Boston MA'),
  ('US','San Francisco CA'), ('US','Chicago IL'), ('US','Washington DC'),
  ('US','Houston TX'), ('US','Dallas TX'), ('US','Atlanta GA'),
  ('US','Philadelphia PA'), ('US','Seattle WA'), ('US','Miami FL'),
  -- United Kingdom
  ('UK','London'), ('UK','Manchester'), ('UK','Birmingham'),
  ('UK','Edinburgh'), ('UK','Bristol'), ('UK','Leeds'),
  ('UK','Oxford'), ('UK','Cambridge'), ('UK','Glasgow'), ('UK','Brighton')
) as r(country, region)
cross join (values
  ('independent school'),
  ('grammar school'),
  ('private college'),
  ('international school'),
  ('independent schools association'),
  ('education association')
) as t(term)
on conflict (country, region, search_term) do nothing;

-- ---------- settings (single row, id = 1) ----------
create table if not exists public.educ_discovery_settings (
  id              integer primary key default 1,
  target_new      integer not null default 10,   -- net-new orgs to collect per run
  reviews_floor   integer not null default 10,   -- prominence proxy for "big enough"
  max_cells_run   integer not null default 40,   -- safety cap on cells scanned per run
  include_keywords text[] not null default array[
    'independent','grammar','college','private','international',
    'anglican','catholic','preparatory','academy','school','association',
    'council','institute','society','federation','alliance'
  ],
  exclude_keywords text[] not null default array[
    'child care','childcare','day care','daycare','preschool','pre-school',
    'kindergarten','early learning','early childhood','tutor','tutoring',
    'driving school','language school','english language','dance','swim',
    'music school','art school','vocational','business school','university',
    'rto','tafe','training','beauty','massage','yoga','gym'
  ],
  constraint educ_discovery_settings_singleton check (id = 1)
);

insert into public.educ_discovery_settings (id) values (1)
on conflict (id) do nothing;

alter table public.educ_discovery_config enable row level security;
alter table public.educ_discovery_settings enable row level security;
