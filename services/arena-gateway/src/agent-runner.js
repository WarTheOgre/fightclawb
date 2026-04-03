// services/arena-gateway/src/agent-runner.js
// Executes agent code for one turn via child process (stdin/stdout protocol).
// MVP: direct process execution for algorithm agents (tier 3).
// Future: Docker sandbox via sandbox-executor.js for tiers 1-2.

const { spawn } = require('child_process');
const { getValidMoves, AP_PER_TURN } = require('./board');

const TURN_TIMEOUT_MS = 8000;

/**
 * Execute an agent's code for one turn.
 *
 * @param {object} agent - Agent record with agent_id, display_name, code_path, agent_type
 * @param {object} board - Current board state
 * @param {number} round - Current round number
 * @returns {Promise<object[]>} Array of action objects
 */
async function executeAgent(agent, board, round) {
  if (!agent.code_path) {
    throw new Error(`Agent ${agent.display_name} has no code_path`);
  }

  const turnPayload = {
    round,
    your_id: agent.agent_id,
    board: board.cells,
    scores: board.scores,
    valid_moves: getValidMoves(board, agent.agent_id),
    ap_budget: AP_PER_TURN,
    board_size: board.size,
  };

  const inputJson = JSON.stringify(turnPayload);

  return new Promise((resolve, reject) => {
    const child = spawn('node', [agent.code_path], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: TURN_TIMEOUT_MS + 1000,
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        child.kill('SIGKILL');
        console.error(`[AgentRunner] ${agent.display_name} timed out (${TURN_TIMEOUT_MS}ms)`);
        resolve([]);
      }
    }, TURN_TIMEOUT_MS);

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (stderr) {
        console.error(`[AgentRunner] ${agent.display_name} stderr: ${stderr.trim()}`);
      }

      if (code !== 0) {
        console.error(`[AgentRunner] ${agent.display_name} exited with code ${code}`);
        resolve([]);
        return;
      }

      try {
        const response = JSON.parse(stdout.trim());
        const actions = response.actions;
        if (!Array.isArray(actions)) {
          throw new Error('Response .actions is not an array');
        }
        resolve(actions);
      } catch (err) {
        console.error(`[AgentRunner] ${agent.display_name} bad output: ${err.message}`);
        resolve([]);
      }
    });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      console.error(`[AgentRunner] ${agent.display_name} spawn error: ${err.message}`);
      resolve([]);
    });

    // Write turn payload to stdin and close
    child.stdin.write(inputJson);
    child.stdin.end();
  });
}

module.exports = { executeAgent };
