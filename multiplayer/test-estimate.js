'use strict';
// 驗證 game-core.estimateVsRandom：對隨機手牌勝率，支援 2-4 人
const assert = require('assert');
const core = require('./game-core.js');

// AA vs 1 opponent 應高勝率
const aa = [{ r: 14, s: 0 }, { r: 14, s: 1 }];
const e1 = core.estimateVsRandom(aa, [], 1, 2000);
const eq1 = (e1.win + e1.tie) / e1.n * 100;
console.log('AA vs 1 opp equity:', eq1.toFixed(1) + '%');
assert.ok(eq1 > 60, 'AA vs 1 對手應 >60%，實際 ' + eq1.toFixed(1));

// AA vs 3 opponents 應更低
const e3 = core.estimateVsRandom(aa, [], 3, 2000);
const eq3 = (e3.win + e3.tie) / e3.n * 100;
console.log('AA vs 3 opp equity:', eq3.toFixed(1) + '%');
assert.ok(eq3 < eq1, '對手越多勝率越低');

// 72o vs 1 opponent 應低勝率
const seven2 = [{ r: 7, s: 0 }, { r: 2, s: 1 }];
const e72 = core.estimateVsRandom(seven2, [], 1, 2000);
const eq72 = (e72.win + e72.tie) / e72.n * 100;
console.log('72o vs 1 opp equity:', eq72.toFixed(1) + '%');
assert.ok(eq72 < 50, '72o 應 <50%，實際 ' + eq72.toFixed(1));

// 有公用牌時也能算（翻牌後）
const board = [{ r: 14, s: 2 }, { r: 5, s: 0 }, { r: 9, s: 3 }];
const eB = core.estimateVsRandom(aa, board, 2, 2000);
console.log('AA on A95 flop vs 2 opp equity:', ((eB.win + eB.tie) / eB.n * 100).toFixed(1) + '%');
assert.ok((eB.win + eB.tie) / eB.n > 0.5, '頂三條應高勝率');

console.log('\n✓ estimateVsRandom 測試通過');
