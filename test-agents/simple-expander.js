#!/usr/bin/env node
// Simple agent: expands greedily toward center, then fortifies home
const input = JSON.parse(require('fs').readFileSync(0, 'utf-8'));

const validMoves = input.valid_moves || [];
const apBudget = input.ap_budget || 10;
const actions = [];
let ap = apBudget;

// Expand toward center first
const expands = validMoves
  .filter(m => m.type === 'EXPAND')
  .sort((a, b) => {
    const d = (r, c) => Math.abs(r - 5.5) + Math.abs(c - 5.5);
    return d(a.row, a.col) - d(b.row, b.col);
  });

for (const m of expands) {
  if (ap < 1) break;
  actions.push(m);
  ap -= 1;
}

// Fortify home if AP left
if (ap >= 2) {
  const fort = validMoves.find(m => m.type === 'FORTIFY');
  if (fort) {
    actions.push(fort);
    ap -= 2;
  }
}

console.log(JSON.stringify({ actions }));
