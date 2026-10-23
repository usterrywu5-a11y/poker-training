/**
 * server.js — 德州撲克多人版 WebSocket 伺服器
 *
 * 功能：
 *  - 好友房制：房主開房（房號）、玩家用房號加入、房主開局。
 *  - 伺服器權威：發牌/下注/翻牌/勝負全在伺服器，客戶端只收狀態快照。
 *  - 公平性：每位玩家只收到自己的底牌 + 公用牌，拿不到整副牌。
 *  - 斷線重連：session/token 綁定座位，斷線保留 60 秒，重連補發快照，超時自動棄牌。
 *
 * 用法：node server.js [port]   （預設 8080）
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const eng = require('./engine.js');

const PORT = parseInt(process.argv[2] || process.env.PORT || '8080', 10);
const KEEP_SEAT_MS = parseInt(process.env.KEEP_SEAT_MS || '60000', 10); // 斷線保留座位（預設 60 秒）
// roundEnd 後自動開下一手的倒數毫秒（可被任一玩家按「下一局」提前；玩家可照抄看牌）
const NEXT_HAND_DELAY = parseInt(process.env.NEXT_HAND_DELAY || '20000', 10); // 攤牌後下一局按鈕 + 倒數（預設 20 秒）

// ---------- 房間管理 ----------
const rooms = new Map(); // roomCode -> room

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function genToken() { return crypto.randomBytes(16).toString('hex'); }

function createRoom(owner) {
  const code = genRoomCode();
  const teaching = !!owner.teaching;
  const numAI = Math.max(1, Math.min(3, parseInt(owner.numAI, 10) || 2)); // 教學房 AI 同桌數（2-3）
  const maxPlayers = teaching ? 1 + numAI : (owner.maxPlayers || 4);
  const room = {
    code,
    game: eng.createGame({
      smallBlind: owner.smallBlind || 10,
      bigBlind: owner.bigBlind || 20,
      startStack: owner.startStack || 1000,
      maxPlayers,
      teaching,
      difficulty: owner.difficulty || 'normal', // AI 難度：beginner / normal / pro
    }),
    ownerId: null,
    seats: new Map(), // seat -> {id, name, token, ws, connected, disconnectTimer}
    started: false,
    aiFill: !!owner.aiFill,          // 人數不足由 AI 補位
    aiTakeover: owner.aiTakeover !== false, // 斷線由 AI 代打（預設開）
    aiTimers: new Map(),             // seat -> setTimeout（AI 行動延遲）
    roundEndTimer: null,              // 攤牌後下一局倒數 timer
    teaching,
    difficulty: owner.difficulty || 'normal',
    numAI,
    stats: { hands: 0, net: 0, correct: 0, total: 0 }, // 教學房累計：手數/淨籌碼/決策正確數
    handStartStack: 0,               // 每手開始時真人籌碼（算本手 +/-）
  };
  rooms.set(code, room);
  return room;
}

// ---------- 連線處理 ----------
// ---------- 靜態檔案服務（讓同一 origin 提供 HTML + WS） ----------
const fs = require('fs');
const path = require('path');
const STATIC_ROOT = path.join(__dirname, '..'); // 上層 = poker-training/

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = urlPath === '/' ? '/multiplayer.html' : urlPath;
  // 防目錄穿越
  const full = path.normalize(path.join(STATIC_ROOT, file));
  if (!full.startsWith(STATIC_ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }
}

// 廣播給房間內所有已連線玩家（各自帶自己的快照）
function broadcast(room, event) {
  for (const [seat, s] of room.seats) {
    if (!s.connected || !s.ws) continue;
    const snap = eng.snapshotFor(room.game, seat);
    if (room.teaching && room.stats) snap.stats = room.stats;
    send(s.ws, { type: 'state', ...snap, event });
  }
}

// 對單一玩家補發快照
function sendSnapshot(room, seat) {
  const s = room.seats.get(seat);
  if (!s || !s.connected || !s.ws) return;
  const snap = eng.snapshotFor(room.game, seat);
  if (room.teaching && room.stats) snap.stats = room.stats;
  send(s.ws, { type: 'state', ...snap, event: { type: 'resume' } });
}

// 若輪到 AI 座位，排程 0.5-1 秒後伺服器端跑 aiAct
function maybeRunAI(room) {
  const g = room.game;
  if (g.phase !== 'betting') return;
  const seat = g.toActSeat;
  if (seat < 0) return;
  const p = g.players[seat];
  if (!p || !p.isAI) return;
  if (room.aiTimers.has(seat)) return; // 已排程
  const delay = 500 + Math.random() * 500; // 0.5-1 秒
  const timer = setTimeout(() => {
    room.aiTimers.delete(seat);
    const g2 = room.game;
    if (g2.phase !== 'betting' || g2.toActSeat !== seat) return;
    const p2 = g2.players[seat];
    if (!p2 || !p2.isAI) return; // 真人已取回座位
    const r = eng.aiAct(g2, seat);
    if (r.ok) {
      broadcast(room, { type: 'action', events: r.events, ai: true });
      if (g2.phase === 'roundEnd') maybeNextHand(room);
      else maybeRunAI(room);
    }
  }, delay);
  room.aiTimers.set(seat, timer);
}

// 開局時補 AI 至設定人數（aiFill）
function fillAI(room) {
  const g = room.game;
  let k = 0;
  while (g.players.length < g.config.maxPlayers) {
    const n = room.teaching ? ('🎓 AI' + (k + 1)) : '🤖 AI';
    const seat = eng.addPlayer(g, { id: 'ai-' + g.players.length, name: n, isAI: true });
    room.seats.set(seat, { id: 'ai-' + seat, name: n, token: null, ws: null, connected: true, disconnectTimer: null, isAI: true });
    k++;
  }
}

// 教學房：記錄每手開始時真人籌碼，供 roundEnd 算本手 +/- 與累計淨籌碼
function finalizeHandStart(room) {
  const g = room.game;
  const human = g.players.find(p => !p.isAI);
  room.handStartStack = human ? human.stack : 0;
}

// 斷線：保留座位 60 秒，超時自動棄牌
function onDisconnect(room, seat) {
  const s = room.seats.get(seat);
  if (!s) return;
  s.connected = false;
  s.ws = null;
  const p = room.game.players[seat];
  if (p) p.connected = false;

  // 通知其他玩家
  broadcast(room, { type: 'playerDisconnected', seat });

  // 60 秒後若仍未重連 → AI 代打（若開啟）或自動棄牌
  clearTimeout(s.disconnectTimer);
  s.disconnectTimer = setTimeout(() => {
    if (s.connected) return; // 已重連
    const g = room.game;
    const p = g.players[seat];
    if (room.aiTakeover) {
      // AI 代打該座位：只切 isAI/controlledBy 旗標，玩家物件全程保留
      if (p) { p.isAI = true; p.controlledBy = 'ai'; }
      broadcast(room, { type: 'aiTakeover', seat });
      maybeRunAI(room);
    } else if (g.phase === 'betting') {
      const r = eng.forceFold(g, seat);
      if (r.ok) {
        broadcast(room, { type: 'autoFold', seat, events: r.events });
        // 若牌局結束，自動開下一手
        maybeNextHand(room);
      }
    }
  }, KEEP_SEAT_MS);
}

// 重連：token 綁定座位，補發快照
function onReconnect(room, seat, ws) {
  const s = room.seats.get(seat);
  if (!s) return false;
  clearTimeout(s.disconnectTimer);
  s.connected = true;
  s.ws = ws;
  const p = room.game.players[seat];
  if (p) {
    p.connected = true;
    // 若該座位正被 AI 代打，真人重連取回座位與剩餘籌碼
    if (p.isAI && p.controlledBy === 'ai') {
      p.isAI = false;
      p.controlledBy = null;
      broadcast(room, { type: 'aiTakeoverEnd', seat });
    }
  }
  broadcast(room, { type: 'playerReconnected', seat });
  sendSnapshot(room, seat);
  return true;
}

// 立即開下一手（按鈕按下或倒數到）——若仍有 ≥2 人
function startNextHand(room) {
  const g = room.game;
  if (g.phase !== 'roundEnd') return;
  const live = g.players.filter(p => p.stack > 0);
  if (live.length < 2) {
    broadcast(room, { type: 'gameOver', winners: g.players.filter(p => p.stack > 0).map(p => p.seat) });
    return;
  }
  clearTimeout(room.roundEndTimer);
    room.roundEndTimer = null;
    eng.startHand(room.game);
    if (room.teaching) finalizeHandStart(room);
    broadcast(room, { type: 'handStart' });
    maybeRunAI(room);
  }

  // 攤牌後：廣播倒數、開「下一局」按鈕、20 秒後自動開下一手
  function maybeNextHand(room) {
    const g = room.game;
    if (g.phase !== 'roundEnd') return;
    const live = g.players.filter(p => p.stack > 0);
    if (live.length < 2) {
      broadcast(room, { type: 'gameOver', winners: g.players.filter(p => p.stack > 0).map(p => p.seat) });
      return;
    }
    // 教學房：累計本手淨籌碼與手數
    if (room.teaching) {
      const human = g.players.find(p => !p.isAI);
      if (human) room.stats.net += human.stack - (room.handStartStack || human.stack);
      room.stats.hands++;
    }
    if (room.roundEndTimer) return; // 已在倒數，避免重複排程
    broadcast(room, { type: 'nextHandCountdown', ms: NEXT_HAND_DELAY });
    room.roundEndTimer = setTimeout(() => {
      room.roundEndTimer = null;
      startNextHand(room);
    }, NEXT_HAND_DELAY);
  }

// ---------- 訊息處理 ----------
function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return send(ws, { type: 'error', message: '訊息格式錯誤' }); }

  switch (msg.type) {
    case 'createRoom': {
      const room = createRoom(msg);
      const token = genToken();
      const seat = eng.addPlayer(room.game, { id: token, name: msg.name || '房主', isOwner: true });
      room.ownerId = token;
      room.seats.set(seat, { id: token, name: msg.name || '房主', token, ws, connected: true, disconnectTimer: null });
      ws.roomCode = room.code;
      ws.seat = seat;
      send(ws, { type: 'joined', roomCode: room.code, seat, token, isOwner: true });
      sendSnapshot(room, seat);
      break;
    }
    case 'joinRoom': {
      const room = rooms.get(String(msg.roomCode || '').toUpperCase());
      if (!room) return send(ws, { type: 'error', message: '找不到此房號' });
      if (room.teaching) return send(ws, { type: 'error', message: '教學房為單人練習，無法加入' });
      if (room.started) return send(ws, { type: 'error', message: '牌局已開始，無法加入' });
      if (room.seats.size >= room.game.config.maxPlayers) return send(ws, { type: 'error', message: '座位已滿' });
      const token = genToken();
      const seat = eng.addPlayer(room.game, { id: token, name: msg.name || '玩家' });
      room.seats.set(seat, { id: token, name: msg.name || '玩家', token, ws, connected: true, disconnectTimer: null });
      ws.roomCode = room.code;
      ws.seat = seat;
      send(ws, { type: 'joined', roomCode: room.code, seat, token, isOwner: false });
      broadcast(room, { type: 'playerJoined', seat, name: msg.name || '玩家' });
      sendSnapshot(room, seat);
      break;
    }
    case 'resume': {
      // 重連：用 token 找回座位
      const token = String(msg.token || '');
      for (const [code, room] of rooms) {
        for (const [seat, s] of room.seats) {
          if (s.token === token) {
            ws.roomCode = code;
            ws.seat = seat;
            onReconnect(room, seat, ws);
            return;
          }
        }
      }
      send(ws, { type: 'error', message: '無效的連線憑證' });
      break;
    }
    case 'start': {
      const room = rooms.get(ws.roomCode);
      if (!room) return send(ws, { type: 'error', message: '不在房間內' });
      const s = room.seats.get(ws.seat);
      if (!s || s.id !== room.ownerId) return send(ws, { type: 'error', message: '只有房主能開局' });
      if (room.game.players.length < 1) return send(ws, { type: 'error', message: '至少需要 1 名玩家' });
      // 人數不足由 AI 補位：補至設定人數（教學房一律補 AI 同桌）
            if (room.aiFill || room.teaching) fillAI(room);
      if (room.game.players.length < 2) return send(ws, { type: 'error', message: '至少需要 2 名玩家' });
            room.started = true;
            if (room.teaching) room.stats = { hands: 0, net: 0, correct: 0, total: 0 };
            eng.startGame(room.game);
            if (room.teaching) finalizeHandStart(room);
            broadcast(room, { type: 'gameStart' });
            maybeRunAI(room);
            break;
    }
    case 'act': {
      const room = rooms.get(ws.roomCode);
      if (!room) return send(ws, { type: 'error', message: '不在房間內' });
      const seat = ws.seat;
      const r = eng.act(room.game, seat, msg.action, msg.amount);
      if (!r.ok) return send(ws, { type: 'error', message: r.error });
      // 教學房：真人決策點累計正確率
      if (room.teaching && r.verdict) {
        room.stats.total++;
        if (r.verdict.verdict === '+EV') room.stats.correct++;
      }
      broadcast(room, { type: 'action', events: r.events, verdict: r.verdict || null });
      if (room.game.phase === 'roundEnd') maybeNextHand(room);
      else maybeRunAI(room);
      break;
    }
    case 'leave': {
      const room = rooms.get(ws.roomCode);
      if (room) {
        const seat = ws.seat;
        const s = room.seats.get(seat);
        if (s) {
          clearTimeout(s.disconnectTimer);
          room.seats.delete(seat);
          try { eng.removePlayer(room.game, s.id); } catch (e) { /* 進行中不可離席 */ }
          broadcast(room, { type: 'playerLeft', seat });
        }
      }
      ws.close();
      break;
    }
    case 'nextHand': {
      // 玩家按下「下一局 ▶」：立即推進，清除倒數
      const room = rooms.get(ws.roomCode);
      if (!room) return send(ws, { type: 'error', message: '不在房間內' });
      startNextHand(room);
      break;
    }
    default:
      send(ws, { type: 'error', message: '未知指令' });
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => handleMessage(ws, data.toString()));
  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (room && ws.seat !== undefined) {
      onDisconnect(room, ws.seat);
    }
  });
  ws.on('error', () => { /* ignore */ });
});

server.listen(PORT, () => {
  console.log(`德州撲克多人版伺服器已啟動 ws://0.0.0.0:${PORT}`);
});
