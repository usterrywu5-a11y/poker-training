'use strict';
// 教學實戰版 handLog 冒煙測試：驗證真人玩家在每個決策點都會被記錄檢討資料，
// 且 snapshotFor 會把 handLog 帶給客戶端。AI 玩家不應被記錄。
const eng = require('./engine.js');

function run() {
  const g = eng.createGame({ smallBlind: 10, bigBlind: 20, startStack: 1000, maxPlayers: 4 });
  // 固定洗牌，讓測試可重現
  g._bindShuffle(eng.seededShuffle(12345));

  // 房主 = 真人（isAI=false），其餘補 AI
  eng.addPlayer(g, { id: 'human', name: '小明', isOwner: true, isAI: false });
  eng.addPlayer(g, { id: 'ai1', name: 'AI1', isAI: true });
  eng.addPlayer(g, { id: 'ai2', name: 'AI2', isAI: true });

  eng.startGame(g);

  // 驅動牌局：真人輪到就由 act() 下決策，AI 輪到就 aiAct()
  let guard = 0;
  while (g.phase === 'betting' && guard++ < 200) {
    const seat = g.toActSeat;
    const p = g.players[seat];
    if (p.isAI) {
      const r = eng.aiAct(g, seat);
      if (!r.ok) throw new Error('aiAct 失敗: ' + r.error);
    } else {
      // 真人：簡單策略——能 check 就 check，否則 call
      const need = Math.max(0, g.currentBet - p.betThisStreet);
      const action = need <= 0 ? 'check' : 'call';
      const r = eng.act(g, seat, action, 0);
      if (!r.ok) throw new Error('act 失敗: ' + r.error);
    }
  }

  // 驗證 1：handLog 有記錄真人玩家的決策點
  const humanSeat = eng.seatOf(g, 'human');
  const humanEntries = g.handLog.filter(e => e.seat === humanSeat);
  if (humanEntries.length === 0) {
    throw new Error('handLog 未記錄真人玩家的任何決策點');
  }

  // 驗證 2：每筆記錄都含檢討欄位
  for (const e of humanEntries) {
    if (typeof e.street !== 'number' || typeof e.action !== 'string') throw new Error('handLog 缺 street/action');
    if (typeof e.eqPercent !== 'number' || typeof e.needPercent !== 'number') throw new Error('handLog 缺勝率欄位');
    if (e.verdict !== '+EV' && e.verdict !== '-EV') throw new Error('handLog verdict 非法: ' + e.verdict);
    if (typeof e.advice !== 'string' || e.advice.length === 0) throw new Error('handLog 缺中文建議');
  }

  // 驗證 3：AI 玩家不應被記錄（recordHandLog 只記真人）
  const aiEntries = g.handLog.filter(e => g.players[e.seat] && g.players[e.seat].isAI);
  if (aiEntries.length > 0) throw new Error('handLog 不應記錄 AI 玩家');

  // 驗證 4：snapshotFor 把 handLog 帶給客戶端
  const snap = eng.snapshotFor(g, humanSeat);
  if (!Array.isArray(snap.handLog)) throw new Error('snapshotFor 未帶 handLog');
  if (snap.handLog.length !== g.handLog.length) throw new Error('snapshot handLog 數量不符');

  // 驗證 5：每手重置——開新一手後 handLog 清空
  eng.startHand(g);
  if (g.handLog.length !== 0) throw new Error('startHand 未重置 handLog');

  console.log('✓ handLog 冒煙測試通過');
  console.log('  真人決策點數 =', humanEntries.length);
  console.log('  範例記錄 =', JSON.stringify(humanEntries[0]));
  console.log('  snapshot 帶 handLog =', snap.handLog.length, '筆');
  console.log('  startHand 重置 =', g.handLog.length === 0);
  return true;
}

run();
