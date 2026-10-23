/**
 * engine.js — 德州撲克多人牌局狀態機（純函式，無 I/O）
 *
 * 由伺服器驅動、供多人版與無頭/訓練皆可共用同一核心，避免邏輯分叉。
 * - 所有牌（整副）只存在於 engine 狀態內，由伺服器端持有。
 * - 洗牌用注入的 shuffle/rng，讓測試可決定性重現。
 * - act() 回傳 events 由伺服器廣播，行動只在 currentPlayer 身上合法。
 */
'use strict';

const core = require('./game-core.js');
const ai = require('./ai-core.js');

const STREETS = ['翻牌前', '翻牌', '轉牌', '河牌'];

// ---------- 可注入 shuffle ----------
function defaultShuffle(a) { return core.shuffle(a); }
function seededRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function seededShuffle(seed) {
  const rand = seededRng(seed);
  return function (a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };
}

// ---------- 建立牌局 ----------
function createGame(cfg) {
  const config = Object.assign({
    smallBlind: 10, bigBlind: 20, startStack: 1000, maxPlayers: 4,
  }, cfg);
  const g = {
    config, phase: 'waiting', deck: [], board: [],
    players: [], dealerSeat: -1, smallBlindSeat: -1, bigBlindSeat: -1,
    startSeat: -1, lastAggressorSeat: -1,
    currentBet: 0, minRaise: 0, pot: 0, street: 0,
        toActSeat: -1, winners: [], round: 1, sidePots: [],
        handLog: [], // 教學實戰版：單一真人玩家的逐決策點檢討紀錄（每手重置）
        _shuffle: defaultShuffle,
  };
  g._bindShuffle = (fn) => { g._shuffle = fn || defaultShuffle; return g; };
  return g;
}

// ---------- 玩家 / 座位 ----------
function seatOf(game, pid) { return game.players.findIndex(p => p.id === pid); }

function addPlayer(game, p) {
  if (game.phase !== 'waiting') throw new Error('牌局已開始，無法加入');
  if (game.players.length >= game.config.maxPlayers) throw new Error('座位已滿');
  const seat = game.players.length;
    game.players.push({
      seat, id: p.id, name: p.name || ('玩家' + (seat + 1)),
      stack: game.config.startStack, hole: [], folded: false, allin: false,
      betThisStreet: 0, betTotal: 0, connected: true, disconnectedAt: null, isOwner: !!p.isOwner,
      isAI: !!p.isAI, controlledBy: p.controlledBy || null, raiseCount: 0,
    });
    return seat;
}

function removePlayer(game, pid) {
  if (game.phase !== 'waiting') return false;
  const idx = seatOf(game, pid);
  if (idx < 0) return false;
  game.players.splice(idx, 1);
  game.players.forEach((pl, i) => { pl.seat = i; });
  return true;
}

// ---------- 開局 ----------
function _after(seat, n) { return (seat + 1) % n; }
function activePlayers(game) { return game.players.filter(p => !p.folded); }

// 自 fromSeat 之「下一位」起，找出下一個「未蓋、未全下、有籌碼」的玩家座位
function nextActionable(game, fromSeat) {
  let s = fromSeat;
  for (let k = 0; k < game.players.length; k++) {
    s = (s + 1) % game.players.length;
    const p = game.players[s];
    if (!p.folded && !p.allin && p.stack > 0) return s;
  }
  return -1;
}

// 本街最後一位可行動者（無加注時）：從 startSeat 往前找第一個「未蓋、未全下、有籌碼」者
function lastActionable(game) {
  const N = game.players.length;
  let s = game.startSeat;
  for (let k = 0; k < N; k++) {
    s = (s - 1 + N) % N;
    const p = game.players[s];
    if (!p.folded && !p.allin && p.stack > 0) return s;
  }
  return -1;
}

