const express = require('express');
const http = require('http');
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
