'use strict';
// 斷線自動棄牌整合測試：KEEP_SEAT_MS 縮短為 800ms，驗證斷線超時自動棄牌
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 18082;
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

  const owner = await connect();
  const ownerStates = collectStates(owner);
  owner.send(JSON.stringify({ type: 'createRoom', name: '房主', maxPlayers: 2, aiTakeover: false }));
  const joined = await waitMsg(owner, 'joined');
  const code = joined.roomCode;

  const p1 = await connect();
  const p1States = collectStates(p1);
  p1.send(JSON.stringify({ type: 'joinRoom', roomCode: code, name: '玩家A' }));
  const j1 = await waitMsg(p1, 'joined');

  owner.send(JSON.stringify({ type: 'start' }));
  await waitMsg(owner, 'state');
  await wait(200);

  // 讓玩家A斷線（若輪到他，超時後應自動棄牌）
  const s0 = ownerStates[ownerStates.length - 1];
  const toAct = s0.toActSeat;
  p1.close();
  await wait(200);

  // 若輪到玩家A，等待自動棄牌；否則房主先行動
  let guard = 0;
  while (guard++ < 20) {
    const cur = ownerStates[ownerStates.length - 1];
    if (cur.phase === 'roundEnd') break;
    if (cur.toActSeat === j1.seat) {
      // 玩家A離線且輪到他 → 等自動棄牌
      await wait(1200);
      break;
    }
    // 房主行動
    const me = cur.players[ownerStates[ownerStates.length - 1].mySeat];
    const action = me.bet < cur.currentBet ? 'call' : 'check';
    owner.send(JSON.stringify({ type: 'act', action }));
    await wait(100);
  }

  await wait(500);
  const final = ownerStates[ownerStates.length - 1];
  // 玩家A應已被自動棄牌（folded=true）或牌局已結束
  const pA = final.players[j1.seat];
  assert.ok(pA.folded || final.phase === 'roundEnd', '玩家A應被自動棄牌，實際 folded=' + pA.folded + ' phase=' + final.phase);
  console.log('✓ 斷線超時自動棄牌：玩家A folded=', pA.folded, 'phase=', final.phase);

  owner.close();
  srv.kill();
  console.log('\n斷線自動棄牌測試通過');
  process.exit(0);
}

main().catch(e => { console.error('失敗:', e.message); console.error(srvOut); srv.kill(); process.exit(1); });