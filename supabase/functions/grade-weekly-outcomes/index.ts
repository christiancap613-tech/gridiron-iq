/**
 * grade-weekly-outcomes
 *
 * Invoke from Supabase Dashboard → Functions → grade-weekly-outcomes → Invoke
 * Or via CLI: supabase functions invoke grade-weekly-outcomes
 *
 * Grades the PREVIOUS week's ungraded recommendations by comparing each
 * player's actual Sleeper matchup points against positional averages.
 *
 * Required secrets (same as generate-weekly-recommendations):
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 *   SUPABASE_URL              — auto-injected
 *
 * Handles gracefully when:
 *   - No recommendations exist for the previous week (season not started)
 *   - Sleeper matchup data is empty (week hasn't been played yet)
 *   - Individual players can't be matched to matchup data
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── CONFIG ──────────────────────────────────────────────────────────
// Keep in sync with generate-weekly-recommendations.
// grade-weekly-outcomes always grades CURRENT_WEEK - 1.
const CURRENT_WEEK   = 1;
const CURRENT_SEASON = 2026;
const GRADE_WEEK     = CURRENT_WEEK - 1;  // grades the previous week

// Positional fantasy point averages used as correct/wrong thresholds
const POS_AVERAGES: Record<string, number> = { QB: 18, RB: 10, WR: 11, TE: 8, K: 7 };

// ── HELPERS ─────────────────────────────────────────────────────────
function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function getSleeperUserId(username: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.sleeper.app/v1/user/${encodeURIComponent(username)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.user_id ?? null;
  } catch {
    return null;
  }
}

/** Returns a map of player_id → actual_points for a given league + week.
 *  Returns null if the matchup data is empty or the week hasn't been played. */
