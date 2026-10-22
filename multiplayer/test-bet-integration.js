'use strict';
// 整合測試：透過真實 WS 伺服器驗證「開池下注(bet)」與「攤牌秀牌」
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 18081;
const URL = `ws://127.0.0.1:${PORT}`;

const srv = spawn('node', ['server.js', String(PORT)], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
let srvOut = '';
srv.stdout.on('data', d => srvOut += d);
srv.stderr.on('data', d => srvOut += d);

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
function waitMsg(ws, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting ' + type)), timeout);
    const onMsg = (data) => {
      const m = JSON.parse(data);
      if (m.type === type) { clearTimeout(timer); ws.off('message', onMsg); resolve(m); }
    };
    ws.on('message', onMsg);
  });
}
function collectStates(ws) {
  const states = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'state') states.push(m);
  });
  return states;
}

async function main() {
  for (let i = 0; i < 20; i++) { await wait(200); if (srvOut.includes('已啟動')) break; }
  assert.ok(srvOut.includes('已啟動'), '伺服器未啟動: ' + srvOut);

  const owner = await connect();
  const ownerStates = collectStates(owner);
  owner.send(JSON.stringify({ type: 'createRoom', name: '房主', maxPlayers: 2 }));
  const joined = await waitMsg(owner, 'joined');
  const roomCode = joined.roomCode;
  const ownerSeat = joined.seat;

  const p1 = await connect();
  const p1States = collectStates(p1);
  p1.send(JSON.stringify({ type: 'joinRoom', roomCode, name: '玩家A' }));
  const j1 = await waitMsg(p1, 'joined');

  owner.send(JSON.stringify({ type: 'start' }));
  await waitMsg(owner, 'state');
  await wait(300);

  const seatToWs = { [ownerSeat]: owner, [j1.seat]: p1 };
  let guard = 0;
  let betSent = false;
  let showdownReached = false;
  while (guard++ < 300) {
    const cur = ownerStates[ownerStates.length - 1];
    const toAct = cur.toActSeat;
    if (toAct < 0) break;
    const ws = seatToWs[toAct];
    const my = cur.players[toAct];
    // 策略：翻牌前 call/check；翻牌後若無人下注(currentBet=0)則開池下注(bet)
    if (cur.street >= 1 && cur.currentBet <= 0 && !betSent) {
      ws.send(JSON.stringify({ type: 'act', action: 'bet', amount: 30 }));
      betSent = true;
      console.log('✓ 透過 WS 送出開池下注 bet 30 (street=' + cur.street + ')');
    } else {
      const action = my.bet < cur.currentBet ? 'call' : 'check';
      ws.send(JSON.stringify({ type: 'act', action }));
    }
    await wait(80);
    if (ownerStates[ownerStates.length - 1].phase === 'roundEnd') { showdownReached = true; break; }
  }
  await wait(400);
  const final = ownerStates[ownerStates.length - 1];
  assert.ok(betSent, '應已送出 bet');
  assert.strictEqual(final.phase, 'roundEnd', '牌局應結束，實際 ' + final.phase);
  // 攤牌後所有未蓋牌玩家應 reveal + 有牌型
  for (const p of final.players) {
    if (!p.folded) {
      assert.strictEqual(p.revealed, true, p.name + ' 應 reveal');
      assert.strictEqual(p.hole.length, 2, p.name + ' 應秀底牌');
      assert.ok(p.handName, p.name + ' 應有牌型');
    }
  }
  console.log('✓ 攤牌秀牌:', final.players.map(p => p.name + '=' + (p.handName || '蓋牌')).join(', '));
  console.log('✓ 開池下注 + 攤牌秀牌 整合測試通過');

  owner.close(); p1.close();
  srv.kill();
  process.exit(0);
}

main().catch(e => {
  console.error('整合測試失敗:', e.message);
  console.error('伺服器輸出:', srvOut);
  srv.kill();
  process.exit(1);
});
