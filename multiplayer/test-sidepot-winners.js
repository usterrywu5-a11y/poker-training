'use strict';
// 側池退款誤列贏家 回歸測試
// 情境：3 人全下金額不同，較高金額者（無人競爭的退款池）不應被列為贏家。
// 已知 bug：runShowdown 把所有從任一側池領到錢的人都列入 game.winners，
// 導致「退還自己多下注部分」的玩家被顯示成 🏆 贏家（如 一對6 跟 順子 並列贏）。
const assert = require('assert');
const eng = require('./engine.js');
const core = require('./game-core.js');

function card(s) { return core.deckAll().find(c => core.cardStr(c) === s); }
function makeScenario() {
  // Terry 全下 830（順子），AI2 全下 1100（一對2），AI1 已蓋（已投入 830）
  const g = eng.createGame({ smallBlind: 5, bigBlind: 10, startStack: 2000, maxPlayers: 4 });
  eng.addPlayer(g, { id: 'terry', name: 'terry' });
  eng.addPlayer(g, { id: 'AI2', name: 'AI2', isAI: true });
  eng.addPlayer(g, { id: 'AI1', name: 'AI1', isAI: true });
  g.players[0].hole = ['8♠', 'J♠'].map(card);
  g.players[1].hole = ['2♥', '2♠'].map(card);
  g.board = ['K♠', 'T♠', 'Q♦', '9♣', '6♥'].map(card);
  g.players[0].betTotal = 830; g.players[0].stack = 0; g.players[0].allin = true;
  g.players[1].betTotal = 1100; g.players[1].stack = 0; g.players[1].allin = true;
  g.players[2].betTotal = 830; g.players[2].stack = 1170; g.players[2].folded = true;
  g.pot = 2760;
  return g;
}

let n = 0;
function t(name, cond, extra) { assert.ok(cond, 'FAIL: ' + name + (extra ? ' :: ' + extra : '')); n++; console.log('✓ ' + name); }

// --- 案例 1：全下退款不列贏家（使用者回報） ---
{
  const g = makeScenario();
  eng.runShowdown(g, []);
  t('只列實際贏家 Terry（1 人）', g.winners.length === 1 && g.winners[0].seat === 0,
    JSON.stringify(g.winners));
  t('Terry 金流正確（主池 2490）', g.players[0].stack === 2490, 'stack=' + g.players[0].stack);
  t('AI2 退款照領（270）但不列贏家', g.players[1].stack === 270, 'stack=' + g.players[1].stack);
}

// --- 案例 2：一般 2 人攤牌，贏家照常列出 ---
{
  const g = eng.createGame({ smallBlind: 5, bigBlind: 10, startStack: 1000, maxPlayers: 4 });
  eng.addPlayer(g, { id: 'A', name: 'A' });
  eng.addPlayer(g, { id: 'B', name: 'B', isAI: true });
  g.players[0].hole = ['A♣', 'A♦'].map(card);
  g.players[1].hole = ['K♣', 'K♦'].map(card);
  g.board = ['2♦', '7♠', '9♥', '3♣', 'T♠'].map(card);
  g.players[0].betTotal = 100; g.players[1].betTotal = 100;
  g.pot = 200;
  eng.runShowdown(g, []);
  t('一般攤牌：一對A 贏家列出', g.winners.length === 1 && g.winners[0].seat === 0,
    JSON.stringify(g.winners));
  t('贏家拿到全池（起始 1000 + 底池 200）', g.players[0].stack === 1200,
    'stack=' + g.players[0].stack);
}

// --- 案例 3：平手（公用牌即為最佳牌）兩人都列贏家 ---
{
  const g = eng.createGame({ smallBlind: 5, bigBlind: 10, startStack: 1000, maxPlayers: 4 });
  eng.addPlayer(g, { id: 'A', name: 'A' });
  eng.addPlayer(g, { id: 'B', name: 'B', isAI: true });
  g.board = ['A♠', 'K♠', 'Q♠', 'J♠', 'T♠'].map(card); // 皇家同花順在公用牌
  g.players[0].hole = ['2♣', '3♦'].map(card);
  g.players[1].hole = ['4♥', '5♣'].map(card);
  g.players[0].betTotal = 100; g.players[1].betTotal = 100;
  g.pot = 200;
  eng.runShowdown(g, []);
  t('平手：兩人都列贏家', g.winners.length === 2,
    JSON.stringify(g.winners));
  t('每人分一半（1000 + 各回 100）', g.players[0].stack === 1100 && g.players[1].stack === 1100);
}

// --- 案例 4：3 人側池各有競爭者，多池贏家都列出 ---
{
  const g = eng.createGame({ smallBlind: 5, bigBlind: 10, startStack: 2000, maxPlayers: 4 });
  eng.addPlayer(g, { id: 'A', name: 'A' });
  eng.addPlayer(g, { id: 'B', name: 'B', isAI: true });
  eng.addPlayer(g, { id: 'C', name: 'C', isAI: true });
  // A 全下 500（對子），B 全下 1000（三條），C 全下 1000（兩對）
  g.players[0].hole = ['A♣', 'A♦'].map(card);        // 一對A
  g.players[1].hole = ['K♣', 'K♦'].map(card);        // 三條K 會贏主池
  g.players[2].hole = ['Q♣', 'Q♦'].map(card);        // 兩對Q
  g.board = ['2♦', '7♠', '9♥', 'K♥', 'T♠'].map(card); // K 讓 B 三條
  g.players[0].betTotal = 500; g.players[0].stack = 0; g.players[0].allin = true;
  g.players[1].betTotal = 1000; g.players[1].stack = 0; g.players[1].allin = true;
  g.players[2].betTotal = 1000; g.players[2].stack = 0; g.players[2].allin = true;
  g.pot = 2500;
  eng.runShowdown(g, []);
  t('主池 B（三條）勝', g.players[1].stack > 0, JSON.stringify(g.winners));
  t('無退款誤列：A 沒贏任何池', g.winners.every(w => w.seat !== 0), JSON.stringify(g.winners));
}

console.log(`\n側池贏家回歸測試全過（${n} 項）`);
