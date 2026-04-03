// services/arena-gateway/src/board.js
// Board state utilities for Grid Dominance — no agent execution

const BOARD_SIZE = 12;
const MAX_TURNS = 100;
const AP_PER_TURN = 10;
const WIN_THRESHOLD = 0.6; // >60% territory to win
const MAX_DEFENCE = 3;

// ── Board creation ───────────────────────────────────────────────────────────

/**
 * Create a fresh 12×12 board with two agents placed at opposite corners.
 *
 * @param {string} agent1Id - UUID for player 1 (home at 0,0)
 * @param {string} agent2Id - UUID for player 2 (home at 11,11)
 * @returns {object} Board state
 */
function createBoard(agent1Id, agent2Id) {
  const cells = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    const row = [];
    for (let c = 0; c < BOARD_SIZE; c++) {
      row.push({ owner: null, defence: 0, isHome: false });
    }
    cells.push(row);
  }

  // Place home cells
  cells[0][0] = { owner: agent1Id, defence: 0, isHome: true };
  cells[BOARD_SIZE - 1][BOARD_SIZE - 1] = { owner: agent2Id, defence: 0, isHome: true };

  return {
    turn: 0,
    size: BOARD_SIZE,
    agents: [agent1Id, agent2Id],
    cells,
    scores: { [agent1Id]: 1, [agent2Id]: 1 },
  };
}

// ── Move validation ──────────────────────────────────────────────────────────

/**
 * Check whether a single action is legal on the current board.
 *
 * @param {object} board
 * @param {string} agentId
 * @param {object} action - { type: 'EXPAND'|'FORTIFY'|'ATTACK', row, col, apCost }
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateMove(board, agentId, action) {
  const { type, row, col } = action;

  // Bounds check
  if (row < 0 || row >= board.size || col < 0 || col >= board.size) {
    return { valid: false, reason: 'Out of bounds' };
  }

  const cell = board.cells[row][col];

  if (type === 'EXPAND') {
    if (cell.owner !== null) {
      return { valid: false, reason: 'Cell already claimed' };
    }
    if (!hasAdjacentOwned(board, agentId, row, col)) {
      return { valid: false, reason: 'Must expand adjacent to owned cell' };
    }
    return { valid: true };
  }

  if (type === 'FORTIFY') {
    if (cell.owner !== agentId) {
      return { valid: false, reason: 'Can only fortify own cells' };
    }
    if (cell.defence >= MAX_DEFENCE) {
      return { valid: false, reason: `Defence already at max (${MAX_DEFENCE})` };
    }
    return { valid: true };
  }

  if (type === 'ATTACK') {
    if (cell.owner === null || cell.owner === agentId) {
      return { valid: false, reason: 'Can only attack opponent cells' };
    }
    if (!hasAdjacentOwned(board, agentId, row, col)) {
      return { valid: false, reason: 'Must attack adjacent to owned cell' };
    }
    const apCost = action.apCost || 1;
    if (apCost < 1 || apCost > 3) {
      return { valid: false, reason: 'Attack AP must be 1-3' };
    }
    return { valid: true };
  }

  return { valid: false, reason: `Unknown action type: ${type}` };
}

/**
 * Validate an entire batch of actions against the AP budget.
 *
 * @param {object}   board
 * @param {string}   agentId
 * @param {object[]} actions
 * @returns {{ valid: boolean, reason?: string, validActions?: object[] }}
 */
function validateActions(board, agentId, actions) {
  if (!Array.isArray(actions)) {
    return { valid: false, reason: 'Actions must be an array' };
  }

  let apSpent = 0;
  for (const action of actions) {
    const cost = getApCost(action);
    if (apSpent + cost > AP_PER_TURN) {
      return { valid: false, reason: `Exceeds AP budget (${apSpent + cost} > ${AP_PER_TURN})` };
    }
    const result = validateMove(board, agentId, action);
    if (!result.valid) {
      return result;
    }
    apSpent += cost;
  }

  return { valid: true, validActions: actions };
}

// ── Move application ─────────────────────────────────────────────────────────

/**
 * Apply a single validated action to the board. Mutates the board in place.
 *
 * @param {object} board
 * @param {string} agentId
 * @param {object} action
 * @returns {object} The board (same reference)
 */
function applyMove(board, agentId, action) {
  const { type, row, col } = action;
  const cell = board.cells[row][col];

  if (type === 'EXPAND') {
    cell.owner = agentId;
    cell.defence = 0;
    board.scores[agentId]++;
  } else if (type === 'FORTIFY') {
    cell.defence = Math.min(cell.defence + 1, MAX_DEFENCE);
  } else if (type === 'ATTACK') {
    const attackStrength = action.apCost || 1;
    if (attackStrength > cell.defence) {
      // Attacker wins — capture the cell
      const previousOwner = cell.owner;
      board.scores[previousOwner]--;
      cell.owner = agentId;
      cell.defence = 0;
      board.scores[agentId]++;
    } else {
      // Defender holds — reduce defence by attack strength
      cell.defence = Math.max(0, cell.defence - attackStrength);
    }
  }

  return board;
}

