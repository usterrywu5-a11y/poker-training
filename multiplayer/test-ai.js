'use strict';
// Phase 4 測試：AI 補位、AI 行動、斷線 AI 代打、公平性
const assert = require('assert');
const eng = require('./engine.js');
const ai = require('./ai-core.js');
const core = require('./game-core.js');

// ==================== 引擎層級 ====================
function makeGame(seed, nPlayers, cfg) {
  const g = eng.createGame(Object.assign({ startStack: 1000, smallBlind: 10, bigBlind: 20, maxPlayers: 4 }, cfg));
  g._bindShuffle(eng.seededShuffle(seed));
  for (let i = 0; i < nPlayers; i++) eng.addPlayer(g, { id: 'p' + i, name: 'P' + i, isOwner: i === 0 });
  return g;
}

// 測試 1：aiDecide 回傳合法行動（含翻牌前無公用牌）
{
  const hand = [{ r: 14, s: 0 }, { r: 14, s: 1 }]; // AA
  const d1 = ai.aiDecide(hand, [], 30, 20, 10, 990, 0, 1);
  assert.ok(['fold', 'check', 'call', 'bet', 'raise', 'allin'].includes(d1.action), '非法行動 ' + d1.action);
  // 翻牌前（無公用牌）不應崩潰
  const d2 = ai.aiDecide([{ r: 7, s: 0 }, { r: 2, s: 1 }], [], 30, 20, 10, 990, 0, 1);
  assert.ok(['fold', 'check', 'call', 'bet', 'raise', 'allin'].includes(d2.action));
  console.log('✓ 測試1 aiDecide 合法行動，AA→', JSON.stringify(d1), '72o→', JSON.stringify(d2));
}

// 測試 2：aiAct 走同一條 act()，牌局能推進到結束
{
  const g = makeGame(42, 2);
  // 把 P1 標成 AI
  g.players[1].isAI = true;
  eng.startGame(g);
  let guard = 0;
  while (g.phase === 'betting' && guard++ < 200) {
    const seat = g.toActSeat;
    if (g.players[seat].isAI) {
      const r = eng.aiAct(g, seat);
      assert.ok(r.ok, 'aiAct 失敗: ' + JSON.stringify(r));
    } else {
      const p = g.players[seat];
            const action = p.betThisStreet < g.currentBet ? 'call' : 'check';
      const r = eng.act(g, seat, action);
      assert.ok(r.ok, 'act 失敗: ' + JSON.stringify(r));
    }
  }
  assert.strictEqual(g.phase, 'roundEnd', 'AI 牌局應結束，實際 ' + g.phase);
  const total = g.players.reduce((a, p) => a + p.stack, 0);
  assert.strictEqual(total, 2000, '籌碼守恆');
  console.log('✓ 測試2 aiAct 推進牌局到結束，winners=', JSON.stringify(g.winners));
}

// 測試 3：AI 補位（1 真人 + 補至 4 人）
{
  const g = makeGame(7, 1);
  while (g.players.length < 4) eng.addPlayer(g, { id: 'ai-' + g.players.length, name: '🤖 AI', isAI: true });
  assert.strictEqual(g.players.length, 4);
  assert.strictEqual(g.players.filter(p => p.isAI).length, 3);
  eng.startGame(g);
  assert.strictEqual(g.phase, 'betting');
  // 快照：AI 座位標 isAI，且不洩漏他人底牌
  const s0 = eng.snapshotFor(g, 0);
  for (const p of s0.players) {
    if (p.seat === 0) assert.strictEqual(p.hole.length, 2, '自己底牌');
    else assert.strictEqual(p.hole.length, 0, '他人底牌為空');
  }
  assert.ok(s0.players.some(p => p.isAI), '快照應含 isAI 旗標');
  console.log('✓ 測試3 AI 補位至 4 人，快照公平性 OK');
}

// 測試 4：estimateVsRandom 對手越多勝率越低（共用模組）
{
  const aa = [{ r: 14, s: 0 }, { r: 14, s: 1 }];
  const e1 = core.estimateVsRandom(aa, [], 1, 2000);
  const e3 = core.estimateVsRandom(aa, [], 3, 2000);
  assert.ok((e1.win + e1.tie) / e1.n > (e3.win + e3.tie) / e3.n, '對手越多勝率越低');
  console.log('✓ 測試4 estimateVsRandom 共用模組，AA 1opp=', ((e1.win + e1.tie) / e1.n * 100).toFixed(1) + '%', '3opp=', ((e3.win + e3.tie) / e3.n * 100).toFixed(1) + '%');
}

console.log('\n引擎層級 AI 測試通過');
