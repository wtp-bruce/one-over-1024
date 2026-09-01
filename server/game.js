import { pickRandomQuestion } from "./questions.js";

const TOTAL_ROUNDS = 10;
const PREDICTION_POINTS = 2;
const BUDDY_SAME = 2;
const BUDDY_DIFF = 1;

function emptyBuddy() {
  return {
    pairs: [], // [[a,b], ...] mutual exclusive pairs
    requests: {}, // fromId -> { toId, buddyGuess }
    oddBuddy: null, // { playerId, targetId, buddyGuess? }
  };
}

export function createGame(roomCode, creatorId) {
  return {
    roomCode: roomCode || null,
    creatorId: creatorId || null,
    // lobby | answering | buddy | revealed | finished
    phase: "lobby",
    round: 0,
    question: null,
    usedQuestions: [],
    players: new Map(),
    // id -> { answer, prediction, buddyId?, buddyGuess?, buddyKind? }
    submissions: new Map(),
    buddy: emptyBuddy(),
    roundHistory: [],
    lastReveal: null,
  };
}

function connectedPlayers(game) {
  return [...game.players.values()].filter((p) => p.connected);
}

/** Everyone still in the room (online or offline) — used so reconnecting players are not skipped. */
function rosterPlayers(game) {
  return [...game.players.values()];
}

function allAnswerReady(game) {
  const roster = rosterPlayers(game);
  if (roster.length === 0) return false;
  return roster.every((p) => {
    const s = game.submissions.get(p.id);
    return s && (s.answer === "A" || s.answer === "B") && s.prediction;
  });
}

function clearGuess(game, userId) {
  const sub = game.submissions.get(userId);
  if (sub) {
    game.submissions.set(userId, {
      ...sub,
      buddyGuess: undefined,
      buddyId: undefined,
      buddyKind: undefined,
    });
  }
}

function setBuddyLink(game, userId, buddyId, buddyKind) {
  const sub = game.submissions.get(userId) || {};
  game.submissions.set(userId, {
    ...sub,
    buddyId,
    buddyKind,
    buddyGuess: undefined,
  });
}

function partnerOf(game, userId) {
  for (const [a, b] of game.buddy.pairs) {
    if (a === userId) return b;
    if (b === userId) return a;
  }
  return null;
}

function isInPair(game, userId) {
  return partnerOf(game, userId) != null;
}

function isOddAttached(game, userId) {
  return game.buddy.oddBuddy?.playerId === userId;
}

function isFree(game, userId) {
  return !isInPair(game, userId) && !isOddAttached(game, userId);
}

function clearRequestsInvolving(game, userId) {
  const next = { ...game.buddy.requests };
  delete next[userId];
  for (const [from, req] of Object.entries(next)) {
    if (req.toId === userId) delete next[from];
  }
  game.buddy.requests = next;
}

function dissolvePairContaining(game, userId) {
  const partner = partnerOf(game, userId);
  if (!partner) return;
  game.buddy.pairs = game.buddy.pairs.filter(
    ([a, b]) => a !== userId && b !== userId
  );
  clearGuess(game, userId);
  clearGuess(game, partner);
  // Odd attachment targeting either member becomes invalid
  if (
    game.buddy.oddBuddy &&
    (game.buddy.oddBuddy.targetId === userId ||
      game.buddy.oddBuddy.targetId === partner ||
      game.buddy.oddBuddy.playerId === userId ||
      game.buddy.oddBuddy.playerId === partner)
  ) {
    const oddId = game.buddy.oddBuddy.playerId;
    game.buddy.oddBuddy = null;
    clearGuess(game, oddId);
  }
}

