-- ── PG_CRON SCHEDULES FOR EDGE FUNCTIONS ────────────────────────────
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New query)
--
-- Prerequisites:
--   pg_cron and pg_net must be enabled.
--   Dashboard → Database → Extensions → enable pg_cron and pg_net if not already on.
--
-- Schedule 1: generate-weekly-recommendations
--   Every Wednesday 8pm ET = Thursday 00:00 UTC
--   Cron: 0 0 * * 4
--
-- Schedule 2: grade-weekly-outcomes
--   Every Monday 10am ET = Monday 14:00 UTC
--   Cron: 0 14 * * 1

-- Enable extensions (safe if already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove existing jobs with these names before re-creating (idempotent)
SELECT cron.unschedule('generate-weekly-recommendations') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'generate-weekly-recommendations'
);
SELECT cron.unschedule('grade-weekly-outcomes') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'grade-weekly-outcomes'
);

-- ── JOB 1: Generate weekly recommendations ───────────────────────────
-- Fires Wednesday 8pm ET (Thursday 00:00 UTC) — cron: 0 0 * * 4
SELECT cron.schedule(
  'generate-weekly-recommendations',
  '0 0 * * 4',
  $$
  SELECT net.http_post(
    url     := 'https://niawfubwwstjpwbtrsgm.supabase.co/functions/v1/generate-weekly-recommendations',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pYXdmdWJ3d3N0anB3YnRyc2dtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NDI5MDAsImV4cCI6MjA5NTQxODkwMH0.-vup-to4ONOSQFKiR9CKkgVNRHr6yRyQxggwlbNdq-0'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);

-- ── JOB 2: Grade weekly outcomes ─────────────────────────────────────
-- Fires Monday 10am ET (Monday 14:00 UTC) — cron: 0 14 * * 1
SELECT cron.schedule(
  'grade-weekly-outcomes',
  '0 14 * * 1',
  $$
  SELECT net.http_post(
    url     := 'https://niawfubwwstjpwbtrsgm.supabase.co/functions/v1/grade-weekly-outcomes',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pYXdmdWJ3d3N0anB3YnRyc2dtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NDI5MDAsImV4cCI6MjA5NTQxODkwMH0.-vup-to4ONOSQFKiR9CKkgVNRHr6yRyQxggwlbNdq-0'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);

-- ── VERIFY ───────────────────────────────────────────────────────────
-- Run this after to confirm both jobs are registered:
-- SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobid;
