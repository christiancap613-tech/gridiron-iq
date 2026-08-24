-- ── PG_CRON SCHEDULES FOR EDGE FUNCTIONS ────────────────────────────
-- BEFORE RUNNING: enable pg_cron and pg_net via the Supabase Dashboard:
--   Dashboard → Database → Extensions → search "pg_cron" → toggle on
--   Dashboard → Database → Extensions → search "pg_net"  → toggle on
--
-- Then paste this file into SQL Editor and run.
--
-- Schedule 1: generate-weekly-recommendations
--   Every Wednesday 8pm ET = Thursday 00:00 UTC
--   Cron: 0 0 * * 4
--
-- Schedule 2: grade-weekly-outcomes
--   Every Monday 10am ET = Monday 14:00 UTC
--   Cron: 0 14 * * 1

-- Remove existing jobs by name if they already exist (idempotent)
DO $$
BEGIN
  PERFORM cron.unschedule('generate-weekly-recommendations');
EXCEPTION WHEN OTHERS THEN NULL;
END;
$$;

DO $$
BEGIN
  PERFORM cron.unschedule('grade-weekly-outcomes');
EXCEPTION WHEN OTHERS THEN NULL;
END;
$$;

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
SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobid;
