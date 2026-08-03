-- ── USERS TABLE ─────────────────────────────────────────────────────
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New query)

CREATE TABLE IF NOT EXISTS users (
  id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  sleeper_username  text        UNIQUE NOT NULL,
  sleeper_league_id text,
  dynasty_league_id text,
  espn_league_id    text,
  espn_team_id      text,
  email             text,
  created_at        timestamptz DEFAULT now()
);

-- ── SEED USERS ───────────────────────────────────────────────────────
-- christiancap24 and caution1011 share the same dynasty league:
-- "BFI Dynasty League" (1354515225516199936)
-- caution1011 Sleeper user_id: 985640373244465152
--   additional leagues: Heavy Hitters (1386032557006544896, redraft)
--                       XFL (1312536192486473728, dynasty)

INSERT INTO users (sleeper_username, sleeper_league_id, dynasty_league_id)
VALUES
  ('christiancap24', '1354515225516199936', '1354515225516199936'),
  ('caution1011',    '1354515225516199936', '1354515225516199936')
ON CONFLICT (sleeper_username) DO UPDATE SET
  sleeper_league_id = EXCLUDED.sleeper_league_id,
  dynasty_league_id = EXCLUDED.dynasty_league_id;

-- ── OUTCOMES TABLE — ADD MISSING COLUMNS ────────────────────────────
-- Add actual_points and variance_pending if not already present
-- (safe to run even if columns already exist)

ALTER TABLE outcomes
  ADD COLUMN IF NOT EXISTS actual_points    numeric,
  ADD COLUMN IF NOT EXISTS variance_pending boolean DEFAULT false;

-- ── RECOMMENDATIONS TABLE — ENSURE week COLUMN EXISTS ───────────────
ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS reasoning text;
