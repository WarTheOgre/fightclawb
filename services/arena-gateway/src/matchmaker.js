// Matchmaker service - pairs agents and runs real battles via BattleEngine
const { Pool } = require("pg");
const BattleEngine = require("./battle-engine");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:password@localhost:5432/fightclawb",
  max: 20,
});

async function findMatches() {
  try {
    // Get all queued agents (include code_path for BattleEngine)
    const result = await pool.query(`
      SELECT q.agent_id, q.tier, q.mode, q.elo, a.display_name, a.code_path
      FROM queue_entries q
      JOIN agents a ON q.agent_id = a.agent_id
      WHERE q.match_id IS NULL
      ORDER BY q.tier, q.joined_at ASC
    `);

    const queued = result.rows;

    if (queued.length < 2) {
      console.log(`[Matchmaker] ${queued.length} agent(s) in queue, need 2 minimum`);
      return;
    }

    // Simple pairing: match by tier, closest ELO
    const matched = [];
    const used = new Set();

    for (let i = 0; i < queued.length; i++) {
      if (used.has(i)) continue;

      const agent1 = queued[i];
      let bestMatch = null;
      let bestIdx = -1;
      let bestDiff = Infinity;

      for (let j = i + 1; j < queued.length; j++) {
        if (used.has(j)) continue;

        const agent2 = queued[j];

        // Must match tier and mode
        if (agent1.tier !== agent2.tier || agent1.mode !== agent2.mode) continue;

        const eloDiff = Math.abs(agent1.elo - agent2.elo);
        if (eloDiff < bestDiff) {
          bestDiff = eloDiff;
          bestMatch = agent2;
          bestIdx = j;
        }
      }

      if (bestMatch) {
        matched.push([agent1, bestMatch]);
        used.add(i);
        used.add(bestIdx);
      }
    }

    // Create matches
    for (const [agent1, agent2] of matched) {
      await createMatch(agent1, agent2);
    }

    if (matched.length > 0) {
      console.log(`[Matchmaker] Created ${matched.length} match(es)`);
    }
  } catch (err) {
    console.error("[Matchmaker] Error:", err.message);
  }
}

async function createMatch(agent1, agent2) {
  const client = await pool.connect();
  let matchId;
  try {
    await client.query("BEGIN");

    // Create match in lobby state (BattleEngine will set it to active)
    const matchResult = await client.query(`
      INSERT INTO matches (mode, tier, board_size, status)
      VALUES ($1, $2, 12, 'lobby')
      RETURNING match_id
    `, [agent1.mode, agent1.tier]);

    matchId = matchResult.rows[0].match_id;

    // Add participants
    await client.query(`
      INSERT INTO match_participants (match_id, agent_id, player_slot, home_row, home_col, elo_before)
      VALUES ($1, $2, 'p1', 0, 0, $3), ($1, $4, 'p2', 11, 11, $5)
    `, [matchId, agent1.agent_id, agent1.elo, agent2.agent_id, agent2.elo]);

    // Mark agents as matched in queue
    await client.query(`
      UPDATE queue_entries
      SET match_id = $1
      WHERE agent_id IN ($2, $3)
    `, [matchId, agent1.agent_id, agent2.agent_id]);

    await client.query("COMMIT");

    console.log(`[Matchmaker] Match ${matchId}: ${agent1.display_name} vs ${agent2.display_name}`);

    // Run battle asynchronously — BattleEngine handles everything
    runBattle(matchId, agent1, agent2).catch(err => {
      console.error(`[Matchmaker] Battle ${matchId} failed:`, err.message);
    });

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function runBattle(matchId, agent1, agent2) {
  try {
    const engine = new BattleEngine(matchId, agent1, agent2, pool);
    const result = await engine.run();
    console.log(
      `[Matchmaker] Battle ${matchId.slice(0, 8)} complete: ` +
      (result.winner_id ? `winner determined` : `draw`) +
      ` (${result.reason})`
    );
  } catch (err) {
    console.error(`[Matchmaker] Battle ${matchId} error:`, err.message);
    // Mark match as aborted so it doesn't hang in active state
    await pool.query(
      "UPDATE matches SET status = 'aborted' WHERE match_id = $1",
      [matchId]
    ).catch(() => {});
  }
}

// Run matchmaker every 5 seconds
console.log("[Matchmaker] Starting...");
setInterval(findMatches, 5000);
findMatches();