function syncBuddyLinks(game) {
  for (const p of game.players.values()) {
    const sub = game.submissions.get(p.id);
    if (!sub) continue;
    const partner = partnerOf(game, p.id);
    if (partner) {
      game.submissions.set(p.id, {
        ...sub,
        buddyId: partner,
        buddyKind: "pair",
        buddyGuess: sub.buddyGuess,
      });
      continue;
    }
    if (game.buddy.oddBuddy?.playerId === p.id) {
      game.submissions.set(p.id, {
        ...sub,
        buddyId: game.buddy.oddBuddy.targetId,
        buddyKind: "odd",
        buddyGuess: sub.buddyGuess,
      });
      continue;
    }
    game.submissions.set(p.id, {
      ...sub,
      buddyId: undefined,
      buddyKind: undefined,
      buddyGuess: undefined,
    });
  }
}

function freeConnectedIds(game) {
  return connectedPlayers(game)
    .map((p) => p.id)
    .filter((id) => isFree(game, id));
}

function canOddAttachNow(game) {
  const n = connectedPlayers(game).length;
  if (n % 2 === 0) return false;
  const free = freeConnectedIds(game);
  return free.length === 1 && game.buddy.pairs.length === Math.floor(n / 2);
}

function allBuddyReady(game) {
  const roster = rosterPlayers(game);
  if (roster.length === 0) return false;
  return roster.every((p) => {
    const s = game.submissions.get(p.id);
    return (
      s &&
      s.buddyId &&
      (s.buddyGuess === "same" || s.buddyGuess === "different")
    );
  });
}

function buddyPublic(game) {
  const incoming = {};
  const incomingDetails = {};
  const outgoing = {};
  for (const [from, req] of Object.entries(game.buddy.requests)) {
    if (!incoming[req.toId]) incoming[req.toId] = [];
    incoming[req.toId].push(from);
    if (!incomingDetails[req.toId]) incomingDetails[req.toId] = [];
    incomingDetails[req.toId].push({
      fromId: from,
      buddyGuess: req.buddyGuess,
    });
    outgoing[from] = req;
  }
  return {
    pairs: game.buddy.pairs,
    requests: game.buddy.requests,
    incoming,
    incomingDetails,
    outgoing,
    oddBuddy: game.buddy.oddBuddy,
    freeIds: freeConnectedIds(game),
    canOddAttach: canOddAttachNow(game),
    playerCount: connectedPlayers(game).length,
  };
}

export function publicState(game, viewerId = null) {
  const players = [...game.players.values()].map((p) => ({
    id: p.id,
    username: p.username,
    score: p.score,
    connected: p.connected,
    answerHistory: p.answerHistory,
  }));

  const submissions = {};
  for (const [id, sub] of game.submissions) {
    const answerReady = !!(sub.answer && sub.prediction);
    const buddyReady = !!(sub.buddyId && sub.buddyGuess);
    const entry = {
      answerReady,
      buddyReady,
      ready: game.phase === "answering" ? answerReady : buddyReady,
      buddyId: sub.buddyId || null,
      buddyKind: sub.buddyKind || null,
      buddyGuess: sub.buddyGuess || null,
    };

    if (game.phase === "buddy" || game.phase === "revealed" || game.phase === "finished") {
      entry.prediction = sub.prediction;
    }
    if (game.phase === "revealed" || game.phase === "finished") {
      entry.answer = sub.answer;
    }
    // Only the viewer sees their own locked A/B (and prediction while still answering)
    if (viewerId && id === viewerId && answerReady) {
      entry.answer = sub.answer;
      entry.prediction = sub.prediction;
    }
    submissions[id] = entry;
  }

  const hostId = getHostId(game);
  return {
    phase: game.phase,
    round: game.round,
    totalRounds: TOTAL_ROUNDS,
    question: game.question,
    players,
    roomCode: game.roomCode,
    hostId,
    controllerId: hostId,
    hostOnline: isHostOnline(game),
    submissions,
    buddy: buddyPublic(game),
    lastReveal: game.lastReveal,
    roundHistory: game.roundHistory,
    similarity: computeSimilarity(players),
    soulmates: findSoulmates(players, TOTAL_ROUNDS),
  };
}

function isBruce(username) {
  return String(username || "").trim().toLowerCase() === "bruce";
}

