const express = require('express');
const http = require('http');const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

// ─── In-memory state ───────────────────────────────────────────────
const rooms = new Map();
// rooms: Map<roomId, { meta, music, members: Map<wsId, member> }>

function makeRoom({ name, type, pin, ownerWsId, ownerName }) {
  const code = name.slice(0, 3).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase();
  return {
    meta: { id: crypto.randomUUID(), name, type, pin, code, ownerWsId },
    music: {
      queue: [],
      currentIdx: -1,
      isPlaying: false,
      elapsed: 0,
      serverStartTime: null, // Date.now() when play started
      startElapsed: 0,       // elapsed when play started
    },
    members: new Map([[ownerWsId, { id: ownerWsId, name: ownerName, micOn: true }]]),
  };
}

// ─── WebSocket ─────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("VoiceRoom Server OK");
});

const wss = new WebSocketServer({ server });
const clients = new Map(); // wsId -> { ws, roomId, userId, name }

function wsId(ws) {
  if (!ws._uid) ws._uid = crypto.randomUUID();
  return ws._uid;
}

function broadcast(room, msg, excludeWsId = null) {
  const data = JSON.stringify(msg);
  room.members.forEach((_, wid) => {
    if (wid === excludeWsId) return;
    const c = clients.get(wid);
    if (c && c.ws.readyState === 1) c.ws.send(data);
  });
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function roomSnapshot(room) {
  const members = [];
  room.members.forEach((m) => members.push(m));
  // compute live elapsed
  let elapsed = room.music.elapsed;
  if (room.music.isPlaying && room.music.serverStartTime) {
    elapsed = room.music.startElapsed + Math.floor((Date.now() - room.music.serverStartTime) / 1000);
    const track = room.music.queue[room.music.currentIdx];
    if (track && elapsed >= track.durSec) elapsed = track.durSec;
  }
  return {
    meta: room.meta,
    music: { ...room.music, elapsed, serverStartTime: undefined },
    members,
  };
}

function publicRoomList() {
  const list = [];
  rooms.forEach((room) => {
    if (room.meta.type === "public") {
      const members = [];
      room.members.forEach((m) => members.push({ id: m.id, name: m.name }));
      list.push({ ...room.meta, memberCount: members.length, members });
    }
  });
  return list;
}

wss.on("connection", (ws) => {
  const id = wsId(ws);
  clients.set(id, { ws, roomId: null, name: "Anonim" });

  // Send room list on connect
  send(ws, { type: "ROOM_LIST", rooms: publicRoomList() });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const client = clients.get(id);

    switch (msg.type) {

      // ── Room management ──────────────────────────────────────────

      case "CREATE_ROOM": {
        // 1 user = 1 room check
        for (const [, r] of rooms) {
          if (r.meta.ownerWsId === id) {
            send(ws, { type: "ERROR", code: "ALREADY_OWNER", message: "Kamu sudah memiliki ruangan aktif." });
            return;
          }
        }
        const room = makeRoom({ ...msg, ownerWsId: id, ownerName: msg.name });
        rooms.set(room.meta.id, room);
        client.roomId = room.meta.id;
        client.name = msg.name;
        send(ws, { type: "ROOM_CREATED", room: roomSnapshot(room) });
        // broadcast updated list
        broadcastRoomList();
        break;
      }

      case "JOIN_ROOM": {
        const room = rooms.get(msg.roomId);
        if (!room) { send(ws, { type: "ERROR", code: "NOT_FOUND", message: "Ruangan tidak ditemukan." }); return; }
        if (room.meta.type === "private" && room.meta.pin !== String(msg.pin)) {
          send(ws, { type: "ERROR", code: "WRONG_PIN", message: "PIN salah." }); return;
        }
        if (client.roomId) leaveRoom(id, client);
        client.roomId = room.meta.id;
        client.name = msg.name || "Pendengar";
        room.members.set(id, { id, name: client.name, micOn: true });
        send(ws, { type: "ROOM_JOINED", room: roomSnapshot(room) });
        broadcast(room, { type: "MEMBER_JOINED", member: { id, name: client.name } }, id);
        broadcastRoomList();
        break;
      }

      case "LEAVE_ROOM": {
        leaveRoom(id, client);
        break;
      }

      case "DELETE_ROOM": {
        const room = rooms.get(client.roomId);
        if (!room) return;
        if (room.meta.ownerWsId !== id) {
          send(ws, { type: "ERROR", code: "NOT_OWNER", message: "Hanya pemilik yang bisa menghapus ruangan." }); return;
        }
        broadcast(room, { type: "ROOM_DELETED", roomId: room.meta.id });
        room.members.forEach((_, wid) => {
          const c = clients.get(wid);
          if (c) c.roomId = null;
        });
        rooms.delete(room.meta.id);
        broadcastRoomList();
        break;
      }

      // ── Music sync (owner only) ──────────────────────────────────

      case "MUSIC_PLAY": {
        const room = rooms.get(client.roomId);
        if (!room || room.meta.ownerWsId !== id) return;
        room.music.isPlaying = true;
        room.music.serverStartTime = Date.now();
        room.music.startElapsed = room.music.elapsed;
        const payload = { type: "MUSIC_STATE", music: { ...room.music, elapsed: room.music.startElapsed, serverStartTime: room.music.serverStartTime } };
        broadcast(room, payload);
        send(ws, payload);
        break;
      }

      case "MUSIC_PAUSE": {
        const room = rooms.get(client.roomId);
        if (!room || room.meta.ownerWsId !== id) return;
        if (room.music.isPlaying && room.music.serverStartTime) {
          room.music.elapsed = room.music.startElapsed + Math.floor((Date.now() - room.music.serverStartTime) / 1000);
        }
        room.music.isPlaying = false;
        room.music.serverStartTime = null;
        const payload = { type: "MUSIC_STATE", music: { ...room.music } };
        broadcast(room, payload);
        send(ws, payload);
        break;
      }

      case "MUSIC_SEEK": {
        const room = rooms.get(client.roomId);
        if (!room || room.meta.ownerWsId !== id) return;
        room.music.elapsed = msg.elapsed;
        room.music.startElapsed = msg.elapsed;
        room.music.serverStartTime = room.music.isPlaying ? Date.now() : null;
        const payload = { type: "MUSIC_STATE", music: { ...room.music } };
        broadcast(room, payload);
        send(ws, payload);
        break;
      }

      case "MUSIC_TRACK": {
        const room = rooms.get(client.roomId);
        if (!room || room.meta.ownerWsId !== id) return;
        room.music.currentIdx = msg.currentIdx;
        room.music.elapsed = 0;
        room.music.startElapsed = 0;
        room.music.isPlaying = true;
        room.music.serverStartTime = Date.now();
        const payload = { type: "MUSIC_STATE", music: { ...room.music } };
        broadcast(room, payload);
        send(ws, payload);
        break;
      }

      case "MUSIC_QUEUE_ADD": {
        const room = rooms.get(client.roomId);
        if (!room || room.meta.ownerWsId !== id) return;
        room.music.queue.push(msg.track);
        const payload = { type: "MUSIC_QUEUE", queue: room.music.queue };
        broadcast(room, payload);
        send(ws, payload);
        break;
      }

      case "MUSIC_QUEUE_REMOVE": {
        const room = rooms.get(client.roomId);
        if (!room || room.meta.ownerWsId !== id) return;
        room.music.queue.splice(msg.index, 1);
        if (room.music.currentIdx >= room.music.queue.length) {
          room.music.currentIdx = room.music.queue.length - 1;
        }
        const payload = { type: "MUSIC_QUEUE", queue: room.music.queue, currentIdx: room.music.currentIdx };
        broadcast(room, payload);
        send(ws, payload);
        break;
      }

      // ── Voice ────────────────────────────────────────────────────

      case "MIC_STATE": {
        const room = rooms.get(client.roomId);
        if (!room) return;
        const member = room.members.get(id);
        if (member) member.micOn = msg.micOn;
        broadcast(room, { type: "MEMBER_UPDATE", member: { id, micOn: msg.micOn } });
        break;
      }

      case "GET_ROOM_LIST": {
        send(ws, { type: "ROOM_LIST", rooms: publicRoomList() });
        break;
      }
    }
  });

  ws.on("close", () => {
    const client = clients.get(id);
    if (client) leaveRoom(id, client);
    clients.delete(id);
  });
});

