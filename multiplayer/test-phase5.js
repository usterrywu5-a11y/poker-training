'use strict';
// Phase 5 整合測試：roundEnd 後「下一局 ▶ 按鈕 + 倒數」
// 驗證：
//  1. roundEnd 後伺服器廣播 nextHandCountdown（含剩餘毫秒）。
//  2. 沒人按 → 倒數結束（NEXT_HAND_DELAY）自動開下一手，不卡房。
//  3. 有人按 nextHand → 立即開下一手（遠早於倒數 Timer 到期）。
//  4. 任一玩家都能按（不限房主）。
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 18084;
const URL = `ws://127.0.0.1:${PORT}`;
const DELAY = 4000; // 縮短倒數以便測試

// 縮短 AI 行動延遲、斷線保留，加快測試
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

// 當輪到任一真人就 check/call，直到牌局結束（AI 補位自行行動）
async function playToRoundEnd(seatToWs, ownerStates) {
  let guard = 0;
  while (guard++ < 300) {
    const cur = ownerStates[ownerStates.length - 1];
    if (cur.phase === 'roundEnd') return cur;
    const toAct = cur.toActSeat;
    if (toAct < 0) return cur;
    const pl = cur.players[toAct];
    if (pl.isAI) { await wait(1100); continue; }
    const ws = seatToWs[toAct];
    if (!ws) { await wait(200); continue; }
    ws.send(JSON.stringify({ type: 'act', action: pl.bet < cur.currentBet ? 'call' : 'check' }));
    await wait(80);
    if (guard % 25 === 0) console.log(`  [play] guard=${guard} street=${cur.street} toAct=${toAct} phase=${cur.phase} pot=${cur.pot}`);
  }
  throw new Error('牌局未在預期內結束');
}

// 等待下一次 roundEnd 的 nextHandCountdown event（先查已收集的 states，避免 race）
function waitCountdown(ws, states, startHintMs) {
  // 掃描已收集的 states，找最後一筆 roundEnd 的 nextHandCountdown
  for (let i = states.length - 1; i >= 0; i--) {
    const m = states[i];
    if (m.phase === 'roundEnd' && m.event && m.event.type === 'nextHandCountdown') {
      return Promise.resolve({ m, at: Date.now() });
    }
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout nextHandCountdown')), startHintMs || 12000);
    const on = (d) => {
      const m = JSON.parse(d);
      if (m.type !== 'state') return;
      if (m.event && m.event.type === 'nextHandCountdown' && m.phase === 'roundEnd') {
        clearTimeout(t); ws.off('message', on);
        resolve({ m, at: Date.now() });
      }
    };
    ws.on('message', on);
  });
}

async function main() {
  for (let i = 0; i < 20; i++) { await wait(200); if (srvOut.includes('已啟動')) break; }
  assert.ok(srvOut.includes('已啟動'), '伺服器未啟動');

  // 房主開房 + aiFill（補 AI 到 3 人），讓牌局能快速自動打完
  const owner = await connect();
  const ownerStates = collectStates(owner);
  owner.send(JSON.stringify({ type: 'createRoom', name: '房主', maxPlayers: 3, aiFill: true }));
  const joined = await waitMsg(owner, 'joined');
  const ownerSeat = joined.seat;
  const code = joined.roomCode;

  // 第二位真人加入（驗證「任一玩家」都能按）
  const other = await connect();
  const otherStates = collectStates(other);
  other.send(JSON.stringify({ type: 'joinRoom', roomCode: code, name: '玩家B' }));
  const jOther = await waitMsg(other, 'joined');
  const otherSeat = jOther.seat;
  console.log('✓ 房主開房（aiFill）房號', code, '房主 seat', ownerSeat, '玩家B seat', otherSeat);

  owner.send(JSON.stringify({ type: 'start' }));
  await waitMsg(owner, 'state');
  await wait(300);

  // ---- 第一手：驗證 roundEnd 廣播 nextHandCountdown + 立即按 nextHand 可提前 ----
  const seatToWs = { [ownerSeat]: owner, [otherSeat]: other };
  await playToRoundEnd(seatToWs, ownerStates);
  const countdown1 = await waitCountdown(other, otherStates); // 由「其他玩家」觸發驗證任一人都能推進
  assert.strictEqual(countdown1.m.event.ms, DELAY, '倒數毫秒應等於 NEXT_HAND_DELAY');
  console.log('✓ roundEnd 廣播 nextHandCountdown ms=', countdown1.m.event.ms);

  // 玩家B 立即按 nextHand → 應約立刻開下一手（遠早於 DELAY）
  const t0 = Date.now();
  other.send(JSON.stringify({ type: 'nextHand' }));
  const hs = await waitMsg(other, 'state', DELAY); // 等新一手 state
  const immediateMs = Date.now() - t0;
  assert.strictEqual(hs.phase, 'betting', '按 nextHand 後應立即進入下一下注階段');
  assert.ok(immediateMs < DELAY * 0.6, '立即推進應早於倒數到期，實際 ' + immediateMs + 'ms < ' + DELAY + 'ms');
  console.log('✓ 按下 nextHand 立即開下一手（', immediateMs + 'ms，早於 ', DELAY, 'ms 倒數）');

  // confirm 真有人按就能觸發 maybeNextHand 的 nextHandTimer 被清掉
  // （已在 startNextHand 內 clearTimeout，下面第 2 手驗證「不按則倒數自開」）

  // ---- 第二手：驗證不按按鈕 → 倒數結束自動開局，不卡房 ----
  await playToRoundEnd(seatToWs, ownerStates);
  const countdown2 = await waitCountdown(owner, ownerStates);
  assert.strictEqual(countdown2.m.event.ms, DELAY);
  // 記錄目前狀態數，等倒數結束後應出現新的 betting 一手（phase 從 roundEnd 回到 betting）
  const nStatesBefore = ownerStates.length;
  const t1 = Date.now();
  let autoStarted = false;
  for (let i = 0; i < 60; i++) {
    const cur = ownerStates[ownerStates.length - 1];
    if (ownerStates.length > nStatesBefore + 1 && cur.phase === 'betting') { autoStarted = true; break; }
    await wait(150);
  }
  assert.ok(autoStarted, '倒數結束應自動開下一手（不卡房）');
  const autoMs = Date.now() - t1;
  assert.ok(autoMs >= DELAY - 700, '應等到倒數結束才自動開，實際約 ' + autoMs + 'ms (DELAY=' + DELAY + ')');
  console.log('✓ 不按按鈕：倒數 ', DELAY, 'ms 結束後自動開局（', autoMs, 'ms），掛機不卡房');

  owner.close(); other.close();
  srv.kill();
  console.log('\n全部 Phase 5 整合測試通過');
  process.exit(0);
}

main().catch(e => {
  console.error('整合測試失敗:', e.message);
  try { console.error('owner errs=', JSON.stringify(owner.__errs)); } catch(_){}
  console.error('伺服器輸出:', srvOut);
  srv.kill();
  process.exit(1);
});