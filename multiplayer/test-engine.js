'use strict';
// engine 測試：驗證下注回合收斂、發牌流程、攤牌、側池
const assert = require('assert');
const eng = require('./engine.js');

function makeGame(seed, nPlayers, cfg) {
  const g = eng.createGame(Object.assign({ startStack: 1000, smallBlind: 10, bigBlind: 20, maxPlayers: 4 }, cfg));
  g._bindShuffle(eng.seededShuffle(seed));
  for (let i = 0; i < nPlayers; i++) eng.addPlayer(g, { id: 'p' + i, name: 'P' + i, isOwner: i === 0 });
  return g;
}

// 依序讓 toActSeat 行動，直到 done
function playToDone(g, actions) {
  let guard = 0;
  while (g.phase === 'betting' && guard++ < 200) {
    const seat = g.toActSeat;
    const a = actions[seat];
    if (!a) throw new Error('no action for seat ' + seat + ' street ' + g.street);
    const r = eng.act(g, seat, a[0], a[1]);
    assert.ok(r.ok, 'act failed: ' + JSON.stringify(r));
  }
  return g;
}

// 測試 1：2 人，翻牌前全跟注到底 → 攤牌
{
  const g = makeGame(42, 2);
  eng.startGame(g);
  assert.strictEqual(g.phase, 'betting');
  assert.strictEqual(g.street, 0);
  assert.strictEqual(g.players[0].hole.length, 2);
  assert.strictEqual(g.players[1].hole.length, 2);
  // 2 人：dealer=0, SB=0, BB=1。toAct 應為 SB(0)
  assert.strictEqual(g.toActSeat, 0);
  // SB call 10, BB check → 進翻牌
  let r = eng.act(g, 0, 'call');
  assert.ok(r.ok && !r.done);
  r = eng.act(g, 1, 'check');
  assert.ok(r.ok && r.done);
  assert.strictEqual(g.street, 1, '應進翻牌');
  assert.strictEqual(g.board.length, 3);
  // 翻牌後 check-check 到河牌
  r = eng.act(g, g.toActSeat, 'check');
  r = eng.act(g, g.toActSeat, 'check');
  assert.strictEqual(g.street, 2);
  r = eng.act(g, g.toActSeat, 'check');
  r = eng.act(g, g.toActSeat, 'check');
  assert.strictEqual(g.street, 3);
  r = eng.act(g, g.toActSeat, 'check');
  r = eng.act(g, g.toActSeat, 'check');
  assert.strictEqual(g.phase, 'roundEnd', '河牌後應攤牌');
  assert.ok(g.winners.length >= 1);
  const total = g.players.reduce((a, p) => a + p.stack, 0);
  assert.strictEqual(total, 2000, '籌碼守恆');
  console.log('✓ 測試1 完整流程到攤牌，winner=', JSON.stringify(g.winners));
}

// 測試 2：3 人，兩人蓋牌 → 收池
{
  const g = makeGame(7, 3);
  eng.startGame(g);
  // 依實際 toAct 順序：前兩人蓋牌，第三人收池
  const first = g.toActSeat;
  const others = [0, 1, 2].filter(s => s !== first);
  const actions = {};
  actions[first] = ['fold'];
  actions[others[0]] = ['fold'];
  actions[others[1]] = ['check'];
  playToDone(g, actions);
  assert.strictEqual(g.phase, 'roundEnd');
  assert.strictEqual(g.winners.length, 1);
  const total = g.players.reduce((a, p) => a + p.stack, 0);
  assert.strictEqual(total, 3000);
  console.log('✓ 測試2 蓋牌收池，winner=', JSON.stringify(g.winners));
}