function startGame(game) {
  if (game.phase !== 'waiting') throw new Error('狀態錯誤');
  if (game.players.length < 2) throw new Error('至少需要 2 名玩家');
  if (game.dealerSeat < 0) game.dealerSeat = game.players.length - 1;
  game.phase = 'betting';
  return startHand(game);
}

function startHand(game) {
  game.dealerSeat = _after(game.dealerSeat, game.players.length);
  game.street = 0; game.board = []; game.pot = 0; game.winners = []; game.sidePots = [];
  game.handLog = []; // 每手重置教學檢討紀錄
  for (const p of game.players) {
      p.folded = false; p.allin = (p.stack <= 0); p.hole = [];
      p.betThisStreet = 0; p.betTotal = 0; p.raiseCount = 0;
    }
  const active = game.players.filter(p => !p.allin);
  if (active.length < 2) { game.phase = 'roundEnd'; return []; }

  game.deck = game._shuffle(core.deckAll().slice());
  let di = 0;
  for (const p of game.players) { if (!p.allin) p.hole = [game.deck[di++], game.deck[di++]]; }

  const N = game.players.length;
  // 找下一個有籌碼者當 SB/BB（跳過全下玩家）
  // 2 人（heads-up）：SB = dealer，BB = 另一人
  // 3+ 人：SB = dealer 下一位，BB = 再下一位
  let sb = -1, bb = -1;
  if (N === 2) {
    sb = game.dealerSeat;
    bb = _after(game.dealerSeat, N);
  } else {
    let s = game.dealerSeat;
    for (let k = 0; k < N; k++) {
      s = _after(s, N);
      if (game.players[s] && !game.players[s].allin) { if (sb < 0) sb = s; else if (bb < 0) { bb = s; break; } }
    }
  }
  game.smallBlindSeat = sb;
  game.bigBlindSeat = bb;

  postBlind(game, sb, game.config.smallBlind);
  postBlind(game, bb, game.config.bigBlind);

  game.currentBet = game.config.bigBlind;
  game.minRaise = game.config.bigBlind;
  game.startSeat = nextActionable(game, game.bigBlindSeat);
  game.lastAggressorSeat = -1;
  game.toActSeat = game.startSeat;
  game.phase = 'betting';
  return [{ type: 'handStart', street: 0 }];
}

function postBlind(game, seat, amount) {
  const p = game.players[seat];
  if (!p || p.allin) return;
  const amt = Math.min(amount, p.stack);
  p.stack -= amt; p.betThisStreet += amt; p.betTotal += amt; game.pot += amt;
  if (p.stack === 0) p.allin = true;
}

