const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// 核心修改 1：确保 data 目录存在
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// 核心修改 2：数据库路径指向 data 文件夹内
const DB_FILE = path.join(dataDir, 'data.json');
const WWW_DIR = path.join(__dirname, 'www');
let certData = null;
(function tryLoadCert() {
  const paths = [
    path.join(__dirname, 'cert'),
    path.join(__dirname, 'www', 'cert')
  ];
  for (const dir of paths) {
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      try {
        certData = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
        console.log('✓ 已成功加载证书: ' + certPath);
        return;
      } catch (e) { console.log('✗ 证书读取失败: ' + e.message); }
    }
  }
  console.log('⚠ 未找到证书，尝试使用 selfsigned 自动生成...');
  try {
    const selfsigned = require('selfsigned');
    const os = require('os');
    let ip = 'localhost';
    const nets = os.networkInterfaces();
    for (const n of Object.keys(nets)) {
      for (const net of nets[n]) {
        if (net.family === 'IPv4' && !net.internal) { ip = net.address; break; }
      }
    }
    const pems = selfsigned.generate([{ name: 'commonName', value: ip }], { days: 3650 });
    const dir = path.join(__dirname, 'cert');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'key.pem'), pems.private);
    fs.writeFileSync(path.join(dir, 'cert.pem'), pems.cert);
    certData = { key: pems.private, cert: pems.cert };
    console.log('✓ 证书已自动生成: ' + dir);
  } catch (e) {
    console.log('⚠ 生成失败，语音功能将不可用');
  }
})();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ico': 'image/x-icon'
};

function handleRequest(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.indexOf('..') >= 0) { res.writeHead(403); res.end('Forbidden'); return; }
  const filePath = path.join(WWW_DIR, urlPath);
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) { res.writeHead(404); res.end('404 Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(filePath).pipe(res);
  });
}

