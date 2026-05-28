/* ═══════════════════════════════════════════════════
   VoiceRoom 2.0 — Client
   - WebRTC mesh (internet via STUN/TURN)
   - Background room (stay in room while browsing lobby)
   - Auto-leave when joining new room
   - Music auto-save to localStorage (playlist names)
   - Speaking detection via analyser
   - Search & filter rooms
═══════════════════════════════════════════════════ */

// ── Socket ───────────────────────────────────────
const socket = io({ transports: ['websocket', 'polling'] });

// ── ICE (STUN + public TURN) ─────────────────────
const ICE_CFG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'turn:openrelay.metered.ca:80',   username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

// ── State ────────────────────────────────────────
let myId = null, myName = 'Tamu';
let curRoomId = null, curRoomData = null;
let inRoom = false;  // true when actually joined (background browsing = inRoom stays true)

const peers = {};    // { socketId: RTCPeerConnection }
const audioEls = {}; // { socketId: HTMLAudioElement }
let localStream = null, gainNode = null, audioCtx = null, analyser = null;
let isMuted = false, micGainVal = 1, voiceVolVal = 1;

// ── Toast ────────────────────────────────────────
let _tt;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show ' + type;
  clearTimeout(_tt); _tt = setTimeout(() => el.className = 'toast', 3000);
}

// ── Navigation ───────────────────────────────────
const Nav = {
  goLobby() {
    document.getElementById('pg-room').classList.remove('active');
    document.getElementById('pg-lobby').classList.add('active');
    updateActivePill();
    Lobby.load();
  },
  goRoom() {
    if (!inRoom) return;
    document.getElementById('pg-lobby').classList.remove('active');
    document.getElementById('pg-room').classList.add('active');
  }
};
window.Nav = Nav;

// ── Active Pill ──────────────────────────────────
function updateActivePill() {
  const pill = document.getElementById('activePill');
  if (inRoom && curRoomData) {
    document.getElementById('pillText').textContent = `Kamu di: ${curRoomData.name}`;
    pill.classList.remove('hidden');
  } else {
    pill.classList.add('hidden');
  }
}

// ── Lobby ────────────────────────────────────────
let _allRooms = [], _filter = 'all', _searchQ = '';

