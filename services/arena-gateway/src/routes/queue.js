const { Router } = require("express");
const { pool } = require("../database");

const router = Router();

// POST /api/queue - Join matchmaking queue
router.post("/", async (req, res) => {
  const { agent_id, mode = "1v1" } = req.body;

  if (!agent_id) {
    return res.status(400).json({ error: "agent_id required" });
  }

  try {
    // Check if agent exists
    const agentCheck = await pool.query(
      "SELECT agent_id, tier FROM agents WHERE agent_id = $1",
      [agent_id]
    );

    if (agentCheck.rows.length === 0) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const { tier } = agentCheck.rows[0];

    // Check if already in queue
    const existing = await pool.query(
      "SELECT * FROM queue_entries WHERE agent_id = $1 AND match_id IS NULL",
      [agent_id]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Agent already in queue" });
    }

    // Get agent ELO
    const eloResult = await pool.query(
      "SELECT elo FROM agents WHERE agent_id = $1",
      [agent_id]
    );
    const elo = eloResult.rows[0].elo || 1000;

    // Add to queue
    await pool.query(
      "INSERT INTO queue_entries (agent_id, tier, mode, elo) VALUES ($1, $2, $3, $4)",
      [agent_id, tier, mode, elo]
    );

    res.json({
      status: "queued",
      agent_id,
      tier,
      mode,
      message: "Agent added to matchmaking queue",
    });
  } catch (err) {
    console.error("Queue error:", err);
    res.status(500).json({ error: "Failed to join queue" });
  }
});

// DELETE /api/queue/:agentId - Leave queue
router.delete("/:agentId", async (req, res) => {
  const { agentId } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM queue_entries WHERE agent_id = $1 AND match_id IS NULL RETURNING agent_id",
      [agentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Agent not in queue" });
    }

    res.json({ status: "removed", agent_id: agentId });
  } catch (err) {
    console.error("Queue removal error:", err);
    res.status(500).json({ error: "Failed to leave queue" });
  }
});

// GET /api/queue/status - Get queue status
router.get("/status", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT agent_id, tier, mode, joined_at FROM queue_entries WHERE match_id IS NULL ORDER BY joined_at ASC"
    );

    res.json({
      queue_length: result.rows.length,
      entries: result.rows,
    });
  } catch (err) {
    console.error("Queue status error:", err);
    res.status(500).json({ error: "Failed to get queue status" });
  }
});

module.exports = router;
