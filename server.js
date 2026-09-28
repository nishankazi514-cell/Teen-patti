const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get("/health",(req,res)=>{
    res.json({
        ok:true,
        players:players.filter(p=>p.connected).length,
        maxPlayers:4
    });
});

const MAX_PLAYERS=4;
const START_BALANCE=13460;
const ANTE=100;

let players=[];
let phase="waiting";
let pot=0;
let roundNumber=0;
let turnSeat=0;
let turnTimer=null;

function makeId(){
    return crypto.randomUUID();
}

function createDeck(){

    const suits=["♠","♥","♦","♣"];
    const ranks=[
        "2","3","4","5","6","7","8",
        "9","10","J","Q","K","A"
    ];

    const deck=[];

    for(const suit of suits){
        for(const rank of ranks){

            let value=Number(rank);

            if(rank==="J") value=11;
            if(rank==="Q") value=12;
            if(rank==="K") value=13;
            if(rank==="A") value=14;

            deck.push({
                rank,
                suit,
                value
            });
        }
    }

    return deck;
}

function shuffle(deck){

    for(let i=deck.length-1;i>0;i--){

        const j=Math.floor(Math.random()*(i+1));

        [deck[i],deck[j]]=[
            deck[j],
            deck[i]
        ];
    }

    return deck;
}

function cardText(card){
    return card.rank+card.suit;
}

function activePlayers(){

    return players.filter(
        p=>p.connected&&!p.packed
    );
}

function currentPlayer(){

    return players.find(
        p=>p.connected &&
        !p.packed &&
        p.seat===turnSeat
    );
}

function handScore(cards){

    const values=cards
        .map(c=>c.value)
        .sort((a,b)=>b-a);

    const flush=
        cards.every(
            c=>c.suit===cards[0].suit
        );

    const count={};

    values.forEach(v=>{
        count[v]=(count[v]||0)+1;
    });

    const groups=
        Object.entries(count)
        .sort((a,b)=>b[1]-a[1]);

    const unique=[...new Set(values)];

    let straight=false;
    let straightHigh=values[0];

    if(
        unique.length===3 &&
        unique[0]===14 &&
        unique[1]===3 &&
        unique[2]===2
    ){
        straight=true;
        straightHigh=3;
    }

    if(
        unique.length===3 &&
        unique[0]===unique[1]+1 &&
        unique[1]===unique[2]+1
    ){
        straight=true;
        straightHigh=unique[0];
    }

    if(straight&&flush){
        return [5,straightHigh];
    }

    if(groups[0][1]===3){
        return [4,Number(groups[0][0])];
    }

    if(flush){
        return [3,...values];
    }

    if(straight){
        return [2,straightHigh];
    }

    if(groups[0][1]===2){

        const pair=Number(groups[0][0]);

        const kicker=
            values.find(v=>v!==pair);

        return [1,pair,kicker];
    }

    return [0,...values];
}

function compare(a,b){

    const A=handScore(a.cards);
    const B=handScore(b.cards);

    const len=Math.max(A.length,B.length);

    for(let i=0;i<len;i++){

        const av=A[i]||0;
        const bv=B[i]||0;

        if(av!==bv){
            return av-bv;
        }
    }

    return 0;
}

function stateFor(viewer){

    return {
        type:"state",
        phase,
        round:roundNumber,
        pot,
        turnPlayerId:
            currentPlayer()
            ? currentPlayer().id
            : null,

        players:players.map(player=>({

            id:player.id,
            name:player.name,
            seat:player.seat,
            balance:player.balance,
            packed:player.packed,
            connected:player.connected,

            cards:
                player.id===viewer.id ||
                phase==="finished"
                ? player.cards.map(cardText)
                : [null,null,null]
        }))
    };
}

function broadcast(){

    players.forEach(player=>{

        if(
            player.ws &&
            player.ws.readyState===WebSocket.OPEN
        ){

            player.ws.send(
                JSON.stringify(
                    stateFor(player)
                )
            );
        }
    });
}

function notice(message){

    players.forEach(player=>{

        if(
            player.ws &&
            player.ws.readyState===WebSocket.OPEN
        ){

            player.ws.send(
                JSON.stringify({
                    type:"notice",
                    message
                })
            );
        }
    });
}

function startRound(){

    if(phase==="playing"){
        return;
    }

    const connected=
        players.filter(p=>p.connected);

    if(connected.length<2){

        phase="waiting";

        broadcast();

        return;
    }

    roundNumber++;
    phase="playing";
    pot=0;

    connected.forEach(player=>{

        player.cards=[];
        player.packed=false;
        player.bet=0;

        const amount=
            Math.min(
                ANTE,
                player.balance
            );

        player.balance-=amount;
        player.bet+=amount;
        pot+=amount;
    });

    const deck=shuffle(createDeck());

    for(let i=0;i<3;i++){

        connected.forEach(player=>{
            player.cards.push(
                deck.pop()
            );
        });
    }

    const first=
        connected.sort(
            (a,b)=>a.seat-b.seat
        )[0];

    turnSeat=first.seat;

    broadcast();

    startTimer();
}

