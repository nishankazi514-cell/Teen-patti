"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 4;
const START_BALANCE = 13460;
const ANTE = 100;
const TURN_TIME = 20000;

const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".svg": "image/svg+xml"
};

const suits = ["♠", "♥", "♦", "♣"];

const ranks = [
  ["2", 2],
  ["3", 3],
  ["4", 4],
  ["5", 5],
  ["6", 6],
  ["7", 7],
  ["8", 8],
  ["9", 9],
  ["10", 10],
  ["J", 11],
  ["Q", 12],
  ["K", 13],
  ["A", 14]
];

let players = [];
let pot = 0;
let deck = [];
let round = 0;
let turnIndex = 0;
let phase = "waiting";
let turnTimer = null;
let nextRoundTimer = null;
let roundStarting = false;

/* ---------------- HTTP SERVER ---------------- */

const server = http.createServer((req, res) => {
  try {
    let requestPath = decodeURIComponent(
      new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname
    );

    if (requestPath === "/health") {
      const body = JSON.stringify({
        ok: true,
        service: "teen-patti",
        players: players.filter(p => p.connected).length,
        maxPlayers: MAX_PLAYERS,
        phase,
        round
      });

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });

      res.end(body);
      return;
    }

    if (requestPath === "/") {
      requestPath = "/index.html";
    }

    const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(ROOT, safePath);

    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8"
        });
        res.end("Not found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();

      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "no-cache"
      });

      res.end(data);
    });

  } catch (err) {
    console.error("HTTP error:", err);

    res.writeHead(500, {
      "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("Internal server error");
  }
});

/* ---------------- GAME HELPERS ---------------- */

function makeId() {
  return Math.random().toString(36).slice(2) +
         Date.now().toString(36);
}

function makeDeck() {
  const cards = [];

  for (const suit of suits) {
    for (const [rank, value] of ranks) {
      cards.push({
        rank,
        value,
        suit
      });
    }
  }

  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }

  return cards;
}

function handScore(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) {
    return [0];
  }

  const values = cards
    .map(c => c.value)
    .sort((a, b) => b - a);

  const counts = {};

  for (const value of values) {
    counts[value] = (counts[value] || 0) + 1;
  }

  const flush = cards.every(
    c => c.suit === cards[0].suit
  );

  const unique = [...new Set(values)].sort(
    (a, b) => a - b
  );

  let straight = false;

  if (
    unique.length === 3 &&
    unique[2] - unique[0] === 2
  ) {
    straight = true;
  }

  // A-2-3
  if (
    unique[0] === 2 &&
    unique[1] === 3 &&
    unique[2] === 14
  ) {
    straight = true;
  }

  // Trail / Trio
  const triple = Object.keys(counts).find(
    key => counts[key] === 3
  );

  if (straight && flush) {
    return [6, Math.max(...values)];
  }

  if (triple) {
    return [5, Number(triple)];
  }

  if (flush) {
    return [4, ...values];
  }

  if (straight) {
    return [3, Math.max(...values)];
  }

  const pair = Object.keys(counts).find(
    key => counts[key] === 2
  );

  if (pair) {
    const kicker = Number(
      Object.keys(counts).find(
        key => counts[key] === 1
      )
    );

    return [2, Number(pair), kicker];
  }

  return [1, ...values];
}

function compareHands(a, b) {
  const sa = handScore(a);
  const sb = handScore(b);

  const length = Math.max(sa.length, sb.length);

  for (let i = 0; i < length; i++) {
    const av = sa[i] || 0;
    const bv = sb[i] || 0;

    if (av !== bv) {
      return av - bv;
    }
  }

  return 0;
}

function connectedPlayers() {
  return players.filter(p => p.connected);
}

function activePlayers() {
  return players.filter(
    p => p.connected && !p.packed
  );
}