// ---------- 行動 ----------
// 教學實戰版：為單一真人玩家在每個決策點記錄檢討資料。
// eqPercent 用「對目前未蓋牌對手逐一手牌做蒙特卡羅估算後取平均」，
// 因為伺服器端持有所有底牌，比 estimateVsRandom 更貼近真實勝率；
// 若無未蓋牌對手（理論上不會發生）則退回 estimateVsRandom。
function recordHandLog(game, seat, action, amount) {
  const p = game.players[seat];
  if (!p || p.isAI) return null; // 只記錄真人玩家
  const need = Math.max(0, game.currentBet - p.betThisStreet);
  const needPercent = need > 0 ? need / (game.pot + need) * 100 : 0;

  // 對每個未蓋牌對手估算勝率後取平均
  const opps = game.players.filter(x => !x.folded && x.seat !== seat && x.hole.length === 2);
  let eqPercent = 0;
  if (opps.length > 0) {
    let sum = 0;
    for (const o of opps) {
      const e = core.estimate(p.hole, o.hole, game.board);
      sum += (e.win + e.tie) / e.n * 100;
    }
    eqPercent = sum / opps.length;
  } else {
    const e = core.estimateVsRandom(p.hole, game.board, 1);
    eqPercent = (e.win + e.tie) / e.n * 100;
  }

  // 判定 +EV / -EV：跟注/過牌用「勝率 ≥ 底池賠率」；
  // 下注/加注屬主動進攻，需勝率明顯高於底池賠率（+15%）才算 +EV。
  const isAggressive = action === 'bet' || action === 'raise' || action === 'allin';
  const margin = isAggressive ? 15 : 0;
  const verdict = eqPercent >= needPercent + margin ? '+EV' : '-EV';

  // 中文教學建議
  let advice;
  if (action === 'fold') {
    advice = verdict === '+EV' ? '牌力尚可，棄牌略保守，可考慮跟注' : '勝率不足，棄牌合理';
  } else if (action === 'check') {
    advice = verdict === '+EV' ? '過牌合理，保留底池' : '勝率偏低，過牌觀望即可';
  } else if (action === 'call') {
    advice = verdict === '+EV' ? '這注跟得划算（+EV）' : '勝率不足，傾向棄牌';
  } else if (action === 'allin') {
    advice = verdict === '+EV' ? '全下勝率充足，強勢推進' : '全下過於激進，勝率不足';
  } else { // bet / raise
    advice = verdict === '+EV' ? '牌強位置好，可加注' : '下注/加注略激進，勝率不足';
  }

  game.handLog.push({
      street: game.street, seat, action,
      amount: (action === 'call' || action === 'bet' || action === 'raise' || action === 'allin') ? (amount || 0) : 0,
      currentBet: game.currentBet, betThisStreet: p.betThisStreet, pot: game.pot, need,
      eqPercent: Math.round(eqPercent * 10) / 10,
      needPercent: Math.round(needPercent * 10) / 10,
      verdict, advice,
    });
    return game.handLog[game.handLog.length - 1];
  }

  function act(game, seat, action, amount) {
    if (game.phase !== 'betting') return { ok: false, error: '現在不是下注階段' };
    const p = game.players[seat];
    if (!p || p.folded || p.allin) return { ok: false, error: '你無法行動' };
    if (seat !== game.toActSeat) return { ok: false, error: '還沒輪到你' };

    // 教學實戰版：真人玩家行動前記錄決策點（AI 由 aiAct 走同一 act()，但 isAI 會被跳過）
    const logEntry = recordHandLog(game, seat, action, amount);

        const evs = [];
      switch (action) {
    case 'fold': { p.folded = true; evs.push({ type: 'fold', seat }); break; }
    case 'check': {
      if (p.betThisStreet < game.currentBet) return { ok: false, error: '需跟注，不能過牌' };
      evs.push({ type: 'check', seat });
      break;
    }
    case 'call': {
      const need = game.currentBet - p.betThisStreet;
      const amt = Math.min(need, p.stack);
      p.stack -= amt; p.betThisStreet += amt; p.betTotal += amt; game.pot += amt;
      if (p.stack === 0) p.allin = true;
      evs.push({ type: 'call', seat, amount: amt, allin: p.allin });
      break;
    }
    case 'bet': {
          // 開池下注：只有當本街無人下注（currentBet = 0）時合法
          if (game.currentBet > 0) return { ok: false, error: '已有下注，請用加注' };
          const t = Math.round(amount);
          if (!(t > 0) || !isFinite(t)) return { ok: false, error: '下注金額無效' };
          const minBet = game.minRaise; // 本街最小下注 = 大盲
          const maxTotal = p.betThisStreet + p.stack;
          if (t < minBet && t < maxTotal) return { ok: false, error: '未達最低下注' };
          const trg = Math.min(Math.max(t, minBet), maxTotal);
          const amt = trg - p.betThisStreet;
          if (amt <= 0) return { ok: false, error: '下注金額低於最低下注' };
          p.stack -= amt; p.betThisStreet = trg; p.betTotal += amt; game.pot += amt;
          if (p.stack === 0) p.allin = true;
          game.currentBet = trg;
          game.minRaise = Math.max(game.minRaise, amt);
          game.lastAggressorSeat = seat;
          p.raiseCount++;
          evs.push({ type: 'bet', seat, to: trg, amount: amt, allin: p.allin });
      break;
    }
    case 'raise': {
      const t = Math.round(amount);
      const minTotal = game.currentBet + game.minRaise;
      const maxTotal = p.betThisStreet + p.stack;
      if (t <= 0 || (t < minTotal && t < maxTotal)) return { ok: false, error: '未達最小加注' };
      const trg = Math.min(Math.max(t, minTotal), maxTotal);
      const amt = trg - p.betThisStreet;
      if (amt <= 0) return { ok: false, error: '加注金額無效' };
      p.stack -= amt; p.betThisStreet = trg; p.betTotal += amt; game.pot += amt;
      if (p.stack === 0) p.allin = true;
      const raiseSize = trg - game.currentBet;
      game.currentBet = trg;
      game.minRaise = Math.max(game.minRaise, raiseSize);
      game.lastAggressorSeat = seat;
      p.raiseCount++;
      evs.push({ type: 'raise', seat, to: trg, amount: amt, allin: p.allin });
      break;
    }
    case 'allin': {
      const amt = p.stack;
      p.stack = 0; p.betThisStreet += amt; p.betTotal += amt; game.pot += amt; p.allin = true;
      const newTotal = p.betThisStreet;
      if (newTotal > game.currentBet) {
        game.minRaise = Math.max(game.minRaise, newTotal - game.currentBet);
        game.currentBet = newTotal;
        game.lastAggressorSeat = seat;
        p.raiseCount++;
      }
      evs.push({ type: 'allin', seat, amount: amt, to: newTotal });
      break;
    }
    default: return { ok: false, error: '未知行動' };
      }

      const res = settle(game, evs);
      if (logEntry) res.verdict = logEntry;
      if (!res.done && res.next >= 0) game.toActSeat = res.next;
      return { ok: true, events: evs, ...res };
    }

