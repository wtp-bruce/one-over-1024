import express from "express";
import http from "http";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import cors from "cors";
import cookieParser from "cookie-parser";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import QRCode from "qrcode";
import {
  createGame,
  publicState,
  upsertPlayer,
  setDisconnected,
  kickPlayer,
  pruneObsoletePlayers,
  canControl,
  startGame,
  setQuestion,
  setPhysicalCard,
  setRandomQuestion,
  submitAnswer,
  requestBuddy,
  cancelBuddyRequest,
  respondBuddyRequest,
  attachOddBuddy,
  unlockBuddy,
  reveal,
  nextRound,
  resetToLobby,
} from "./game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const COOKIE_NAME = "game_user_id";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());

const game = createGame();

function getLanIPv4() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        candidates.push(net.address);
      }
    }
  }
  // Prefer common home LAN ranges
  const preferred = candidates.find(
    (ip) =>
      ip.startsWith("192.168.") ||
      ip.startsWith("10.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  );
  return preferred || candidates[0] || "127.0.0.1";
}

function getPublicBaseUrl(req) {
  const vercelUrl =
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercelUrl) {
    const host = vercelUrl.replace(/^https?:\/\//, "");
    return { host, protocol: "https", url: `https://${host}` };
  }
  const host = req?.get?.("host");
  if (host && !host.includes("localhost") && !host.startsWith("127.")) {
    const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https"
      ? "https"
      : "http";
    return { host, protocol, url: `${protocol}://${host}` };
  }
  const ip = getLanIPv4();
  return { host: `${ip}:${PORT}`, protocol: "http", url: `http://${ip}:${PORT}` };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/join-info", (req, res) => {
  const info = getPublicBaseUrl(req);
  const [ip, portPart] = info.host.includes(":")
    ? [info.host.split(":")[0], info.host.split(":")[1]]
    : [info.host, info.protocol === "https" ? "443" : String(PORT)];
  res.json({
    ip,
    port: Number(portPart) || PORT,
    url: info.url,
  });
});

app.get("/api/qr.png", async (req, res) => {
  const info = getPublicBaseUrl(req);
  const url = info.url;
  try {
    const png = await QRCode.toBuffer(url, {
      type: "png",
      width: 512,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: "qr_failed", message: String(err) });
  }
});

app.get("/api/me", (req, res) => {
  let userId = req.cookies[COOKIE_NAME];
  if (!userId) {
    userId = uuidv4();
    res.cookie(COOKIE_NAME, userId, {
      maxAge: 1000 * 60 * 60 * 24 * 365,
      httpOnly: false,
      sameSite: "lax",
    });
  }
  const player = game.players.get(userId);
  res.json({
    userId,
    username: player?.username ?? null,
  });
});

app.post("/api/me", (req, res) => {
  let userId = req.cookies[COOKIE_NAME];
  if (!userId) {
    userId = uuidv4();
    res.cookie(COOKIE_NAME, userId, {
      maxAge: 1000 * 60 * 60 * 24 * 365,
      httpOnly: false,
      sameSite: "lax",
    });
  }
  const username = String(req.body?.username || "").trim().slice(0, 24);
  if (!username) {
    return res.status(400).json({ error: "username_required" });
  }
  res.json({ userId, username });
});

const clientDist = path.join(__dirname, "../client/dist");
app.use(express.static(clientDist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/socket.io")) {
    return next();
  }
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) next();
  });
});

function broadcast() {
  for (const sock of io.sockets.sockets.values()) {
    sock.emit("state", publicState(game, sock.data.userId || null));
  }
}

io.on("connection", (socket) => {
  socket.on("join", ({ userId, username }) => {
    const id = String(userId || "").trim();
    const name = String(username || "").trim().slice(0, 24);
    if (!id || !name) {
      socket.emit("error_msg", { error: "invalid_join" });
      return;
    }
    upsertPlayer(game, { id, username: name, socketId: socket.id });
    socket.data.userId = id;
    broadcast();
  });

  socket.on("kick", ({ targetId }) => {
    const userId = socket.data.userId;
    if (!canControl(game, userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    if (targetId === userId) {
      socket.emit("error_msg", { error: "cannot_kick_self" });
      return;
    }
    const kicked = kickPlayer(game, targetId);
    if (kicked?.socketId) {
      io.to(kicked.socketId).emit("kicked");
      const sock = io.sockets.sockets.get(kicked.socketId);
      sock?.disconnect(true);
    }
    broadcast();
  });

  socket.on("start_game", () => {
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    const result = startGame(game);
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcast();
  });

  socket.on("physical_card", (payload) => {
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    const result = setPhysicalCard(game, payload || {});
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcast();
  });

  socket.on("set_question", (payload) => {
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    const text = String(payload?.text || "").trim();
    const a = String(payload?.a || "A").trim() || "A";
    const b = String(payload?.b || "B").trim() || "B";
    if (!text) {
      socket.emit("error_msg", { error: "question_required" });
      return;
    }
    const result = setQuestion(game, { text, a, b, source: "custom" });
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcast();
  });

  socket.on("random_question", () => {
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    const result = setRandomQuestion(game);
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcast();
  });

  socket.on("submit_answer", (payload) => {
    const result = submitAnswer(game, socket.data.userId, payload || {});
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcast();
  });

  socket.on("buddy_request", ({ targetId, buddyGuess }) => {
    const result = requestBuddy(
      game,
      socket.data.userId,
      targetId,
      buddyGuess
    );
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcast();
  });

  socket.on("buddy_cancel_request", () => {
    const result = cancelBuddyRequest(game, socket.data.userId);
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcast();
  });

  socket.on("buddy_respond", ({ fromId, accept }) => {
    const result = respondBuddyRequest(
      game,
      socket.data.userId,
      fromId,
      !!accept
    );
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcast();
  });

  socket.on("buddy_odd_attach", ({ targetId, buddyGuess }) => {
    const result = attachOddBuddy(
      game,
      socket.data.userId,
      targetId,
      buddyGuess
    );
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcast();
  });

  socket.on("buddy_unlock", () => {
    const result = unlockBuddy(game, socket.data.userId);
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcast();
  });

  socket.on("reveal", () => {
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    const result = reveal(game);
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcast();
  });

  socket.on("next_round", () => {
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    const result = nextRound(game);
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcast();
  });

  socket.on("back_to_lobby", () => {
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    resetToLobby(game);
    broadcast();
  });

  socket.on("new_game", () => {
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    resetToLobby(game);
    broadcast();
  });

  socket.on("disconnect", () => {
    setDisconnected(game, socket.id);
    if (game.phase === "lobby" || game.phase === "finished") {
      pruneObsoletePlayers(game);
    }
    broadcast();
  });
});

if (!process.env.VERCEL) {
  server.listen(PORT, "0.0.0.0", () => {
    const ip = getLanIPv4();
    console.log(`1/1024 server listening on http://0.0.0.0:${PORT}`);
    console.log(`LAN join URL: http://${ip}:${PORT}`);
  });
}

export default server;