const Lobby = {
  async load(q = '') {
    try {
      const url = q ? `/api/rooms?q=${encodeURIComponent(q)}` : '/api/rooms';
      const res = await fetch(url);
      _allRooms = await res.json();
      this.render();
    } catch { /* silent */ }
  },

  render() {
    const grid = document.getElementById('roomsGrid');
    const noEl = document.getElementById('noRooms');
    let list = _allRooms;

    // Filter by type
    if (_filter !== 'all') list = list.filter(r => r.type === _filter);

    // Search
    if (_searchQ) {
      const q = _searchQ.toLowerCase();
      list = list.filter(r => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
    }

    grid.innerHTML = '';
    if (!list.length) { noEl.classList.remove('hidden'); return; }
    noEl.classList.add('hidden');

    list.forEach(r => {
      const isFull = r.memberCount >= 10;
      const isMe = curRoomId === r.id;
      const age = timeAgo(r.createdAt);

      const dots = Array.from({ length: 10 }, (_, i) =>
        `<div class="rc-dot${i < r.memberCount ? ' on' : ''}"></div>`).join('');

      const card = document.createElement('div');
      card.className = 'room-card' + (isMe ? ' is-active' : '');
      card.innerHTML = `
        <div class="rc-top">
          <div class="rc-name">${esc(r.name)}</div>
          <div class="rc-badge">
            ${isFull ? '<span class="badge badge-full">PENUH</span>' :
              r.type === 'private' ? '<span class="badge badge-priv">🔒 PRIVAT</span>' :
              '<span class="badge badge-pub">🌐 PUBLIK</span>'}
          </div>
        </div>
        <div class="rc-code fira">${r.id}</div>
        <div class="rc-bottom">
          <div class="rc-members"><div class="rc-dots">${dots}</div> ${r.memberCount}/10</div>
          <div class="rc-age">${age}</div>
        </div>`;
      card.onclick = () => App.joinRoom(r.id, r.type, r.name);
      grid.appendChild(card);
    });
  },

  filter(f, btn) {
    _filter = f;
    document.querySelectorAll('.ftab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    this.render();
  },

  search(q) {
    _searchQ = q;
    document.getElementById('searchClear').style.display = q ? '' : 'none';
    this.render();
  },

  clearSearch() {
    _searchQ = '';
    document.getElementById('searchInput').value = '';
    document.getElementById('searchClear').style.display = 'none';
    this.render();
  },

  async joinByCode() {
    const code = document.getElementById('directCode').value.trim().toUpperCase();
    if (!code) return toast('Masukkan kode ruang', 'err');
    try {
      const res = await fetch(`/api/rooms/${code}`);
      if (!res.ok) return toast('Ruang tidak ditemukan', 'err');
      const r = await res.json();
      App.joinRoom(r.id, r.type, r.name);
    } catch { toast('Ruang tidak ditemukan', 'err'); }
  }
};
window.Lobby = Lobby;

// ── Modal helpers ────────────────────────────────
const Mod = {
  openCreate() {
    document.getElementById('modCreate').classList.add('open');
    setTimeout(() => document.getElementById('cName').focus(), 50);
    document.querySelectorAll('input[name="ctype"]').forEach(r =>
      r.onchange = () => {
        document.getElementById('pinWrap').style.display =
          document.querySelector('input[name="ctype"]:checked').value === 'private' ? 'flex' : 'none';
      }
    );
  },
  close() {
    document.querySelectorAll('.overlay').forEach(o => o.classList.remove('open'));
  },
  openPin(roomName, roomId) {
    document.getElementById('pinRoomName').textContent = `🔒 "${roomName}"`;
    document.getElementById('modPin').dataset.rid = roomId;
    document.getElementById('modPin').classList.add('open');
    setTimeout(() => document.getElementById('pinInput').focus(), 50);
  }
};
window.Mod = Mod;

// ── Mic init ─────────────────────────────────────
async function initMic() {
  if (localStream) return; // already inited
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      video: false
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(localStream);
    gainNode = audioCtx.createGain();
    gainNode.gain.value = micGainVal;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    const dst = audioCtx.createMediaStreamDestination();
    src.connect(gainNode);
    gainNode.connect(analyser);
    gainNode.connect(dst);
    localStream._out = dst.stream;
    startSpeakDetect();
  } catch {
    toast('Mikrofon tidak bisa diakses. Mode chat saja.', 'err');
    localStream = null;
  }
}

function startSpeakDetect() {
  if (!analyser) return;
  const buf = new Uint8Array(analyser.fftSize);
  let wasSpeaking = false;
  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += Math.abs(buf[i] - 128);
    const speaking = (sum / buf.length) > 5 && !isMuted;
    if (speaking !== wasSpeaking) {
      wasSpeaking = speaking;
      const ring = document.getElementById('av-ring-' + myId);
      if (ring) ring.classList.toggle('speaking', speaking);
      const mi = document.getElementById('mi-' + myId);
      if (mi) mi.classList.toggle('speaking', speaking);
    }
    requestAnimationFrame(tick);
  };
  tick();
}

function peerStream() { return localStream?._out || localStream; }

// ── WebRTC ───────────────────────────────────────
function makePeer(id) {
  const pc = new RTCPeerConnection(ICE_CFG);
  peers[id] = pc;
  const s = peerStream();
  if (s) s.getTracks().forEach(t => pc.addTrack(t, s));

  pc.ontrack = ev => {
    if (!audioEls[id]) {
      const a = new Audio();
      a.autoplay = true;
      a.volume = Math.min(voiceVolVal, 1);
      audioEls[id] = a;
    }
    audioEls[id].srcObject = ev.streams[0];
  };

  pc.onicecandidate = ev => {
    if (ev.candidate) socket.emit('ice-candidate', { to: id, candidate: ev.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) dropPeer(id);
  };
  return pc;
}

async function callPeer(id) {
  const pc = makePeer(id);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { to: id, offer });
}

