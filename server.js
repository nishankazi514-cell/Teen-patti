"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* =========================
   SERVER
========================= */

const PORT = Number(process.env.PORT) || 10000;

const MAX_PLAYERS = 4;

const START_BALANCE = 13460;

const ANTE = 100;

const TURN_TIME = 20000;

const ROUND_START_DELAY = 1200;

const ROUND_END_DELAY = 4000;


/* =========================
   STATIC FILES
========================= */

app.use(express.static(__dirname));


/* =========================
   GAME DATA
========================= */

const suits = [
    "♠",
    "♥",
    "♦",
    "♣"
];

const ranks = [
    { n: "2",  v: 2 },
    { n: "3",  v: 3 },
    { n: "4",  v: 4 },
    { n: "5",  v: 5 },
    { n: "6",  v: 6 },
    { n: "7",  v: 7 },
    { n: "8",  v: 8 },
    { n: "9",  v: 9 },
    { n: "10", v: 10 },
    { n: "J",  v: 11 },
    { n: "Q",  v: 12 },
    { n: "K",  v: 13 },
    { n: "A",  v: 14 }
];


let players = [];

let pot = 0;

let deck = [];

let round = 0;

let turnIndex = -1;

let phase = "waiting";

let timer = null;

let roundStartTimer = null;

let roundEndTimer = null;


/* =========================
   HELPERS
========================= */

function safeName(name, fallback){

    if(typeof name !== "string"){
        return fallback;
    }

    name = name.trim();

    if(!name){
        return fallback;
    }

    return name
        .replace(/[<>]/g, "")
        .slice(0, 18)
        .trim() || fallback;
}


function send(ws, data){

    if(
        ws &&
        ws.readyState === 1
    ){

        try{
            ws.send(JSON.stringify(data));
        }catch(e){}
    }
}


function broadcast(data){

    for(const p of players){

        if(
            p.ws &&
            p.ws.readyState === 1
        ){

            send(p.ws, data);

        }

    }
}


/* =========================
   DECK
========================= */

function makeDeck(){

    const d = [];

    for(const suit of suits){

        for(const rank of ranks){

            d.push({

                rank: rank.n,

                value: rank.v,

                suit: suit

            });

        }

    }


    for(
        let i = d.length - 1;
        i > 0;
        i--
    ){

        const j =
            Math.floor(
                Math.random() * (i + 1)
            );

        [
            d[i],
            d[j]
        ] = [
            d[j],
            d[i]
        ];

    }


    return d;
}


/* =========================
   HAND SCORE
========================= */

function score(cards){

    if(
        !Array.isArray(cards) ||
        cards.length !== 3
    ){

        return [0];

    }


    const values =
        cards
            .map(c => c.value)
            .sort((a,b) => b-a);


    const counts = {};


    for(const value of values){

        counts[value] =
            (counts[value] || 0) + 1;

    }


    const flush =
        cards.every(
            c => c.suit === cards[0].suit
        );


    const unique =
        [...new Set(values)]
            .sort((a,b) => a-b);


    let straight =
        unique.length === 3 &&
        unique[2] - unique[0] === 2;


    /* A-2-3 */

    if(
        unique.join(",") === "2,3,14"
    ){

        straight = true;

    }


    /* Straight Flush */

    if(straight && flush){

        return [
            6,
            Math.max(...values)
        ];

    }


    /* Trio */

    const trio =
        Object.keys(counts)
            .find(
                v => counts[v] === 3
            );


    if(trio){

        return [
            5,
            Number(trio)
        ];

    }


    /* Flush */

    if(flush){

        return [
            4,
            ...values
        ];

    }


    /* Straight */

    if(straight){

        return [
            3,
            Math.max(...values)
        ];

    }


    /* Pair */

    const pair =
        Object.keys(counts)
            .find(
                v => counts[v] === 2
            );


    if(pair){

        const kicker =
            Number(
                Object.keys(counts)
                    .find(
                        v => counts[v] === 1
                    )
            );


        return [
            2,
            Number(pair),
            kicker
        ];

    }


    /* High Card */

    return [
        1,
        ...values
    ];

}


/* =========================
   COMPARE
========================= */

function compare(a,b){

    const sa = score(a);

    const sb = score(b);


    const length =
        Math.max(
            sa.length,
            sb.length
        );


    for(let i=0;i<length;i++){

        const av = sa[i] || 0;

        const bv = sb[i] || 0;


        if(av !== bv){

            return av - bv;

        }

    }


    return 0;

}


