// services/arena-gateway/src/battle-engine.js
// Core battle loop — orchestrates a complete Grid Dominance match

const { createBoard, validateActions, applyMove, checkVictory, getValidMoves, AP_PER_TURN, MAX_TURNS } = require('./board');
const storage = require('./battle-storage');

class BattleEngine {
  /**
   * @param {string} matchId
   * @param {{ agent_id: string, display_name: string, elo: number }} agent1 - player slot p1
   * @param {{ agent_id: string, display_name: string, elo: number }} agent2 - player slot p2
   * @param {import('pg').Pool} pool
   */
  constructor(matchId, agent1, agent2, pool) {
    this.matchId = matchId;
    this.agent1 = agent1;
    this.agent2 = agent2;
    this.pool = pool;
    this.tag = `[Battle ${matchId.slice(0, 8)}]`;
  }

  async run() {
    const board = createBoard(this.agent1.agent_id, this.agent2.agent_id);

    await storage.markMatchStarted(this.pool, this.matchId);
    await storage.storeBoardSnapshot(this.pool, this.matchId, 0, board);
    await storage.appendMatchLog(this.pool, this.matchId, 'MATCH_START', {
      agents: [this.agent1.agent_id, this.agent2.agent_id],
    });

    console.log(`${this.tag} Started: ${this.agent1.display_name} vs ${this.agent2.display_name}`);

    for (let round = 1; round <= MAX_TURNS; round++) {
      // Agent 1 turn
      const moves1 = this.pickActions(board, this.agent1.agent_id);
      this.applyValidated(board, this.agent1.agent_id, moves1, round);
      await storage.storeRoundActions(
        this.pool, this.matchId, this.agent1.agent_id, 'p1', round, moves1
      );

      // Check after agent 1
      let result = checkVictory(board);
      if (result.finished) {
        return this.finish(board, result, round);
      }

      // Agent 2 turn
      const moves2 = this.pickActions(board, this.agent2.agent_id);
      this.applyValidated(board, this.agent2.agent_id, moves2, round);
      await storage.storeRoundActions(
        this.pool, this.matchId, this.agent2.agent_id, 'p2', round, moves2
      );

      // Store snapshot after both agents move
      await storage.storeBoardSnapshot(this.pool, this.matchId, round, board);

      await storage.appendMatchLog(this.pool, this.matchId, 'ROUND_RESOLVED', {
        round,
        scores: { ...board.scores },
      });

      // Check after agent 2
      result = checkVictory(board);
      if (result.finished) {
        return this.finish(board, result, round);
      }

      // Increment the logical turn counter on the board
      board.turn = round;
    }

    // Turn limit reached — checkVictory at MAX_TURNS handles this
    board.turn = MAX_TURNS;
    const finalResult = checkVictory(board);
    return this.finish(board, finalResult, MAX_TURNS);
  }

  // ── Action selection (hardcoded greedy strategy for testing) ──────────────

  /**
   * Generate actions for an agent using a simple greedy strategy:
   *   1. EXPAND into as many neutral cells as AP allows
   *   2. FORTIFY home cell if AP remains
   *   3. ATTACK weakest adjacent enemy cell if AP remains
   */
  pickActions(board, agentId) {
    const allMoves = getValidMoves(board, agentId);
    const actions = [];
    let ap = AP_PER_TURN;

    // Phase 1: expand (1 AP each) — prioritise moves closer to center
    const expands = allMoves
      .filter(m => m.type === 'EXPAND')
      .sort((a, b) => {
        const centerDist = (r, c) => Math.abs(r - 5.5) + Math.abs(c - 5.5);
        return centerDist(a.row, a.col) - centerDist(b.row, b.col);
      });

    for (const move of expands) {
      if (ap < 1) break;
      actions.push(move);
      ap -= 1;
      // After expanding, the new cell is owned — but since we only apply
      // after this function returns, we don't get chained adjacency here.
      // That's fine; the engine applies moves and next turn sees the result.
    }

    // Phase 2: fortify home (2 AP)
    if (ap >= 2) {
      const homeFortify = allMoves.find(
        m => m.type === 'FORTIFY' && board.cells[m.row][m.col].isHome
      );
      if (homeFortify) {
        actions.push(homeFortify);
        ap -= 2;
      }
    }

    // Phase 3: attack weakest enemy cells (pick lowest apCost options first)
    const attacks = allMoves
      .filter(m => m.type === 'ATTACK')
      .sort((a, b) => a.apCost - b.apCost);

    const attackedCells = new Set();
    for (const move of attacks) {
      const key = `${move.row},${move.col}`;
      if (attackedCells.has(key)) continue; // one attack per cell per turn
      if (ap < move.apCost) continue;
      // Only attack if we can overcome the defence
      const defence = board.cells[move.row][move.col].defence;
      if (move.apCost > defence) {
        actions.push(move);
        ap -= move.apCost;
        attackedCells.add(key);
      }
    }

    return actions;
  }