async function fetchMatchupPoints(
  leagueId: string,
  week: number,
): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`);
    if (!res.ok) return null;
    const matchups = await res.json();
    if (!Array.isArray(matchups) || matchups.length === 0) return null;

    // Merge all players_points maps into one player_id → points map
    const pointsMap: Record<string, number> = {};
    for (const m of matchups) {
      if (m.players_points && typeof m.players_points === 'object') {
        Object.assign(pointsMap, m.players_points);
      }
    }
    return Object.keys(pointsMap).length > 0 ? pointsMap : null;
  } catch {
    return null;
  }
}

/** Fetches the Sleeper player map (player_id → player object) to build
 *  a reverse lookup: normalized player name → player_id. */
async function buildNameToIdMap(): Promise<Record<string, string>> {
  const res = await fetch('https://api.sleeper.app/v1/players/nfl');
  if (!res.ok) throw new Error(`Sleeper players API returned ${res.status}`);
  const data: Record<string, { first_name: string; last_name: string; position: string }> =
    await res.json();

  const nameMap: Record<string, string> = {};
  for (const [id, p] of Object.entries(data)) {
    if (!p.first_name || !p.last_name) continue;
    const key = `${p.first_name} ${p.last_name}`.toLowerCase().trim();
    // keep first match (higher player_id tends to be more active player)
    if (!nameMap[key]) nameMap[key] = id;
  }
  return nameMap;
}

/** Grade a single recommendation given the player's actual points.
 *  Returns { decision_correct, variance_pending } */
function gradeRec(
  decision: string,
  position: string,
  actualPoints: number | null,
): { decision_correct: boolean; variance_pending: boolean } {
  const avg = POS_AVERAGES[position] ?? 10;
  const performedWell = actualPoints !== null && actualPoints >= avg;

  const isStartCall = decision === 'START' || decision === 'FLEX';
  const isSitCall   = decision === 'SIT'   || decision === 'STASH';

  if (isStartCall && performedWell)  return { decision_correct: true,  variance_pending: false };
  if (isSitCall   && !performedWell && actualPoints !== null)
                                     return { decision_correct: true,  variance_pending: false };
  if (isStartCall && !performedWell && actualPoints !== null)
                                     return { decision_correct: false, variance_pending: true  };
  if (isSitCall   && performedWell)  return { decision_correct: false, variance_pending: true  };

  // actualPoints is null — can't grade yet
  return { decision_correct: false, variance_pending: true };
}

interface RecRow {
  id: string;
  sleeper_username: string;
  league_id: string;
  player_name: string;
  position: string;
  decision: string;
  week: number;
  season: number;
}

// ── MAIN ─────────────────────────────────────────────────────────────
serve(async (_req) => {
  // Guard: nothing to grade before week 2
  if (GRADE_WEEK < 1) {
    return jsonRes({
      ok: true,
      note: `GRADE_WEEK is ${GRADE_WEEK} — season has not started yet. No outcomes to grade.`,
      graded: 0,
    });
  }

  try {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── 1. Find all ungraded recs for the grade week ───────────────
    const { data: recs, error: recsErr } = await sb
      .from('recommendations')
      .select('id, sleeper_username, league_id, player_name, position, decision, week, season')
      .eq('season', CURRENT_SEASON)
      .eq('week', GRADE_WEEK);

    if (recsErr) throw recsErr;
    if (!recs?.length) {
      return jsonRes({
        ok: true,
        note: `No recommendations found for week ${GRADE_WEEK} — nothing to grade.`,
        graded: 0,
      });
    }

    // Filter out recs that already have an outcome
    const recIds = recs.map((r: RecRow) => r.id);
    const { data: existingOutcomes, error: outErr } = await sb
      .from('outcomes')
      .select('recommendation_id')
      .in('recommendation_id', recIds);
    if (outErr) throw outErr;

    const alreadyGraded = new Set((existingOutcomes ?? []).map((o: { recommendation_id: string }) => o.recommendation_id));
    const ungradedRecs  = (recs as RecRow[]).filter((r) => !alreadyGraded.has(r.id));

    if (!ungradedRecs.length) {
      return jsonRes({
        ok: true,
        note: `All ${recs.length} recommendations for week ${GRADE_WEEK} are already graded.`,
        graded: 0,
      });
    }

    // ── 2. Fetch Sleeper player name→id map once ───────────────────
    let nameToId: Record<string, string>;
    try {
      nameToId = await buildNameToIdMap();
    } catch (e: unknown) {
      return jsonRes({ ok: false, error: `Failed to build name map: ${(e as Error).message}` }, 502);
    }

    // ── 3. Group ungraded recs by league_id ───────────────────────
    const byLeague = new Map<string, RecRow[]>();
    for (const rec of ungradedRecs) {
      if (!byLeague.has(rec.league_id)) byLeague.set(rec.league_id, []);
      byLeague.get(rec.league_id)!.push(rec);
    }

    const gradingResults: unknown[] = [];
    let totalGraded = 0;

    for (const [leagueId, leagueRecs] of byLeague) {
      // Fetch matchup points for this league + grade week
      const pointsMap = await fetchMatchupPoints(leagueId, GRADE_WEEK);

      if (!pointsMap) {
        gradingResults.push({
          league_id: leagueId,
          status: 'skipped',
          reason: `No matchup data available for week ${GRADE_WEEK} — week may not have been played yet.`,
          affected_recs: leagueRecs.length,
        });
        continue;
      }

      // Grade each rec in this league
      const outcomeRows = [];
      for (const rec of leagueRecs) {
        // Look up player_id by name
        const nameKey  = rec.player_name.toLowerCase().trim();
        const playerId = nameToId[nameKey];
        const actualPoints = playerId != null ? (pointsMap[playerId] ?? null) : null;

        const { decision_correct, variance_pending } = gradeRec(
          rec.decision,
          rec.position,
          actualPoints,
        );

        outcomeRows.push({
          recommendation_id: rec.id,
          player_name:       rec.player_name,
          decision_correct,
          variance_pending,
          variance_flag:     decision_correct ? false : null,  // null = awaiting user classification
          actual_points:     actualPoints,
          updated_at:        new Date().toISOString(),
        });
      }

      const { error: insertErr } = await sb.from('outcomes').insert(outcomeRows);
      if (insertErr) {
        gradingResults.push({ league_id: leagueId, status: 'error', reason: insertErr.message });
        continue;
      }

      const correct = outcomeRows.filter((o) => o.decision_correct).length;
      const wrong   = outcomeRows.filter((o) => !o.decision_correct).length;
      totalGraded  += outcomeRows.length;

      gradingResults.push({
        league_id: leagueId,
        status: 'graded',
        week: GRADE_WEEK,
        total: outcomeRows.length,
        correct,
        wrong,
        variance_pending: outcomeRows.filter((o) => o.variance_pending).length,
      });
    }

    return jsonRes({
      ok: true,
      grade_week:   GRADE_WEEK,
      season:       CURRENT_SEASON,
      total_graded: totalGraded,
      results:      gradingResults,
    });
  } catch (e: unknown) {
    return jsonRes({ ok: false, error: (e as Error).message }, 500);
  }
});