// 測試 3：加注後回補（raise 後需再繞一圈）
{
  const g = makeGame(99, 3);
  eng.startGame(g);
  // toAct=2（大盲下一位）
  // P2 raise to 60, P0 call 60, P1 (BB) call 40
  let r = eng.act(g, g.toActSeat, 'raise', 60);
  assert.ok(r.ok && !r.done);
  r = eng.act(g, g.toActSeat, 'call');
  assert.ok(r.ok && !r.done);
  r = eng.act(g, g.toActSeat, 'call');
  assert.ok(r.ok && r.done, '加注後應收斂進翻牌');
  assert.strictEqual(g.street, 1, '加注後應進翻牌');
  assert.strictEqual(g.pot, 180, 'pot=60*3');
  console.log('✓ 測試3 加注回補，pot=', g.pot);
}

// 測試 4：全下 → 直接攤牌
{
  const g = makeGame(123, 2);
  eng.startGame(g);
  // P0 allin 1000, P1 call
  playToDone(g, { 0: ['allin'], 1: ['call'] });
  assert.strictEqual(g.phase, 'roundEnd');
  const total = g.players.reduce((a, p) => a + p.stack, 0);
  assert.strictEqual(total, 2000);
  console.log('✓ 測試4 全下攤牌，winner=', JSON.stringify(g.winners));
}

// 測試 5：側池（3 人，一人短碼全下 < BB）
{
  const g = makeGame(5, 3, { startStack: 1000 });
  // 3 人：dealer=0, SB=1, BB=2（startGame 後 dealer 遞莊到 0）
  // 讓 SB(seat 1) 短碼：SB 10 + allin 5 = 15 < BB 20
  g.players[1].stack = 15;
  eng.startGame(g);
  const sb = g.smallBlindSeat, bb = g.bigBlindSeat;
  assert.strictEqual(sb, 1, 'SB 應為 seat 1');
  // toAct = 大盲下一位 = 0
  // 依序：toAct(0) call 20, SB(1) allin 15, BB(2) check → 主池 45，側池 10
  let r = eng.act(g, g.toActSeat, 'call');
  assert.ok(r.ok, 'toAct call 失敗 ' + JSON.stringify(r));
  r = eng.act(g, sb, 'allin');
  assert.ok(r.ok, 'SB allin 失敗 ' + JSON.stringify(r));
  r = eng.act(g, bb, 'check');
  assert.ok(r.ok, 'BB check 失敗 ' + JSON.stringify(r));
  // 其餘仍有籌碼 → 進翻牌，check 到底到攤牌
  assert.strictEqual(g.street, 1, '應進翻牌');
  while (g.phase === 'betting') {
    r = eng.act(g, g.toActSeat, 'check');
    assert.ok(r.ok, 'check 失敗 ' + JSON.stringify(r));
  }
  assert.strictEqual(g.phase, 'roundEnd');
  const total = g.players.reduce((a, p) => a + p.stack, 0);
  assert.strictEqual(total, 2015, '15+1000+1000');
  assert.ok(g.sidePots.length >= 2, '應有主池+側池');
  console.log('✓ 測試5 側池，sidePots=', JSON.stringify(g.sidePots), 'winners=', JSON.stringify(g.winners));
}

// 測試 6：非法行動被拒
{
  const g = makeGame(1, 2);
  eng.startGame(g);
  const r = eng.act(g, 1, 'raise', 5); // 未輪到 P1
  assert.strictEqual(r.ok, false);
  const r2 = eng.act(g, 0, 'check'); // SB 欠注不能 check
  assert.strictEqual(r2.ok, false);
  console.log('✓ 測試6 非法行動被拒');
}

// 測試 7：快照不含他人底牌、不含整副
{
  const g = makeGame(2, 3);
  eng.startGame(g);
  const s0 = eng.snapshotFor(g, 0);
  assert.strictEqual(s0.players[0].hole.length, 2, '自己底牌');
  assert.strictEqual(s0.players[1].hole.length, 0, '他人底牌為空');
  assert.strictEqual(s0.players[2].hole.length, 0);
  assert.ok(!('deck' in s0), '快照不含整副');
  console.log('✓ 測試7 快照公平性');
}

console.log('\n全部 engine 測試通過');
