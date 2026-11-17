-- schedule_discover_educ_orgs.sql
-- Daily pg_cron job that fires the discover-educ-orgs edge function.
-- 0 22 * * *  = 22:00 UTC = 06:00 Philippine time (UTC+8).
-- Replace <PUSH_SHARED_SECRET> with the value set as the edge-function secret.
-- Run this ONCE in the Supabase SQL editor (or via MCP) for project aivitcomiywiysrfwqxt.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any previous copy so re-running this file is idempotent.
select cron.unschedule('discover-educ-orgs-daily')
where exists (select 1 from cron.job where jobname = 'discover-educ-orgs-daily');

select cron.schedule(
  'discover-educ-orgs-daily',
  '0 22 * * *',
  $$
  select net.http_post(
    url := 'https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/discover-educ-orgs?token=<PUSH_SHARED_SECRET>',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Verify:
--   select jobid, jobname, schedule, active from cron.job where jobname = 'discover-educ-orgs-daily';