// 下注回合收斂判斷；回傳 {done} 或 {done, next}
function settle(game, evs) {
  const live = activePlayers(game);

  // 只剩一人未蓋 → 收池
  if (live.length === 1) {
    const w = live[0];
    w.stack += game.pot;
    game.winners = [{ seat: w.seat, amount: game.pot }];
    game.phase = 'roundEnd';
    evs.push({ type: 'win', seats: [w.seat], amount: game.pot, byFold: true });
    return { done: true };
  }

  // 是否有人欠注（未全下且有籌碼但投入少於 currentBet）
  const owesAny = game.players.some(p => !p.folded && !p.allin && p.stack > 0 && p.betThisStreet < game.currentBet);
  if (owesAny) {
    // 若目前玩家自己就欠注 → 停留；否則輪下一欠注者
    const cur = game.players[game.toActSeat];
    if (cur && !cur.folded && !cur.allin && cur.stack > 0 && cur.betThisStreet < game.currentBet) {
      return { done: false, next: game.toActSeat };
    }
    // 找下一個欠注者
    let s = game.toActSeat;
    for (let k = 0; k < game.players.length; k++) {
      s = (s + 1) % game.players.length;
      const pl = game.players[s];
      if (!pl.folded && !pl.allin && pl.stack > 0 && pl.betThisStreet < game.currentBet) return { done: false, next: s };
    }
    // 理論上不該到這：all 都全下
    return intakeAllIn(game, evs);
  }

  // 無人欠注。若所有未蓋者皆全下/無籌碼 → 直接攤牌
  if (live.every(p => p.allin || p.stack === 0)) {
    return intakeAllIn(game, evs);
  }

  // 無人欠注。判斷是否該收斂：
        // anchor = 最後加注者（若有）否則 startSeat。
        //  - 有加注者：加注者是最後行動者，繞回 anchor（cand===anchor）即收斂。
        //  - 無加注者：startSeat 最先行動，繞回 startSeat（cand===anchor）即收斂。
        //  - 若 anchor 已蓋/全下（不可行動）：cand 永遠不等於 anchor，改為「剛行動完者
        //    就是本街最後一位可行動者」即收斂。
        const anchor = game.lastAggressorSeat >= 0 ? game.lastAggressorSeat : game.startSeat;
        const cand = nextActionable(game, game.toActSeat);
        // 若最後加注者已全下（無法再行動），則無人欠注即收斂
        const anchorAllin = game.lastAggressorSeat >= 0 && game.players[game.lastAggressorSeat].allin;
        const anchorActionable = game.players[anchor] && !game.players[anchor].folded && !game.players[anchor].allin && game.players[anchor].stack > 0;
        if (cand === -1 || anchorAllin) {
          return intakeStreet(game, evs);
        }
        if (anchorActionable) {
          // 繞回 anchor → 一輪結束
          if (cand === anchor) return intakeStreet(game, evs);
        } else {
          // anchor 已蓋/全下：最後一位可行動者行動完 → 收斂
          if (game.toActSeat === lastActionable(game)) return intakeStreet(game, evs);
        }
        return { done: false, next: cand };
  }

