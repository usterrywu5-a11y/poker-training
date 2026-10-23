/**
 * ai-core.js — 德州撲克共用 AI 決策純函式核心
 *
 * 由單人訓練模式 (duel.js) 抽出的 AI 決策邏輯，訓練模式與多人版共用同一份，
 * 避免邏輯分叉。AI 只使用自己的底牌 + 公用牌做蒙特卡羅勝率估算，
 * 絕不暴露其他玩家底牌（公平性）。
 *
 * 同時支援：
 *   - Node (module.exports)
 *   - 瀏覽器 (window.PokerAI)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./game-core.js'));
  } else {
    root.PokerAI = factory(root.PokerCore);
  }
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';

  // 粗估聽牌 outs：同花聽牌(4同色)、順子聽牌
  function aiOuts(hand, board) {
    const cs = hand.concat(board);
    const suits = {};
    cs.forEach(c => suits[c.s] = (suits[c.s] || 0) + 1);
    const mx = Math.max(...Object.values(suits), 0);
    let outs = 0;
    if (mx >= 4) outs = Math.max(outs, 9);
    return outs;
  }

  /**
     * aiDecide(hand, board, pot, currentBet, aiIn, aiChips, raiseCount, nOpponents, difficulty)
     *   → { action, amount }
     *
     * 純函式：給定 AI 自己的底牌與公用牌，回傳要做的行動。
     *   - action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin'
     *   - amount: bet/raise 時為「目標總下注額」（與 engine.act 的 amount 語意一致）
     *
     * 決策邏輯與訓練模式同款：蒙特卡羅對隨機手牌勝率 + 牌型強度 + 聽牌，
     * 會詐唬（反加注）也會跟注/棄牌。nOpponents = 對手數（1-3）。
     *
     * difficulty（可選第 9 參數，預設 'normal'，向後相容）：
     *   - 'beginner'：更保守——只在強成牌時下注/加注，幾乎不詐唬，跟注門檻更高。
     *   - 'normal'  ：現有行為（預設）。
     *   - 'pro'     ：更激進——詐唬/反加注更頻繁，跟注更寬鬆。
     */
    function aiDecide(hand, board, pot, currentBet, aiIn, aiChips, raiseCount, nOpponents, difficulty) {
        const diff = difficulty || 'normal';
        const sc = core.evaluate7(hand.concat(board));
        const e = core.estimateVsRandom(hand, board, nOpponents);
        const eq = (e.win + e.tie) / e.n * 100;
        const need = Math.max(0, currentBet - aiIn);
        const needPct = need > 0 ? need / (pot + need) * 100 : 0;
        const strong = !!sc && sc[0] >= 1;
        const draws = aiOuts(hand, board) >= 8;
        const maxTotal = aiIn + aiChips;

        // 依難度調整的門檻參數
        //   - openEq：開池下注所需的最低勝率（越高越保守）
        //   - callEq：跟注所需的最低勝率（越高越保守）
        //   - bluffP：詐唬/反加注機率（越低越保守）
        //   - raiseStrong：反加注所需的牌型強度門檻（sc[0] 越大越強）
        let openEq = 50, callEq = 0, bluffP = 0.5, raiseStrong = 2, raiseEq = 55;
        if (diff === 'beginner') {
          openEq = 62; callEq = 8; bluffP = 0.08; raiseStrong = 3; raiseEq = 70;
        } else if (diff === 'pro') {
          openEq = 42; callEq = -6; bluffP = 0.8; raiseStrong = 1; raiseEq = 45;
        }

        // 開池下注：本街無人下注，強牌或高勝率 → 下注約半池
        if (currentBet <= 0) {
          if (strong || eq >= openEq) {
            const bet = Math.max(20, Math.round(pot * 0.5));
            const t = Math.min(bet, maxTotal);
            if (t > 0) return { action: 'bet', amount: t };
          }
          return { action: 'check' };
        }

        // 反加注（詐唬/強牌）：強牌且還沒太多次時，依難度機率反加注
        if (raiseCount < 2 && (!!sc && (sc[0] >= raiseStrong || (sc[0] === 1 && eq >= raiseEq))) && Math.random() < bluffP) {
          let t = Math.round(currentBet * 2.2);
          if (t > maxTotal) t = maxTotal;
          if (t > currentBet) return { action: 'raise', amount: t };
        }

      const calls = eq >= needPct + callEq || strong || draws;
      if (calls) {
        if (need <= 0) return { action: 'check' };
        if (need >= aiChips) return { action: 'allin' };
        return { action: 'call' };
      }
            return { action: 'fold' };
    }

  return { aiDecide, aiOuts };
});
