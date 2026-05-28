web: node src/server.js
const http = require("http");
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
