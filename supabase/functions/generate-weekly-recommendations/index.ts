/**
 * generate-weekly-recommendations
 *
 * Invoke from Supabase Dashboard → Functions → generate-weekly-recommendations → Invoke
 * Or via CLI: supabase functions invoke generate-weekly-recommendations
 *
 * Required secrets (set via Supabase Dashboard → Settings → Edge Functions):
 *   ANTHROPIC_KEY          — your Anthropic API key
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected by Supabase runtime
 *   SUPABASE_URL              — auto-injected by Supabase runtime
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── CONFIG ──────────────────────────────────────────────────────────
// Update CURRENT_WEEK each week of the NFL season.
// Before the season starts, leave at 1 — the function will still run
// but Sleeper rosters will be preseason rosters.
const CURRENT_WEEK   = 1;
const CURRENT_SEASON = 2026;
const CURRENT_DATE   = new Date().toISOString().split('T')[0];

const POS_AVERAGES: Record<string, number> = { QB: 18, RB: 10, WR: 11, TE: 8 };
const STARTABLE_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K']);

// ── HELPERS ─────────────────────────────────────────────────────────
function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Fetch the Sleeper user_id for a given username. */
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

/** Fetch and return the full Sleeper NFL player map (player_id → player object).
 *  This is a ~10 MB payload — only fetched once per function invocation and
 *  reused across all users. */
async function fetchPlayerMap(): Promise<Record<string, SleeperPlayer>> {
  const res = await fetch('https://api.sleeper.app/v1/players/nfl');
  if (!res.ok) throw new Error(`Sleeper players API returned ${res.status}`);
  return await res.json();
}

interface SleeperPlayer {
  player_id: string;
  first_name: string;
  last_name: string;
  position: string;
  team?: string;
}

interface UserRow {
  sleeper_username: string;
  sleeper_league_id: string | null;
}

interface RecRow {
  player_name: string;
  position: string;
  decision: string;
  confidence: number;
  reasoning: string;
}