function send(ws, data) {
  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(data) {
  for (const player of players) {
    send(player.ws, data);
  }
}

function createPublicState(forPlayerId) {
  return {
    type: "state",

    phase,

    round,

    pot,

    turn:
      players[turnIndex] &&
      players[turnIndex].connected &&
      !players[turnIndex].packed
        ? players[turnIndex].id
        : null,

    players: players.map(player => {
      const isMe = player.id === forPlayerId;

      const showCards =
        phase === "finished" || isMe;

      return {
        id: player.id,
        name: player.name,
        seat: player.seat,
        balance: player.balance,
        connected: player.connected,
        packed: player.packed,

        cards: showCards
          ? player.cards
          : []
      };
    })
  };
}

function broadcastState() {
  for (const player of players) {
    send(
      player.ws,
      createPublicState(player.id)
    );
  }
}

function clearTimers() {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }

  if (nextRoundTimer) {
    clearTimeout(nextRoundTimer);
    nextRoundTimer = null;
  }
}

/* ---------------- ROUND ---------------- */

function startRound() {
  if (roundStarting) return;

  const connected = connectedPlayers();

  if (connected.length < 2) {
    phase = "waiting";
    broadcastState();
    return;
  }

  roundStarting = true;

  clearTimers();

  pot = 0;
  deck = makeDeck();

  round++;
  phase = "playing";

  for (const player of players) {
    if (!player.connected) {
      player.cards = [];
      player.packed = true;
      continue;
    }

    player.packed = false;

    player.cards = [
      deck.pop(),
      deck.pop(),
      deck.pop()
    ];

    if (player.balance >= ANTE) {
      player.balance -= ANTE;
      pot += ANTE;
    } else {
      player.packed = true;
    }
  }

  turnIndex = 0;

  moveToNextActive(false);

  roundStarting = false;

  broadcast({
    type: "notice",
    text: `Round ${round} started`
  });

  broadcastState();

  startTurnTimer();
}

function moveToNextActive(changeTurn = true) {
  const active = activePlayers();

  if (active.length <= 1) {
    finishRound("last-player");
    return;
  }

  if (!players.length) return;

  let index = turnIndex;

  for (let i = 0; i < players.length; i++) {
    if (changeTurn || i > 0) {
      index = (index + 1) % players.length;
    }

    const player = players[index];

    if (
      player &&
      player.connected &&
      !player.packed
    ) {
      turnIndex = index;
      return;
    }
  }
}

function startTurnTimer() {
  if (phase !== "playing") return;

  clearTimeout(turnTimer);

  turnTimer = setTimeout(() => {
    const player = players[turnIndex];

    if (
      player &&
      player.connected &&
      !player.packed
    ) {
      player.packed = true;

      broadcast({
        type: "notice",
        text: `${player.name} timed out and packed.`
      });

      nextTurn();
    }
  }, TURN_TIME);
}

function nextTurn() {
  clearTimeout(turnTimer);
  turnTimer = null;

  const active = activePlayers();

  if (active.length <= 1) {
    finishRound("last-player");
    return;
  }

  moveToNextActive(true);

  broadcastState();

  startTurnTimer();
}

function finishRound(reason) {
  if (phase !== "playing") return;

  clearTimeout(turnTimer);
  turnTimer = null;

  const active = activePlayers();

  if (!active.length) {
    phase = "waiting";
    pot = 0;
    broadcastState();
    return;
  }

  let winner = active[0];

  for (const player of active.slice(1)) {
    if (
      compareHands(
        player.cards,
        winner.cards
      ) > 0
    ) {
      winner = player;
    }
  }

  const winAmount = pot;

  winner.balance += winAmount;

  phase = "finished";

  broadcast({
    type: "result",

    winnerId: winner.id,

    winnerName: winner.name,

    amount: winAmount,

    pot: winAmount,

    reason,

    cards: active.map(player => ({
      id: player.id,
      cards: player.cards
    }))
  });

  broadcastState();

  nextRoundTimer = setTimeout(() => {
    nextRoundTimer = null;

    if (
      connectedPlayers().length >= 2
    ) {
      startRound();
    } else {
      phase = "waiting";
      pot = 0;
      broadcastState();
    }
  }, 4000);
}

/* ---------------- ACTIONS ---------------- */