function dropPeer(id) {
  peers[id]?.close(); delete peers[id];
  if (audioEls[id]) { audioEls[id].srcObject = null; delete audioEls[id]; }
}

function dropAllPeers() {
  Object.keys(peers).forEach(dropPeer);
}

// ── Socket events ────────────────────────────────
socket.on('room-joined', ({ room, messages, myId: id, isHost }) => {
  myId = id;
  inRoom = true;
  curRoomId = room.id;
  curRoomData = room;

  // Switch to room page
  document.getElementById('pg-lobby').classList.remove('active');
  document.getElementById('pg-room').classList.add('active');

  // Fill header
  document.getElementById('rh-name').textContent = room.name;
  document.getElementById('rh-code').textContent = room.id;
  const badge = document.getElementById('rh-badge');
  badge.textContent = room.type === 'private' ? '🔒 PRIVAT' : '🌐 PUBLIK';
  badge.className = 'rh-badge ' + (room.type === 'private' ? 'priv' : 'pub');

  renderMembers(room.members);

  // Chat history
  const log = document.getElementById('chatMsgs'); log.innerHTML = '';
  messages.forEach(appendMsg);
  sysMsg(`Kamu masuk sebagai ${myName}`);

  updateActivePill();
  toast(`Masuk ke "${room.name}"`, 'ok');
});

socket.on('peer-joined', async ({ id, name }) => {
  sysMsg(`${name} bergabung`);
  await callPeer(id);
});

socket.on('peer-left', ({ id, name }) => {
  sysMsg(`${name} keluar`);
  dropPeer(id);
});

socket.on('offer', async ({ from, offer }) => {
  const pc = makePeer(from);
  await pc.setRemoteDescription(offer);
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);
  socket.emit('answer', { to: from, answer: ans });
});

socket.on('answer', async ({ from, answer }) => {
  if (peers[from]) await peers[from].setRemoteDescription(answer).catch(() => {});
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  if (peers[from]) try { await peers[from].addIceCandidate(candidate); } catch {}
});

socket.on('members-update', renderMembers);
socket.on('chat-message', appendMsg);
socket.on('error', msg => toast(msg, 'err'));
socket.on('rooms-updated', () => { if (document.getElementById('pg-lobby').classList.contains('active')) Lobby.load(); });

// ── Render members ───────────────────────────────
function renderMembers(members) {
  // Sidebar list
  const list = document.getElementById('membersList'); list.innerHTML = '';
  members.forEach(m => {
    const d = document.createElement('div');
    d.className = 'mi'; d.id = 'mi-' + m.id;
    d.innerHTML = `<div class="mi-av">${ini(m.name)}</div>
      <span class="mi-name">${esc(m.name)}${m.id === myId ? ' ★' : ''}</span>
      <span class="mi-mute">${m.muted ? '🔇' : ''}</span>`;
    list.appendChild(d);
  });

  // Stage avatars
  const grid = document.getElementById('avatarGrid'); grid.innerHTML = '';
  members.forEach(m => {
    const d = document.createElement('div');
    d.className = 'av';
    d.innerHTML = `
      <div class="av-ring${m.muted ? ' muted' : ''}" id="av-ring-${m.id}">${ini(m.name)}</div>
      <div class="av-name">${esc(m.name)}</div>
      ${m.id === myId ? '<div class="av-you">Kamu</div>' : ''}`;
    grid.appendChild(d);
  });
}

