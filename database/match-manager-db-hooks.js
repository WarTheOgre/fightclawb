/**
 * engine/match-manager-db-hooks.js
 *
 * Attaches PostgreSQL + Redis persistence to a Match instance by
 * subscribing to its EventEmitter events.
 *
 * The Match class (match-manager.js) is kept pure (no I/O).
 * All persistence is side-effects triggered here.
 *
 * Usage:
 *   import { attachDbHooks, persistMoveSubmission } from './match-manager-db-hooks.js';
 *
 *   const match = matchRegistry.create({ format, agentSlots });
 *   await attachDbHooks(match);
 *   // Then in move submission route:
 *   await persistMoveSubmission(match, agentId, actions, nonce, signature);
 */

import { matchStorePg } from './match-store-pg.js';
import { matchState as redisMatchState, leaderboard as redisLeaderboard } from '../../db/redis.js';

/**
 * Wire up all persistence side-effects for a Match instance.
 * Call once immediately after creating the match.
 */
export async function attachDbHooks(match) {

  // ── Credits consumed → match persisted ──────────────────────────────────
  match.once('credits_consumed', async () => {
    try {
      await matchStorePg.createMatch(match);
    } catch (err) {
      console.error(`[db-hooks] createMatch failed for ${match.matchId}:`, err.message);
    }
  });

  // ── Round start → cache state in Redis ──────────────────────────────────
  match.on('round_start', async ({ round }) => {
    try {
      await Promise.all([
        redisMatchState.set(match.matchId, match.gameState),
        redisMatchState.setPhase(match.matchId, 'strategy'),
        redisMatchState.setRound(match.matchId, round),
        matchStorePg.appendLog(match.matchId, 'ROUND_START', { round }),
      ]);
    } catch (err) {
      console.error(`[db-hooks] round_start persistence error (match ${match.matchId}):`, err.message);
    }
  });

  // ── Round resolved → snapshot + log ─────────────────────────────────────
  match.on('round_resolved', async ({ round, gameState }) => {
    try {
      const cells = match.gameState?.cells;
      const size  = match.gameState?.size;

      await Promise.all([
        // Update Redis hot state
        redisMatchState.set(match.matchId, match.gameState),
        redisMatchState.setPhase(match.matchId, 'resolution'),
        redisMatchState.setRound(match.matchId, round),
        // Durable round counter
        matchStorePg.updateRound(match.matchId, round),
        // Board snapshot for replay
        cells && size ? matchStorePg.persistBoardSnapshot(match.matchId, round, cells, size) : null,
        // Hash-chained log
        matchStorePg.appendLog(match.matchId, 'ROUND_RESOLVED', {
          round,
          events: match.gameState?.log?.at(-1)?.events ?? [],
          standings: match.gameState?.players?.map(p => ({
            agentId: p.agentId, cellCount: p.cellCount, eliminated: p.eliminated,
          })),
        }),
      ]);
    } catch (err) {
      console.error(`[db-hooks] round_resolved persistence error (match ${match.matchId}):`, err.message);
    }
  });

  // ── Forfeit event ────────────────────────────────────────────────────────
  match.on('forfeit', async ({ agentId, reason }) => {
    try {
      await matchStorePg.appendLog(match.matchId, 'FORFEIT', { agentId, reason });
    } catch (err) {
      console.error(`[db-hooks] forfeit log error:`, err.message);
    }
  });

  // ── Match ended → full settlement ────────────────────────────────────────
  match.on('match_ended', async ({ winner, reason }) => {
    try {
      await matchStorePg.settle(match, winner, reason);
      await matchStorePg.appendLog(match.matchId, 'MATCH_ENDED', { winner, reason });

      // Update Redis leaderboards for all participants
      for (const { agentId } of match.agentSlots) {
        // Re-read new Elo from PG (settle() just wrote it)
        const { query } = await import('../../db/pool.js');
        const { rows }  = await query('SELECT elo, tier FROM agents WHERE agent_id = $1', [agentId]);
        if (rows.length) {
          await redisLeaderboard.update(agentId, rows[0].elo, rows[0].tier);
        }
      }
    } catch (err) {
      console.error(`[db-hooks] match_ended settlement error (match ${match.matchId}):`, err.message);
    }
  });

  // ── Match voided → mark aborted ──────────────────────────────────────────
  match.on('match_voided', async ({ reason }) => {
    try {
      await matchStorePg.voidMatch(match.matchId, reason);
    } catch (err) {
      console.error(`[db-hooks] match_voided error:`, err.message);
    }
  });
}

/**
 * Persist a move submission after match.submitMove() succeeds.
 * Call this in the HTTP/WS move handler immediately after submitMove returns { accepted: true }.
 *
 * @param {Match}    match
 * @param {string}   agentId
 * @param {object[]} actions    - validated actions array
 * @param {string}   nonce
 * @param {string}   signature  - hex Ed25519 signature
 */
export async function persistMoveSubmission(match, agentId, actions, nonce, signature) {
  try {
    const slotIdx    = match.agentSlots.findIndex(s => s.agentId === agentId);
    const playerSlot = ['p1', 'p2', 'p3', 'p4'][slotIdx] ?? 'p1';
    const round      = (match.gameState?.round ?? 0) + 1; // current (unresolved) round

    await matchStorePg.persistRoundAction(
      match.matchId, round, agentId, playerSlot, actions, nonce, signature
    );
  } catch (err) {
    // Move persistence failure is non-fatal — game continues
    console.error(`[db-hooks] persistMoveSubmission error:`, err.message);
  }
}