// 全下到底：直接跑完攤牌
function intakeAllIn(game, evs) {
  while (game.board.length < 5) game.board.push(game.deck.pop());
  return runShowdown(game, evs);
}

function intakeStreet(game, evs) {
  game.lastAggressorSeat = -1;
  if (game.street < 3) {
    game.street++;
    game.deck.pop(); // burn
    const n = game.street === 1 ? 3 : 1;
    for (let i = 0; i < n; i++) game.board.push(game.deck.pop());
    for (const p of game.players) p.betThisStreet = 0;
    game.currentBet = 0;
    game.minRaise = game.config.bigBlind;
    game.startSeat = nextActionable(game, game.dealerSeat);
    game.toActSeat = game.startSeat;
    evs.push({ type: 'street', street: game.street, board: game.board.slice() });
    return { done: true };
  }
  // river 結束 → 攤牌
  return runShowdown(game, evs);
}

function runShowdown(game, evs) {
  while (game.board.length < 5) game.board.push(game.deck.pop());
  game.phase = 'showdown';
  const table = game.board;
  game.sidePots = buildSidePots(game);
  const totals = {};
  for (const pot of game.sidePots) {
    const contenders = pot.players.map(s => game.players[s]);
    let best = null, bestSeats = [];
    for (const pl of contenders) {
      const sc = core.evaluate7([...pl.hole, ...table]);
      if (!best || core.cmpScores(sc, best.score) > 0) { best = { score: sc, seat: pl.seat }; bestSeats = [pl.seat]; }
      else if (core.cmpScores(sc, best.score) === 0) { bestSeats.push(pl.seat); }
    }
    const share = Math.floor(pot.amount / bestSeats.length);
    for (const s of bestSeats) totals[s] = (totals[s] || 0) + share;
    totals[bestSeats[0]] += pot.amount % bestSeats.length;
  }
  const winners = [];
  for (const s in totals) { game.players[+s].stack += totals[s]; winners.push({ seat: +s, amount: totals[s] }); }
  game.winners = winners;
  game.phase = 'roundEnd';
  evs.push({ type: 'showdown', winners: winners.map(w => w.amount), board: game.board.slice() });
  return { done: true };
}

function buildSidePots(game) {
  const levels = [...new Set(game.players.map(p => p.betTotal))].filter(v => v > 0).sort((a, b) => a - b);
  let prev = 0;
  const pots = [];
  for (const lv of levels) {
    const amt = game.players.reduce((acc, p) => acc + Math.max(0, Math.min(p.betTotal, lv) - prev), 0);
    prev = lv;
    const eligible = game.players.filter(p => !p.folded && p.betTotal >= lv).map(p => p.seat);
    if (amt > 0 && eligible.length > 0) pots.push({ amount: amt, players: eligible });
  }
  return pots;
}