// ── Main App actions ─────────────────────────────
const App = {
  async createRoom() {
    const name = document.getElementById('cName').value.trim();
    const type = document.querySelector('input[name="ctype"]:checked').value;
    const pin  = document.getElementById('cPin').value.trim();
    if (!name) return toast('Nama ruang wajib diisi', 'err');
    if (type === 'private' && !/^\d{4}$/.test(pin)) return toast('PIN harus 4 digit angka', 'err');
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, pin })
      });
      const data = await res.json();
      if (!res.ok) return toast(data.error, 'err');
      Mod.close();
      this._enter(data.roomId);
    } catch { toast('Gagal membuat ruang', 'err'); }
  },

  async joinRoom(roomId, type, name) {
    const rid = roomId.toUpperCase();
    if (curRoomId === rid) { Nav.goRoom(); return; } // already in this room

    if (type === 'private') {
      Mod.openPin(name, rid);
      return;
    }
    this._enter(rid);
  },

  async verifyPin() {
    const rid = document.getElementById('modPin').dataset.rid;
    const pin = document.getElementById('pinInput').value.trim();
    if (!pin) return toast('Masukkan PIN', 'err');
    try {
      const res = await fetch(`/api/rooms/${rid}/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const data = await res.json();
      if (!res.ok) return toast(data.error, 'err');
      Mod.close();
      this._enter(rid);
    } catch { toast('Gagal verifikasi PIN', 'err'); }
  },

  async _enter(roomId) {
    myName = document.getElementById('myName').value.trim() || 'Tamu';

    // If already in a room, auto-leave it first
    if (inRoom && curRoomId && curRoomId !== roomId) {
      socket.emit('leave-room');
      dropAllPeers();
      inRoom = false;
      curRoomId = null;
    }

    await initMic();
    socket.emit('join-room', { roomId, name: myName });
  },

  toggleMute() {
    isMuted = !isMuted;
    if (localStream) localStream.getTracks().forEach(t => t.enabled = !isMuted);
    const btn = document.getElementById('btnMute');
    btn.className = 'mute-toggle ' + (isMuted ? 'off' : 'on');
    document.getElementById('muteIco').textContent = isMuted ? '🔇' : '🎙';
    document.getElementById('muteLbl').textContent = isMuted ? 'Bisu' : 'Aktif';
    socket.emit('mute-status', { muted: isMuted });
    const ring = document.getElementById('av-ring-' + myId);
    if (ring) ring.classList.toggle('muted', isMuted);
  },

  setMicGain(v) {
    micGainVal = v / 100;
    if (gainNode) gainNode.gain.value = micGainVal;
    document.getElementById('vMicVal').textContent = v + '%';
  },

  setVoiceVol(v) {
    voiceVolVal = v / 100;
    Object.values(audioEls).forEach(a => a.volume = Math.min(voiceVolVal, 1));
    document.getElementById('vVoiceVal').textContent = v + '%';
  },

  chat() {
    const inp = document.getElementById('chatIn');
    const txt = inp.value.trim();
    if (!txt) return;
    socket.emit('chat-message', { text: txt });
    inp.value = '';
  },

  leaveRoom() {
    socket.emit('leave-room');
    dropAllPeers();
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    audioCtx?.close(); audioCtx = null; gainNode = null; analyser = null;
    inRoom = false; curRoomId = null; curRoomData = null;
    updateActivePill();
    Nav.goLobby();
  }
};
window.App = App;

// ── Chat UI ──────────────────────────────────────
function appendMsg(msg) {
  const log = document.getElementById('chatMsgs');
  const d = document.createElement('div');
  d.className = 'cmsg' + (msg.senderId === myId ? ' mine' : '');
  const t = new Date(msg.time);
  const ts = `${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}`;
  d.innerHTML = `<span class="cmsg-who">${esc(msg.senderName)}<span class="ts">${ts}</span></span>
    <span class="cmsg-txt">${esc(msg.text)}</span>`;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}
function sysMsg(t) {
  const log = document.getElementById('chatMsgs');
  const d = document.createElement('div');
  d.className = 'cmsg-sys'; d.textContent = t;
  log.appendChild(d); log.scrollTop = log.scrollHeight;
}

// ── Copy code ────────────────────────────────────
function copyCode() {
  const code = document.getElementById('rh-code').textContent;
  navigator.clipboard.writeText(code)
    .then(() => toast('Kode disalin: ' + code, 'ok'))
    .catch(() => toast('Kode: ' + code));
}
window.copyCode = copyCode;

// ── Music Player ─────────────────────────────────
const Mus = (() => {
  let audio = null, list = [], idx = 0, looping = false, v = 0.6;
  const LS_KEY = 'vr2_playlist_names';

  // Auto-save playlist names to localStorage
  function savePL() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(list.map(f => f.name))); } catch {}
  }

  function render() {
    const pl = document.getElementById('playlist'); pl.innerHTML = '';
    list.forEach((f, i) => {
      const d = document.createElement('div');
      d.className = 'pli' + (i === idx ? ' now' : '');
      d.textContent = clean(f.name);
      d.onclick = () => play(i);
      pl.appendChild(d);
    });
  }

  function play(i) {
    idx = i;
    const f = list[i]; if (!f) return;
    document.getElementById('musTrack').textContent = clean(f.name);
    if (audio) { audio.pause(); }
    audio = new Audio(URL.createObjectURL(f));
    audio.volume = v;
    audio.play().catch(() => {});
    audio.ontimeupdate = () => {
      if (!audio.duration) return;
      document.getElementById('mSeek').value = (audio.currentTime / audio.duration) * 100;
      document.getElementById('mCur').textContent = fmt(audio.currentTime);
    };
    audio.onloadedmetadata = () => document.getElementById('mDur').textContent = fmt(audio.duration);
    audio.onended = () => {
      if (looping) { audio.currentTime = 0; audio.play(); }
      else if (idx < list.length - 1) play(idx + 1);
      else document.getElementById('mcPlay').textContent = '▶';
    };
    document.getElementById('mcPlay').textContent = '⏸';
    render();
  }

  function clean(n) { return n.replace(/\.[^.]+$/, ''); }

  return {
    load(inp) {
      list = Array.from(inp.files);
      idx = 0; render(); play(0); savePL();
    },
    togglePlay() {
      if (!audio && list.length) { play(0); return; }
      if (!audio) return;
      if (audio.paused) { audio.play(); document.getElementById('mcPlay').textContent = '⏸'; }
      else { audio.pause(); document.getElementById('mcPlay').textContent = '▶'; }
    },
    prev() { if (list.length) play(idx > 0 ? idx - 1 : list.length - 1); },
    next() { if (list.length) play(idx < list.length - 1 ? idx + 1 : 0); },
    loop() {
      looping = !looping;
      document.getElementById('mcLoop').classList.toggle('active', looping);
    },
    vol(val) {
      v = val / 100;
      if (audio) audio.volume = v;
      document.getElementById('vMusVal').textContent = val + '%';
    },
    seek(val) {
      if (audio?.duration) audio.currentTime = (val / 100) * audio.duration;
    },
    // Expose play for inline button
    play() { this.togglePlay(); }
  };
})();
window.Mus = Mus;

// ── Utils ────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function ini(n) {
  return (n||'?').split(' ').map(w=>w[0]||'').slice(0,2).join('').toUpperCase()||'?';
}
function fmt(s) {
  if (!isFinite(s)) return '0:00';
  return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.floor(s/60)} mnt lalu`;
  return `${Math.floor(s/3600)} jam lalu`;
}

// ── Init ─────────────────────────────────────────
Lobby.load();
setInterval(() => {
  if (document.getElementById('pg-lobby').classList.contains('active')) Lobby.load();
}, 15000);

// Restore myName from localStorage
try {
  const saved = localStorage.getItem('vr2_name');
  if (saved) document.getElementById('myName').value = saved;
} catch {}
document.getElementById('myName').addEventListener('input', e => {
  try { localStorage.setItem('vr2_name', e.target.value); } catch {}
});
