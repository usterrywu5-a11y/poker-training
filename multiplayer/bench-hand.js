'use strict';
// 基準測試：單手牌局（1真人+3AI）耗時，用於驗證效能修復
const eng = require('./engine.js');

function runOneHand() {
  const g = eng.createGame({ smallBlind: 10, bigBlind: 20, startStack: 1000, maxPlayers: 4, teaching: true, difficulty: 'normal' });
  g._bindShuffle(eng.seededShuffle(12345));
  eng.addPlayer(g, { id: 'human', name: '小明', isOwner: true, isAI: false });
  eng.addPlayer(g, { id: 'ai1', name: 'AI1', isAI: true });
  eng.addPlayer(g, { id: 'ai2', name: 'AI2', isAI: true });
  eng.addPlayer(g, { id: 'ai3', name: 'AI3', isAI: true });
  eng.startGame(g);
  let guard = 0;
  while (g.phase === 'betting' && guard++ < 200) {
    const seat = g.toActSeat;
    const p = g.players[seat];
    if (p.isAI) { const r = eng.aiAct(g, seat); if (!r.ok) throw new Error('aiAct: ' + r.error); }
    else {
      const need = Math.max(0, g.currentBet - p.betThisStreet);
      const action = need <= 0 ? 'check' : 'call';
      const r = eng.act(g, seat, action, 0);
      if (!r.ok) throw new Error('act: ' + r.error);
    }
  }
  return g;
}

// 跑 5 手取平均
const N = 5;
let total = 0;
for (let i = 0; i < N; i++) {
  const t0 = process.hrtime.bigint();
  runOneHand();
  const dt = Number(process.hrtime.bigint() - t0) / 1e6;
  total += dt;
  console.log(`  第 ${i + 1} 手: ${dt.toFixed(1)}ms`);
}
console.log(`平均單手耗時: ${(total / N).toFixed(1)}ms`);
