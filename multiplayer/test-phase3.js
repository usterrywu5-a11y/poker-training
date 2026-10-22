'use strict';
// 驗證 P0 開池下注 + P1 攤牌秀牌
const assert = require('assert');
const eng = require('./engine.js');

function makeGame(seed, nPlayers, cfg) {
  const g = eng.createGame(Object.assign({ startStack: 1000, smallBlind: 10, bigBlind: 20, maxPlayers: 4 }, cfg));
  g._bindShuffle(eng.seededShuffle(seed));
  for (let i = 0; i < nPlayers; i++) eng.addPlayer(g, { id: 'p' + i, name: 'P' + i, isOwner: i === 0 });
  return g;
}

// 測試 A：翻牌後 check 到底 → 開池下注（bet）合法
{
  const g = makeGame(42, 2);
  eng.startGame(g);
  eng.act(g, 0, 'call');
  eng.act(g, 1, 'check');
  assert.strictEqual(g.street, 1);
  eng.act(g, g.toActSeat, 'check');
  eng.act(g, g.toActSeat, 'check');
  assert.strictEqual(g.street, 2);
  eng.act(g, g.toActSeat, 'check');
  eng.act(g, g.toActSeat, 'check');
  assert.strictEqual(g.street, 3);
  assert.strictEqual(g.currentBet, 0, '河牌無人下注 currentBet=0');
  const seat = g.toActSeat;
  const r = eng.act(g, seat, 'bet', 50);
  assert.ok(r.ok, '開池下注應成功: ' + JSON.stringify(r));
  assert.strictEqual(g.currentBet, 50, 'currentBet 應為 50');
  eng.act(g, g.toActSeat, 'call');
  assert.strictEqual(g.phase, 'roundEnd');
  console.log('✓ 測試A 開池下注成功，winner=', JSON.stringify(g.winners));
}

// 測試 B：開池下注金額過低被拒
{
  const g = makeGame(42, 2);
  eng.startGame(g);
  eng.act(g, 0, 'call');
  eng.act(g, 1, 'check');
  eng.act(g, g.toActSeat, 'check');
  eng.act(g, g.toActSeat, 'check');
  eng.act(g, g.toActSeat, 'check');
  eng.act(g, g.toActSeat, 'check');
  assert.strictEqual(g.currentBet, 0);
  const r = eng.act(g, g.toActSeat, 'bet', 5); // 低於大盲 20
  assert.strictEqual(r.ok, false, '低於大盲的下注應被拒');
  console.log('✓ 測試B 過低下注被拒:', r.error);
}

// 測試 C：已有下注時 bet 被拒（應改用 raise）
{
  const g = makeGame(42, 2);
  eng.startGame(g);
  eng.act(g, 0, 'call');
  eng.act(g, 1, 'check');
  eng.act(g, g.toActSeat, 'check');
  eng.act(g, g.toActSeat, 'check');
  eng.act(g, g.toActSeat, 'check');
  eng.act(g, g.toActSeat, 'check');
  const r = eng.act(g, g.toActSeat, 'bet', 50);
  assert.ok(r.ok);
  const r2 = eng.act(g, g.toActSeat, 'bet', 100); // 已有人下注
  assert.strictEqual(r2.ok, false, '已有下注時 bet 應被拒');
  console.log('✓ 測試C 已有下注時 bet 被拒:', r2.error);
}

// 測試 D：攤牌快照秀出雙方手牌與牌型
{
  const g = makeGame(42, 2);
  eng.startGame(g);
  eng.act(g, 0, 'call');
  eng.act(g, 1, 'check');
  eng.act(g, g.toActSeat, 'check');
  eng.act(g, g.toActSeat, 'check');
  eng.act(g, g.toActSeat, 'check');
  eng.act(g, g.toActSeat, 'check');
  eng.act(g, g.toActSeat, 'check');
  eng.act(g, g.toActSeat, 'check');
  assert.strictEqual(g.phase, 'roundEnd');
  const s0 = eng.snapshotFor(g, 0);
  for (const p of s0.players) {
    assert.strictEqual(p.revealed, true, '攤牌後應 reveal');
    assert.strictEqual(p.hole.length, 2, '攤牌後應秀出底牌');
    assert.ok(p.handName, '應有牌型名稱，got ' + p.handName);
  }
  console.log('✓ 測試D 攤牌秀牌:', s0.players.map(p => p.name + '=' + p.handName).join(', '));
}

// 測試 E：下注中快照不洩漏他人底牌（公平性）
{
  const g = makeGame(2, 3);
  eng.startGame(g);
  const s0 = eng.snapshotFor(g, 0);
  assert.strictEqual(s0.players[1].hole.length, 0, '下注中他人底牌為空');
  assert.strictEqual(s0.players[1].revealed, false);
  console.log('✓ 測試E 下注中快照公平性');
}

console.log('\n全部 P0/P1 測試通過');
