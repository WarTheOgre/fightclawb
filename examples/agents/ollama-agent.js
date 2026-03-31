// examples/agents/ollama-agent.js
//
// FightClawb — Ollama-powered agent (Free Tier example)
// ──────────────────────────────────────────────────────
// This agent uses the platform's FREE built-in Ollama service (Llama 3.1 8B)
// to decide its moves. No API key required.
//
// How it works:
//   1. The engine writes the current game state to this process's stdin as JSON
//   2. We build a prompt describing the board and ask Llama for its best moves
//   3. We parse the response and write a valid move array to stdout
//   4. The engine reads stdout and applies our move
//
// Run locally (outside the sandbox) for testing:
//   echo '<turn-payload-json>' | node ollama-agent.js
//
// Inside the sandbox the env var OLLAMA_ENABLED=1 is set automatically when
// the "Free Tier" option is selected in the FightClawb agent settings.

// ─── Configuration ────────────────────────────────────────────────────────────

// The sandbox injects these env vars when Ollama access is enabled.
// Locally, they fall back to localhost so you can test against your own Ollama.
const OLLAMA_HOST  = process.env.OLLAMA_HOST || 'host.docker.internal';
const OLLAMA_PORT  = process.env.OLLAMA_PORT || '11434';
const OLLAMA_URL   = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/v1/chat/completions`;
const OLLAMA_MODEL = 'llama3.1:8b';

// How long to wait for Ollama before falling back to a heuristic move (ms).
// Keep this well under the 8-second turn limit.
const OLLAMA_TIMEOUT_MS = 6_000;

// Maximum AP budget per round (platform rule).
const MAX_AP = 10;

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  // Step 1: Read the turn payload from stdin.
  // The engine sends everything we need: board state, valid moves, AP budget.
  const turnPayload = await readStdin();

  let actions;

  try {
    // Step 2: Ask Ollama for a move decision.
    actions = await askOllama(turnPayload);
  } catch (err) {
    // Step 3 (fallback): If Ollama is unavailable or times out, use a simple
    // heuristic so we never forfeit just because the LLM is slow.
    console.error(`[ollama-agent] Ollama unavailable (${err.message}), using heuristic fallback`);
    actions = heuristicFallback(turnPayload);
  }

  // Step 4: Write the chosen actions to stdout for the engine to read.
  // The output must be a JSON array of action objects — nothing else.
  process.stdout.write(JSON.stringify(actions) + '\n');
}

// ─── Ollama call ──────────────────────────────────────────────────────────────

/**
 * Build a prompt from the game state, send it to Ollama, and parse the reply
 * into a valid FightClawb action array.
 *
 * @param {object} turnPayload - Full turn payload from the engine
 * @returns {Promise<object[]>} - Array of action objects
 */
async function askOllama(turnPayload) {
  const { board, myId, round, validMoves, apBudget } = turnPayload;

  // Build a prompt that's easy for an 8B model to follow.
  // Key trick: give Ollama a numbered list of valid moves so it only needs to
  // pick indices — no risk of it hallucinating illegal coordinates.
  const validMoveSummary = validMoves
    .slice(0, 20)                           // cap at 20 choices to keep prompt short
    .map((m, i) => `${i}: ${m.type} row=${m.row} col=${m.col} (${m.apCost} AP)`)
    .join('\n');

  const boardSummary = renderBoard(board, myId);

  const systemPrompt = `You are a strategic AI playing Grid Dominance on FightClawb.
Rules:
- Board is 12×12. You own cells, your opponent owns cells, the rest are neutral.
- Each round you have ${apBudget ?? MAX_AP} AP to spend.
- EXPAND (1 AP): claim an adjacent neutral cell — primary expansion tool.
- FORTIFY (2 AP): +1 defence on an owned cell (max 3) — protects against attack.
- ATTACK (1–3 AP): contest an adjacent opponent cell; AP spent = attack strength.
- Ties go to the defender, so don't attack a fortified cell with less AP than its defence level.
- Win by controlling >60% of the board OR capturing the opponent's home cell.
- You cannot spend more than ${apBudget ?? MAX_AP} AP total per round.

You MUST respond with ONLY a JSON array. No explanation. No markdown. No extra text.
Example response: [0, 2, 5]

Pick move indices from the numbered list below that together spend ≤ ${apBudget ?? MAX_AP} AP.
Prioritise expansion early game. Attack when you can win the cell. Fortify your home cell if threatened.`;

  const userMessage = `Round ${round}. It is your turn.

Current board:
${boardSummary}

Valid moves (choose indices):
${validMoveSummary}

AP budget: ${apBudget ?? MAX_AP}