/** Bruce in the room always hosts; otherwise the room creator (first joiner). */
export function getHostId(game) {
  const bruce = [...game.players.values()].find((p) => isBruce(p.username));
  if (bruce) return bruce.id;
  if (game.creatorId && game.players.has(game.creatorId)) {
    return game.creatorId;
  }
  const sorted = [...game.players.values()].sort(
    (a, b) => (a.joinedAt || 0) - (b.joinedAt || 0)
  );
  return sorted[0]?.id ?? null;
}

export function getControllerId(game) {
  return getHostId(game);
}

export function isHostOnline(game) {
  const hostId = getHostId(game);
  if (!hostId) return false;
  const host = game.players.get(hostId);
  return !!(host && host.connected);
}

export function canControl(game, userId) {
  return !!userId && getHostId(game) === userId && isHostOnline(game);
}

export function upsertPlayer(game, { id, username, socketId }) {
  const existing = game.players.get(id);
  if (existing) {
    existing.username = username;
    existing.connected = true;
    existing.socketId = socketId;
    return existing;
  }
  if (!game.creatorId) {
    game.creatorId = id;
  }
  const player = {
    id,
    username,
    socketId,
    connected: true,
    joinedAt: Date.now(),
    score: 0,
    answerHistory: [],
  };
  game.players.set(id, player);
  return player;
}

export function setDisconnected(game, socketId) {
  for (const p of game.players.values()) {
    // Ignore stale disconnects after the player already reconnected on a new socket
    if (p.socketId === socketId) {
      p.connected = false;
      p.socketId = null;
      return p;
    }
  }
  return null;
}

export function kickPlayer(game, targetId) {
  const p = game.players.get(targetId);
  if (!p) return null;
  if (game.phase === "buddy") {
    unlockBuddy(game, targetId);
  }
  clearRequestsInvolving(game, targetId);
  game.players.delete(targetId);
  game.submissions.delete(targetId);
  reassignCreatorIfNeeded(game, targetId);
  return p;
}

/** Player leaves the room voluntarily (same cleanup as kick). */
export function leavePlayer(game, userId) {
  return kickPlayer(game, userId);
}

function reassignCreatorIfNeeded(game, leftId) {
  if (game.creatorId !== leftId) return;
  const sorted = [...game.players.values()].sort(
    (a, b) => (a.joinedAt || 0) - (b.joinedAt || 0)
  );
  game.creatorId = sorted[0]?.id ?? null;
}

/** After reconnect / host returns, finish any phase that was waiting on the full roster. */
export function reconcilePhases(game) {
  if (!isHostOnline(game)) return;
  if (game.phase === "answering" && game.question && allAnswerReady(game)) {
    game.phase = "buddy";
    game.buddy = emptyBuddy();
  }
}

/** Drop offline leftovers from earlier sessions so they don't linger into a new game. */
export function pruneObsoletePlayers(game) {
  const removed = [];
  for (const [id, p] of [...game.players.entries()]) {
    if (p.connected) continue;
    if (game.phase === "buddy") {
      unlockBuddy(game, id);
    }
    clearRequestsInvolving(game, id);
    game.players.delete(id);
    game.submissions.delete(id);
    removed.push(id);
  }
  return removed;
}

export function startGame(game) {
  pruneObsoletePlayers(game);

  if (connectedPlayers(game).length < 2) {
    return { ok: false, error: "need_two_players" };
  }
  game.phase = "answering";
  game.round = 1;
  game.question = null;
  game.usedQuestions = [];
  game.submissions.clear();
  game.buddy = emptyBuddy();
  game.roundHistory = [];
  game.lastReveal = null;
  for (const p of game.players.values()) {
    p.score = 0;
    p.answerHistory = [];
  }
  return { ok: true };
}

export function setQuestion(game, question) {
  if (game.phase !== "answering") {
    return { ok: false, error: "wrong_phase" };
  }
  game.question = {
    text: question.text,
    a: question.a,
    b: question.b,
    source: question.source || "custom",
  };
  if (question.source !== "physical") {
    game.usedQuestions.push(question.text);
  }
  game.submissions.clear();
  game.buddy = emptyBuddy();
  return { ok: true };
}