/* =========================
   ACTIVE PLAYERS
========================= */

function activePlayers(){

    return players.filter(
        p =>
            p.connected &&
            !p.packed
    );

}


function connectedPlayers(){

    return players.filter(
        p => p.connected
    );

}


/* =========================
   STATE
========================= */

function publicState(){

    return {

        type: "state",

        phase,

        round,

        pot,

        turn:
            turnIndex >= 0 &&
            players[turnIndex]
                ? players[turnIndex].id
                : null,

        players:
            players.map(p => ({

                id: p.id,

                name: p.name,

                seat: p.seat,

                balance: p.balance,

                packed: p.packed,

                connected: p.connected,

                cards: p.cards || []

            }))

    };

}


/* =========================
   BROADCAST PRIVATE STATE
========================= */

function broadcastState(){

    const state = publicState();


    for(const viewer of players){

        if(
            !viewer.ws ||
            viewer.ws.readyState !== 1
        ){

            continue;

        }


        const personal = {

            ...state,

            players:
                state.players.map(p => {

                    /*
                       During playing:
                       only own cards are visible.
                    */

                    if(
                        phase === "playing" &&
                        p.id !== viewer.id
                    ){

                        return {
                            ...p,
                            cards: []
                        };

                    }

                    return p;

                })

        };


        send(
            viewer.ws,
            personal
        );

    }

}


/* =========================
   WAITING STATE
========================= */

function setWaiting(){

    clearTimeout(timer);

    clearTimeout(roundStartTimer);

    clearTimeout(roundEndTimer);

    phase = "waiting";

    turnIndex = -1;

    deck = [];

    pot = 0;


    for(const p of players){

        p.cards = [];

        p.packed = false;

    }


    broadcastState();

}


/* =========================
   FIND NEXT TURN
========================= */

function findNextTurn(){

    const active =
        activePlayers();


    if(active.length === 0){

        turnIndex = -1;

        return false;

    }


    if(active.length === 1){

        finishRound(
            "last-player"
        );

        return false;

    }


    let current =
        turnIndex;


    for(
        let i=0;
        i<players.length;
        i++
    ){

        current =
            (current + 1) %
            players.length;


        const candidate =
            players[current];


        if(
            candidate &&
            candidate.connected &&
            !candidate.packed
        ){

            turnIndex = current;

            startTurnTimer();

            broadcastState();

            return true;

        }

    }


    return false;

}


/* =========================
   TURN TIMER
========================= */

function startTurnTimer(){

    clearTimeout(timer);


    if(
        phase !== "playing" ||
        turnIndex < 0
    ){

        return;

    }


    timer = setTimeout(() => {

        const player =
            players[turnIndex];


        if(
            !player ||
            !player.connected ||
            player.packed
        ){

            return;

        }


        player.packed = true;


        broadcast({

            type: "notice",

            text:
                `${player.name} timed out and packed.`

        });


        if(
            activePlayers().length <= 1
        ){

            finishRound(
                "timeout"
            );

        }else{

            findNextTurn();

        }

    }, TURN_TIME);

}


/* =========================
   START ROUND
========================= */

function startRound(){

    clearTimeout(timer);

    clearTimeout(roundStartTimer);

    clearTimeout(roundEndTimer);


    const connected =
        connectedPlayers();


    if(connected.length < 2){

        setWaiting();

        return;

    }


    phase = "playing";

    round++;

    pot = 0;

    deck = makeDeck();


    for(const p of players){

        p.packed = false;

        p.cards = [];


        if(!p.connected){

            continue;

        }


        p.cards = [

            deck.pop(),

            deck.pop(),

            deck.pop()

        ];


        const contribution =
            Math.min(
                ANTE,
                p.balance
            );


        p.balance -=
            contribution;


        pot +=
            contribution;

    }


    /*
       First connected player starts.
    */

    turnIndex =
        players.findIndex(
            p => p.connected
        );


    broadcast({

        type: "notice",

        text:
            `Round ${round} started.`

    });


    broadcastState();


    startTurnTimer();

}


/* =========================
   AUTO START
========================= */

function scheduleRound(){

    clearTimeout(roundStartTimer);


    if(
        phase !== "waiting"
    ){

        return;

    }


    if(
        connectedPlayers().length < 2
    ){

        return;

    }


    roundStartTimer =
        setTimeout(() => {

            if(
                phase === "waiting" &&
                connectedPlayers().length >= 2
            ){

                startRound();

            }

        }, ROUND_START_DELAY);

}


