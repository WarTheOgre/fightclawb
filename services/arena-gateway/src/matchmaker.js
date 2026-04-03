// Matchmaker service - pairs agents and creates matches
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://arena:arena_dev_password_change_in_prod@localhost:5432/arena",
  max: 20,
});

async function findMatches() {
  try {
    // Get all queued agents
    const result = await pool.query(`
      SELECT q.agent_id, q.tier, q.mode, q.elo, a.display_name
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
  try {
    await client.query("BEGIN");

    // Create match
    const matchResult = await client.query(`
      INSERT INTO matches (mode, tier, board_size, status)
      VALUES ($1, $2, 12, 'active')
      RETURNING match_id
    `, [agent1.mode, agent1.tier]);

    const matchId = matchResult.rows[0].match_id;

    // Add participants (player_slot, home positions, ELO)
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

    // Start the battle (async, don't wait)
    runBattle(matchId, agent1, agent2).catch(err => {
      console.error(`[Battle ${matchId}] Error:`, err.message);
    });

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function runBattle(matchId, agent1, agent2) {
  console.log(`[Battle ${matchId}] Starting...`);

  // Simulate battle (for now - later this will call actual agent code)
  await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second battle

  // Random winner for now
  const winner = Math.random() > 0.5 ? agent1 : agent2;
  const loser = winner === agent1 ? agent2 : agent1;

  // Update match
  await pool.query(`
    UPDATE matches
    SET status = 'finished',
        winner_id = $1,
        win_reason = 'simulated battle',
        finished_at = NOW()
    WHERE match_id = $2
  `, [winner.agent_id, matchId]);

  console.log(`[Battle ${matchId}] Winner: ${winner.display_name}`);

  // Update ELO and win/loss stats (simple +20/-20 for now)
  const winnerEloChange = 20;
  const loserEloChange = -20;

  try {
    // Log before ELO update
    console.log(`[Battle ${matchId}] Updating ELO: Winner ${winner.agent_id.slice(0, 8)} +${winnerEloChange}, Loser ${loser.agent_id.slice(0, 8)} ${loserEloChange}`);

    // Update winner: ELO and wins
    const winnerResult = await pool.query(`
      UPDATE agents 
      SET elo = elo + $1, 
          wins = wins + 1
      WHERE agent_id = $2
      RETURNING elo, wins
    `, [winnerEloChange, winner.agent_id]);
    
    if (winnerResult.rows.length > 0) {
      console.log(`[Battle ${matchId}] ✅ Winner ${winner.display_name} updated: ELO=${winnerResult.rows[0].elo}, Wins=${winnerResult.rows[0].wins}`);
    } else {
      console.error(`[Battle ${matchId}] ❌ Winner ${winner.display_name} not found in agents table!`);
    }

    // Update loser: ELO and losses
    const loserResult = await pool.query(`
      UPDATE agents 
      SET elo = elo + $1, 
          losses = losses + 1
      WHERE agent_id = $2
      RETURNING elo, losses
    `, [loserEloChange, loser.agent_id]);
    
    if (loserResult.rows.length > 0) {
      console.log(`[Battle ${matchId}] ✅ Loser ${loser.display_name} updated: ELO=${loserResult.rows[0].elo}, Losses=${loserResult.rows[0].losses}`);
    } else {
      console.error(`[Battle ${matchId}] ❌ Loser ${loser.display_name} not found in agents table!`);
    }

    // Update participant elo_after for winner
    await pool.query(`
      UPDATE match_participants
      SET elo_after = elo_before + $1
      WHERE match_id = $2 AND agent_id = $3
    `, [winnerEloChange, matchId, winner.agent_id]);

    // Update participant elo_after for loser
    await pool.query(`
      UPDATE match_participants
      SET elo_after = elo_before + $1
      WHERE match_id = $2 AND agent_id = $3
    `, [loserEloChange, matchId, loser.agent_id]);

    console.log(`[Battle ${matchId}] ✅ ELO and stats fully updated in both agents and match_participants tables`);
    
  } catch (error) {
    console.error(`[Battle ${matchId}] ❌ ERROR updating ELO:`, error.message);
    console.error(error.stack);
    throw error; // Re-throw to prevent silent failures
  }
}

// Run matchmaker every 5 seconds
console.log("[Matchmaker] Starting...");
setInterval(findMatches, 5000);
findMatches(); // Run immediately on start