export function setPhysicalCard(game, payload = {}) {
  const text = String(payload.text || "").trim();
  const a = String(payload.a || "").trim();
  const b = String(payload.b || "").trim();
  return setQuestion(game, {
    text: text || "physical",
    a: a || "A",
    b: b || "B",
    source: "physical",
  });
}

export function setRandomQuestion(game) {
  const q = pickRandomQuestion(game.usedQuestions);
  return setQuestion(game, { ...q, source: "bank" });
}

export function submitAnswer(game, userId, payload) {
  if (game.phase !== "answering" || !game.question) {
    return { ok: false, error: "wrong_phase" };
  }
  if (!game.players.has(userId)) {
    return { ok: false, error: "not_in_game" };
  }
  const { answer, prediction } = payload;
  if (answer !== "A" && answer !== "B") {
    return { ok: false, error: "bad_answer" };
  }
  if (prediction !== "majority" && prediction !== "minority") {
    return { ok: false, error: "bad_prediction" };
  }
  const prev = game.submissions.get(userId) || {};
  game.submissions.set(userId, {
    ...prev,
    answer,
    prediction,
    buddyId: undefined,
    buddyGuess: undefined,
    buddyKind: undefined,
  });

  if (isHostOnline(game) && allAnswerReady(game)) {
    game.phase = "buddy";
    game.buddy = emptyBuddy();
  }
  return { ok: true };
}

/** A requests B — inviter must lock same/different with the invite */
export function requestBuddy(game, fromId, toId, buddyGuess) {
  if (game.phase !== "buddy") return { ok: false, error: "wrong_phase" };
  if (!fromId || !toId || fromId === toId) return { ok: false, error: "bad_buddy" };
  if (!game.players.has(fromId) || !game.players.has(toId)) {
    return { ok: false, error: "bad_buddy" };
  }
  if (buddyGuess !== "same" && buddyGuess !== "different") {
    return { ok: false, error: "bad_buddy_guess" };
  }
  if (!isFree(game, fromId) || !isFree(game, toId)) {
    return { ok: false, error: "not_free" };
  }
  if (canOddAttachNow(game)) {
    return { ok: false, error: "use_odd_attach" };
  }
  const next = { ...game.buddy.requests };
  delete next[fromId];
  next[fromId] = { toId, buddyGuess };
  game.buddy.requests = next;
  return { ok: true };
}

export function cancelBuddyRequest(game, fromId) {
  if (game.phase !== "buddy") return { ok: false, error: "wrong_phase" };
  const next = { ...game.buddy.requests };
  delete next[fromId];
  game.buddy.requests = next;
  return { ok: true };
}

export function respondBuddyRequest(game, userId, fromId, accept) {
  if (game.phase !== "buddy") return { ok: false, error: "wrong_phase" };
  const req = game.buddy.requests[fromId];
  if (!req || req.toId !== userId) {
    return { ok: false, error: "no_request" };
  }
  if (!accept) {
    cancelBuddyRequest(game, fromId);
    return { ok: true };
  }
  if (req.buddyGuess !== "same" && req.buddyGuess !== "different") {
    return { ok: false, error: "bad_buddy_guess" };
  }
  if (!isFree(game, userId) || !isFree(game, fromId)) {
    return { ok: false, error: "not_free" };
  }
  game.buddy.pairs.push([fromId, userId]);
  clearRequestsInvolving(game, fromId);
  clearRequestsInvolving(game, userId);

  // Both share the inviter's same/different lock (symmetric relation)
  const sharedGuess = req.buddyGuess;
  const fromSub = game.submissions.get(fromId) || {};
  const toSub = game.submissions.get(userId) || {};
  game.submissions.set(fromId, {
    ...fromSub,
    buddyId: userId,
    buddyKind: "pair",
    buddyGuess: sharedGuess,
  });
  game.submissions.set(userId, {
    ...toSub,
    buddyId: fromId,
    buddyKind: "pair",
    buddyGuess: sharedGuess,
  });
  return { ok: true };
}

