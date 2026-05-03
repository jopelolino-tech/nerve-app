const express = require('express');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const selfsigned = require('selfsigned');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const attrs = [{ name: 'commonName', value: 'localhost' }];
const pems = selfsigned.generate(attrs, { days: 365 });

const httpsServer = https.createServer({ key: pems.private, cert: pems.cert }, app);
const httpServer  = http.createServer((req, res) => {
  res.writeHead(301, { Location: `https://${req.headers.host.split(':')[0]}:3443${req.url}` });
  res.end();
});

const wss = new WebSocket.Server({ server: httpsServer });

const queue = [], rooms = new Map(), players = new Map();
const ELO_WIN = 25, ELO_LOSE = 18;

function getRank(elo) {
  if (elo >= 4500) return { name: 'Nerve God', icon: '💀' };
  if (elo >= 3001) return { name: 'Void', icon: '👁️' };
  if (elo >= 1801) return { name: 'Venom', icon: '🐍' };
  if (elo >= 801)  return { name: 'Ice Cold', icon: '🧊' };
  return { name: 'Stone Face', icon: '🪨' };
}
function send(ws, data) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function broadcast(room, data, exclude = null) { room.players.forEach(p => { if (p !== exclude) send(p, data); }); }

function tryMatchmake() {
  while (queue.length >= 2) {
    const p1 = queue.shift(), p2 = queue.shift();
    if (p1.readyState !== WebSocket.OPEN) { queue.unshift(p2); continue; }
    if (p2.readyState !== WebSocket.OPEN) { queue.unshift(p1); continue; }
    const roomId = uuidv4();
    const room = { players: [p1, p2], started: false, startTime: null, timeoutHandled: false };
    rooms.set(roomId, room);
    const i1 = players.get(p1), i2 = players.get(p2);
    i1.roomId = i2.roomId = roomId;
    send(p1, { type:'matched', roomId, opponent:{ username:i2.username, elo:i2.elo, rank:getRank(i2.elo) }, role:'offerer' });
    send(p2, { type:'matched', roomId, opponent:{ username:i1.username, elo:i1.elo, rank:getRank(i1.elo) }, role:'answerer' });
    console.log(`Room: ${i1.username} vs ${i2.username}`);
  }
}

wss.on('connection', ws => {
  const id = uuidv4();
  players.set(ws, { id, username:'anon', elo:1200, roomId:null });
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const pl = players.get(ws);
    switch (msg.type) {
      case 'join':
        pl.username = msg.username || 'anon_'+id.slice(0,4);
        pl.elo = msg.elo || 1200;
        send(ws, { type:'joined', id, username:pl.username, elo:pl.elo, rank:getRank(pl.elo) });
        break;
      case 'queue':
        if (!queue.includes(ws)) { queue.push(ws); tryMatchmake(); }
        send(ws, { type:'queuing', position: queue.length });
        break;
      case 'dequeue':
        const qi = queue.indexOf(ws); if (qi>-1) queue.splice(qi,1);
        send(ws, { type:'dequeued' }); break;
      case 'offer': case 'answer': case 'ice': {
        const room = rooms.get(pl.roomId); if (room) broadcast(room, msg, ws); break;
      }
      case 'challenge_select': {
        const room = rooms.get(pl.roomId);
        if (!room || room.started) break;
        room.started = true; room.startTime = Date.now();
        broadcast(room, { type:'challenge_start', challenge: msg.challenge }); break;
      }
      case 'fail': {
        const room = rooms.get(pl.roomId); if (!room) break;
        const elapsed = ((Date.now()-room.startTime)/1000).toFixed(1);
        room.players.forEach(p => {
          send(p, { type:'game_end', won:p!==ws, loserName:pl.username, elapsed, eloDelta:p!==ws?ELO_WIN:-ELO_LOSE });
          players.get(p).elo += p!==ws?ELO_WIN:-ELO_LOSE;
        });
        rooms.delete(pl.roomId); room.players.forEach(p=>{players.get(p).roomId=null;}); break;
      }
      case 'timeout_win': {
        const room = rooms.get(pl.roomId); if (!room||room.timeoutHandled) break;
        room.timeoutHandled = true;
        const elapsed = ((Date.now()-room.startTime)/1000).toFixed(1);
        room.players.forEach(p => {
          send(p, { type:'game_end', won:p===ws, elapsed, eloDelta:p===ws?ELO_WIN:-ELO_LOSE });
          players.get(p).elo += p===ws?ELO_WIN:-ELO_LOSE;
        });
        rooms.delete(pl.roomId); room.players.forEach(p=>{players.get(p).roomId=null;}); break;
      }
      case 'ping': send(ws, { type:'pong' }); break;
    }
  });
  ws.on('close', () => {
    const pl = players.get(ws);
    const qi = queue.indexOf(ws); if(qi>-1) queue.splice(qi,1);
    if (pl?.roomId) {
      const room = rooms.get(pl.roomId);
      if (room) { broadcast(room, { type:'opponent_disconnected' }, ws); rooms.delete(pl.roomId); }
    }
    players.delete(ws);
  });
  ws.on('error', console.error);
});

app.get('/api/stats', (req, res) => res.json({ online: players.size, inQueue: queue.length, activeGames: rooms.size }));

httpsServer.listen(3443, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(nets))
    for (const net of nets[name])
      if (net.family==='IPv4' && !net.internal) { localIP = net.address; break; }
  console.log('\n NERVE corriendo!\n');
  console.log('  PC:    https://localhost:3443');
  console.log(`  Movil: https://${localIP}:3443\n`);
  console.log('  En movil: pulsa "Avanzado" > "Acceder de todas formas"\n');
});
httpServer.listen(3000, '0.0.0.0');
