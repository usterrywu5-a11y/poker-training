'use strict';
// 出局（破產/籌碼 0）玩家處理回歸測試
// Bug1：出局玩家不應被顯示成「被發到手牌」（client 畫牌背）。
// Bug2：出局玩家不應「靠別人蓋牌」贏底池而復活。
// 已知根因：activePlayers 只 filter(!folded)，把出局(allin 且本手未投入)玩家也算在局，
//       導致全蓋時把底池判給出局玩家→復活。修復後 activePlayers 排除該類玩家。
const assert = require('assert');
const eng = require('./engine.js');
const core = require('./game-core.js');

let n = 0;
function t(name, cond, extra) { assert.ok(cond, 'FAIL: ' + name + (extra ? ' :: ' + String(extra) : '')); n++; console.log('✓ ' + name); }

function setup4() {
  const g = eng.createGame({ smallBlind: 5, bigBlind: 10, startStack: 1000, maxPlayers: 4 });
  eng.addPlayer(g, { id: 'p0', name: 'P0' });
  eng.addPlayer(g, { id: 'ai1', name: 'AI1', isAI: true });
  eng.addPlayer(g, { id: 'ai2', name: 'AI2', isAI: true });
  eng.addPlayer(g, { id: 'ai3', name: 'AI3', isAI: true });
  return g;
}

// --- Bug 2：出局玩家不靠別人的蓋牌贏底池復活 ---
{
  const g = setup4();
  // AI3 出局：0 籌碼、allin、無手牌、本手無投入
  g.players[3].stack = 0; g.players[3].allin = true; g.players[3].hole = []; g.players[3].betTotal = 0;
  g.phase = 'betting'; g.currentBet = 10; g.pot = 30; g.toActSeat = 0;
  // P0、P1 蓋牌 → 只剩 P2（有籌碼）在局 → P2 收池
  const r0 = eng.act(g, 0, 'fold');
  const r1 = eng.act(g, 1, 'fold');
  t('P0、P1 蓋牌後牌局結束', g.phase === 'roundEnd', 'phase=' + g.phase);
  t('贏家是最後在局的 P2，不是出局的 AI3', g.winners.length === 1 && g.winners[0].seat === 2, JSON.stringify(g.winners));
  t('AI3（出局）維持 0 籌碼，不復活', g.players[3].stack === 0, 'stack=' + g.players[3].stack);
  t('AI3 不在 winners', g.winners.every(w => w.seat !== 3));
}

// --- Bug 1 + 快照：出局玩家快照正確（holeCount=0、eliminated=true） ---
{
  const g = setup4();
  g.players[3].stack = 0; eng.startGame(g); // 出局者標 allin，其他發牌
  const snap = eng.snapshotFor(g, 0);
  const ai3 = snap.players[3];
  t('出局玩家快照 holeCount=0', ai3.holeCount === 0, 'holeCount=' + ai3.holeCount);
  t('出局玩家快照 eliminated=true', ai3.eliminated === true, 'eliminated=' + ai3.eliminated);
  // 一位正常在局對手：holeCount=2、eliminated=false
  const ai1 = snap.players[1];
  t('正常玩家 holeCount=2', ai1.holeCount === 2, 'holeCount=' + ai1.holeCount + ' folded=' + ai1.folded);
  t('正常玩家 eliminated=false', ai1.eliminated !== true, 'eliminated=' + ai1.eliminated);
}

// --- 出局玩家不影響 hasFunded 牌局運行（在多手連續中維持觀戰） ---
{
  const g = setup4();
  g.players[3].stack = 0; g.players[3].allin = true; g.players[3].hole = []; g.players[3].betTotal = 0;
  // startGame/startHand 應正常開始（有 3 位在局），出局者繼續 out
  eng.startGame(g);
  t('有出局玩家時牌局仍能開始', g.phase === 'betting');
  t('出局玩家未被發牌', g.players[3].hole.length === 0);
  t('出局玩家被標 allin 排除', g.players[3].allin === true);
}

console.log(`\n出局玩家處理回歸測試全過（${n} 項）`);