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
  leavePlayer,
  canControl,
  isHostOnline,
  reconcilePhases,
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
  // Help reconnecting clients recover faster after brief drops
  pingInterval: 10000,
  pingTimeout: 20000,
});

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());

/** @type {Map<string, ReturnType<typeof createGame>>} */
const rooms = new Map();

function normalizeRoomCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

function getOrCreateRoom(roomCode, creatorId) {
  let game = rooms.get(roomCode);
  if (!game) {
    game = createGame(roomCode, creatorId);
    rooms.set(roomCode, game);
  }
  return game;
}

function destroyRoomIfEmpty(roomCode) {
  const game = rooms.get(roomCode);
  if (!game) return;
  if (game.players.size === 0) {
    rooms.delete(roomCode);
  }
}

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
    const protocol =
      req.protocol === "https" || req.get("x-forwarded-proto") === "https"
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
  const room = normalizeRoomCode(req.query.room);
  const [ip, portPart] = info.host.includes(":")
    ? [info.host.split(":")[0], info.host.split(":")[1]]
    : [info.host, info.protocol === "https" ? "443" : String(PORT)];
  const url = room ? `${info.url}?room=${encodeURIComponent(room)}` : info.url;
  res.json({
    ip,
    port: Number(portPart) || PORT,
    url,
    roomCode: room || null,
  });
});

