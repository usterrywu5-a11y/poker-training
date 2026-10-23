'use strict';
// equityExact 單元測試：驗證精確勝率窮舉正確性
const core = require('./game-core.js');

function card(s) { // 'As' -> {r,s}
  const r = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 }[s[0]];
  const suit = { 's':0,'h':1,'d':2,'c':3 }[s[1]];
  return { r, s: suit };
}
function cards(arr) { return arr.map(card); }

// 河牌（need=0）：直接比較，精確
// 玩家 AA vs 對手 KK，河牌已出，玩家必勝
{
  const hx = cards(['As','Ah']);
  const ax = cards(['Ks','Kh']);
  const board = cards(['2s','3h','4d','5c','9s']);
  const e = core.equityExact(hx, ax, board);
  if (!e || e.n !== 1 || e.win !== 1) throw new Error('河牌 AA vs KK 應為 1 勝: ' + JSON.stringify(e));
  console.log('✓ 河牌精確：AA vs KK =', e.win + '/' + e.n);
}

// 轉牌（need=1）：窮舉 44 張
{
  const hx = cards(['As','Ah']);
  const ax = cards(['Ks','Kh']);
  const board = cards(['2s','3h','4d','5c']);
  const e = core.equityExact(hx, ax, board);
    if (!e || e.n !== 44) throw new Error('轉牌應窮舉 44 張: ' + JSON.stringify(e));
    // board 2,3,4,5 可成順子（轉牌出 A 或 6），AA vs KK 可能平手，故驗證 win+tie=44
    if (e.win + e.tie !== 44) throw new Error('轉牌 AA vs KK 應全勝或平手: ' + JSON.stringify(e));
    console.log('✓ 轉牌精確：AA vs KK =', e.win + '/' + e.n, '(tie=' + e.tie + ')');
}

// 翻牌（need=2）：應回傳 null（退回蒙特卡羅）
{
  const hx = cards(['As','Ah']);
  const ax = cards(['Ks','Kh']);
  const board = cards(['2s','3h','4d']);
  const e = core.equityExact(hx, ax, board);
  if (e !== null) throw new Error('翻牌應回傳 null: ' + JSON.stringify(e));
  console.log('✓ 翻牌回傳 null（退回蒙特卡羅）');
}

// 翻牌前（need=5）：應回傳 null
{
  const hx = cards(['As','Ah']);
  const ax = cards(['Ks','Kh']);
  const e = core.equityExact(hx, ax, []);
  if (e !== null) throw new Error('翻牌前應回傳 null');
  console.log('✓ 翻牌前回傳 null（退回蒙特卡羅）');
}

// 平手案例：河牌雙方同牌
{
  const hx = cards(['As','Kh']);
  const ax = cards(['Ah','Ks']);
  const board = cards(['2s','3h','4d','5c','9s']);
  const e = core.equityExact(hx, ax, board);
  if (!e || e.tie !== 1) throw new Error('河牌平手應 tie=1: ' + JSON.stringify(e));
  console.log('✓ 河牌平手：tie =', e.tie);
}

console.log('✓ equityExact 全部測試通過');