function leaveRoom(wsId, client) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  if (!room) { client.roomId = null; return; }
  room.members.delete(wsId);
  broadcast(room, { type: "MEMBER_LEFT", memberId: wsId });
  client.roomId = null;
  // If owner left without deleting, auto-delete
  if (room.meta.ownerWsId === wsId) {
    broadcast(room, { type: "ROOM_DELETED", roomId: room.meta.id, reason: "Pemilik meninggalkan ruangan." });
    room.members.forEach((_, wid) => {
      const c = clients.get(wid);
      if (c) c.roomId = null;
    });
    rooms.delete(room.meta.id);
  }
  broadcastRoomList();
}

function broadcastRoomList() {
  const list = publicRoomList();
  clients.forEach(({ ws }) => {
    if (ws.readyState === 1) send(ws, { type: "ROOM_LIST", rooms: list });
  });
}

server.listen(PORT, () => console.log(`VoiceRoom server running on port ${PORT}`));

const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── In-memory store ─────────────────────────────────────────
const rooms = new Map();
// room: { id, name, type, pin, host, members[], messages[], createdAt, _timer }
// member: { id, name, muted, joinedAt }

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function safeRoom(r) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    host: r.host,
    memberCount: r.members.length,
    members: r.members.map(m => ({ id: m.id, name: m.name, muted: m.muted })),
    createdAt: r.createdAt
  };
}

// ── REST ────────────────────────────────────────────────────

// List all rooms (public + private metadata, no pin exposed)
app.get('/api/rooms', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const list = [];
  rooms.forEach(r => {
    const sr = safeRoom(r);
    if (!q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)) {
      list.push(sr);
    }
  });
  // sort by member count desc
  list.sort((a, b) => b.memberCount - a.memberCount);
  res.json(list);
});