app.get("/api/qr.png", async (req, res) => {
  const info = getPublicBaseUrl(req);
  const room = normalizeRoomCode(req.query.room);
  const url = room ? `${info.url}?room=${encodeURIComponent(room)}` : info.url;
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
  res.json({
    userId,
    username: null,
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
  const roomCode = normalizeRoomCode(req.body?.roomCode);
  if (!roomCode) {
    return res.status(400).json({ error: "room_required" });
  }
  res.json({ userId, username, roomCode });
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

function broadcastRoom(roomCode) {
  const game = rooms.get(roomCode);
  if (!game) return;
  for (const sock of io.sockets.sockets.values()) {
    if (sock.data.roomCode === roomCode) {
      sock.emit("state", publicState(game, sock.data.userId || null));
    }
  }
}

function detachSocketFromRoom(socket, { removePlayer = false } = {}) {
  const roomCode = socket.data.roomCode;
  const userId = socket.data.userId;
  if (!roomCode) return null;
  const game = rooms.get(roomCode);
  socket.leave(roomCode);
  socket.data.roomCode = null;
  if (!game) return null;

  if (removePlayer && userId) {
    leavePlayer(game, userId);
    destroyRoomIfEmpty(roomCode);
    if (rooms.has(roomCode)) broadcastRoom(roomCode);
  }
  return { game, roomCode, userId };
}

function requireRoom(socket) {
  const roomCode = socket.data.roomCode;
  const game = roomCode ? rooms.get(roomCode) : null;
  if (!game || !socket.data.userId) {
    socket.emit("error_msg", { error: "not_in_room" });
    return null;
  }
  return { game, roomCode };
}

function requireHostOnline(socket, game) {
  if (!isHostOnline(game)) {
    socket.emit("error_msg", { error: "host_offline" });
    return false;
  }
  return true;
}

io.on("connection", (socket) => {
  socket.on("join", ({ userId, username, roomCode }) => {
    const id = String(userId || "").trim();
    const name = String(username || "").trim().slice(0, 24);
    const code = normalizeRoomCode(roomCode);
    if (!id || !name) {
      socket.emit("error_msg", { error: "invalid_join" });
      return;
    }
    if (!code) {
      socket.emit("error_msg", { error: "room_required" });
      return;
    }

    // Moving rooms / refreshing: leave previous room roster if needed
    if (socket.data.roomCode && socket.data.roomCode !== code) {
      detachSocketFromRoom(socket, { removePlayer: true });
    } else if (socket.data.roomCode === code && socket.data.userId === id) {
      // Same room reconnect path — just refresh membership below
    }

    const game = getOrCreateRoom(code, id);
    upsertPlayer(game, { id, username: name, socketId: socket.id });
    reconcilePhases(game);
    socket.data.userId = id;
    socket.data.roomCode = code;
    socket.join(code);
    socket.emit("state", publicState(game, id));
    broadcastRoom(code);
  });

  socket.on("leave_room", () => {
    const roomCode = socket.data.roomCode;
    detachSocketFromRoom(socket, { removePlayer: true });
    socket.emit("left_room");
    if (roomCode && rooms.has(roomCode)) {
      broadcastRoom(roomCode);
    }
  });

  socket.on("kick", ({ targetId }) => {
    const ctx = requireRoom(socket);
    if (!ctx) return;
    const { game, roomCode } = ctx;
    if (!requireHostOnline(socket, game)) return;
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    if (targetId === socket.data.userId) {
      socket.emit("error_msg", { error: "cannot_kick_self" });
      return;
    }
    const kicked = kickPlayer(game, targetId);
    if (kicked?.socketId) {
      io.to(kicked.socketId).emit("kicked");
      const sock = io.sockets.sockets.get(kicked.socketId);
      if (sock) {
        sock.data.roomCode = null;
        sock.leave(roomCode);
        sock.disconnect(true);
      }
    }
    destroyRoomIfEmpty(roomCode);
    if (rooms.has(roomCode)) broadcastRoom(roomCode);
  });

  socket.on("start_game", () => {
    const ctx = requireRoom(socket);
    if (!ctx) return;
    const { game, roomCode } = ctx;
    if (!requireHostOnline(socket, game)) return;
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    const result = startGame(game);
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcastRoom(roomCode);
  });

  socket.on("physical_card", (payload) => {
    const ctx = requireRoom(socket);
    if (!ctx) return;
    const { game, roomCode } = ctx;
    if (!requireHostOnline(socket, game)) return;
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    const result = setPhysicalCard(game, payload || {});
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcastRoom(roomCode);
  });

  socket.on("set_question", (payload) => {
    const ctx = requireRoom(socket);
    if (!ctx) return;
    const { game, roomCode } = ctx;
    if (!requireHostOnline(socket, game)) return;
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
    broadcastRoom(roomCode);
  });

  socket.on("random_question", () => {
    const ctx = requireRoom(socket);
    if (!ctx) return;
    const { game, roomCode } = ctx;
    if (!requireHostOnline(socket, game)) return;
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    const result = setRandomQuestion(game);
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcastRoom(roomCode);
  });

  socket.on("submit_answer", (payload) => {
    const ctx = requireRoom(socket);
    if (!ctx) return;
    const { game, roomCode } = ctx;
    if (!requireHostOnline(socket, game)) return;
    const result = submitAnswer(game, socket.data.userId, payload || {});
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcastRoom(roomCode);
  });

  socket.on("buddy_request", ({ targetId, buddyGuess }) => {
    const ctx = requireRoom(socket);
    if (!ctx) return;
    const { game, roomCode } = ctx;
    if (!requireHostOnline(socket, game)) return;
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
    broadcastRoom(roomCode);
  });

  socket.on("buddy_cancel_request", () => {
    const ctx = requireRoom(socket);
    if (!ctx) return;
    const { game, roomCode } = ctx;
    if (!requireHostOnline(socket, game)) return;
    const result = cancelBuddyRequest(game, socket.data.userId);
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcastRoom(roomCode);
  });

  socket.on("buddy_respond", ({ fromId, accept }) => {
    const ctx = requireRoom(socket);
    if (!ctx) return;
    const { game, roomCode } = ctx;
    if (!requireHostOnline(socket, game)) return;
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
    broadcastRoom(roomCode);
  });

  socket.on("buddy_odd_attach", ({ targetId, buddyGuess }) => {
    const ctx = requireRoom(socket);
    if (!ctx) return;
    const { game, roomCode } = ctx;
    if (!requireHostOnline(socket, game)) return;
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
    broadcastRoom(roomCode);
  });

  socket.on("buddy_unlock", () => {
    const ctx = requireRoom(socket);
    if (!ctx) return;
    const { game, roomCode } = ctx;
    if (!requireHostOnline(socket, game)) return;
    const result = unlockBuddy(game, socket.data.userId);
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcastRoom(roomCode);
  });

  socket.on("reveal", () => {
    const ctx = requireRoom(socket);
    if (!ctx) return;
    const { game, roomCode } = ctx;
    if (!requireHostOnline(socket, game)) return;
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    const result = reveal(game);
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcastRoom(roomCode);
  });

  socket.on("next_round", () => {
    const ctx = requireRoom(socket);
    if (!ctx) return;
    const { game, roomCode } = ctx;
    if (!requireHostOnline(socket, game)) return;
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    const result = nextRound(game);
    if (!result.ok) {
      socket.emit("error_msg", result);
      return;
    }
    broadcastRoom(roomCode);
  });

  socket.on("back_to_lobby", () => {
    const ctx = requireRoom(socket);
    if (!ctx) return;
    const { game, roomCode } = ctx;
    if (!requireHostOnline(socket, game)) return;
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    resetToLobby(game);
    broadcastRoom(roomCode);
  });

  socket.on("new_game", () => {
    const ctx = requireRoom(socket);
    if (!ctx) return;
    const { game, roomCode } = ctx;
    if (!requireHostOnline(socket, game)) return;
    if (!canControl(game, socket.data.userId)) {
      socket.emit("error_msg", { error: "not_controller" });
      return;
    }
    resetToLobby(game);
    broadcastRoom(roomCode);
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const game = rooms.get(roomCode);
    if (!game) return;
    // Only mark offline — do not remove from room (reconnect can resume)
    setDisconnected(game, socket.id);
    broadcastRoom(roomCode);
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