function playerAction(player, action) {
  if (phase !== "playing") return;

  if (
    players[turnIndex]?.id !== player.id
  ) {
    send(player.ws, {
      type: "error",
      text: "Not your turn."
    });

    return;
  }

  if (
    !player.connected ||
    player.packed
  ) {
    return;
  }

  if (action === "pack") {
    player.packed = true;

    broadcast({
      type: "notice",
      text: `${player.name} packed.`
    });

    nextTurn();

    return;
  }

  if (action === "chaal") {
    playBet(player, ANTE);
    return;
  }

  if (action === "chaal2") {
    playBet(player, ANTE * 2);
    return;
  }

  if (action === "show") {
    finishRound("show");
    return;
  }

  if (action === "sideshow") {
    send(player.ws, {
      type: "notice",
      text: "Side Show requested."
    });

    return;
  }
}

function playBet(player, amount) {
  if (player.balance < amount) {
    send(player.ws, {
      type: "error",
      text: "Not enough chips."
    });

    return;
  }

  player.balance -= amount;
  pot += amount;

  broadcast({
    type: "notice",
    text:
      `${player.name} played ` +
      `${amount === ANTE * 2 ? "2X Chaal" : "Chaal"}`
  });

  nextTurn();
}

/* ---------------- WEBSOCKET ---------------- */

const wss = new WebSocketServer({
  server
});

wss.on("connection", ws => {
  if (connectedPlayers().length >= MAX_PLAYERS) {
    send(ws, {
      type: "full",
      text: "Table is full."
    });

    ws.close();
    return;
  }

  const usedSeats = new Set(
    players
      .filter(p => p.connected)
      .map(p => p.seat)
  );

  let seat = 0;

  while (usedSeats.has(seat)) {
    seat++;
  }

  const player = {
    id: makeId(),
    ws,
    seat,
    name: `Player ${seat + 1}`,
    balance: START_BALANCE,
    cards: [],
    packed: false,
    connected: true
  };

  players.push(player);

  send(ws, {
    type: "welcome",
    id: player.id,
    seat: player.seat,
    name: player.name
  });

  broadcast({
    type: "notice",
    text: `${player.name} joined the table.`
  });

  broadcastState();

  if (
    connectedPlayers().length >= 2 &&
    phase === "waiting"
  ) {
    setTimeout(() => {
      if (
        phase === "waiting" &&
        connectedPlayers().length >= 2
      ) {
        startRound();
      }
    }, 1000);
  }

  ws.on("message", raw => {
    try {
      const message = JSON.parse(
        raw.toString()
      );

      if (
        message &&
        message.type === "action"
      ) {
        playerAction(
          player,
          String(message.action || "")
        );
      }
    } catch (error) {
      send(ws, {
        type: "error",
        text: "Invalid request."
      });
    }
  });

  ws.on("close", () => {
    if (!player.connected) return;

    player.connected = false;

    if (
      phase === "playing" &&
      !player.packed
    ) {
      player.packed = true;

      if (
        players[turnIndex]?.id === player.id
      ) {
        nextTurn();
      }
    }

    broadcast({
      type: "notice",
      text: `${player.name} disconnected.`
    });

    broadcastState();

    // Remove old disconnected player after the
    // current round is finished.
    if (phase !== "playing") {
      setTimeout(cleanDisconnectedPlayers, 1000);
    }
  });

  ws.on("error", error => {
    console.error(
      "WebSocket error:",
      error.message
    );
  });
});

function cleanDisconnectedPlayers() {
  players = players.filter(
    p => p.connected || phase === "playing"
  );

  // Re-numbering is intentionally avoided while
  // a live round is active.
}

/* ---------------- START ---------------- */

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Teen Patti server running on port ${PORT}`
  );
});

server.on("error", error => {
  console.error(
    "SERVER ERROR:",
    error
  );

  process.exit(1);
});

process.on("uncaughtException", error => {
  console.error(
    "UNCAUGHT EXCEPTION:",
    error
  );
});

process.on("unhandledRejection", error => {
  console.error(
    "UNHANDLED REJECTION:",
    error
  );
});