/* =========================
   FINISH ROUND
========================= */

function finishRound(reason){

    if(
        phase !== "playing"
    ){

        return;

    }


    clearTimeout(timer);


    const active =
        activePlayers();


    if(active.length === 0){

        setWaiting();

        return;

    }


    let winner =
        active[0];


    /*
       If one player remains,
       no comparison needed.
    */

    if(active.length > 1){

        for(
            const player of active.slice(1)
        ){

            if(
                compare(
                    player.cards,
                    winner.cards
                ) > 0
            ){

                winner = player;

            }

        }

    }


    winner.balance += pot;


    phase = "finished";


    broadcast({

        type: "result",

        winnerId: winner.id,

        winnerName: winner.name,

        pot,

        reason,

        cards:
            active.map(
                p => ({
                    id: p.id,
                    name: p.name,
                    cards: p.cards
                })
            )

    });


    broadcastState();


    clearTimeout(roundEndTimer);


    roundEndTimer =
        setTimeout(() => {

            if(
                connectedPlayers().length >= 2
            ){

                phase = "waiting";

                broadcastState();

                scheduleRound();

            }else{

                setWaiting();

            }

        }, ROUND_END_DELAY);

}


/* =========================
   GAME ACTION
========================= */

function act(player, action){

    if(
        !player ||
        !player.connected
    ){

        return;

    }


    if(
        phase !== "playing"
    ){

        send(
            player.ws,
            {
                type: "error",
                text: "Round is not active."
            }
        );

        return;

    }


    if(
        turnIndex < 0 ||
        !players[turnIndex] ||
        players[turnIndex].id !== player.id
    ){

        send(
            player.ws,
            {
                type: "error",
                text: "Wait for your turn."
            }
        );

        return;

    }


    if(player.packed){

        return;

    }


    /* =====================
       PACK
    ===================== */

    if(action === "pack"){

        player.packed = true;


        broadcast({

            type: "notice",

            text:
                `${player.name} packed.`

        });


        if(
            activePlayers().length <= 1
        ){

            finishRound(
                "last-player"
            );

        }else{

            findNextTurn();

        }


        return;

    }


    /* =====================
       SHOW
    ===================== */

    if(action === "show"){

        finishRound("show");

        return;

    }


    /* =====================
       SIDE SHOW
    ===================== */

    if(action === "sideshow"){

        broadcast({

            type: "notice",

            text:
                `${player.name} requested Side Show.`

        });


        /*
           Keep the existing simple
           Side Show behavior.
        */

        findNextTurn();

        return;

    }


    /* =====================
       CHAAL
    ===================== */

    let amount = 0;


    if(action === "chaal"){

        amount = ANTE;

    }


    if(action === "chaal2"){

        amount = ANTE * 2;

    }


    if(amount <= 0){

        return;

    }


    if(player.balance < amount){

        send(
            player.ws,
            {
                type: "error",
                text: "Insufficient chips."
            }
        );

        return;

    }


    player.balance -= amount;

    pot += amount;


    broadcast({

        type: "notice",

        text:
            `${player.name} played ${
                action === "chaal2"
                    ? "Chaal 2x"
                    : "Chaal"
            }.`

    });


    findNextTurn();

}


/* =========================
   REMOVE DISCONNECTED
========================= */

function removeDisconnected(){

    const oldLength =
        players.length;


    players =
        players.filter(
            p => p.connected
        );


    /*
       Reassign seats 0-3
    */

    players.forEach(
        (p,index) => {

            p.seat = index;

        }
    );


    if(
        players.length !== oldLength
    ){

        if(
            connectedPlayers().length < 2
        ){

            /*
               Critical fix:
               Never leave game in "playing"
               with only one player.
            */

            setWaiting();

        }else if(
            phase === "playing"
        ){

            /*
               Make sure turn still points
               to a valid player.
            */

            if(
                turnIndex >= players.length ||
                !players[turnIndex] ||
                !players[turnIndex].connected ||
                players[turnIndex].packed
            ){

                turnIndex =
                    players.findIndex(
                        p =>
                            p.connected &&
                            !p.packed
                    );

            }


            broadcastState();

            startTurnTimer();

        }else{

            broadcastState();

            scheduleRound();

        }

    }

}


/* =========================
   WEBSOCKET
========================= */