/** Odd leftover attaches to someone already in a pair */
export function attachOddBuddy(game, playerId, targetId, buddyGuess) {
  if (game.phase !== "buddy") return { ok: false, error: "wrong_phase" };
  if (!canOddAttachNow(game)) return { ok: false, error: "odd_not_ready" };
  if (playerId !== freeConnectedIds(game)[0]) {
    return { ok: false, error: "not_leftover" };
  }
  if (!isInPair(game, targetId)) {
    return { ok: false, error: "target_not_paired" };
  }
  if (buddyGuess !== "same" && buddyGuess !== "different") {
    return { ok: false, error: "bad_buddy_guess" };
  }
  game.buddy.oddBuddy = { playerId, targetId, buddyGuess };
  clearRequestsInvolving(game, playerId);
  const sub = game.submissions.get(playerId) || {};
  game.submissions.set(playerId, {
    ...sub,
    buddyId: targetId,
    buddyKind: "odd",
    buddyGuess,
  });
  return { ok: true };
}

export function unlockBuddy(game, userId) {
  if (game.phase !== "buddy") return { ok: false, error: "wrong_phase" };
  if (!game.players.has(userId)) return { ok: false, error: "not_in_game" };

  if (isOddAttached(game, userId)) {
    game.buddy.oddBuddy = null;
    clearGuess(game, userId);
    clearRequestsInvolving(game, userId);
    return { ok: true };
  }

  if (isInPair(game, userId)) {
    dissolvePairContaining(game, userId);
    clearRequestsInvolving(game, userId);
    syncBuddyLinks(game);
    return { ok: true };
  }

  // Cancel pending outgoing request
  cancelBuddyRequest(game, userId);
  return { ok: true };
}

export function reveal(game) {
  if (game.phase !== "buddy" || !game.question) {
    return { ok: false, error: "wrong_phase" };
  }
  syncBuddyLinks(game);
  const roster = rosterPlayers(game);
  if (!allBuddyReady(game)) {
    return { ok: false, error: "not_all_ready" };
  }

  const counts = { A: 0, B: 0 };
  for (const p of roster) {
    counts[game.submissions.get(p.id).answer]++;
  }

  const tied = counts.A === counts.B;
  const majoritySide = tied ? null : counts.A > counts.B ? "A" : "B";

  const results = {};
  for (const p of roster) {
    const sub = game.submissions.get(p.id);
    const isMajority = !tied && sub.answer === majoritySide;
    const isMinority = !tied && sub.answer !== majoritySide;

    let predictionOk = false;
    if (!tied) {
      predictionOk =
        (sub.prediction === "majority" && isMajority) ||
        (sub.prediction === "minority" && isMinority);
    }

    const buddySub = game.submissions.get(sub.buddyId);
    const buddySame = buddySub ? buddySub.answer === sub.answer : false;
    const guessOk =
      buddySub &&
      ((sub.buddyGuess === "same" && buddySame) ||
        (sub.buddyGuess === "different" && !buddySame));

    let buddyPoints = 0;
    if (guessOk) {
      buddyPoints = sub.buddyGuess === "same" ? BUDDY_SAME : BUDDY_DIFF;
    }

    const predictionPoints = predictionOk ? PREDICTION_POINTS : 0;
    const gained = predictionPoints + buddyPoints;

    p.score += gained;
    p.answerHistory.push(sub.answer);

    results[p.id] = {
      answer: sub.answer,
      prediction: sub.prediction,
      buddyId: sub.buddyId,
      buddyKind: sub.buddyKind,
      buddyGuess: sub.buddyGuess,
      predictionOk,
      buddySame,
      buddyGuessOk: !!guessOk,
      predictionPoints,
      buddyPoints,
      oddBuddyBonus: 0,
      oddBuddyFromId: null,
      oddBuddyGuess: null,
      oddBuddyGuessOk: false,
      gained,
      score: p.score,
    };
  }

  // Odd leftover attaches to someone already paired: that target also scores
  // once more vs the leftover, using the leftover's locked same/different guess.
  const odd = game.buddy.oddBuddy;
  if (odd?.playerId && odd?.targetId) {
    const leftoverSub = game.submissions.get(odd.playerId);
    const targetSub = game.submissions.get(odd.targetId);
    const targetResult = results[odd.targetId];
    if (leftoverSub && targetSub && targetResult) {
      const same = leftoverSub.answer === targetSub.answer;
      const guess = odd.buddyGuess || leftoverSub.buddyGuess;
      const guessOk =
        (guess === "same" && same) || (guess === "different" && !same);
      let bonus = 0;
      if (guessOk) {
        bonus = guess === "same" ? BUDDY_SAME : BUDDY_DIFF;
      }
      targetResult.oddBuddyBonus = bonus;
      targetResult.oddBuddyFromId = odd.playerId;
      targetResult.oddBuddyGuess = guess;
      targetResult.oddBuddyGuessOk = !!guessOk;
      targetResult.gained += bonus;
      const targetPlayer = game.players.get(odd.targetId);
      if (targetPlayer) {
        targetPlayer.score += bonus;
        targetResult.score = targetPlayer.score;
      }
    }
  }

  for (const p of game.players.values()) {
    if (!results[p.id]) {
      p.answerHistory.push(null);
    }
  }

  game.lastReveal = {
    round: game.round,
    question: game.question,
    counts,
    tied,
    majoritySide,
    results,
    pairs: game.buddy.pairs,
    oddBuddy: game.buddy.oddBuddy,
  };
  game.roundHistory.push(game.lastReveal);
  game.phase = "revealed";
  return { ok: true };
}