app.get('/api/rooms/:id', (req, res) => {
  const r = rooms.get(req.params.id.toUpperCase());
  if (!r) return res.status(404).json({ error: 'Ruang tidak ditemukan' });
  res.json(safeRoom(r));
});

app.post('/api/rooms', (req, res) => {
  const { name, type, pin } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nama ruang wajib diisi' });
  if (type === 'private' && !/^\d{4}$/.test(pin))
    return res.status(400).json({ error: 'PIN harus 4 digit angka' });

  let id;
  do { id = genCode(); } while (rooms.has(id));

  rooms.set(id, {
    id, name: name.trim().slice(0, 40),
    type: type === 'private' ? 'private' : 'public',
    pin: type === 'private' ? pin : null,
    host: null, members: [], messages: [],
    createdAt: Date.now(), _timer: null
  });
  res.json({ roomId: id });
});

app.post('/api/rooms/:id/verify', (req, res) => {
  const r = rooms.get(req.params.id.toUpperCase());
  if (!r) return res.status(404).json({ error: 'Ruang tidak ditemukan' });
  if (r.type === 'public') return res.json({ ok: true, name: r.name });
  if (req.body.pin !== r.pin) return res.status(403).json({ error: 'PIN salah' });
  res.json({ ok: true, name: r.name });
});

app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));

// ── Socket.IO ───────────────────────────────────────────────
io.on('connection', socket => {
  let curRoom = null, userName = 'Tamu';

  socket.on('join-room', ({ roomId, name }) => {
    const rid = (roomId || '').toUpperCase();
    const r = rooms.get(rid);
    if (!r) return socket.emit('error', 'Ruang tidak ditemukan');
    if (r.members.length >= 10) return socket.emit('error', 'Ruang penuh (maks 10 orang)');

    // Auto-leave previous room if any
    if (curRoom && curRoom !== rid) {
      _leaveRoom(socket, curRoom, userName);
    }

    userName = (name || 'Tamu').slice(0, 24);
    curRoom = rid;

    if (r._timer) { clearTimeout(r._timer); r._timer = null; }

    if (!r.members.find(m => m.id === socket.id)) {
      r.members.push({ id: socket.id, name: userName, muted: false, joinedAt: Date.now() });
    }
    if (!r.host) r.host = socket.id;

    socket.join(rid);
    socket.emit('room-joined', {
      room: safeRoom(r),
      messages: r.messages.slice(-120),
      myId: socket.id,
      isHost: r.host === socket.id
    });

    socket.to(rid).emit('peer-joined', { id: socket.id, name: userName });
    io.to(rid).emit('members-update', safeRoom(r).members);
    // Broadcast updated room list to lobby watchers
    io.emit('rooms-updated');
  });

  // WebRTC signaling
  socket.on('offer',         ({ to, offer })     => socket.to(to).emit('offer',         { from: socket.id, offer }));
  socket.on('answer',        ({ to, answer })    => socket.to(to).emit('answer',        { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => socket.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  socket.on('chat-message', ({ text }) => {
    if (!curRoom || !text?.trim()) return;
    const r = rooms.get(curRoom); if (!r) return;
    const msg = { id: uuidv4(), senderId: socket.id, senderName: userName, text: text.slice(0, 500), time: Date.now() };
    r.messages.push(msg);
    if (r.messages.length > 300) r.messages.shift();
    io.to(curRoom).emit('chat-message', msg);
  });

  socket.on('mute-status', ({ muted }) => {
    if (!curRoom) return;
    const r = rooms.get(curRoom); if (!r) return;
    const m = r.members.find(x => x.id === socket.id);
    if (m) m.muted = !!muted;
    io.to(curRoom).emit('members-update', safeRoom(r).members);
  });

  socket.on('leave-room', () => {
    if (curRoom) { _leaveRoom(socket, curRoom, userName); curRoom = null; }
  });

  socket.on('disconnect', () => {
    if (curRoom) _leaveRoom(socket, curRoom, userName);
  });

  function _leaveRoom(sock, rid, uname) {
    const r = rooms.get(rid); if (!r) return;
    r.members = r.members.filter(m => m.id !== sock.id);
    if (r.host === sock.id) r.host = r.members[0]?.id || null;
    sock.leave(rid);
    sock.to(rid).emit('peer-left', { id: sock.id, name: uname });
    io.to(rid).emit('members-update', safeRoom(r).members);
    io.emit('rooms-updated');
    if (r.members.length === 0) {
      r._timer = setTimeout(() => {
        if (rooms.get(rid)?.members.length === 0) { rooms.delete(rid); io.emit('rooms-updated'); }
      }, 8 * 60 * 1000);
    }
  }
});

// ── Start ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║      🎙  VoiceRoom 2.0 — Ready           ║');
  console.log(`║  http://localhost:${PORT}                     ║`.slice(0, 44) + '║');
  Object.values(os.networkInterfaces()).flat()
    .filter(i => i.family === 'IPv4' && !i.internal)
    .forEach(i => console.log(`║  ${i.address}:${PORT}`.padEnd(43) + '║'));
  console.log('╚══════════════════════════════════════════╝\n');
});