function attachWs(server) {
  const wss = new WebSocket.Server({ server });
  let rooms = {};
  function generateRoomId() { return Math.floor(100000 + Math.random() * 900000).toString(); }
  function getSeatData(room) {
    return room.seats.map((s, i) => {
      if (!s) return { type: 'empty', name: '空位', playerId: '' };
      var ns = (s.type === 'ai') ? -1 : (typeof s.netSeat === 'number' ? s.netSeat : i);
      var sd = { type: s.type, netSeat: ns, name: s.name || ('玩家' + (i+1)), playerId: '' };
      if (s.avatarUrl) sd.avatarUrl = s.avatarUrl;
      return sd;
    });
  }
  function broadcastSeatData(room) {
    const seatData = getSeatData(room);
    const humanCount = room.seats.filter(s => s && s.type === 'human').length;
    room.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'action', data: { type: 'sync-seats', seatData: seatData, count: humanCount, myNetSeat: client.seatId } }));
      }
    });
  }
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data); } catch (e) { return; }
      const room = ws.roomId ? rooms[ws.roomId] : null;

      if (msg.type === 'create') {
        const roomId = generateRoomId();
        const newRoom = { id: roomId, config: msg.config, clients: [ws], seats: [{ type: 'human', name: '房主', isHost: true }, null, null, null] };
        rooms[roomId] = newRoom; ws.roomId = roomId; ws.seatId = 0;
        ws.send(JSON.stringify({ type: 'created', roomId, seat: 0, config: newRoom.config }));
        broadcastSeatData(newRoom); return;
      }
      if (msg.type === 'get-rooms') {
        const roomList = [];
        for (const id in rooms) {
          const r = rooms[id];
          if (!r.started && r.seats) {
            const emptyCount = r.seats.filter(s => !s).length;
            if (emptyCount > 0) {
              let hostName = '未知房主', hostAvatar = '';
              for (let i = 0; i < 4; i++) {
                if (r.seats[i] && r.seats[i].isHost) { hostName = r.seats[i].name || '房主'; hostAvatar = r.seats[i].avatarUrl || ''; break; }
              }
              roomList.push({ id: id, hostName, hostAvatar, gameName: (r.config && r.config.game === 'dy') ? '勾圆' : '板子炮', emptyCount });
            }
          }
        }
        ws.send(JSON.stringify({ type: 'rooms-list', rooms: roomList })); return;
      }
      if (msg.type === 'join') {
        const targetRoom = rooms[msg.roomId];
        if (!targetRoom) { ws.send(JSON.stringify({ type: 'error-msg', msg: '房间不存在' })); return; }
        let emptySeat = targetRoom.seats.findIndex(s => s === null);
        if (emptySeat === -1) { ws.send(JSON.stringify({ type: 'error-msg', msg: '房间已满' })); return; }
        targetRoom.seats[emptySeat] = { type: 'human', name: '玩家' + (emptySeat + 1), isHost: false };
        targetRoom.clients.push(ws); ws.roomId = msg.roomId; ws.seatId = emptySeat;
        const humanCount = targetRoom.seats.filter(s => s && s.type === 'human').length;
        ws.send(JSON.stringify({ type: 'joined', roomId: msg.roomId, seat: emptySeat, config: targetRoom.config, count: humanCount }));
        broadcastSeatData(targetRoom); return;
      }
      if (!room) return;

      if (msg.type === 'action' && msg.data && msg.data.type === 'sync-seats') {
        const sd = msg.data.seatData;
        sd.forEach((s, idx) => {
          if (s.type === 'empty') room.seats[idx] = null;
          else {
            let isHost = false;
            if (s.type === 'human') isHost = !!(room.seats[idx] && room.seats[idx].isHost);
            room.seats[idx] = { type: s.type, name: s.name, isHost: isHost, netSeat: (typeof s.netSeat === 'number' ? s.netSeat : idx) };
            if (s.avatarUrl) room.seats[idx].avatarUrl = s.avatarUrl;
          }
        });
        const anyHost = room.seats.some(s => s && s.isHost);
        if (!anyHost) {
          const myIdx = room.seats.findIndex(s => s && s.type === 'human' && s.netSeat === ws.seatId);
          if (myIdx >= 0) room.seats[myIdx].isHost = true;
        }
        broadcastSeatData(room); return;
      }
      if (msg.type === 'add-ai') {
         if (room.seats[ws.seatId] && room.seats[ws.seatId].isHost) {
            let empty = msg.targetSeat != null ? msg.targetSeat : room.seats.findIndex(s => s === null);
            if (empty !== -1 && room.seats[empty] === null) { room.seats[empty] = { type: 'ai', name: 'AI-' + (empty + 1) }; broadcastSeatData(room); }
         }
         return;
      }
      if (msg.type === 'remove-ai') {
         if (room.seats[ws.seatId] && room.seats[ws.seatId].isHost) {
            const target = msg.targetSeat;
            if (room.seats[target] && room.seats[target].type === 'ai') { room.seats[target] = null; broadcastSeatData(room); }
         }
         return;
      }
      if (msg.type === 'switch-seat') {
        const target = msg.targetSeat, mySeat = ws.seatId;
        if (target < 0 || target > 3 || target === mySeat) return;
        if (room.seats[target] && room.seats[target].type === 'human') return;
        const temp = room.seats[mySeat]; room.seats[mySeat] = room.seats[target]; room.seats[target] = temp;
        room.clients.forEach(c => {
           if (c.seatId === target) c.seatId = mySeat;
           else if (c.seatId === mySeat) c.seatId = target;
        });
        broadcastSeatData(room); return;
      }
      if (msg.type === 'update-profile') {
        const _r0 = ws.roomId ? rooms[ws.roomId] : null;
        if (_r0 && _r0.seats[ws.seatId] && _r0.seats[ws.seatId].type === 'human') {
          const _me0 = _r0.seats[ws.seatId];
          if (msg.name) _me0.name = msg.name;
          if (msg.avatarUrl) _me0.avatarUrl = msg.avatarUrl; else delete _me0.avatarUrl;
          _me0.netSeat = ws.seatId;
        }
        broadcastSeatData(_r0); return;
      }
      
      if (msg.type === 'action') {
        if (msg.data && msg.data.type === 'rtc-signal') {
          const targetSeat = msg.data.target;
          if (targetSeat != null) {
            const targetClient = room.clients.find(c => c.seatId === targetSeat);
            if (targetClient && targetClient.readyState === WebSocket.OPEN) {
              targetClient.send(JSON.stringify({ type: 'action', seat: ws.seatId, data: msg.data }));
            }
          } else {
            room.clients.forEach(c => {
              if (c !== ws && c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'action', seat: ws.seatId, data: msg.data }));
            });
          }
          return;
        }
        if (msg.data && msg.data.type === 'voice-msg') {
          const voiceMsg = JSON.stringify({ type: 'action', seat: ws.seatId, data: msg.data });
          room.clients.forEach(c => { if (c !== ws && c.readyState === WebSocket.OPEN) c.send(voiceMsg); });
          return;
        }
        if (msg.data && msg.data.type === 'state') {
          room.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'action', seat: ws.seatId, data: msg.data })); });
        } else if (msg.data && msg.data.type === 'chat') {
          room.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'chat-broadcast', seat: ws.seatId, idx: msg.data.idx, text: msg.data.text })); });
        } else if (msg.data && msg.data.type === 'request-seat-data') {
          broadcastSeatData(room);
        } else if (msg.data && msg.data.targetNetSeat !== undefined) {
          const targetClient = room.clients.find(c => c.seatId === msg.data.targetNetSeat);
          if (targetClient && targetClient.readyState === WebSocket.OPEN) targetClient.send(JSON.stringify({ type: 'action', seat: ws.seatId, data: msg.data }));
        } else {
          const hostClient = room.clients.find(c => room.seats[c.seatId] && room.seats[c.seatId].isHost);
          if (hostClient && hostClient.readyState === WebSocket.OPEN) hostClient.send(JSON.stringify({ type: 'action', seat: ws.seatId, data: msg.data }));
        }
        return;
      }
      if (msg.type === 'start') {
         const hasAnyHost = room.seats.some(s => s && s.isHost);
         if (!hasAnyHost) return;
         for(let i=0; i<4; i++) { if(!room.seats[i]) room.seats[i] = { type: 'ai', name: 'AI-' + (i+1) }; }
         const humanSeats = [];
         room.seats.forEach((s, idx) => { if (s.type === 'human') humanSeats.push(idx); });
         const startMsg = JSON.stringify({ type: 'game-start', config: room.config, humanSeats: humanSeats, count: humanSeats.length });
         room.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(startMsg); });
         return;
      }
    });
    ws.on('close', () => {
      if (!ws.roomId) return;
      const room = rooms[ws.roomId]; if (!room) return;
      if (ws.seatId != null && room.seats[ws.seatId]) room.seats[ws.seatId] = null;
      room.clients = room.clients.filter(c => c !== ws);
      if (room.clients.length === 0) delete rooms[ws.roomId];
      else {
         const hasHost = room.seats.some(s => s && s.isHost);
         if (!hasHost) {
            const firstHuman = room.seats.findIndex(s => s && s.type === 'human');
            if (firstHuman !== -1) room.seats[firstHuman].isHost = true;
         }
         broadcastSeatData(room);
      }
    });
  });
  return wss;
}

// 将原来的 const HTTP_PORT = 8081; 改成：
const HTTP_PORT = process.env.PORT || 8081;
const IS_CLOUD = !!process.env.PORT;

const httpServer = http.createServer(handleRequest);
attachWs(httpServer);
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log('══════════════════════════════════════');
  console.log(' 🚀 服务已启动！');
  if (IS_CLOUD) {
    console.log(' ☁ 运行在云端环境，由平台代理 HTTPS/WSS');
  } else {
    console.log(' 🌐 本机访问: http://localhost:' + HTTP_PORT);
  }
  console.log('══════════════════════════════════════');
});

// 只有在本地环境（非云端），才启动自带证书的 HTTPS 服务
if (!IS_CLOUD && certData) {
  const HTTPS_PORT = 8443;
  const httpsServer = https.createServer(certData, handleRequest);
  attachWs(httpsServer);
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(' 🔒 HTTPS 已启动 https://电脑IP:' + HTTPS_PORT + '  ← 本地语音必须用这个');
  });
} else if (!IS_CLOUD) {
  console.log(' ⚠ 缺少 HTTPS 证书，本地环境只有文字聊天可用。');
}