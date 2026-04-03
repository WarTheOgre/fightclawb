const assert = require('assert');
const {
  BOARD_SIZE,
  MAX_TURNS,
  AP_PER_TURN,
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
} = require('../src/board');

const A1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const A2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ── createBoard ──────────────────────────────────────────────────────────────

describe('createBoard', () => {
  it('creates a 12x12 grid', () => {
    const board = createBoard(A1, A2);
    assert.strictEqual(board.cells.length, 12);
    assert.strictEqual(board.cells[0].length, 12);
    assert.strictEqual(board.size, BOARD_SIZE);
  });

  it('places home cells at opposite corners', () => {
    const board = createBoard(A1, A2);
    const topLeft = board.cells[0][0];
    const bottomRight = board.cells[11][11];
    assert.strictEqual(topLeft.owner, A1);
    assert.strictEqual(topLeft.isHome, true);
    assert.strictEqual(bottomRight.owner, A2);
    assert.strictEqual(bottomRight.isHome, true);
  });

  it('starts with turn 0 and score 1 each', () => {
    const board = createBoard(A1, A2);
    assert.strictEqual(board.turn, 0);
    assert.strictEqual(board.scores[A1], 1);
    assert.strictEqual(board.scores[A2], 1);
  });

  it('all non-home cells are neutral', () => {
    const board = createBoard(A1, A2);
    let neutralCount = 0;
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if ((r === 0 && c === 0) || (r === 11 && c === 11)) continue;
        assert.strictEqual(board.cells[r][c].owner, null);
        neutralCount++;
      }
    }
    assert.strictEqual(neutralCount, 142);
  });
});

// ── validateMove ─────────────────────────────────────────────────────────────

describe('validateMove', () => {
  it('accepts EXPAND on neutral cell adjacent to owned', () => {
    const board = createBoard(A1, A2);
    const result = validateMove(board, A1, { type: 'EXPAND', row: 0, col: 1 });
    assert.strictEqual(result.valid, true);
  });

  it('rejects EXPAND on already-claimed cell', () => {
    const board = createBoard(A1, A2);
    const result = validateMove(board, A2, { type: 'EXPAND', row: 0, col: 0 });
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes('already claimed'));
  });

  it('rejects EXPAND not adjacent to owned cell', () => {
    const board = createBoard(A1, A2);
    const result = validateMove(board, A1, { type: 'EXPAND', row: 5, col: 5 });
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes('adjacent'));
  });

  it('rejects out-of-bounds moves', () => {
    const board = createBoard(A1, A2);
    assert.strictEqual(validateMove(board, A1, { type: 'EXPAND', row: -1, col: 0 }).valid, false);
    assert.strictEqual(validateMove(board, A1, { type: 'EXPAND', row: 12, col: 0 }).valid, false);
    assert.strictEqual(validateMove(board, A1, { type: 'EXPAND', row: 0, col: 12 }).valid, false);
  });

  it('accepts FORTIFY on own cell below max defence', () => {
    const board = createBoard(A1, A2);
    const result = validateMove(board, A1, { type: 'FORTIFY', row: 0, col: 0 });
    assert.strictEqual(result.valid, true);
  });

  it('rejects FORTIFY on opponent cell', () => {
    const board = createBoard(A1, A2);
    const result = validateMove(board, A1, { type: 'FORTIFY', row: 11, col: 11 });
    assert.strictEqual(result.valid, false);
  });

  it('rejects FORTIFY at max defence', () => {
    const board = createBoard(A1, A2);
    board.cells[0][0].defence = MAX_DEFENCE;
    const result = validateMove(board, A1, { type: 'FORTIFY', row: 0, col: 0 });
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes('max'));
  });

  it('accepts ATTACK on opponent cell adjacent to owned', () => {
    const board = createBoard(A1, A2);
    // Place A1 cell adjacent to A2 home
    board.cells[11][10] = { owner: A1, defence: 0, isHome: false };
    board.scores[A1]++;
    const result = validateMove(board, A1, { type: 'ATTACK', row: 11, col: 11, apCost: 1 });
    assert.strictEqual(result.valid, true);
  });

  it('rejects ATTACK on neutral cell', () => {
    const board = createBoard(A1, A2);
    const result = validateMove(board, A1, { type: 'ATTACK', row: 0, col: 1, apCost: 1 });
    assert.strictEqual(result.valid, false);
  });

  it('rejects ATTACK on own cell', () => {
    const board = createBoard(A1, A2);
    const result = validateMove(board, A1, { type: 'ATTACK', row: 0, col: 0, apCost: 1 });
    assert.strictEqual(result.valid, false);
  });

  it('rejects ATTACK with invalid AP cost', () => {
    const board = createBoard(A1, A2);
    board.cells[0][1] = { owner: A2, defence: 0, isHome: false };
    const result = validateMove(board, A1, { type: 'ATTACK', row: 0, col: 1, apCost: 4 });
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes('1-3'));
  });

  it('rejects unknown action type', () => {
    const board = createBoard(A1, A2);
    const result = validateMove(board, A1, { type: 'NUKE', row: 0, col: 0 });
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes('Unknown'));
  });
});

