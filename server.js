const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

const MAX_PLAYERS = 4;
const START_BALANCE = 13460;
const ANTE = 100;
const TURN_TIME = 20000;

const players = [];

let pot = 0;
let phase = "waiting";
let round = 0;
let turnIndex = -1;
let deck = [];
let turnTimer = null;
let startTimer = null;

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

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function makeDeck() {
  const d = [];

  for (const suit of suits) {
    for (const [rank, value] of ranks) {
      d.push({
        rank,
        value,
        suit
      });
    }
  }

  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }

  return d;
}

function handScore(cards) {
  if (!cards || cards.length !== 3) {
    return [0];
  }

  const values = cards
    .map(c => c.value)
    .sort((a, b) => b - a);

  const unique = [...new Set(values)]
    .sort((a, b) => a - b);

  const count = {};

  for (const v of values) {
    count[v] = (count[v] || 0) + 1;
  }

  const flush = cards.every(
    c => c.suit === cards[0].suit
  );

  let straight =
    unique.length === 3 &&
    unique[2] - unique[0] === 2;

  if (unique.join(",") === "2,3,14") {
    straight = true;
  }

  if (straight && flush) {
    return [6, Math.max(...values)];
  }

  const triple = Object.keys(count).find(
    v => count[v] === 3
  );

  if (triple) {
    return [5, Number(triple)];
  }

  const pair = Object.keys(count).find(
    v => count[v] === 2
  );

  if (flush) {
    return [4, ...values];
  }

  if (straight) {
    return [3, Math.max(...values)];
  }

  if (pair) {
    const kicker = Object.keys(count).find(
      v => count[v] === 1
    );

    return [
      2,
      Number(pair),
      Number(kicker)
    ];
  }

  return [1, ...values];
}

function compareHands(a, b) {
  const A = handScore(a);
  const B = handScore(b);

  const length = Math.max(A.length, B.length);

  for (let i = 0; i < length; i++) {
    const av = A[i] || 0;
    const bv = B[i] || 0;

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
    p =>
      p.connected &&
      !p.packed
  );
}

function findPlayer(id) {
  return players.find(
    p => p.id === id
  );
}

function sendEvent(player, data) {
  if (!player || !player.response) {
    return;
  }

  try {
    player.response.write(
      "data: " +
      JSON.stringify(data) +
      "\n\n"
    );
  } catch {}
}

function publicState(player) {
  return {
    type: "state",

    phase,

    round,

    pot,

    turn:
      players[turnIndex]?.id || null,

    players: players.map(p => ({
      id: p.id,

      name: p.name,

      seat: p.seat,

      balance: p.balance,

      packed: p.packed,

      connected: p.connected,

      cards:
        phase === "finished" ||
        p.id === player.id
          ? p.cards
          : []
    }))
  };
}

function broadcast(data) {
  for (const player of players) {
    if (player.connected) {
      sendEvent(player, data);
    }
  }
}

function broadcastStates() {
  for (const player of players) {
    if (player.connected) {
      sendEvent(
        player,
        publicState(player)
      );
    }
  }
}

function clearTurnTimer() {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
}

function startTurnTimer() {
  clearTurnTimer();

  turnTimer = setTimeout(() => {
    const player =
      players[turnIndex];

    if (
      player &&
      player.connected &&
      !player.packed
    ) {
      player.packed = true;

      broadcast({
        type: "notice",
        text:
          player.name +
          " timed out and packed."
      });

      nextTurn();
    }
  }, TURN_TIME);
}

function nextTurn() {
  const active = activePlayers();

  if (active.length <= 1) {
    finishRound("last-player");
    return;
  }

  for (
    let step = 1;
    step <= players.length;
    step++
  ) {
    const next =
      (turnIndex + step) %
      players.length;

    const player =
      players[next];

    if (
      player &&
      player.connected &&
      !player.packed
    ) {
      turnIndex = next;

      broadcastStates();

      startTurnTimer();

      return;
    }
  }

  finishRound("no-turn");
}

function startRound() {
  clearTurnTimer();

  pot = 0;

  deck = makeDeck();

  round++;

  phase = "playing";

  for (const player of players) {
    if (!player.connected) {
      continue;
    }

    player.cards = [
      deck.pop(),
      deck.pop(),
      deck.pop()
    ];

    player.packed = false;

    if (player.balance >= ANTE) {
      player.balance -= ANTE;

      pot += ANTE;
    } else {
      player.packed = true;
    }
  }

  const active = activePlayers();

  if (active.length < 2) {
    phase = "waiting";

    broadcastStates();

    return;
  }

  turnIndex =
    players.indexOf(active[0]);

  broadcastStates();

  broadcast({
    type: "notice",
    text: "Round " + round + " started"
  });

  startTurnTimer();
}

