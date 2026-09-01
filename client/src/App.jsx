import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import { QRCodeSVG } from "qrcode.react";
import { t } from "./i18n";

const USER_COOKIE = "game_user_id";
const THEME_KEY = "game_theme";
const ROOM_KEY = "game_room_code";

function readRoomFromUrl() {
  try {
    const q = new URLSearchParams(window.location.search).get("room");
    return q ? String(q).trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) : "";
  } catch {
    return "";
  }
}

function normalizeRoomInput(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}
const THEMES = [
  {
    id: "karaoke",
    nameKey: "themeKaraoke",
    descKey: "themeKaraokeDesc",
    swatches: ["#0a0e24", "#ff2d6a", "#ffe566"],
  },
  {
    id: "arcade",
    nameKey: "themeArcade",
    descKey: "themeArcadeDesc",
    swatches: ["#050508", "#00e5ff", "#ff3d9a"],
  },
  {
    id: "sunset",
    nameKey: "themeSunset",
    descKey: "themeSunsetDesc",
    swatches: ["#1c0a14", "#ff6b35", "#ffc857"],
  },
  {
    id: "matcha",
    nameKey: "themeMatcha",
    descKey: "themeMatchaDesc",
    swatches: ["#14160f", "#c8f542", "#ff8a3d"],
  },
  {
    id: "daylight",
    nameKey: "themeDaylight",
    descKey: "themeDaylightDesc",
    swatches: ["#f6f0e4", "#e11d48", "#0f766e"],
  },
  {
    id: "ocean",
    nameKey: "themeOcean",
    descKey: "themeOceanDesc",
    swatches: ["#031520", "#22d3ee", "#fbbf24"],
  },
];

function applyTheme(themeId) {
  document.documentElement.setAttribute("data-theme", themeId);
}

