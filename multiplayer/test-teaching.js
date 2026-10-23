'use strict';
// Phase 6 教學實戰版整合測試：驗證教學房（teaching:true）完整流程。
//  1. createRoom 帶 teaching:true → 房主為真人，AI 補位至設定人數（2-3 AI 同桌）。
//  2. 教學房無法被 joinRoom 加入（單人練習）。
//  3. 真人 + AI 打到 roundEnd：AI 行動由伺服器 aiAct 驅動。
//  4. roundEnd 快照翻開所有 AI 牌（含蓋牌），供玩家檢討。
//  5. 真人決策點被記錄進 handLog，且帶 verdict(+EV/-EV) 與中文建議。
//  6. 教學房 stats 累計手數/淨籌碼/決策正確率。
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 18085;
const URL = `ws://127.0.0.1:${PORT}`;
const DELAY = 4000;

const srv = spawn('node', ['server.js', String(PORT)], {
  cwd: __dirname,
  env: { ...process.env, KEEP_SEAT_MS: '800', NEXT_HAND_DELAY: String(DELAY) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
srv.stdout.on('data', d => srvOut += d);
srv.stderr.on('data', d => srvOut += d);

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function connect() { return new Promise((res, rej) => { const ws = new WebSocket(URL); ws.on('open', () => res(ws)); ws.on('error', rej); }); }
function waitMsg(ws, type, timeout = 8000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + type)), timeout);
    const on = (d) => { const m = JSON.parse(d); if (m.type === type) { clearTimeout(t); ws.off('message', on); res(m); } };
    ws.on('message', on);
  });
}
function collectStates(ws) { const a = []; const errs = []; ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'state') a.push(m); else if (m.type === 'error') errs.push(m.message); }); ws.__errs = errs; return a; }

async function playToRoundEnd(ownerStates) {
  let guard = 0;
  while (guard++ < 400) {
    const cur = ownerStates[ownerStates.length - 1];
    if (cur.phase === 'roundEnd') return cur;
    const toAct = cur.toActSeat;
    if (toAct < 0) return cur;
    const pl = cur.players[toAct];
    if (pl.isAI) { await wait(1100); continue; }
    // 真人：能 check 就 check，否則 call
    ownerStates[0].__ws.send(JSON.stringify({ type: 'act', action: pl.bet < cur.currentBet ? 'call' : 'check' }));
    await wait(80);
  }
  throw new Error('牌局未在預期內結束');
}

async function main() {
  for (let i = 0; i < 20; i++) { await wait(200); if (srvOut.includes('已啟動')) break; }
  assert.ok(srvOut.includes('已啟動'), '伺服器未啟動');

  // 房主開教學房：teaching:true, numAI=3, difficulty=beginner
  const owner = await connect();
  const ownerStates = collectStates(owner);
  ownerStates[0] = { __ws: owner }; // 供 playToRoundEnd 送 act
  owner.send(JSON.stringify({ type: 'createRoom', teaching: true, name: '學員',
    difficulty: 'beginner', numAI: 3, startStack: 1000, smallBlind: 10, bigBlind: 20 }));
  const joined = await waitMsg(owner, 'joined');
  const ownerSeat = joined.seat;
  const code = joined.roomCode;
  console.log('✓ 開教學房 房號', code, '真人 seat', ownerSeat);

  // 驗證 2：教學房無法被加入
  const intruder = await connect();
  intruder.send(JSON.stringify({ type: 'joinRoom', roomCode: code, name: '路人' }));
  const err = await waitMsg(intruder, 'error');
  assert.ok(err.message.includes('教學房'), '教學房應拒絕加入，實際: ' + err.message);
  console.log('✓ 教學房拒絕 joinRoom：', err.message);
  intruder.close();

  // 開局
  owner.send(JSON.stringify({ type: 'start' }));
  await waitMsg(owner, 'state');
  await wait(300);

  // 驗證 1：AI 補位至 4 人（1 真人 + 3 AI）
  const st0 = ownerStates[ownerStates.length - 1];
  const aiCount = st0.players.filter(p => p.isAI).length;
  assert.strictEqual(aiCount, 3, '教學房應有 3 位 AI 同桌，實際 ' + aiCount);
  assert.strictEqual(st0.players.length, 4, '應為 1 真人 + 3 AI');
  assert.strictEqual(st0.teaching, true, '快照應標記 teaching');
  assert.strictEqual(st0.difficulty, 'beginner', '快照應帶難度');
  console.log('✓ AI 補位 3 位同桌，teaching=', st0.teaching, 'difficulty=', st0.difficulty);

  // 打到 roundEnd
  const end = await playToRoundEnd(ownerStates);
  console.log('✓ 打到 roundEnd，pot=', end.pot);

  // 驗證 4：roundEnd 翻開所有 AI 牌（含蓋牌）
  const aiRevealed = end.players.filter(p => p.isAI && p.revealed).length;
  assert.strictEqual(aiRevealed, 3, 'roundEnd 應翻開所有 3 位 AI 牌，實際 ' + aiRevealed);
  console.log('✓ roundEnd 翻開所有 AI 牌（', aiRevealed, '位）');

  // 驗證 5：handLog 記錄真人決策點，帶 verdict 與中文建議
  const logs = (end.handLog || []).filter(l => l.verdict);
  assert.ok(logs.length > 0, 'handLog 應有真人決策點');
  for (const l of logs) {
    assert.ok(l.verdict === '+EV' || l.verdict === '-EV', 'verdict 非法');
    assert.ok(typeof l.advice === 'string' && l.advice.length > 0, '缺中文建議');
    assert.ok(typeof l.eqPercent === 'number', '缺勝率');
  }
  console.log('✓ handLog 記錄', logs.length, '個真人決策點，範例:', JSON.stringify(logs[0]));

  // 驗證 6：stats 累計
  assert.ok(end.stats, '教學房快照應帶 stats');
  assert.ok(end.stats.hands >= 1, 'stats.hands 應 ≥1，實際 ' + end.stats.hands);
  assert.ok(end.stats.total >= logs.length, 'stats.total 應 ≥ handLog 數');
  console.log('✓ stats 累計：hands=', end.stats.hands, 'net=', end.stats.net, 'correct=', end.stats.correct, '/', end.stats.total);

  owner.close();
  srv.kill();
  console.log('\n全部 Phase 6 教學實戰整合測試通過');
  process.exit(0);
}

main().catch(e => {
  console.error('整合測試失敗:', e.message);
  try { console.error('owner errs=', JSON.stringify(owner.__errs)); } catch (_) {}
  console.error('伺服器輸出:', srvOut);
  srv.kill();
  process.exit(1);
});