function scheduleRound() {
  if (
    phase !== "waiting" ||
    connectedPlayers().length < 2
  ) {
    return;
  }

  clearTimeout(startTimer);

  startTimer = setTimeout(() => {
    if (
      phase === "waiting" &&
      connectedPlayers().length >= 2
    ) {
      startRound();
    }
  }, 1000);
}

function finishRound(reason) {
  clearTurnTimer();

  const active = activePlayers();

  if (active.length === 0) {
    phase = "waiting";

    broadcastStates();

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

  winner.balance += pot;

  phase = "finished";

  broadcast({
    type: "result",

    winnerId: winner.id,

    winnerName: winner.name,

    pot,

    reason
  });

  broadcastStates();

  setTimeout(() => {
    const connected =
      connectedPlayers();

    if (connected.length >= 2) {
      startRound();
    } else {
      phase = "waiting";

      broadcastStates();
    }
  }, 4000);
}

function performAction(player, action) {
  if (
    phase !== "playing" ||
    !player.connected ||
    player.packed ||
    players[turnIndex]?.id !== player.id
  ) {
    return;
  }

  if (action === "pack") {
    player.packed = true;

    broadcast({
      type: "notice",
      text:
        player.name +
        " packed."
    });

    nextTurn();

    return;
  }

  if (action === "show") {
    finishRound("show");

    return;
  }

  if (action === "sideshow") {
    broadcast({
      type: "notice",
      text:
        player.name +
        " requested Side Show."
    });

    nextTurn();

    return;
  }

  let amount = 0;

  if (action === "chaal") {
    amount = ANTE;
  }

  if (action === "chaal2") {
    amount = ANTE * 2;
  }

  if (!amount) {
    return;
  }

  if (player.balance < amount) {
    sendEvent(player, {
      type: "error",
      text: "Insufficient chips"
    });

    return;
  }

  player.balance -= amount;

  pot += amount;

  broadcast({
    type: "notice",
    text:
      player.name +
      " played " +
      (action === "chaal2"
        ? "2X Chaal"
        : "Chaal")
  });

  nextTurn();
}

function parseBody(req) {
  return new Promise(
    (resolve, reject) => {
      let body = "";

      req.on("data", chunk => {
        body += chunk;
      });

      req.on("end", () => {
        try {
          resolve(
            body
              ? JSON.parse(body)
              : {}
          );
        } catch (error) {
          reject(error);
        }
      });
    }
  );
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store",

    "Access-Control-Allow-Origin":
      "*"
  });

  res.end(
    JSON.stringify(data)
  );
}

function serveFile(req, res) {
  const url = new URL(
    req.url,
    "http://localhost"
  );

  let requested =
    url.pathname === "/"
      ? "/index.html"
      : url.pathname;

  requested =
    decodeURIComponent(requested);

  const filePath = path.join(
    __dirname,
    requested
  );

  if (
    !filePath.startsWith(
      __dirname
    ) ||
    !fs.existsSync(filePath) ||
    fs.statSync(filePath).isDirectory()
  ) {
    json(res, 404, {
      error: "Not found"
    });

    return;
  }

  const extension =
    path.extname(filePath);

  const contentTypes = {
    ".html":
      "text/html; charset=utf-8",

    ".js":
      "text/javascript; charset=utf-8",

    ".css":
      "text/css; charset=utf-8",

    ".png":
      "image/png",

    ".jpg":
      "image/jpeg",

    ".jpeg":
      "image/jpeg",

    ".mp3":
      "audio/mpeg"
  };

  res.writeHead(200, {
    "Content-Type":
      contentTypes[extension] ||
      "application/octet-stream",

    "Cache-Control":
      extension === ".html"
        ? "no-store"
        : "public,max-age=3600"
  });

  fs.createReadStream(
    filePath
  ).pipe(res);
}

const server =
  http.createServer(
    async (req, res) => {
      try {
        if (
          req.method === "GET" &&
          req.url === "/health"
        ) {
          json(res, 200, {
            ok: true,

            players:
              connectedPlayers()
                .length,

            phase
          });

          return;
        }