function startTimer(){

    clearTimeout(turnTimer);

    turnTimer=setTimeout(()=>{

        const player=currentPlayer();

        if(player){

            player.packed=true;

            notice(
                player.name+
                " timed out"
            );
        }

        nextTurn();

    },20000);
}

function nextTurn(){

    const active=activePlayers();

    if(active.length<=1){

        finishRound();

        return;
    }

    const seats=
        active
        .map(p=>p.seat)
        .sort((a,b)=>a-b);

    let next=null;

    for(const seat of seats){

        if(seat>turnSeat){

            next=seat;

            break;
        }
    }

    if(next===null){
        next=seats[0];
    }

    turnSeat=next;

    broadcast();

    startTimer();
}

function finishRound(){

    clearTimeout(turnTimer);

    const active=activePlayers();

    if(active.length===0){

        phase="finished";

        broadcast();

        setTimeout(()=>{

            phase="waiting";
            broadcast();

        },4000);

        return;
    }

    let winner=active[0];

    for(let i=1;i<active.length;i++){

        if(
            compare(
                active[i],
                winner
            )>0
        ){
            winner=active[i];
        }
    }

    winner.balance+=pot;

    phase="finished";

    broadcast();

    const result={
        type:"result",
        message:
            winner.name+
            " wins ₹"+
            pot.toLocaleString()
    };

    players.forEach(player=>{

        if(
            player.ws &&
            player.ws.readyState===WebSocket.OPEN
        ){

            player.ws.send(
                JSON.stringify(result)
            );
        }
    });

    setTimeout(()=>{

        const connected=
            players.filter(p=>p.connected);

        if(connected.length>=2){
            startRound();
        }else{

            phase="waiting";
            broadcast();
        }

    },5000);
}

function action(player,type){

    if(phase!=="playing"){
        return;
    }

    if(player.packed){
        return;
    }

    const current=currentPlayer();

    if(!current || current.id!==player.id){

        player.ws.send(
            JSON.stringify({
                type:"error",
                message:"Not your turn"
            })
        );

        return;
    }

    if(type==="pack"){

        player.packed=true;

        notice(
            player.name+" packed"
        );

        nextTurn();

        return;
    }

    if(type==="chaal"){

        if(player.balance<ANTE){

            player.packed=true;

            notice(
                player.name+
                " has insufficient balance"
            );

            nextTurn();

            return;
        }

        player.balance-=ANTE;
        player.bet+=ANTE;
        pot+=ANTE;

        nextTurn();

        return;
    }

    if(type==="chaal2"){

        const amount=ANTE*2;

        if(player.balance<amount){

            player.packed=true;

            notice(
                player.name+
                " has insufficient balance"
            );

            nextTurn();

            return;
        }

        player.balance-=amount;
        player.bet+=amount;
        pot+=amount;

        nextTurn();

        return;
    }

    if(type==="show"){

        finishRound();

        return;
    }

    if(type==="sideshow"){

        notice(
            player.name+
            " requested Side Show"
        );

        nextTurn();
    }
}

wss.on("connection",(ws)=>{

    let player=null;

    ws.on("message",(raw)=>{

        let data;

        try{
            data=JSON.parse(
                raw.toString()
            );
        }catch{
            return;
        }

        if(data.type==="join"){

            if(player){
                return;
            }

            const connected=
                players.filter(
                    p=>p.connected
                );

            if(connected.length>=MAX_PLAYERS){

                ws.send(
                    JSON.stringify({
                        type:"full"
                    })
                );

                return;
            }

            const used=
                connected.map(
                    p=>p.seat
                );

            let seat=0;

            while(used.includes(seat)){
                seat++;
            }

            player={
                id:makeId(),
                ws,
                seat,
                name:String(
                    data.name||"Player"
                )
                .trim()
                .slice(0,14),

                balance:START_BALANCE,
                cards:[],
                packed:false,
                connected:true,
                bet:0
            };

            players.push(player);

            ws.send(
                JSON.stringify({
                    type:"welcome",
                    id:player.id,
                    seat:player.seat
                })
            );

            broadcast();

            if(
                players.filter(
                    p=>p.connected
                ).length>=2 &&
                phase==="waiting"
            ){

                setTimeout(
                    startRound,
                    1000
                );
            }

            return;
        }

        if(!player){
            return;
        }

        if([
            "pack",
            "chaal",
            "chaal2",
            "show",
            "sideshow"
        ].includes(data.type)){

            action(
                player,
                data.type
            );
        }
    });

    ws.on("close",()=>{

        if(!player){
            return;
        }

        player.connected=false;

        if(
            phase==="playing" &&
            !player.packed
        ){

            player.packed=true;

            if(
                currentPlayer()===null
            ){
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
        "Teen Patti server running on port "+
        PORT
    );
});
