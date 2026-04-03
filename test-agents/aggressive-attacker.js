#!/usr/bin/env node
// Aggressive agent: expands fast, then attacks whenever possible
const input = JSON.parse(require('fs').readFileSync(0, 'utf-8'));

const validMoves = input.valid_moves || [];
const apBudget = input.ap_budget || 10;
const actions = [];
let ap = apBudget;

// Expand first (1 AP each)
const expands = validMoves.filter(m => m.type === 'EXPAND');
for (const m of expands) {
  if (ap < 1) break;
  actions.push(m);
  ap -= 1;
}

// Attack with remaining AP — pick cells we can capture (apCost > defence)
const attacked = new Set();
const attacks = validMoves
  .filter(m => m.type === 'ATTACK')
  .sort((a, b) => a.apCost - b.apCost);

for (const m of attacks) {
  const key = `${m.row},${m.col}`;
  if (attacked.has(key)) continue;
  if (ap < m.apCost) continue;
  actions.push(m);
  ap -= m.apCost;
  attacked.add(key);
}

console.log(JSON.stringify({ actions }));
