-- 0004_elite_k12_tuning.sql
-- Push discovery toward elite K-12 independent schools:
--  * add category allow/block lists (Google Maps categoryName is a strong signal)
--  * raise the prominence floor
--  * replace noisy search terms with elite-K12 ones (keep associations)

-- 1) Category-aware filtering + higher floor.
alter table public.educ_discovery_settings
  add column if not exists include_categories text[] not null default array[
    'school','preparatory','grammar','college','academy','gymnasium',
    'day school','boarding'
  ],
  add column if not exists exclude_categories text[] not null default array[
    'university','community college','junior college','vocational','business school',
    'language school','english','tutor','training','trade school','technical school',
    'technical college','adult education','driving school','child care','preschool',
    'pre-school','kindergarten','education center','education centre','further education',
    'polytechnic','institute of technology','music school','dance school','art school',
    'beauty school','cooking school','flight school','college of further'
  ];

update public.educ_discovery_settings set reviews_floor = 15 where id = 1;

-- 2) Retire the noisy search terms (never deleted — just disabled).
update public.educ_discovery_config
  set enabled = false
  where search_term in ('private college','international school','education association');

-- 3) Add the elite-K12 search terms across every region.
insert into public.educ_discovery_config (country, region, search_term)
select distinct country, region, t.term
from public.educ_discovery_config
cross join (values
  ('private school'),
  ('preparatory school'),
  ('boarding school')
) as t(term)
on conflict (country, region, search_term) do nothing;

-- Make the newly added terms active (rows disabled above keep enabled=false).
update public.educ_discovery_config
  set enabled = true
  where search_term in ('private school','preparatory school','boarding school');