// 斷線超時自動棄牌：無論是否輪到該玩家，直接蓋牌並收斂
function forceFold(game, seat) {
  const p = game.players[seat];
  if (!p || p.folded || p.allin || game.phase !== 'betting') return { ok: false, error: '無法棄牌' };
  p.folded = true;
  const evs = [{ type: 'fold', seat, auto: true }];
  const res = settle(game, evs);
  if (!res.done && res.next >= 0) game.toActSeat = res.next;
  return { ok: true, events: evs, ...res };
}

// ---------- AI 行動（伺服器端同步跑 aiDecide → 走同一條 act()） ----------
function aiAct(game, seat) {
  const p = game.players[seat];
  if (!p || p.folded || p.allin || game.phase !== 'betting') return { ok: false, error: 'AI 無法行動' };
  if (seat !== game.toActSeat) return { ok: false, error: '還沒輪到 AI' };
  const nOpponents = game.players.filter(x => !x.folded && x.seat !== seat).length;
    const d = ai.aiDecide(p.hole, game.board, game.pot, game.currentBet, p.betThisStreet, p.stack, p.raiseCount || 0, nOpponents, game.config.difficulty || 'normal');
  let r = act(game, seat, d.action, d.amount);
  if (!r.ok) {
    // 回退：能 check 就 check，否則 call，否則 fold
    const need = game.currentBet - p.betThisStreet;
    if (need <= 0) r = act(game, seat, 'check');
    else if (need <= p.stack) r = act(game, seat, 'call');
    else r = act(game, seat, 'fold');
  }
  return r;
}

// ---------- 快照（只含該玩家底牌 + 公用牌，不含整副） ----------
function snapshotFor(game, seat) {
  const atEnd = game.phase === 'showdown' || game.phase === 'roundEnd';
  return {
    type: 'state', phase: game.phase, street: game.street,
    board: game.board.map(c => core.cardStr(c)),
    pot: game.pot, currentBet: game.currentBet, bigBlind: game.config.bigBlind,
    toActSeat: game.phase === 'betting' ? game.toActSeat : -1,
    dealerSeat: game.dealerSeat, smallBlindSeat: game.smallBlindSeat, bigBlindSeat: game.bigBlindSeat,
    winners: game.winners, sidePots: game.sidePots || [], round: game.round,
    players: game.players.map(p => {
      const isSelf = seat >= 0 && p.seat === seat;
            // 攤牌/結束時，未蓋牌者手牌公開，並附牌型名稱，方便展示比較
            // 教學實戰版：結束時翻開所有 AI 牌（含蓋牌），供玩家檢討
            const reveal = atEnd && p.hole.length === 2 && (game.config.teaching ? !!p.isAI : !p.folded);
      return {
        seat: p.seat, name: p.name, stack: p.stack, bet: p.betThisStreet, betTotal: p.betTotal,
                folded: p.folded, allin: p.allin, connected: p.connected, isOwner: p.isOwner, isAI: p.isAI,
        holeCount: isSelf ? p.hole.length : (p.folded ? 0 : 2),
        revealed: reveal,
        hole: (isSelf || reveal ? p.hole : []).map(c => core.cardStr(c)),
        handName: reveal ? (() => { const sc = core.evaluate7([...p.hole, ...game.board]); return sc ? core.catName(sc) : null; })() : null,
      };
    }),
    mySeat: seat,
        // 教學實戰版：唯讀快照欄位，供伺服器在 roundEnd 時把真人玩家的決策檢討帶給客戶端
                teaching: !!game.config.teaching,
                difficulty: game.config.difficulty || 'normal',
                handLog: game.handLog || [],
      };
}

module.exports = {
  createGame, addPlayer, removePlayer, seatOf, startGame, act, snapshotFor,
  startHand, buildSidePots, activePlayers, nextActionable, seededShuffle, STREETS, forceFold, aiAct,
};