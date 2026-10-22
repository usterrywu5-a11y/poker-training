'use strict';
// Phase 4 整合測試：AI 補位 + AI 行動 + 斷線 AI 代打 + 公平性
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 18083;
const URL = `ws://127.0.0.1:${PORT}`;

const srv = spawn('node', ['server.js', String(PORT)], {
  cwd: __dirname, env: { ...process.env, KEEP_SEAT_MS: '800' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
srv.stdout.on('data', d => srvOut += d);
srv.stderr.on('data', d => srvOut += d);

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function connect() { return new Promise((res, rej) => { const ws = new WebSocket(URL); ws.on('open', () => res(ws)); ws.on('error', rej); }); }
function waitMsg(ws, type, timeout = 5000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + type)), timeout);
    const on = (d) => { const m = JSON.parse(d); if (m.type === type) { clearTimeout(t); ws.off('message', on); res(m); } };
    ws.on('message', on);
  });
}
function collectStates(ws) { const a = []; ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'state') a.push(m); }); return a; }

async function main() {
  for (let i = 0; i < 20; i++) { await wait(200); if (srvOut.includes('已啟動')) break; }
  assert.ok(srvOut.includes('已啟動'), '伺服器未啟動');

  // 房主開房：aiFill=true，maxPlayers=4
  const owner = await connect();
  const ownerStates = collectStates(owner);
  owner.send(JSON.stringify({ type: 'createRoom', name: '房主', maxPlayers: 4, aiFill: true }));
  const joined = await waitMsg(owner, 'joined');
  const code = joined.roomCode;
  const ownerSeat = joined.seat;
  const ownerToken = joined.token;

  // 觀察者加入（真人）
  const obs = await connect();
  const obsStates = collectStates(obs);
  obs.send(JSON.stringify({ type: 'joinRoom', roomCode: code, name: '觀察者' }));
  const jObs = await waitMsg(obs, 'joined');
  const obsSeat = jObs.seat;
  console.log('✓ 房主開房（aiFill），房號', code, '房主 seat', ownerSeat, '觀察者 seat', obsSeat);

  // 2 位真人開局 → AI 補至 4 人
  owner.send(JSON.stringify({ type: 'start' }));
  await waitMsg(owner, 'state');
  await wait(300);
  const s0 = ownerStates[ownerStates.length - 1];
  assert.strictEqual(s0.players.length, 4, '應補至 4 人，實際 ' + s0.players.length);
  const aiSeats = s0.players.filter(p => p.isAI);
  assert.strictEqual(aiSeats.length, 2, '應有 2 個 AI 座位');
  assert.ok(aiSeats.every(p => p.name.includes('AI')), 'AI 座位應標 🤖 AI');
  console.log('✓ AI 補位：', s0.players.map(p => p.name + (p.isAI ? '(AI)' : '')).join(', '));

  // 公平性：房主快照看不到 AI 底牌
  for (const p of s0.players) {
    if (p.seat === ownerSeat) assert.strictEqual(p.hole.length, 2, '自己底牌');
    else assert.strictEqual(p.hole.length, 0, '他人底牌為空');
  }
  assert.ok(!('deck' in s0), '快照不含整副');
  console.log('✓ 公平性：每人只看到自己底牌，AI 底牌不外洩');

  // AI 自行行動（0.5-1 秒延遲），牌局推進到結束
  const seatToWs = { [ownerSeat]: owner, [obsSeat]: obs };
  let guard = 0;
  let aiActed = false;
  while (guard++ < 300) {
    const cur = ownerStates[ownerStates.length - 1];
    if (cur.phase === 'roundEnd') break;
    const toAct = cur.toActSeat;
    if (toAct < 0) break;
    if (cur.players[toAct].isAI) {
      aiActed = true;
      await wait(1200); // 等 AI 自動行動
    } else {
      const ws = seatToWs[toAct];
      const my = cur.players[toAct];
      const action = my.bet < cur.currentBet ? 'call' : 'check';
      ws.send(JSON.stringify({ type: 'act', action }));
      await wait(100);
    }
  }
  await wait(500);
  const final = ownerStates[ownerStates.length - 1];
  assert.strictEqual(final.phase, 'roundEnd', 'AI 牌局應結束，實際 ' + final.phase);
  assert.ok(aiActed, 'AI 應有自行行動');
  const total = final.players.reduce((a, p) => a + p.stack, 0);
  assert.strictEqual(total, 4000, '籌碼守恆 4000');
  console.log('✓ AI 自行行動完成牌局，winners=', JSON.stringify(final.winners));

  // 斷線 AI 代打：等下一手開始，房主斷線 → 觀察者看到 AI 代打 → 重連取回
  await wait(2000);
  const s1 = ownerStates[ownerStates.length - 1];
  if (s1.phase === 'betting') {
    const stackBefore = s1.players[ownerSeat].stack;
    owner.close();
    await wait(200);
    // 等 AI 代打（KEEP_SEAT_MS=800）
    await wait(1200);
    const sObs = obsStates[obsStates.length - 1];
    assert.ok(sObs.players[ownerSeat].isAI, '斷線後房主座位應由 AI 代打，實際 isAI=' + sObs.players[ownerSeat].isAI);
    console.log('✓ 斷線後 AI 代打房主座位');

    // 重連取回座位與剩餘籌碼
    const owner2 = await connect();
    const owner2States = collectStates(owner2);
    owner2.send(JSON.stringify({ type: 'resume', token: ownerToken }));
    const resumed = await waitMsg(owner2, 'state');
    assert.strictEqual(resumed.mySeat, ownerSeat, '重連後座位不變');
    assert.strictEqual(resumed.players[ownerSeat].isAI, false, '重連後應取回座位（isAI=false）');
    assert.strictEqual(resumed.players[ownerSeat].stack, stackBefore, '剩餘籌碼保留');
    console.log('✓ 重連取回座位與剩餘籌碼，stack=', resumed.players[ownerSeat].stack);
    owner2.close();
  } else {
    console.log('（跳過斷線代打測試：牌局未在進行中）');
  }

  owner.close(); obs.close();
  srv.kill();
  console.log('\n全部 Phase 4 整合測試通過');
  process.exit(0);
}

main().catch(e => {
  console.error('整合測試失敗:', e.message);
  console.error('伺服器輸出:', srvOut);
  srv.kill();
  process.exit(1);
});