wss.on(
    "connection",
    (ws, request) => {

        /*
           Reject when table is full.
        */

        if(
            connectedPlayers().length >= MAX_PLAYERS
        ){

            send(
                ws,
                {
                    type: "full",
                    text: "Table is full."
                }
            );

            ws.close();

            return;

        }


        const url =
            new URL(
                request.url,
                `http://${request.headers.host}`
            );


        const requestedName =
            safeName(
                url.searchParams.get("name"),
                `Player ${players.length + 1}`
            );


        const id =
            Math.random()
                .toString(36)
                .slice(2,10);


        const seat =
            players.length;


        const player = {

            id,

            ws,

            seat,

            name:
                requestedName,

            balance:
                START_BALANCE,

            cards: [],

            packed: false,

            connected: true,

            isAlive: true

        };


        players.push(player);


        /*
           WELCOME
        */

        send(
            ws,
            {
                type: "welcome",

                id: player.id,

                seat: player.seat,

                name: player.name
            }
        );


        broadcast({

            type: "notice",

            text:
                `${player.name} joined the table.`

        });


        /*
           Correct initial state.
        */

        broadcastState();


        /*
           Start only when 2+
           players are connected.
        */

        scheduleRound();


        /* =====================
           MESSAGE
        ===================== */

        ws.on(
            "message",
            raw => {

                try{

                    const message =
                        JSON.parse(
                            raw.toString()
                        );


                    if(
                        message.type === "action"
                    ){

                        act(
                            player,
                            message.action
                        );

                    }

                }catch(error){

                    send(
                        ws,
                        {
                            type: "error",
                            text: "Invalid message."
                        }
                    );

                }

            }
        );


        /* =====================
           PONG
        ===================== */

        ws.on(
            "pong",
            () => {

                player.isAlive = true;

            }
        );


        /* =====================
           ERROR
        ===================== */

        ws.on(
            "error",
            () => {

                player.connected = false;

            }
        );


        /* =====================
           CLOSE
        ===================== */

        ws.on(
            "close",
            () => {

                player.connected = false;


                clearTimeout(timer);


                broadcast({

                    type: "notice",

                    text:
                        `${player.name} disconnected.`

                });


                /*
                   Critical:
                   if fewer than 2 remain,
                   return to WAITING.
                */

                if(
                    connectedPlayers().length < 2
                ){

                    setWaiting();

                }else{

                    if(
                        phase === "playing"
                    ){

                        if(
                            turnIndex >= 0 &&
                            players[turnIndex] &&
                            players[turnIndex].id === player.id
                        ){

                            findNextTurn();

                        }else{

                            broadcastState();

                        }

                    }else{

                        broadcastState();

                        scheduleRound();

                    }

                }


                /*
                   Remove disconnected
                   players from table.
                */

                setTimeout(
                    removeDisconnected,
                    100
                );

            }
        );

    }
);


/* =========================
   HEARTBEAT
========================= */

const heartbeat =
    setInterval(
        () => {

            for(const p of players){

                if(
                    !p.ws ||
                    p.ws.readyState !== 1
                ){

                    continue;

                }


                if(p.isAlive === false){

                    p.connected = false;

                    try{
                        p.ws.terminate();
                    }catch(e){}

                    continue;

                }


                p.isAlive = false;


                try{
                    p.ws.ping();
                }catch(e){}

            }

        },
        30000
    );


/* =========================
   HEALTH
========================= */

app.get(
    "/health",
    (req,res) => {

        res.json({

            ok: true,

            players:
                connectedPlayers().length,

            maxPlayers:
                MAX_PLAYERS,

            phase,

            round,

            pot

        });

    }
);


/* =========================
   ROOT
========================= */

app.get(
    "/",
    (req,res) => {

        res.sendFile(
            path.join(
                __dirname,
                "index.html"
            )
        );

    }
);


/* =========================
   SHUTDOWN
========================= */

function shutdown(){

    clearInterval(heartbeat);

    clearTimeout(timer);

    clearTimeout(roundStartTimer);

    clearTimeout(roundEndTimer);


    for(const p of players){

        try{

            p.ws.close();

        }catch(e){}

    }


    server.close(
        () => process.exit(0)
    );

}


process.on(
    "SIGTERM",
    shutdown
);

process.on(
    "SIGINT",
    shutdown
);


/* =========================
   START
========================= */

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Teen Patti server running on port ${PORT}`
        );

    }
);