function getCookie(name) {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function setCookie(name, value) {
  document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${60 * 60 * 24 * 365};SameSite=Lax`;
}

function createUserId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      /* non-secure context (e.g. LAN http://192.168.x.x) */
    }
  }
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureUserId() {
  let id = getCookie(USER_COOKIE);
  if (!id) {
    id = createUserId();
    setCookie(USER_COOKIE, id);
  }
  return id;
}

export default function App() {
  const [lang, setLang] = useState(() => localStorage.getItem("lang") || "zh");
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem(THEME_KEY);
    return THEMES.some((t) => t.id === saved) ? saved : "karaoke";
  });
  const [userId] = useState(() => ensureUserId());
  const [username, setUsername] = useState(() => localStorage.getItem("username") || "");
  const [roomCode, setRoomCode] = useState(() => {
    return readRoomFromUrl() || localStorage.getItem(ROOM_KEY) || "";
  });
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [kicked, setKicked] = useState(false);
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("play");
  const [joinInfo, setJoinInfo] = useState(null);
  const [socket, setSocket] = useState(null);

  const tr = (key, vars) => t(lang, key, vars);
  const formatError = (code) => {
    const mapped = tr(`error_${code}`);
    if (mapped && mapped !== `error_${code}`) return mapped;
    return code || tr("error");
  };

  useEffect(() => {
    localStorage.setItem("lang", lang);
  }, [lang]);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    const fromUrl = readRoomFromUrl();
    if (fromUrl) setRoomCode(fromUrl);
  }, []);

  useEffect(() => {
    const code = normalizeRoomInput(roomCode);
    const q = code ? `?room=${encodeURIComponent(code)}` : "";
    fetch(`/api/join-info${q}`)
      .then((r) => r.json())
      .then(setJoinInfo)
      .catch(() => {});
  }, [joined, roomCode]);

  useEffect(() => {
    if (!joined || !username || !roomCode) return;
    const code = normalizeRoomInput(roomCode);
    const s = io({
      withCredentials: true,
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
    });
    setSocket(s);

    const emitJoin = () => {
      s.emit("join", { userId, username, roomCode: code });
    };

    s.on("connect", emitJoin);
    s.on("reconnect", emitJoin);
    s.on("state", (next) => {
      setState(next);
      setError("");
    });
    s.on("error_msg", (payload) => {
      setError(formatError(payload?.error || "error"));
    });
    s.on("kicked", () => {
      setKicked(true);
      setJoined(false);
      setState(null);
    });
    s.on("left_room", () => {
      setJoined(false);
      setState(null);
      setTab("play");
    });

    return () => {
      s.removeAllListeners();
      s.disconnect();
      setSocket(null);
    };
  }, [joined, userId, username, roomCode]);

  const me = useMemo(
    () => state?.players?.find((p) => p.id === userId),
    [state, userId]
  );
  const isController = state?.controllerId === userId || state?.hostId === userId;
  const hostOnline = state?.hostOnline !== false;
  const hostPaused = Boolean(joined && state && !hostOnline && !isController);

  async function handleJoin(e) {
    e.preventDefault();
    const name = username.trim();
    const code = normalizeRoomInput(roomCode);
    if (!name || !code) return;
    setJoining(true);
    setKicked(false);
    setError("");
    try {
      const res = await fetch("/api/me", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name, roomCode: code }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(formatError(body.error || "invalid_join"));
        return;
      }
      localStorage.setItem("username", name);
      localStorage.setItem(ROOM_KEY, code);
      setUsername(name);
      setRoomCode(code);
      const url = new URL(window.location.href);
      url.searchParams.set("room", code);
      window.history.replaceState({}, "", url);
      setJoined(true);
    } finally {
      setJoining(false);
    }
  }

  function handleLeaveRoom() {
    socket?.emit("leave_room");
    setJoined(false);
    setState(null);
    setTab("play");
  }

  if (kicked) {
    return (
      <div className="app gate">
        <div className="gate-inner panel">
          <div className="brand">{tr("brand")}</div>
          <p>{tr("kicked")}</p>
          <button type="button" onClick={() => setKicked(false)}>
            {tr("reconnect")}
          </button>
        </div>
      </div>
    );
  }

  if (!joined) {
    return (
      <div className="app gate">
        <div className="gate-inner panel">
          <div className="brand">{tr("brand")}</div>
          <p className="tagline">{tr("tagline")}</p>
          <form className="gateform" onSubmit={handleJoin}>
            <label>
              <span className="muted">{tr("enterName")}</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={tr("username")}
                maxLength={24}
                autoFocus
              />
            </label>
            <label>
              <span className="muted">{tr("roomCode")}</span>
              <input
                value={roomCode}
                onChange={(e) => setRoomCode(normalizeRoomInput(e.target.value))}
                placeholder={tr("roomCodePlaceholder")}
                maxLength={8}
                autoCapitalize="characters"
                inputMode="text"
              />
              <span className="meta">{tr("roomCodeHint")}</span>
            </label>
            {error ? <div className="error-toast">{tr("error")}: {error}</div> : null}
            <button
              type="submit"
              disabled={!username.trim() || !normalizeRoomInput(roomCode) || joining}
            >
              {joining ? tr("joining") : tr("join")}
            </button>
          </form>
          <div className="row" style={{ marginTop: "1rem", justifyContent: "center" }}>
            <button type="button" className="ghost" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
              {tr("lang")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <div className="brand">{tr("brand")}</div>
          <p className="tagline">
            {me ? `${tr("you")}: ${me.username}` : tr("tagline")}
            {state?.roomCode ? (
              <span className="badge">{tr("roomLabel", { code: state.roomCode })}</span>
            ) : null}
            {isController ? <span className="badge">{tr("controller")}</span> : null}
            {!hostOnline ? <span className="badge badge-warn">{tr("hostOffline")}</span> : null}
          </p>
        </div>
        <div className="row">
          <button type="button" className="ghost" onClick={handleLeaveRoom}>
            {tr("leaveRoom")}
          </button>
          <button type="button" className="ghost" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
            {tr("lang")}
          </button>
        </div>
      </header>

      {hostPaused ? (
        <div className="host-pause panel">
          <h2 className="section-title">{tr("hostOfflineTitle")}</h2>
          <p className="muted">{tr("hostOfflineHint")}</p>
          <div style={{ marginTop: "1rem" }}>
            <PlayerList
              tr={tr}
              state={state}
              userId={userId}
              isController={false}
              socket={socket}
              showKick={false}
            />
          </div>
          <button type="button" style={{ marginTop: "1rem" }} onClick={handleLeaveRoom}>
            {tr("leaveRoom")}
          </button>
        </div>
      ) : (
        <>
          <nav className="tabs">
            {[
              ["play", "tabPlay"],
              ["score", "tabScore"],
              ["similar", "tabSimilar"],
              ["history", "tabHistory"],
              ["theme", "tabTheme"],
              ["join", "tabJoin"],
              ...(isController && hostOnline ? [["admin", "tabAdmin"]] : []),
            ].map(([id, key]) => (
              <button
                key={id}
                type="button"
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id)}
              >
                {tr(key)}
              </button>
            ))}
          </nav>

          {error ? <div className="error-toast">{tr("error")}: {error}</div> : null}

          {tab === "play" && (
            <PlayView
              tr={tr}
              state={state}
              userId={userId}
              isController={isController && hostOnline}
              socket={socket}
            />
          )}
          {tab === "score" && <ScoreView tr={tr} state={state} />}
          {tab === "similar" && <SimilarView tr={tr} state={state} />}
          {tab === "history" && <HistoryView tr={tr} state={state} />}
          {tab === "theme" && (
            <ThemeView tr={tr} theme={theme} onThemeChange={setTheme} />
          )}
          {tab === "join" && (
            <JoinView tr={tr} joinInfo={joinInfo} roomCode={state?.roomCode || roomCode} />
          )}
          {tab === "admin" && isController && hostOnline && (
            <AdminView
              tr={tr}
              state={state}
              userId={userId}
              socket={socket}
              onNewGame={() => setTab("play")}
            />
          )}
        </>
      )}
    </div>
  );
}

function ThemeView({ tr, theme, onThemeChange }) {
  return (
    <section className="panel">
      <h2 className="section-title">{tr("themeTitle")}</h2>
      <p className="muted">{tr("themeHint")}</p>
      <div className="theme-grid" style={{ marginTop: "0.85rem" }}>
        {THEMES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`theme-card ${theme === item.id ? "active" : ""}`}
            onClick={() => onThemeChange(item.id)}
          >
            <div className="theme-swatches">
              {item.swatches.map((color) => (
                <span key={color} style={{ background: color }} />
              ))}
            </div>
            <strong>{tr(item.nameKey)}</strong>
            <span className="meta">{tr(item.descKey)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function PlayerList({ tr, state, userId, isController, socket, showKick }) {
  return (
    <ul className="player-list">
      {(state?.players || []).map((p) => (
        <li key={p.id} className="player-row">
          <div>
            <strong>
              {p.username}
              {p.id === userId ? ` (${tr("you")})` : ""}
            </strong>
            {(state.hostId || state.controllerId) === p.id ? (
              <span className="badge">{tr("controller")}</span>
            ) : null}
            <div className="meta">
              {p.connected ? `${p.score} pts` : tr("offline")}
            </div>
          </div>
          {showKick && isController && p.id !== userId ? (
            <button
              type="button"
              className="danger"
              onClick={() => socket?.emit("kick", { targetId: p.id })}
            >
              {tr("kick")}
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function PlayView({ tr, state, userId, isController, socket }) {
  if (!state) {
    return <div className="panel muted">{tr("joining")}</div>;
  }

  if (state.phase === "lobby") {
    return (
      <div className="stack">
        <section className="panel">
          <h2 className="section-title">{tr("lobby")}</h2>
          <p className="muted">{tr("waiting")}</p>
          <div style={{ marginTop: "1rem" }}>
            <PlayerList
              tr={tr}
              state={state}
              userId={userId}
              isController={isController}
              socket={socket}
              showKick
            />
          </div>
          {isController ? (
            <div className="row" style={{ marginTop: "1rem" }}>
              <button
                type="button"
                onClick={() => socket?.emit("start_game")}
                disabled={(state.players || []).filter((p) => p.connected).length < 2}
              >
                {tr("start")}
              </button>
              <span className="muted">{tr("needPlayers")}</span>
            </div>
          ) : (
            <p className="muted" style={{ marginTop: "1rem" }}>
              {tr("waiting")}
            </p>
          )}
        </section>
      </div>
    );
  }

  if (state.phase === "finished") {
    const ranked = [...(state.players || [])].sort((a, b) => b.score - a.score);
    const top = ranked[0];
    return (
      <div className="stack">
        <section className="panel">
          <h2 className="section-title">{tr("gameOver")}</h2>
          {top ? (
            <p>
              {tr("winner")}: <strong>{top.username}</strong> —{" "}
              <span className="score-big">{top.score}</span>
            </p>
          ) : null}
          {(state.soulmates || []).length > 0 ? (
            <div className="soul" style={{ marginTop: "1rem" }}>
              <strong>{tr("soulmates")}</strong>
              <p className="muted" style={{ margin: "0.35rem 0 0" }}>
                {tr("soulmatesDesc")}
              </p>
              <ul>
                {state.soulmates.map(([a, b]) => {
                  const pa = state.players.find((p) => p.id === a)?.username;
                  const pb = state.players.find((p) => p.id === b)?.username;
                  return (
                    <li key={`${a}-${b}`}>
                      {pa} ↔ {pb}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {isController ? (
            <button
              type="button"
              style={{ marginTop: "1rem" }}
              onClick={() => socket?.emit("back_to_lobby")}
            >
              {tr("backLobby")}
            </button>
          ) : null}
        </section>
        <ScoreView tr={tr} state={state} />
      </div>
    );
  }

  if (state.phase === "revealed") {
    return (
      <RevealView tr={tr} state={state} isController={isController} socket={socket} />
    );
  }

  if (state.phase === "buddy") {
    return (
      <BuddyView
        tr={tr}
        state={state}
        userId={userId}
        isController={isController}
        socket={socket}
      />
    );
  }

  return (
    <AnsweringView
      tr={tr}
      state={state}
      userId={userId}
      isController={isController}
      socket={socket}
    />
  );
}

function physicalLabels(tr, question) {
  const isPhysical = question?.source === "physical";
  const defaultText = !question?.text || question.text === "physical";
  const title = isPhysical && defaultText ? tr("physicalQuestion") : question?.text;
  const showPhysicalPrompt = isPhysical && defaultText;
  const aRaw = question?.a;
  const bRaw = question?.b;
  const labelA =
    isPhysical && (!aRaw || aRaw === "A")
      ? tr("optionAOnly")
      : `A. ${aRaw}`;
  const labelB =
    isPhysical && (!bRaw || bRaw === "B")
      ? tr("optionBOnly")
      : `B. ${bRaw}`;
  return { isPhysical, title, showPhysicalPrompt, labelA, labelB };
}

function QuestionHeader({ tr, state, userId }) {
  const mySub = userId ? state.submissions?.[userId] : null;
  const { title, showPhysicalPrompt, labelA, labelB } = physicalLabels(
    tr,
    state.question
  );

  return (
    <>
      <h2 className="section-title">
        {tr("round", { n: state.round })} {tr("of", { total: state.totalRounds })}
      </h2>
      <p className="question-box">{title}</p>
      {showPhysicalPrompt ? (
        <p className="muted">{tr("physicalPrompt")}</p>
      ) : null}
      {mySub?.answer ? (
        <div className="choice-grid" style={{ marginTop: "0.5rem" }}>
          <div className="choice selected">
            <div className="meta">{tr("yourLockedAnswer")}</div>
            {mySub.answer === "A" ? labelA : labelB}
          </div>
          {mySub.prediction ? (
            <div className="choice selected">
              <div className="meta">{tr("yourLockedPrediction")}</div>
              {mySub.prediction === "majority" ? tr("majority") : tr("minority")}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function PredictionBoard({ tr, state }) {
  return (
    <section className="panel">
      <h2 className="section-title">{tr("predictionBoard")}</h2>
      <p className="muted">{tr("predictionBoardHint")}</p>
      <ul className="player-list" style={{ marginTop: "0.75rem" }}>
        {(state.players || [])
          .filter((p) => p.connected)
          .map((p) => {
            const pred = state.submissions?.[p.id]?.prediction;
            return (
              <li key={p.id} className="player-row">
                <strong>{p.username}</strong>
                <span className="meta">
                  {pred === "majority"
                    ? tr("majority")
                    : pred === "minority"
                      ? tr("minority")
                      : "…"}
                </span>
              </li>
            );
          })}
      </ul>
    </section>
  );
}

function AnsweringView({ tr, state, userId, isController, socket }) {
  const [answer, setAnswer] = useState(null);
  const [prediction, setPrediction] = useState(null);
  const [physText, setPhysText] = useState("");
  const [physA, setPhysA] = useState("");
  const [physB, setPhysB] = useState("");

  const answerReady = !!state.submissions?.[userId]?.answerReady;
  const mySub = state.submissions?.[userId] || {};
  const lockedAnswer = mySub.answer || answer;
  const lockedPrediction = mySub.prediction || prediction;

  useEffect(() => {
    setAnswer(null);
    setPrediction(null);
  }, [state.round, state.question?.text, state.question?.source]);

  useEffect(() => {
    setPhysText("");
    setPhysA("");
    setPhysB("");
  }, [state.round]);

  if (!state.question) {
    return (
      <div className="stack">
        <section className="panel">
          <h2 className="section-title">
            {tr("round", { n: state.round })} {tr("of", { total: state.totalRounds })}
          </h2>
          {isController ? (
            <>
              <p className="muted">{tr("physicalHint")}</p>
              <div className="stack" style={{ marginTop: "0.85rem" }}>
                <label>
                  <span className="muted">{tr("physicalOptionalQuestion")}</span>
                  <input
                    value={physText}
                    onChange={(e) => setPhysText(e.target.value)}
                    placeholder={tr("physicalQuestion")}
                  />
                </label>
                <div className="choice-grid">
                  <label>
                    <span className="muted">{tr("physicalOptionalA")}</span>
                    <input
                      value={physA}
                      onChange={(e) => setPhysA(e.target.value)}
                      placeholder={tr("optionAOnly")}
                    />
                  </label>
                  <label>
                    <span className="muted">{tr("physicalOptionalB")}</span>
                    <input
                      value={physB}
                      onChange={(e) => setPhysB(e.target.value)}
                      placeholder={tr("optionBOnly")}
                    />
                  </label>
                </div>
                <div className="row">
                  <button
                    type="button"
                    onClick={() =>
                      socket?.emit("physical_card", {
                        text: physText,
                        a: physA,
                        b: physB,
                      })
                    }
                  >
                    {tr("usePhysical")}
                  </button>
                  <button
                    type="button"
                    className="teal"
                    onClick={() => socket?.emit("random_question")}
                  >
                    {tr("useRandom")}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="muted">{tr("waitingQuestion")}</p>
          )}
        </section>
        <section className="panel">
          <h2 className="section-title">{tr("players")}</h2>
          <PlayerList
            tr={tr}
            state={state}
            userId={userId}
            isController={isController}
            socket={socket}
            showKick
          />
        </section>
      </div>
    );
  }

  const { labelA, labelB } = physicalLabels(tr, state.question);

  return (
    <div className="stack">
      <section className="panel">
        <QuestionHeader tr={tr} state={state} userId={userId} />
        {!answerReady ? (
          <div className="stack">
            <div>
              <p className="muted">{tr("yourAnswer")}</p>
              <div className="choice-grid">
                <button
                  type="button"
                  className={`choice ${answer === "A" ? "selected" : ""}`}
                  onClick={() => setAnswer("A")}
                >
                  {labelA}
                </button>
                <button
                  type="button"
                  className={`choice ${answer === "B" ? "selected" : ""}`}
                  onClick={() => setAnswer("B")}
                >
                  {labelB}
                </button>
              </div>
            </div>
            <div>
              <p className="muted">{tr("predict")}</p>
              <div className="choice-grid">
                <button
                  type="button"
                  className={`choice ${prediction === "majority" ? "selected" : ""}`}
                  onClick={() => setPrediction("majority")}
                >
                  {tr("majority")}
                </button>
                <button
                  type="button"
                  className={`choice ${prediction === "minority" ? "selected" : ""}`}
                  onClick={() => setPrediction("minority")}
                >
                  {tr("minority")}
                </button>
              </div>
            </div>
            <button
              type="button"
              disabled={!answer || !prediction}
              onClick={() => socket?.emit("submit_answer", { answer, prediction })}
            >
              {tr("submitAnswer")}
            </button>
          </div>
        ) : (
          <div className="stack">
            <p className="muted">{tr("answerSubmitted")}</p>
            <div className="choice-grid">
              <div className="choice selected">
                <div className="meta">{tr("yourLockedAnswer")}</div>
                {lockedAnswer === "A" ? labelA : lockedAnswer === "B" ? labelB : "—"}
              </div>
              <div className="choice selected">
                <div className="meta">{tr("yourLockedPrediction")}</div>
                {lockedPrediction === "majority"
                  ? tr("majority")
                  : lockedPrediction === "minority"
                    ? tr("minority")
                    : "—"}
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <h2 className="section-title">{tr("players")}</h2>
        <ul className="player-list">
          {(state.players || [])
            .filter((p) => p.connected)
            .map((p) => (
              <li key={p.id} className="player-row">
                <strong>{p.username}</strong>
                <span className="meta">
                  {state.submissions?.[p.id]?.answerReady ? "✓" : "…"}
                </span>
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}

function guessLabel(tr, guess) {
  return guess === "same" ? tr("buddySame") : tr("buddyDiff");
}

function BuddyView({ tr, state, userId, isController, socket }) {
  const [inviteGuess, setInviteGuess] = useState(null);
  const [oddGuess, setOddGuess] = useState(null);
  const buddy = state.buddy || {};
  const mySub = state.submissions?.[userId] || {};
  const nameOf = (id) => state.players.find((p) => p.id === id)?.username || "?";

  const freeIds = new Set(buddy.freeIds || []);
  const myOutgoing = buddy.outgoing?.[userId];
  const incomingDetails = buddy.incomingDetails?.[userId] || [];
  const hasBuddy = !!mySub.buddyId;
  const allBuddyReady = (state.players || [])
    .filter((p) => p.connected)
    .every((p) => state.submissions?.[p.id]?.buddyReady);

  const pairedIds = new Set();
  for (const [a, b] of buddy.pairs || []) {
    pairedIds.add(a);
    pairedIds.add(b);
  }

  useEffect(() => {
    setInviteGuess(null);
    setOddGuess(null);
  }, [state.round]);

  const others = (state.players || []).filter((p) => p.connected && p.id !== userId);
  const partnerGuess = hasBuddy
    ? state.submissions?.[mySub.buddyId]?.buddyGuess
    : null;

  return (
    <div className="stack">
      <section className="panel">
        <QuestionHeader tr={tr} state={state} userId={userId} />
      </section>

      <PredictionBoard tr={tr} state={state} />

      {incomingDetails.length > 0 ? (
        <section className="panel soul">
          <h2 className="section-title">{tr("buddyIncoming")}</h2>
          {incomingDetails.map(({ fromId, buddyGuess }) => (
            <div key={fromId} className="stack" style={{ marginTop: "0.65rem" }}>
              <p>
                <strong>{nameOf(fromId)}</strong>{" "}
                {tr("buddyIncomingGuess", { guess: guessLabel(tr, buddyGuess) })}
              </p>
              <p className="muted">{tr("buddyAcceptShared")}</p>
              <div className="row">
                <button
                  type="button"
                  className="teal"
                  onClick={() =>
                    socket?.emit("buddy_respond", {
                      fromId,
                      accept: true,
                    })
                  }
                >
                  {tr("buddyAccept")}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() =>
                    socket?.emit("buddy_respond", { fromId, accept: false })
                  }
                >
                  {tr("buddyDecline")}
                </button>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <section className="panel">
        <h2 className="section-title">{tr("pickBuddy")}</h2>

        {hasBuddy ? (
          <div className="stack">
            <p>
              {tr("buddyPairedWith", { name: nameOf(mySub.buddyId) })}
              {mySub.buddyKind === "odd" ? " *" : ""}
            </p>
            <p className="muted">
              {tr("buddyRelation")}: {guessLabel(tr, mySub.buddyGuess)}
            </p>
            {partnerGuess && partnerGuess !== mySub.buddyGuess ? (
              <p className="muted">
                {tr("buddyTheirGuess", { guess: guessLabel(tr, partnerGuess) })}
              </p>
            ) : null}
            <button
              type="button"
              className="ghost"
              onClick={() => socket?.emit("buddy_unlock")}
            >
              {tr("buddyUnlock")}
            </button>
          </div>
        ) : buddy.canOddAttach && freeIds.has(userId) ? (
          <div className="stack">
            <p className="muted">{tr("buddyOddHint")}</p>
            <p className="muted">{tr("buddyInviteGuessFirst")}</p>
            <div className="choice-grid">
              <button
                type="button"
                className={`choice ${oddGuess === "same" ? "selected" : ""}`}
                onClick={() => setOddGuess("same")}
              >
                {tr("buddySame")}
              </button>
              <button
                type="button"
                className={`choice ${oddGuess === "different" ? "selected" : ""}`}
                onClick={() => setOddGuess("different")}
              >
                {tr("buddyDiff")}
              </button>
            </div>
            <div className="choice-grid">
              {others
                .filter((p) => pairedIds.has(p.id))
                .map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="choice buddy-selected"
                    disabled={!oddGuess}
                    onClick={() =>
                      socket?.emit("buddy_odd_attach", {
                        targetId: p.id,
                        buddyGuess: oddGuess,
                      })
                    }
                  >
                    {p.username} — {tr("buddyOddAttach")}
                  </button>
                ))}
            </div>
          </div>
        ) : (
          <div className="stack">
            {myOutgoing ? (
              <div className="row">
                <p className="muted">
                  {tr("buddyPendingOutGuess", {
                    name: nameOf(myOutgoing.toId),
                    guess: guessLabel(tr, myOutgoing.buddyGuess),
                  })}
                </p>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => socket?.emit("buddy_cancel_request")}
                >
                  {tr("buddyCancelRequest")}
                </button>
              </div>
            ) : (
              <>
                <p className="muted">{tr("buddyInviteGuessFirst")}</p>
                <div className="choice-grid">
                  <button
                    type="button"
                    className={`choice ${inviteGuess === "same" ? "selected" : ""}`}
                    onClick={() => setInviteGuess("same")}
                  >
                    {tr("buddySame")}
                  </button>
                  <button
                    type="button"
                    className={`choice ${inviteGuess === "different" ? "selected" : ""}`}
                    onClick={() => setInviteGuess("different")}
                  >
                    {tr("buddyDiff")}
                  </button>
                </div>
                <p className="muted">{tr("buddyWaitingPair")}</p>
                <div className="choice-grid">
                  {others.map((p) => {
                    const free = freeIds.has(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className="choice"
                        disabled={!free || !freeIds.has(userId) || !inviteGuess}
                        onClick={() =>
                          socket?.emit("buddy_request", {
                            targetId: p.id,
                            buddyGuess: inviteGuess,
                          })
                        }
                      >
                        {p.username}
                        <div className="meta">
                          {free ? tr("buddyFree") : tr("buddyBusy")}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <h2 className="section-title">{tr("players")}</h2>
        <ul className="player-list">
          {(state.players || [])
            .filter((p) => p.connected)
            .map((p) => {
              const sub = state.submissions?.[p.id];
              let status = "…";
              if (sub?.buddyReady) status = "✓";
              else if (sub?.buddyId) status = nameOf(sub.buddyId);
              else if (buddy.outgoing?.[p.id]) {
                const out = buddy.outgoing[p.id];
                status = `→ ${guessLabel(tr, out.buddyGuess)}`;
              }
              return (
                <li key={p.id} className="player-row">
                  <strong>{p.username}</strong>
                  <span className="meta">{status}</span>
                </li>
              );
            })}
        </ul>
        {isController ? (
          <div className="row" style={{ marginTop: "1rem" }}>
            <button
              type="button"
              onClick={() => socket?.emit("reveal")}
              disabled={!allBuddyReady}
            >
              {tr("reveal")}
            </button>
            {!allBuddyReady ? <span className="muted">{tr("notReady")}</span> : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function AdminView({ tr, state, userId, socket, onNewGame }) {
  function handleNewGame() {
    if (!window.confirm(tr("adminNewGameConfirm"))) return;
    socket?.emit("new_game");
    onNewGame?.();
  }

  return (
    <div className="stack">
      <section className="panel">
        <h2 className="section-title">{tr("adminNewGame")}</h2>
        <p className="muted">{tr("adminNewGameHint")}</p>
        <div className="row" style={{ marginTop: "0.85rem" }}>
          <button type="button" className="danger" onClick={handleNewGame}>
            {tr("adminNewGame")}
          </button>
        </div>
      </section>

      <section className="panel">
        <h2 className="section-title">{tr("adminTitle")}</h2>
        <p className="muted">{tr("adminHint")}</p>
        <ul className="player-list" style={{ marginTop: "1rem" }}>
          {(state?.players || []).map((p) => (
            <li key={p.id} className="player-row">
              <div>
                <strong>
                  {p.username}
                  {p.id === userId ? ` (${tr("you")})` : ""}
                </strong>
                <div className="meta">
                  {p.connected ? `${p.score} pts` : tr("offline")}
                </div>
              </div>
              {p.id !== userId ? (
                <button
                  type="button"
                  className="danger"
                  onClick={() => socket?.emit("kick", { targetId: p.id })}
                >
                  {tr("adminRemove")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function RevealView({ tr, state, isController, socket }) {
  const reveal = state.lastReveal;
  if (!reveal) return null;
  const nameOf = (id) => state.players.find((p) => p.id === id)?.username || "?";
  const { title, labelA, labelB } = physicalLabels(tr, reveal.question);

  return (
    <div className="stack">
      <section className="panel">
        <h2 className="section-title">
          {tr("results")} — {tr("round", { n: reveal.round })}
        </h2>
        <p className="question-box">{title}</p>
        <p>
          {tr("counts")}: {labelA}={reveal.counts.A} · {labelB}={reveal.counts.B}
        </p>
        <p className="muted">
          {reveal.tied
            ? tr("tied")
            : tr("majorityIs", { side: reveal.majoritySide })}
        </p>
        <ul className="player-list" style={{ marginTop: "1rem" }}>
          {Object.entries(reveal.results).map(([id, r]) => (
            <li key={id} className="player-row">
              <div>
                <strong>
                  {nameOf(id)} → {r.answer}
                </strong>
                <div className="meta">
                  {tr("prediction")}:{" "}
                  {r.prediction === "majority" ? tr("majority") : tr("minority")}{" "}
                  ({r.predictionOk ? tr("ok") : tr("fail")} +{r.predictionPoints}) ·{" "}
                  {tr("buddy")}: {nameOf(r.buddyId)} /{" "}
                  {r.buddyGuess === "same" ? tr("buddySame") : tr("buddyDiff")} (
                  {r.buddyGuessOk ? tr("ok") : tr("fail")} +{r.buddyPoints})
                  {r.oddBuddyFromId ? (
                    <>
                      {" · "}
                      {tr("buddyBonusOdd", { name: nameOf(r.oddBuddyFromId) })}:{" "}
                      {r.oddBuddyGuess === "same"
                        ? tr("buddySame")
                        : tr("buddyDiff")}{" "}
                      ({r.oddBuddyGuessOk ? tr("ok") : tr("fail")} +
                      {r.oddBuddyBonus})
                    </>
                  ) : null}
                </div>
              </div>
              <div className="score-big">{tr("gained", { n: r.gained })}</div>
            </li>
          ))}
        </ul>
        {isController ? (
          <div className="row" style={{ marginTop: "1rem" }}>
            <button type="button" onClick={() => socket?.emit("next_round")}>
              {state.round >= state.totalRounds ? tr("finish") : tr("nextRound")}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function HistoryView({ tr, state }) {
  const history = state?.roundHistory || [];
  const nameOf = (id) => state?.players?.find((p) => p.id === id)?.username || id;

  if (history.length === 0) {
    return (
      <section className="panel">
        <h2 className="section-title">{tr("historyTitle")}</h2>
        <p className="muted">{tr("historyEmpty")}</p>
      </section>
    );
  }

  return (
    <div className="stack">
      {[...history].reverse().map((h) => {
        const { title } = physicalLabels(tr, h.question);
        return (
          <section key={h.round} className="panel">
            <h2 className="section-title">{tr("historyRound", { n: h.round })}</h2>
            <p className="question-box">{title}</p>
            <p className="muted">
              {tr("counts")}: A={h.counts.A} · B={h.counts.B}
              {" · "}
              {h.tied ? tr("tied") : tr("majorityIs", { side: h.majoritySide })}
            </p>
            <ul className="player-list" style={{ marginTop: "0.75rem" }}>
              {Object.entries(h.results).map(([id, r]) => (
                <li key={id} className="player-row">
                  <div>
                    <strong>
                      {nameOf(id)} → {r.answer}
                    </strong>
                    <div className="meta">
                      {r.prediction === "majority" ? tr("majority") : tr("minority")} ·{" "}
                      {tr("buddy")}: {nameOf(r.buddyId)} (
                      {r.buddyGuess === "same" ? tr("buddySame") : tr("buddyDiff")})
                      {r.oddBuddyFromId
                        ? ` · +${r.oddBuddyBonus} (${nameOf(r.oddBuddyFromId)})`
                        : ""}{" "}
                      · {tr("gained", { n: r.gained })}
                    </div>
                  </div>
                  <span className="score-big">{r.score}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ScoreView({ tr, state }) {
  const ranked = [...(state?.players || [])].sort((a, b) => b.score - a.score);
  return (
    <section className="panel">
      <h2 className="section-title">{tr("scoreboard")}</h2>
      <ul className="player-list">
        {ranked.map((p, i) => (
          <li key={p.id} className="player-row">
            <strong>
              #{i + 1} {p.username}
            </strong>
            <span className="score-big">{p.score}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SimilarView({ tr, state }) {
  const players = state?.players || [];
  const matrix = state?.similarity || {};
  return (
    <section className="panel">
      <h2 className="section-title">{tr("similarity")}</h2>
      <p className="muted">{tr("similarityHint")}</p>
      {(state?.soulmates || []).length > 0 ? (
        <div className="soul" style={{ margin: "0.75rem 0" }}>
          <strong>{tr("soulmates")}</strong>
        </div>
      ) : null}
      <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
        <table>
          <thead>
            <tr>
              <th></th>
              {players.map((p) => (
                <th key={p.id}>{p.username}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {players.map((row) => (
              <tr key={row.id}>
                <td>{row.username}</td>
                {players.map((col) => {
                  const v = matrix[row.id]?.[col.id];
                  return (
                    <td key={col.id}>{v == null ? "—" : `${v}%`}</td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function JoinView({ tr, joinInfo, roomCode }) {
  const [copied, setCopied] = useState(false);
  const code = normalizeRoomInput(roomCode || joinInfo?.roomCode || "");
  const base =
    joinInfo?.url?.split("?")[0] ||
    (joinInfo?.ip
      ? `http://${joinInfo.ip}:${window.location.port || joinInfo.port || 4173}`
      : window.location.origin);
  const url = code ? `${base}?room=${encodeURIComponent(code)}` : joinInfo?.url || base;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <section className="panel">
      <h2 className="section-title">{tr("joinUrl")}</h2>
      <p className="muted">{tr("scanQr")}</p>
      {code ? (
        <p>
          {tr("roomLabel", { code })}
        </p>
      ) : null}
      <div className="qr-wrap">
        <div className="qr-frame">
          <QRCodeSVG value={url} size={220} level="M" />
        </div>
        <code>{url}</code>
        <button type="button" className="ghost" onClick={copy}>
          {copied ? tr("copied") : tr("copy")}
        </button>
      </div>
    </section>
  );
}