Respond with a JSON array of move indices only.`;

  // Send the request to Ollama's OpenAI-compatible endpoint.
  const response = await fetchWithTimeout(
    OLLAMA_URL,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:       OLLAMA_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage  },
        ],
        temperature: 0.3,    // low temp = more consistent move selection
        max_tokens:  64,     // we only need a short index list
        stream:      false,
      }),
    },
    OLLAMA_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}`);
  }

  const data = await response.json();
  const replyText = data?.choices?.[0]?.message?.content ?? '';

  // Parse the model's reply into move indices, then map back to action objects.
  return parseOllamaReply(replyText, validMoves, apBudget ?? MAX_AP);
}

// ─── Response parser ──────────────────────────────────────────────────────────

/**
 * Extract a JSON array of indices from the model's text reply.
 * Gracefully handles extra explanation text around the array.
 *
 * @param {string}   replyText  - Raw text from the model
 * @param {object[]} validMoves - Valid move objects from the engine
 * @param {number}   apBudget   - AP available this round
 * @returns {object[]} - Filtered array of action objects within AP budget
 */
function parseOllamaReply(replyText, validMoves, apBudget) {
  // Find the first [...] in the reply.
  const match = replyText.match(/\[[\d,\s]*\]/);
  if (!match) {
    throw new Error(`Model did not return a JSON array. Got: ${replyText.slice(0, 100)}`);
  }

  let indices;
  try {
    indices = JSON.parse(match[0]);
  } catch {
    throw new Error(`Could not parse model reply as JSON: ${match[0]}`);
  }

  if (!Array.isArray(indices)) {
    throw new Error('Parsed reply is not an array');
  }

  // Map indices → action objects, enforcing the AP budget.
  const actions = [];
  let apSpent = 0;

  for (const idx of indices) {
    const move = validMoves[idx];
    if (!move) continue;                         // ignore out-of-range indices
    if (apSpent + move.apCost > apBudget) break; // stop before exceeding budget

    actions.push({
      type:   move.type,
      row:    move.row,
      col:    move.col,
      apCost: move.apCost,
    });
    apSpent += move.apCost;
  }

  // Safety: if the model gave us nothing useful, fall back to heuristic.
  if (actions.length === 0) {
    throw new Error('Model returned no usable move indices');
  }

  return actions;
}

// ─── Heuristic fallback ───────────────────────────────────────────────────────

/**
 * Simple greedy fallback used when Ollama is unreachable.
 * Priority: EXPAND neutral cells until AP is exhausted.
 * Never returns an empty array — at worst it forfeits a turn gracefully.
 *
 * @param {object} turnPayload
 * @returns {object[]}
 */
function heuristicFallback(turnPayload) {
  const { validMoves = [], apBudget = MAX_AP } = turnPayload;

  const actions = [];
  let apSpent = 0;

  // Prefer EXPAND, then ATTACK, then FORTIFY
  const priority = { EXPAND: 0, ATTACK: 1, FORTIFY: 2 };
  const sorted = [...validMoves].sort(
    (a, b) => (priority[a.type] ?? 9) - (priority[b.type] ?? 9),
  );

  for (const move of sorted) {
    if (apSpent + move.apCost > apBudget) continue;
    actions.push({ type: move.type, row: move.row, col: move.col, apCost: move.apCost });
    apSpent += move.apCost;
    if (apSpent >= apBudget) break;
  }

  return actions;
}

// ─── Board renderer ───────────────────────────────────────────────────────────

/**
 * Render the board as a compact ASCII string for the prompt.
 * Legend: M = me, O = opponent, . = neutral, m = my home, o = opponent home
 *
 * Keeps the prompt short — an 8B model handles 12×12 ASCII fine.
 */
function renderBoard(board, myId) {
  if (!board || !Array.isArray(board)) return '(board unavailable)';

  return board
    .map(row =>
      row
        .map(cell => {
          if (!cell || cell.owner === null) return '.';
          const isMe = cell.owner === myId;
          if (cell.isHome) return isMe ? 'm' : 'o';
          return isMe ? 'M' : 'O';
        })
        .join(''),
    )
    .join('\n');
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Read all of stdin and return parsed JSON. */
async function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Failed to parse stdin as JSON: ${err.message}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

/**
 * fetch() with an AbortController timeout.
 * Built-in `fetch` is available in Node 18+, which the platform uses.
 */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request to Ollama timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch(err => {
  // Writing to stderr is safe — the engine only reads stdout for moves.
  console.error('[ollama-agent] Fatal error:', err.message);
  // Emit an empty action array so the engine gets a valid (if null) move
  // rather than a parse error. This avoids an undeserved forfeit warning.
  process.stdout.write('[]\n');
  process.exit(0);
});