// ── validateActions ──────────────────────────────────────────────────────────

describe('validateActions', () => {
  it('accepts actions within AP budget', () => {
    const board = createBoard(A1, A2);
    const actions = [
      { type: 'EXPAND', row: 0, col: 1 },
      { type: 'EXPAND', row: 1, col: 0 },
    ];
    const result = validateActions(board, A1, actions);
    assert.strictEqual(result.valid, true);
  });

  it('rejects actions exceeding AP budget', () => {
    const board = createBoard(A1, A2);
    // Give A1 a row of cells so all expands are adjacent
    for (let c = 1; c <= 11; c++) {
      board.cells[0][c] = { owner: A1, defence: 0, isHome: false };
    }
    // 6 FORTIFY = 12 AP, exceeds budget of 10
    const actions = [];
    for (let c = 0; c <= 5; c++) {
      actions.push({ type: 'FORTIFY', row: 0, col: c });
    }
    const result = validateActions(board, A1, actions);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes('AP budget'));
  });

  it('rejects non-array input', () => {
    const board = createBoard(A1, A2);
    const result = validateActions(board, A1, 'not an array');
    assert.strictEqual(result.valid, false);
  });
});

// ── applyMove ────────────────────────────────────────────────────────────────

describe('applyMove', () => {
  it('EXPAND claims a neutral cell and updates score', () => {
    const board = createBoard(A1, A2);
    applyMove(board, A1, { type: 'EXPAND', row: 0, col: 1 });
    assert.strictEqual(board.cells[0][1].owner, A1);
    assert.strictEqual(board.scores[A1], 2);
  });

  it('FORTIFY increases defence by 1', () => {
    const board = createBoard(A1, A2);
    assert.strictEqual(board.cells[0][0].defence, 0);
    applyMove(board, A1, { type: 'FORTIFY', row: 0, col: 0 });
    assert.strictEqual(board.cells[0][0].defence, 1);
  });

  it('FORTIFY caps at MAX_DEFENCE', () => {
    const board = createBoard(A1, A2);
    board.cells[0][0].defence = MAX_DEFENCE;
    applyMove(board, A1, { type: 'FORTIFY', row: 0, col: 0 });
    assert.strictEqual(board.cells[0][0].defence, MAX_DEFENCE);
  });

  it('ATTACK captures cell when strength > defence', () => {
    const board = createBoard(A1, A2);
    board.cells[0][1] = { owner: A2, defence: 0, isHome: false };
    board.scores[A2]++;
    applyMove(board, A1, { type: 'ATTACK', row: 0, col: 1, apCost: 1 });
    assert.strictEqual(board.cells[0][1].owner, A1);
    assert.strictEqual(board.scores[A1], 2);
    assert.strictEqual(board.scores[A2], 1);
  });

  it('ATTACK fails when strength <= defence (defender holds)', () => {
    const board = createBoard(A1, A2);
    board.cells[0][1] = { owner: A2, defence: 2, isHome: false };
    board.scores[A2]++;
    applyMove(board, A1, { type: 'ATTACK', row: 0, col: 1, apCost: 2 });
    // Defender holds, defence reduced
    assert.strictEqual(board.cells[0][1].owner, A2);
    assert.strictEqual(board.cells[0][1].defence, 0);
    assert.strictEqual(board.scores[A2], 2); // unchanged
  });

  it('ATTACK with strength exactly equal to defence — defender holds', () => {
    const board = createBoard(A1, A2);
    board.cells[0][1] = { owner: A2, defence: 1, isHome: false };
    board.scores[A2]++;
    applyMove(board, A1, { type: 'ATTACK', row: 0, col: 1, apCost: 1 });
    assert.strictEqual(board.cells[0][1].owner, A2);
  });
});

// ── applyActions ─────────────────────────────────────────────────────────────

