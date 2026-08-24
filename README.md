# 1/1024（家用區網版）

即時多人「讀空氣」遊戲：React 前端 + Express / Socket.IO 後端。家中同一 Wi‑Fi 即可連線，單一遊戲房。

## 快速開始

```bash
npm run install:all
npm start
```

瀏覽器開啟終端機顯示的 **LAN join URL**（例如 `http://192.168.x.x:4173`）。  
「加入 QR」分頁可讓手機掃描進房。

開發模式（前後端分開熱重載）：

```bash
npm run install:all
npm run dev
```

- 前端：`http://本機IP:5173`
- 後端：`http://本機IP:4173`（API / WebSocket）

## 規則摘要（本實作）

- 10 回合；每回合選 A/B、預測多數/少數、指定 Buddy
- **預測成功 +1**；平票則預測全部失敗（0 分）
- **Buddy 同答案 +2，不同 +1**
- 無連勝倍率
- 暱稱為 **Bruce** 時為主持（踢人、出題、開牌、下一回合）；房內無 Bruce 則任一在線玩家可主持
- 出題：手動輸入（實體卡）或伺服器隨機題庫

## Deploy

- **Home LAN:** `npm run install:all` then `npm start` → use the printed LAN URL / QR
- **Vercel:** linked to GitHub; push to `main` deploys. Public join URL comes from `/api/join-info`.

Note: realtime game state is in-memory on one Node process. Vercel Fluid + WebSockets can run it, but multiple concurrent instances may split rooms — fine for a small party game.