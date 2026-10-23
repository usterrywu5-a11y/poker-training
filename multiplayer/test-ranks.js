'use strict';
// 牌力編碼回歸測試：驗證牌型評分 / 勝負判定（含 Ace 應為最高牌）
// 覆蓋已知 bug：RANKC 索引錯位導致 Ace 被當最低牌（r=2），
//           造成「較強手牌被判輸」（A高<Q高、一對A<一對6 等）。
const assert = require('assert');
const core = require('./game-core.js');

function card(s) { return core.deckAll().find(c => core.cardStr(c) === s); }
function sc(hold, board) { return core.evaluate7([...hold.map(card), ...board.map(card)]); }
// a 是否勝 b（同一公用牌）
function beats(aHole, bHole, board) { return core.cmpScores(sc(aHole, board), sc(bHole, board)) > 0; }

let n = 0;
function t(name, cond) { assert.ok(cond, 'FAIL: ' + name); n++; console.log('✓ ' + name); }

// --- Terry 回報的兩手 ---
{
  const b1 = ['6♣', '4♥', '3♠', 'T♥', '7♦'];
  t('Hand1: A 高牌 勝 Q 高牌', beats(['A♣', '8♠'], ['J♦', 'Q♦'], b1));
}
{
  const b2 = ['9♦', '5♣', 'A♥', 'Q♣', '6♥'];
  t('Hand2: 一對 A 勝 一對 6', beats(['A♣', '4♣'], ['J♥', '6♣'], b2));
}

// --- Ace 應為最高牌 ---
{
  const b = ['6♦', '2♣', '9♠', '3♥', 'T♦'];
  t('AA > KK（高對）', beats(['A♣', 'A♦'], ['K♣', 'K♦'], b));
  t('A 高牌 > K 高牌', beats(['A♣', '7♦'], ['K♣', 'J♦'], b));
  t('A K 高牌 > Q J 高牌', beats(['A♥', 'K♠'], ['Q♣', 'J♠'], b));
}

// --- 順子 / 輪盤（A-2-3-4-5）/ 同花 ---
{
  const t1 = sc(['7♦', '2♣'], ['A♣', '2♦', '3♥', '4♠', '5♣']);        // 輪盤 5-高
  const t2 = sc(['7♦', '2♣'], ['9♥', 'T♣', 'J♦', 'Q♠', 'K♥']);        // K-高順
  t('輪盤 = 順子(5 高)', core.catName(t1) === '順子' && t1[1] === 5);
  t('K 高順 > 輪盤', core.cmpScores(t2, t1) > 0);
  const fl = sc(['A♠', 'K♠'], ['2♠', '5♠', '9♠', 'J♠', '3♦']);         // A-高同花
  t('同花偵測', core.catName(fl) === '同花');
  const royal = sc(['A♠', 'K♠'], ['Q♠', 'J♠', 'T♠', '2♦', '7♥']);      // 皇家同花順
  t('皇家同花順', core.catName(royal) === '同花順' && royal[1] === 14);
}

// --- 顯示編碼（cardStr）---
t('A♠ 顯示正確', core.cardStr(card('A♠')) === 'A♠');
t('K♠ 顯示正確', core.cardStr(card('K♠')) === 'K♠');

console.log(`\n牌力回歸測試全過（${n} 項）`);