describe('applyActions', () => {
  it('applies multiple actions and increments turn', () => {
    const board = createBoard(A1, A2);
    applyActions(board, A1, [
      { type: 'EXPAND', row: 0, col: 1 },
      { type: 'EXPAND', row: 1, col: 0 },
    ]);
    assert.strictEqual(board.turn, 1);
    assert.strictEqual(board.scores[A1], 3);
    assert.strictEqual(board.cells[0][1].owner, A1);
    assert.strictEqual(board.cells[1][0].owner, A1);
  });
});

// ── checkVictory ─────────────────────────────────────────────────────────────

describe('checkVictory', () => {
  it('returns not finished on a fresh board', () => {
    const board = createBoard(A1, A2);
    const result = checkVictory(board);
    assert.strictEqual(result.finished, false);
  });

  it('detects territory win (>60%)', () => {
    const board = createBoard(A1, A2);
    // Give A1 87 cells (>60% of 144 = 86.4)
    board.scores[A1] = 87;
    const result = checkVictory(board);
    assert.strictEqual(result.finished, true);
    assert.strictEqual(result.winner_id, A1);
    assert.strictEqual(result.reason, 'territory');
  });

  it('does not trigger at exactly 60%', () => {
    const board = createBoard(A1, A2);
    // 60% of 144 = 86.4, so 86 is not > 60%
    board.scores[A1] = 86;
    const result = checkVictory(board);
    assert.strictEqual(result.finished, false);
  });

  it('detects home capture win', () => {
    const board = createBoard(A1, A2);
    // A2 captures A1's home
    board.cells[0][0].owner = A2;
    const result = checkVictory(board);
    assert.strictEqual(result.finished, true);
    assert.strictEqual(result.winner_id, A2);
    assert.strictEqual(result.reason, 'home_captured');
  });

  it('detects turn limit win (higher score)', () => {
    const board = createBoard(A1, A2);
    board.turn = MAX_TURNS;
    board.scores[A1] = 40;
    board.scores[A2] = 30;
    const result = checkVictory(board);
    assert.strictEqual(result.finished, true);
    assert.strictEqual(result.winner_id, A1);
    assert.strictEqual(result.reason, 'turn_limit');
  });

  it('detects draw at turn limit with equal scores', () => {
    const board = createBoard(A1, A2);
    board.turn = MAX_TURNS;
    board.scores[A1] = 30;
    board.scores[A2] = 30;
    const result = checkVictory(board);
    assert.strictEqual(result.finished, true);
    assert.strictEqual(result.winner_id, null);
    assert.strictEqual(result.reason, 'draw');
  });
});

// ── getValidMoves ────────────────────────────────────────────────────────────

describe('getValidMoves', () => {
  it('initial board gives EXPAND and FORTIFY moves for agent1', () => {
    const board = createBoard(A1, A2);
    const moves = getValidMoves(board, A1);
    const expands = moves.filter(m => m.type === 'EXPAND');
    const fortifies = moves.filter(m => m.type === 'FORTIFY');
    const attacks = moves.filter(m => m.type === 'ATTACK');
    // A1 at (0,0) — two adjacent neutral cells: (0,1) and (1,0)
    assert.strictEqual(expands.length, 2);
    // Home cell can be fortified
    assert.strictEqual(fortifies.length, 1);
    // No adjacent opponent cells
    assert.strictEqual(attacks.length, 0);
  });

  it('generates ATTACK moves with 3 AP options each', () => {
    const board = createBoard(A1, A2);
    board.cells[0][1] = { owner: A2, defence: 1, isHome: false };
    board.scores[A2]++;
    const moves = getValidMoves(board, A1);
    const attacks = moves.filter(m => m.type === 'ATTACK');
    // 3 AP options (1, 2, 3) for the one attackable cell
    assert.strictEqual(attacks.length, 3);
    assert.deepStrictEqual(attacks.map(a => a.apCost), [1, 2, 3]);
  });
});

// ── Serialization ────────────────────────────────────────────────────────────

describe('serialization', () => {
  it('round-trips correctly', () => {
    const board = createBoard(A1, A2);
    applyMove(board, A1, { type: 'EXPAND', row: 0, col: 1 });
    applyMove(board, A1, { type: 'FORTIFY', row: 0, col: 0 });
    board.turn = 5;

    const buf = serializeBoard(board);
    assert.ok(Buffer.isBuffer(buf));

    const restored = deserializeBoard(buf);
    assert.strictEqual(restored.turn, 5);
    assert.strictEqual(restored.cells[0][1].owner, A1);
    assert.strictEqual(restored.cells[0][0].defence, 1);
    assert.strictEqual(restored.scores[A1], 2);
  });
});