/**
 * Apply a batch of actions and increment the turn counter.
 *
 * @param {object}   board
 * @param {string}   agentId
 * @param {object[]} actions - Already validated
 * @returns {object} The board
 */
function applyActions(board, agentId, actions) {
  for (const action of actions) {
    applyMove(board, agentId, action);
  }
  board.turn++;
  return board;
}

// ── Victory detection ────────────────────────────────────────────────────────

/**
 * Check win conditions after a turn.
 *
 * @param {object} board
 * @returns {{ finished: boolean, winner_id?: string|null, reason?: string }}
 */
function checkVictory(board) {
  const [agent1, agent2] = board.agents;
  const totalCells = board.size * board.size;

  // Check home capture — instant win
  const a1Home = board.cells[0][0];
  const a2Home = board.cells[board.size - 1][board.size - 1];

  if (a1Home.owner !== agent1 && a1Home.owner !== null) {
    return { finished: true, winner_id: a1Home.owner, reason: 'home_captured' };
  }
  if (a2Home.owner !== agent2 && a2Home.owner !== null) {
    return { finished: true, winner_id: a2Home.owner, reason: 'home_captured' };
  }

  // Check territory dominance (>60%)
  if (board.scores[agent1] > totalCells * WIN_THRESHOLD) {
    return { finished: true, winner_id: agent1, reason: 'territory' };
  }
  if (board.scores[agent2] > totalCells * WIN_THRESHOLD) {
    return { finished: true, winner_id: agent2, reason: 'territory' };
  }

  // Check turn limit
  if (board.turn >= MAX_TURNS) {
    if (board.scores[agent1] > board.scores[agent2]) {
      return { finished: true, winner_id: agent1, reason: 'turn_limit' };
    }
    if (board.scores[agent2] > board.scores[agent1]) {
      return { finished: true, winner_id: agent2, reason: 'turn_limit' };
    }
    return { finished: true, winner_id: null, reason: 'draw' };
  }

  return { finished: false };
}

// ── Valid moves generation ───────────────────────────────────────────────────

/**
 * Generate the list of all valid moves for an agent this turn.
 *
 * @param {object} board
 * @param {string} agentId
 * @returns {object[]} Array of { type, row, col, apCost }
 */
function getValidMoves(board, agentId) {
  const moves = [];

  for (let r = 0; r < board.size; r++) {
    for (let c = 0; c < board.size; c++) {
      const cell = board.cells[r][c];

      // EXPAND: neutral cell adjacent to owned
      if (cell.owner === null && hasAdjacentOwned(board, agentId, r, c)) {
        moves.push({ type: 'EXPAND', row: r, col: c, apCost: 1 });
      }

      // FORTIFY: own cell below max defence
      if (cell.owner === agentId && cell.defence < MAX_DEFENCE) {
        moves.push({ type: 'FORTIFY', row: r, col: c, apCost: 2 });
      }

      // ATTACK: opponent cell adjacent to owned (1-3 AP options)
      if (cell.owner !== null && cell.owner !== agentId && hasAdjacentOwned(board, agentId, r, c)) {
        for (let ap = 1; ap <= 3; ap++) {
          moves.push({ type: 'ATTACK', row: r, col: c, apCost: ap });
        }
      }
    }
  }

  return moves;
}

// ── Serialization ────────────────────────────────────────────────────────────

/**
 * Serialize board to Buffer for BYTEA storage in board_snapshots.
 */
function serializeBoard(board) {
  return Buffer.from(JSON.stringify(board));
}

/**
 * Deserialize a BYTEA buffer back to a board object.
 */
function deserializeBoard(buffer) {
  return JSON.parse(buffer.toString());
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasAdjacentOwned(board, agentId, row, col) {
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dr, dc] of dirs) {
    const r = row + dr;
    const c = col + dc;
    if (r >= 0 && r < board.size && c >= 0 && c < board.size) {
      if (board.cells[r][c].owner === agentId) return true;
    }
  }
  return false;
}

function getApCost(action) {
  if (action.type === 'EXPAND') return 1;
  if (action.type === 'FORTIFY') return 2;
  if (action.type === 'ATTACK') return action.apCost || 1;
  return 0;
}

module.exports = {
  BOARD_SIZE,
  MAX_TURNS,
  AP_PER_TURN,
  WIN_THRESHOLD,
  MAX_DEFENCE,
  createBoard,
  validateMove,
  validateActions,
  applyMove,
  applyActions,
  checkVictory,
  getValidMoves,
  serializeBoard,
  deserializeBoard,
};