export function nextRound(game) {
  if (game.phase !== "revealed") {
    return { ok: false, error: "wrong_phase" };
  }
  if (game.round >= TOTAL_ROUNDS) {
    game.phase = "finished";
    game.question = null;
    game.submissions.clear();
    game.buddy = emptyBuddy();
    return { ok: true, finished: true };
  }
  game.round += 1;
  game.phase = "answering";
  game.question = null;
  game.submissions.clear();
  game.buddy = emptyBuddy();
  game.lastReveal = null;
  return { ok: true, finished: false };
}

export function resetToLobby(game) {
  pruneObsoletePlayers(game);
  game.phase = "lobby";
  game.round = 0;
  game.question = null;
  game.usedQuestions = [];
  game.submissions.clear();
  game.buddy = emptyBuddy();
  game.roundHistory = [];
  game.lastReveal = null;
  for (const p of game.players.values()) {
    p.score = 0;
    p.answerHistory = [];
  }
}

function computeSimilarity(players) {
  const matrix = {};
  for (const a of players) {
    matrix[a.id] = {};
    for (const b of players) {
      if (a.id === b.id) {
        matrix[a.id][b.id] = 100;
        continue;
      }
      let same = 0;
      let total = 0;
      const len = Math.min(a.answerHistory.length, b.answerHistory.length);
      for (let i = 0; i < len; i++) {
        const av = a.answerHistory[i];
        const bv = b.answerHistory[i];
        if (av == null || bv == null) continue;
        total += 1;
        if (av === bv) same += 1;
      }
      matrix[a.id][b.id] = total === 0 ? null : Math.round((same / total) * 100);
    }
  }
  return matrix;
}

function findSoulmates(players, totalRounds) {
  if (players.some((p) => p.answerHistory.filter((x) => x != null).length < totalRounds)) {
    return [];
  }
  const pairs = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      const len = Math.min(a.answerHistory.length, b.answerHistory.length);
      if (len < totalRounds) continue;
      let allSame = true;
      for (let r = 0; r < totalRounds; r++) {
        if (
          a.answerHistory[r] == null ||
          b.answerHistory[r] == null ||
          a.answerHistory[r] !== b.answerHistory[r]
        ) {
          allSame = false;
          break;
        }
      }
      if (allSame) {
        pairs.push([a.id, b.id]);
      }
    }
  }
  return pairs;
}
