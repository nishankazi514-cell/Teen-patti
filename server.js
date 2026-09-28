const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get("/health", (req,res)=>{
    res.json({
        ok:true,
        players:players.length,
        maxPlayers:4
    });
});

const MAX_PLAYERS = 4;
const START_BALANCE = 13460;
const ANTE = 100;

let players = [];
let roundNumber = 0;
let phase = "waiting";
let pot = 0;
let turnIndex = 0;
let turnTimer = null;

function id(){
    return crypto.randomUUID();
}

function shuffle(deck){

    for(let i=deck.length-1;i>0;i--){

        const j =
            Math.floor(Math.random()*(i+1));

        [deck[i],deck[j]] =
            [deck[j],deck[i]];
    }

    return deck;
}

function createDeck(){

    const suits = ["♠","♥","♦","♣"];
    const ranks = [
        "2","3","4","5","6","7","8","9",
        "10","J","Q","K","A"
    ];

    const deck = [];

    for(const suit of suits){

        for(const rank of ranks){

            deck.push({
                rank,
                suit,
                value:
                    rank === "A"
                    ? 14
                    : rank === "K"
                    ? 13
                    : rank === "Q"
                    ? 12
                    : rank === "J"
                    ? 11
                    : Number(rank)
            });
        }
    }

    return deck;
}

function cardText(card){
    return card.rank + card.suit;
}

function evaluate(cards){

    const values =
        cards
        .map(c=>c.value)
        .sort((a,b)=>b-a);

    const flush =
        cards.every(c=>c.suit === cards[0].suit);

    const unique =
        [...new Set(values)];

    let straight = false;
    let high = values[0];

    if(
        unique.length === 3 &&
        unique[0] === 14 &&
        unique[1] === 3 &&
        unique[2] === 2
    ){
        straight = true;
        high = 3;
    }else if(
        unique.length === 3 &&
        unique[0] === unique[1]+1 &&
        unique[1] === unique[2]+1
    ){
        straight = true;
        high = unique[0];
    }

    const counts = {};

    values.forEach(v=>{
        counts[v] =
            (counts[v] || 0) + 1;
    });

    const countValues =
        Object.values(counts)
        .sort((a,b)=>b-a);

    if(straight && flush){
        return {
            rank:5,
            values:[high],
            name:"Straight Flush"
        };
    }

    if(countValues[0] === 3){
        return {
            rank:4,
            values:[values[0]],
            name:"Trail"
        };
    }

    if(flush){
        return {
            rank:3,
            values,
            name:"Color"
        };
    }

    if(straight){
        return {
            rank:2,
            values:[high],
            name:"Straight"
        };
    }

    if(countValues[0] === 2){

        const pair =
            Number(
                Object.keys(counts)
                .find(v=>counts[v] === 2)
            );

        const kicker =
            values.find(v=>v !== pair);

        return {
            rank:1,
            values:[pair,kicker],
            name:"Pair"
        };
    }

    return {
        rank:0,
        values,
        name:"High Card"
    };
}

function compareHands(a,b){

    const ea = evaluate(a.cards);
    const eb = evaluate(b.cards);

    if(ea.rank !== eb.rank){
        return ea.rank - eb.rank;
    }

    const length =
        Math.max(
            ea.values.length,
            eb.values.length
        );

    for(let i=0;i<length;i++){

        const av = ea.values[i] || 0;
        const bv = eb.values[i] || 0;

        if(av !== bv){
            return av - bv;
        }
    }

    return 0;
}

function publicPlayer(player){

    const showCards =
        phase === "finished" ||
        player.id === currentPlayerId();

    return {
        id:player.id,
        name:player.name,
        seat:player.seat,
        balance:player.balance,
        packed:player.packed,
        connected:player.connected,
        cards:showCards
            ? player.cards.map(cardText)
            : ["","",""]
    };
}

function currentPlayerId(){

    if(!players.length){
        return null;
    }

    const active =
        players.filter(p=>!p.packed);

    if(!active.length){
        return null;
    }

    const current =
        active.find(
            p=>p.turnOrder === turnIndex
        );

    return current ? current.id : null;
}

function broadcast(){

    const message = JSON.stringify({
        type:"state",
        phase,
        round:roundNumber,
        pot,
        turnPlayerId:currentPlayerId(),
        players:players.map(publicPlayer)
    });

    players.forEach(player=>{

        if(
            player.ws &&
            player.ws.readyState === WebSocket.OPEN
        ){
            player.ws.send(message);
        }
    });
}

function notice(message){

    const data =
        JSON.stringify({
            type:"notice",
            message
        });

    players.forEach(player=>{

        if(
            player.ws &&
            player.ws.readyState === WebSocket.OPEN
        ){
            player.ws.send(data);
        }
    });
}

function startRound(){

    if(phase === "playing"){
        return;
    }

    const connected =
        players.filter(p=>p.connected);

    if(connected.length < 2){
        phase = "waiting";
        broadcast();
        return;
    }

    roundNumber++;

    phase = "playing";

    pot = 0;

    connected.forEach((player,index)=>{

        player.cards = [];
        player.packed = false;
        player.turnOrder = index;

        const paid =
            Math.min(ANTE,player.balance);

        player.balance -= paid;
        pot += paid;
    });

    const deck = shuffle(createDeck());

    for(let i=0;i<3;i++){

        connected.forEach(player=>{
            player.cards.push(deck.pop());
        });
    }

    turnIndex = 0;

    broadcast();

    startTurnTimer();
}