  // ── Apply validated actions ────────────────────────────────────────────────

  applyValidated(board, agentId, actions, round) {
    const check = validateActions(board, agentId, actions);
    if (!check.valid) {
      console.log(`${this.tag} Round ${round}: ${agentId.slice(0, 8)} invalid — ${check.reason}`);
      return;
    }
    for (const action of actions) {
      applyMove(board, agentId, action);
    }
  }

  // ── Finalization ───────────────────────────────────────────────────────────

  async finish(board, result, finalRound) {
    const winnerId = result.winner_id;
    const loserId = winnerId === this.agent1.agent_id
      ? this.agent2.agent_id
      : winnerId === this.agent2.agent_id
        ? this.agent1.agent_id
        : null;

    const winnerName = winnerId
      ? (winnerId === this.agent1.agent_id ? this.agent1.display_name : this.agent2.display_name)
      : null;

    console.log(
      `${this.tag} Finished round ${finalRound}: ` +
      (winnerName ? `${winnerName} wins (${result.reason})` : `Draw (${result.reason})`) +
      ` — Score: ${board.scores[this.agent1.agent_id]}–${board.scores[this.agent2.agent_id]}`
    );

    // Store final snapshot
    await storage.storeBoardSnapshot(this.pool, this.matchId, finalRound, board);

    // Log the end event
    await storage.appendMatchLog(this.pool, this.matchId, 'MATCH_ENDED', {
      winner_id: winnerId,
      reason: result.reason,
      round: finalRound,
      scores: { ...board.scores },
    });

    // Update match record
    await storage.updateMatchResult(this.pool, this.matchId, winnerId, result.reason, finalRound);

    // ELO changes: +30 winner / -30 loser / 0 draw
    const ELO_DELTA = 30;
    let a1Won, a2Won, a1Elo, a2Elo;

    if (winnerId === this.agent1.agent_id) {
      a1Won = true;  a2Won = false;
      a1Elo = ELO_DELTA;  a2Elo = -ELO_DELTA;
    } else if (winnerId === this.agent2.agent_id) {
      a1Won = false; a2Won = true;
      a1Elo = -ELO_DELTA; a2Elo = ELO_DELTA;
    } else {
      a1Won = null; a2Won = null;
      a1Elo = 0;    a2Elo = 0;
    }

    const [stats1, stats2] = await Promise.all([
      storage.updateAgentStats(this.pool, this.agent1.agent_id, a1Won, a1Elo),
      storage.updateAgentStats(this.pool, this.agent2.agent_id, a2Won, a2Elo),
    ]);

    await Promise.all([
      storage.updateParticipantElo(this.pool, this.matchId, this.agent1.agent_id, stats1.elo),
      storage.updateParticipantElo(this.pool, this.matchId, this.agent2.agent_id, stats2.elo),
    ]);

    await storage.refreshLeaderboard(this.pool);

    console.log(
      `${this.tag} ELO: ${this.agent1.display_name} ${a1Elo >= 0 ? '+' : ''}${a1Elo} → ${stats1.elo}, ` +
      `${this.agent2.display_name} ${a2Elo >= 0 ? '+' : ''}${a2Elo} → ${stats2.elo}`
    );

    return result;
  }
}

module.exports = BattleEngine;