// ── MAIN ─────────────────────────────────────────────────────────────
serve(async (_req) => {
  const results: unknown[] = [];

  try {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_KEY');
    if (!ANTHROPIC_KEY) return jsonRes({ ok: false, error: 'ANTHROPIC_KEY secret not set' }, 500);

    // ── 1. Load all users ──────────────────────────────────────────
    const { data: users, error: usersErr } = await sb
      .from('users')
      .select('sleeper_username, sleeper_league_id');
    if (usersErr) throw usersErr;
    if (!users?.length) return jsonRes({ ok: true, results: [], note: 'No users in table' });

    // ── 2. Fetch Sleeper player map once (shared across all users) ──
    let playerMap: Record<string, SleeperPlayer>;
    try {
      playerMap = await fetchPlayerMap();
    } catch (e: unknown) {
      return jsonRes({ ok: false, error: `Failed to fetch Sleeper player map: ${(e as Error).message}` }, 502);
    }

    // ── 3. Process each user ───────────────────────────────────────
    for (const user of users as UserRow[]) {
      const { sleeper_username, sleeper_league_id } = user;

      if (!sleeper_league_id) {
        results.push({ user: sleeper_username, status: 'skipped', reason: 'no sleeper_league_id' });
        continue;
      }

      // Skip if recs already exist for this user + week
      const { count, error: countErr } = await sb
        .from('recommendations')
        .select('id', { count: 'exact', head: true })
        .eq('sleeper_username', sleeper_username)
        .eq('league_id', sleeper_league_id)
        .eq('season', CURRENT_SEASON)
        .eq('week', CURRENT_WEEK);

      if (countErr) {
        results.push({ user: sleeper_username, status: 'error', reason: countErr.message });
        continue;
      }
      if (count && count > 0) {
        results.push({ user: sleeper_username, status: 'skipped', reason: `already has ${count} recs for week ${CURRENT_WEEK}` });
        continue;
      }

      // Resolve Sleeper user_id
      const sleeperUserId = await getSleeperUserId(sleeper_username);
      if (!sleeperUserId) {
        results.push({ user: sleeper_username, status: 'error', reason: 'could not resolve Sleeper user_id' });
        continue;
      }

      // Fetch rosters for this league
      let rosters: Array<{ owner_id: string; players: string[]; starters: string[] }>;
      try {
        const r = await fetch(`https://api.sleeper.app/v1/league/${sleeper_league_id}/rosters`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        rosters = await r.json();
      } catch (e: unknown) {
        results.push({ user: sleeper_username, status: 'error', reason: `Roster fetch failed: ${(e as Error).message}` });
        continue;
      }

      // Find this user's roster
      const myRoster = rosters.find((r) => r.owner_id === sleeperUserId);
      if (!myRoster) {
        results.push({ user: sleeper_username, status: 'error', reason: 'roster not found in league' });
        continue;
      }

      // Build deduplicated list of all player IDs on this roster
      const allIds = [...new Set([...(myRoster.players ?? []), ...(myRoster.starters ?? [])])];

      // Map to player objects — filter to startable positions only
      const startablePlayers = allIds
        .map((id) => playerMap[id])
        .filter((p): p is SleeperPlayer => !!p && STARTABLE_POSITIONS.has(p.position))
        .map((p) => ({
          name:     `${p.first_name} ${p.last_name}`.trim(),
          position: p.position,
          team:     p.team || 'FA',
        }));

      if (!startablePlayers.length) {
        results.push({ user: sleeper_username, status: 'error', reason: 'no startable players found on roster' });
        continue;
      }

      const playerListStr = startablePlayers
        .map((p) => `${p.name} (${p.position}, ${p.team})`)
        .join('\n');

      const posAvgStr = Object.entries(POS_AVERAGES)
        .map(([pos, avg]) => `${pos}: ${avg} pts`)
        .join(', ');

      // ── 4. Call Claude ─────────────────────────────────────────
      const schema = `{"recommendations":[{"player_name":"string","position":"QB|RB|WR|TE|K","decision":"START|FLEX|SIT|STASH","confidence":75,"reasoning":"one sentence"}]}`;
      const system = `You are GridironIQ's automated recommendation engine for the 2026 NFL fantasy season. Respond ONLY with valid JSON matching this schema: ${schema}`;
      const prompt = `Today is ${CURRENT_DATE}. Generate Week ${CURRENT_WEEK} start/sit recommendations for this ${sleeper_username}'s fantasy roster.

Positional averages for grading reference: ${posAvgStr}

For each player, return:
- decision: START (clear starter), FLEX (usable flex option), SIT (bench), or STASH (bench, long-term hold)
- confidence: 1-100 (how confident you are in this call)
- reasoning: one sentence covering matchup, usage trend, or injury concern

Roster:
${playerListStr}`;

      let aiRecs: RecRow[] = [];
      try {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model:      'claude-sonnet-4-6',
            max_tokens: 2000,
            system,
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        const aiData = await aiRes.json();
        if (!aiRes.ok || aiData.type === 'error') {
          throw new Error(aiData.error?.message ?? `Anthropic HTTP ${aiRes.status}`);
        }

        const txt = aiData.content?.find((b: { type: string }) => b.type === 'text')?.text ?? '';
        const match = txt.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
        if (!match) throw new Error('No JSON object in AI response');

        const parsed = JSON.parse(match[0]);
        aiRecs = parsed.recommendations ?? [];
        if (!aiRecs.length) throw new Error('AI returned empty recommendations array');
      } catch (e: unknown) {
        results.push({ user: sleeper_username, status: 'error', reason: `AI call failed: ${(e as Error).message}` });
        continue;
      }

      // ── 5. Insert recommendations ──────────────────────────────
      const rows = aiRecs.map((r) => ({
        sleeper_username,
        league_id:  sleeper_league_id,
        season:     CURRENT_SEASON,
        week:       CURRENT_WEEK,
        player_name: r.player_name,
        position:   r.position,
        decision:   r.decision,
        confidence: r.confidence,
        reasoning:  r.reasoning,
      }));

      const { error: insertErr } = await sb.from('recommendations').insert(rows);
      if (insertErr) {
        results.push({ user: sleeper_username, status: 'error', reason: `DB insert failed: ${insertErr.message}` });
        continue;
      }

      results.push({ user: sleeper_username, status: 'success', week: CURRENT_WEEK, recs_generated: rows.length });
    }

    return jsonRes({ ok: true, week: CURRENT_WEEK, season: CURRENT_SEASON, results });
  } catch (e: unknown) {
    return jsonRes({ ok: false, error: (e as Error).message }, 500);
  }
});
