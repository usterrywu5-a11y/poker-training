# 德州撲克多人版 · 伺服器核心

2-4 人即時對戰的德州撲克伺服器核心（WebSocket + 牌局狀態機）。
與單人訓練模式共用同一份純函式牌局核心（`game-core.js`），避免邏輯分叉。

## 架構

```
multiplayer/
├── game-core.js        共用純函式核心（抽牌/洗牌/手牌評分/勝率估算）
│                       由單人訓練模式 duel.js 抽出，訓練與多人共用同一份
├── engine.js           牌局狀態機（發牌→翻牌→轉牌→河牌→攤牌、下注、側池、勝負）
│                       純函式、無 I/O，可被無頭/訓練/多人共用
├── server.js           WebSocket 伺服器（好友房、房號加入、廣播、斷線重連）
├── multiplayer.html    多人版客戶端（純渲染，只收自己的底牌+公用牌）
├── test-engine.js      engine 單元測試
├── test-integration.js 整合測試（3 人完成一局 + 斷線重連）
└── test-disconnect.js  斷線超時自動棄牌測試
```

## 啟動

```bash
cd multiplayer
npm install          # 安裝 ws
npm start            # 預設 port 8080
# 或指定 port
node server.js 9000
```

啟動後瀏覽器開 `http://<host>:<port>/` 即進入多人版大廳。
房主「建立房間」→ 把 4 位房號告訴朋友 → 朋友「加入房間」→ 房主「開始遊戲」。

## 測試

```bash
npm test
```

涵蓋：
- 完整牌局流程（發底牌→翻牌→轉牌→河牌→攤牌）由伺服器推進並廣播
- 下注回合收斂（跟注/過牌/加注回補/全下）
- 側池與平分
- 公平性：每位玩家只收到自己的底牌 + 公用牌，拿不到整副牌
- 斷線保留座位 60 秒、重連補發快照、超時自動棄牌

## 部署注意

- 目前正式站 `34.121.69.27` 是 Apache/Debian 靜態伺服器，**不支援 WebSocket 後端**。
- 多人版需另開 Node 進程（`node server.js`），並在 Apache 用反向代理把
  `/` 與 `/ws` 轉到 Node port（或直接以 Node 提供靜態檔，本 server 已內建靜態服務）。
- 需確認該主機可開 Node 進程與對外 port，或另開後端環境。

## 協定（簡）

客戶端 → 伺服器：
- `createRoom {name, maxPlayers, startStack, smallBlind, bigBlind}`
- `joinRoom {roomCode, name}`
- `resume {token}`（斷線重連）
- `start`（房主開局）
- `act {action: fold|check|call|raise|allin, amount?}`

伺服器 → 客戶端：
- `joined {roomCode, seat, token, isOwner}`
- `state {...}`（每位玩家各自的快照，只含自己底牌 + 公用牌）
- `error {message}`
