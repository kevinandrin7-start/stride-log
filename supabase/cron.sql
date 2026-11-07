-- Run this AFTER the "api" function is deployed. It checks for due reminders every 5 minutes.
-- Replace PROJECT_REF with the part of your Project URL before .supabase.co
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('stride-reminders') where exists (select 1 from cron.job where jobname = 'stride-reminders');
select cron.schedule('stride-reminders', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/api/reminders',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
