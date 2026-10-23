/**
 * game-core.js — 德州撲克共用純函式核心
 *
 * 由單人訓練模式 (duel.js) 抽出的牌局邏輯，訓練模式與多人版共用同一份，
 * 避免邏輯分叉。抽牌 / 洗牌 / 手牌評分 / 勝負判定 / 勝率估算全部在此。
 *
 * 同時支援：
 *   - Node (module.exports)
 *   - 瀏覽器 (window.PokerCore)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PokerCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SUITC = ['♠', '♥', '♦', '♣'];
  const RANKC = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']; // r=14=Ace(高) , r=2='2'(低)
  const STREETN = ['翻牌前', '翻牌', '轉牌', '河牌', '攤牌'];
  const CATN = ['高牌', '一對', '兩對', '三條', '順子', '同花', '葫蘆', '四條', '同花順'];

  function deckAll() {
    const d = [];
    for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ r, s });
    return d;
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function cardKey(c) { return c.r + '-' + c.s; }
  function cardStr(c) { return RANKC[c.r - 2] + SUITC[c.s]; }
  function cardRed(c) { return c.s === 1 || c.s === 2; }

  function unseen(hx, ax, board) {
    const used = new Set([...(hx || []), ...(ax || []), ...(board || [])].map(cardKey));
    return deckAll().filter(c => !used.has(cardKey(c)));
  }

  function drawUnseen(hx, ax, board) {
    const rem = unseen(hx, ax, board);
    return shuffle(rem)[0];
  }

  // ==================== 手牌評分 ====================
  // evaluate5: 給 5 張牌回傳 [類別, 比較子...]
  function evaluate5(cs) {
    const rs = cs.map(c => c.r).sort((a, b) => b - a);
    let flush = true;
    for (let i = 1; i < 5; i++) if (cs[i].s !== cs[0].s) { flush = false; break; }
    let straight = false, hi = 0;
    const u = [...new Set(rs)].sort((a, b) => b - a);
    if (u.length === 5) {
      if (u[0] - u[4] === 4) { straight = true; hi = u[0]; }
      else if (u[0] === 14 && u[1] === 5) { straight = true; hi = 5; } // A-2-3-4-5 輪盤（Ace 高，5 高順）
    }
    const cnt = {}; rs.forEach(r => cnt[r] = (cnt[r] || 0) + 1);
    const groups = Object.entries(cnt).map(([r, c]) => ({ r: +r, c })).sort((a, b) => b.c - a.c || b.r - a.r);
    const kicks = rs.filter(r => groups.find(g => g.r === r && g.c === 1));
    if (straight && flush) return [8, hi];
    if (groups[0].c === 4) return [7, groups[0].r, groups[1].r];
    if (groups[0].c === 3 && groups[1].c === 2) return [6, groups[0].r, groups[1].r];
    if (flush) return [5, ...rs];
    if (straight) return [4, hi];
    if (groups[0].c === 3) return [3, groups[0].r, ...kicks.slice(0, 2)];
    if (groups[0].c === 2 && groups[1].c === 2) return [2, groups[0].r, groups[1].r, kicks[0]];
    if (groups[0].c === 2) return [1, groups[0].r, kicks[0], kicks[1], kicks[2]];
    return [0, ...rs];
  }

  function cmpScores(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  function evaluate7(cs) {
    let best = null;
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++)
        for (let k = j + 1; k < cs.length; k++)
          for (let l = k + 1; l < cs.length; l++)
            for (let m = l + 1; m < cs.length; m++) {
              const sc = evaluate5([cs[i], cs[j], cs[k], cs[l], cs[m]]);
              if (!best || cmpScores(sc, best) > 0) best = sc;
            }
    return best;
  }

  function catName(sc) { return CATN[sc[0]]; }

  // ==================== 勝率（蒙特卡羅） ====================
  // estimate(hx, ax, board): 兩手牌 vs 實際勝率（含平手）
  function estimate(hx, ax, board, n) {
    const rem = unseen(hx, ax, board);
    const N = n || 1600;
    let win = 0, tie = 0;
    for (let i = 0; i < N; i++) {
      shuffle(rem);
      const need = 5 - board.length;
      const b = board.concat(rem.slice(0, need));
      const hs = evaluate7(hx.concat(b));
      const as = evaluate7(ax.concat(b));
      const d = cmpScores(hs, as);
      if (d > 0) win++; else if (d === 0) tie++;
    }
    return { win, tie, n: N };
  }

  // ==================== 對隨機手牌勝率（蒙特卡羅） ====================
  // estimateVsRandom(hand, board, nOpponents): 一手牌 vs nOpponents 個隨機手牌
  // 的勝率（含平手均分）。支援 2-4 人（nOpponents = 對手數，1-3）。
  // 只使用自己的底牌 + 公用牌，絕不暴露其他玩家底牌。
  function estimateVsRandom(hand, board, nOpponents, n) {
    const opps = Math.max(1, Math.min(3, nOpponents || 1));
    const N = n || 1200;
    const rem = unseen(hand, null, board);
    let win = 0, tie = 0;
    for (let i = 0; i < N; i++) {
      shuffle(rem);
      const need = 5 - board.length;
      const b = board.concat(rem.slice(0, need));
      const hs = evaluate7(hand.concat(b));
      // 每個對手抽 2 張隨機手牌（從剩餘牌堆）
      let lose = false, bestTie = 0;
      let di = need;
      for (let o = 0; o < opps; o++) {
        const oh = [rem[di++], rem[di++]];
        const os = evaluate7(oh.concat(b));
        const d = cmpScores(hs, os);
        if (d < 0) { lose = true; break; }
        else if (d === 0) { bestTie++; }
      }
      if (lose) continue; // 輸給任一對手
      if (bestTie === 0) win++;
      else tie += 1 / (bestTie + 1); // 平手均分
    }
    return { win, tie, n: N };
  }

  // ==================== 精確勝率（已知對手手牌） ====================
    // equityExact(hx, ax, board): 對「已知對手手牌」窮舉所有剩餘公用牌組合，
    // 得到精確勝率（含平手）。僅在剩餘組合數可接受時回傳 {win, tie, n}，
    // 否則（翻牌前/翻牌需補 2-5 張，組合數過大）回傳 null，由呼叫端退回蒙特卡羅。
    // 適用於伺服器端已知所有底牌的教學房：轉牌/河牌組合數少（≤44），
    // 精確窮舉比蒙特卡羅更快且無抽樣誤差。
    function equityExact(hx, ax, board) {
      const rem = unseen(hx, ax, board);
      const need = 5 - board.length;
      // 組合數 = C(rem.length, need)。翻牌前 need=5、翻牌 need=2 時過大，退回蒙特卡羅。
      if (need > 1) return null;
      let win = 0, tie = 0, total = 0;
      const n = rem.length;
      if (need === 0) {
        const hs = evaluate7(hx.concat(board));
        const as = evaluate7(ax.concat(board));
        const d = cmpScores(hs, as);
        if (d > 0) win++; else if (d === 0) tie++;
        total = 1;
      } else { // need === 1（轉牌）
        for (let i = 0; i < n; i++) {
          const b = board.concat(rem[i]);
          const hs = evaluate7(hx.concat(b));
          const as = evaluate7(ax.concat(b));
          const d = cmpScores(hs, as);
          if (d > 0) win++; else if (d === 0) tie++;
          total++;
        }
      }
      return { win, tie, n: total };
    }

  return {
    SUITC, RANKC, STREETN, CATN,
    deckAll, shuffle, cardKey, cardStr, cardRed,
    unseen, drawUnseen, evaluate5, evaluate7, cmpScores, catName, estimate,
    estimateVsRandom, equityExact,
  };
});