function activePlayers(){

    return players.filter(
        p=>p.connected && !p.packed
    );
}

function nextTurn(){

    const active = activePlayers();

    if(active.length <= 1){

        finishRound();

        return;
    }

    const current =
        active.findIndex(
            p=>p.turnOrder === turnIndex
        );

    const next =
        current < 0
        ? 0
        : (current + 1) % active.length;

    turnIndex =
        active[next].turnOrder;

    broadcast();

    startTurnTimer();
}

function startTurnTimer(){

    clearTimeout(turnTimer);

    turnTimer =
        setTimeout(()=>{

            const player =
                players.find(
                    p=>p.turnOrder === turnIndex
                );

            if(
                player &&
                !player.packed
            ){

                player.packed = true;

                notice(
                    player.name +
                    " packed by timeout"
                );
            }

            nextTurn();

        },20000);
}

function finishRound(){

    clearTimeout(turnTimer);

    const active = activePlayers();

    if(!active.length){

        phase = "finished";
        broadcast();

        setTimeout(startRound,5000);

        return;
    }

    let winner = active[0];

    for(let i=1;i<active.length;i++){

        if(
            compareHands(
                active[i],
                winner
            ) > 0
        ){
            winner = active[i];
        }
    }

    winner.balance += pot;

    phase = "finished";

    broadcast();

    const result =
        JSON.stringify({
            type:"result",
            message:
                winner.name +
                " wins ₹" +
                pot.toLocaleString()
        });

    players.forEach(player=>{

        if(
            player.ws &&
            player.ws.readyState === WebSocket.OPEN
        ){
            player.ws.send(result);
        }
    });

    setTimeout(()=>{

        if(
            players.filter(p=>p.connected).length >= 2
        ){
            startRound();
        }else{
            phase = "waiting";
            broadcast();
        }

    },5000);
}

function playerAction(player,type){

    if(phase !== "playing"){
        return;
    }

    if(player.packed){
        return;
    }

    if(player.id !== currentPlayerId()){
        player.ws.send(JSON.stringify({
            type:"error",
            message:"Not your turn"
        }));
        return;
    }

    if(type === "pack"){

        player.packed = true;

        notice(
            player.name + " packed"
        );

        nextTurn();

        return;
    }

    if(type === "chaal"){

        const amount = ANTE;

        if(player.balance < amount){

            player.packed = true;

            notice(
                player.name +
                " has insufficient balance"
            );

            nextTurn();

            return;
        }

        player.balance -= amount;
        pot += amount;

        nextTurn();

        return;
    }

    if(type === "chaal2"){

        const amount = ANTE * 2;

        if(player.balance < amount){

            player.packed = true;

            notice(
                player.name +
                " has insufficient balance"
            );

            nextTurn();

            return;
        }

        player.balance -= amount;
        pot += amount;

        nextTurn();

        return;
    }

    if(type === "show"){

        finishRound();

        return;
    }

    if(type === "sideshow"){

        notice(
            player.name +
            " requested Side Show"
        );

        nextTurn();

        return;
    }
}

wss.on("connection",(ws)=>{

    let player = null;

    ws.send(JSON.stringify({
        type:"connected",
        message:"Connected to Teen Patti server"
    }));

    ws.on("message",(raw)=>{

        let data;

        try{
            data =
                JSON.parse(raw.toString());
        }catch{
            return;
        }

        if(data.type === "join"){

            if(player){
                return;
            }

            if(
                players.filter(p=>p.connected)
                .length >= MAX_PLAYERS
            ){

                ws.send(JSON.stringify({
                    type:"full"
                }));

                return;
            }

            const occupied =
                players
                .filter(p=>p.connected)
                .map(p=>p.seat);

            let seat = 0;

            while(occupied.includes(seat)){
                seat++;
            }

            player = {
                id:id(),
                ws,
                seat,
                name:
                    String(data.name || "Player")
                    .trim()
                    .slice(0,14),
                balance:START_BALANCE,
                cards:[],
                packed:false,
                connected:true,
                turnOrder:seat
            };

            players.push(player);

            ws.send(JSON.stringify({
                type:"welcome",
                id:player.id,
                seat:player.seat
            }));

            broadcast();

            if(
                players.filter(p=>p.connected)
                .length >= 2 &&
                phase === "waiting"
            ){

                setTimeout(startRound,1200);
            }

            return;
        }

        if(!player){
            return;
        }

        if(
            [
                "pack",
                "chaal",
                "chaal2",
                "show",
                "sideshow"
            ].includes(data.type)
        ){

            playerAction(
                player,
                data.type
            );
        }
    });

    ws.on("close",()=>{

        if(!player){
            return;
        }

        player.connected = false;

        if(phase === "playing"){

            player.packed = true;

            if(player.id === currentPlayerId()){
                nextTurn();
            }else{
                broadcast();
            }

        }else{

            broadcast();
        }
    });
});

server.listen(PORT,()=>{

    console.log(
        `Teen Patti server running on port ${PORT}`
    );

});
