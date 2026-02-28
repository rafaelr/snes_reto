/**
 * SNES Multiplayer Emulator Server
 * Express + Socket.IO server managing rooms, joypad slots and ROM uploads.
 */

'use strict';

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');

// ─── Configuration ────────────────────────────────────────────────────────────
const PORT      = process.env.PORT || 3000;
const MAX_PLAYERS = 4;          // SNES supports up to 4 via MultiTap
const ROM_DIR   = path.join(__dirname, 'roms');

if (!fs.existsSync(ROM_DIR)) fs.mkdirSync(ROM_DIR, { recursive: true });

// ─── Upload middleware ─────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, ROM_DIR),
  filename:    (_, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },         // 8 MB max
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ['.smc', '.sfc', '.rom', '.bin'].includes(ext));
  }
});

// ─── Express + HTTP + Socket.IO ────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout:  20000,   // 20 s — faster dead-socket detection
  pingInterval: 10000,   // heartbeat every 10 s
  // Disable per-message deflate: compression adds latency to small joypad
  // packets and the gains are negligible for tiny bitmask payloads.
  perMessageDeflate: false,
  // Prefer WebSocket from the start; skip long-polling upgrade overhead.
  transports: ['websocket', 'polling'],
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// List uploaded ROMs
app.get('/api/roms', (_, res) => {
  res.json(getRomList());
});

// Serve ROM files
app.use('/roms', express.static(ROM_DIR));

// Upload a ROM
app.post('/api/upload', upload.single('rom'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Invalid file.' });
  io.emit('rom:list', getRomList());   // broadcast updated list
  res.json({ name: req.file.filename, url: `/roms/${req.file.filename}` });
});

function getDisplayName (filename) {
  return filename
    .replace(/^(\d+_)+/, '')       // strip one or more timestamp prefixes
    .replace(/\.[^.]+$/, '')       // strip file extension
    .replace(/\s*\(.*?\)\s*/g, '') // strip region tags like (USA)
    .trim();
}

function getRomList () {
  const all = fs.readdirSync(ROM_DIR)
    .filter(f => ['.smc', '.sfc', '.rom', '.bin'].includes(path.extname(f).toLowerCase()))
    .map(f => ({ name: f, displayName: getDisplayName(f), url: `/roms/${f}` }));

  // Deduplicate by displayName – prefer files without a timestamp prefix
  const seen = new Map();
  all.forEach(r => {
    const existing = seen.get(r.displayName);
    const hasTimestamp = /^\d{10,}_/.test(r.name);
    if (!existing || (!hasTimestamp && /^\d{10,}_/.test(existing.name))) {
      seen.set(r.displayName, r);
    }
  });
  return [...seen.values()];
}

// ─── Room helpers ─────────────────────────────────────────────────────────────
function getAllRooms () {
  return [...rooms.entries()].map(([id, room]) => ({
    id,
    playerCount: room.players.size,
    maxPlayers:  MAX_PLAYERS,
    players: [...room.players.values()].map(p => ({ slot: p.slot, name: p.name })),
    romName: room.romName || null,
  }));
}

function broadcastRoomList () {
  io.emit('rooms:list', getAllRooms());
}

// List all active rooms
app.get('/api/rooms', (_, res) => res.json(getAllRooms()));

// ─── Room / session state ─────────────────────────────────────────────────────
/**
 * rooms: Map<roomId, { players: Map<socketId, playerInfo>, host: socketId | null }>
 * playerInfo: { slot: 1-4, name: string }
 */
const rooms = new Map();

function getOrCreateRoom (roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      players:        new Map(),
      host:           null,   // first socket – for UI/room management
      emulatorSocket: null,   // the socket actually running EmulatorJS
    });
  }
  return rooms.get(roomId);
}

function assignSlot (room) {
  const used = new Set([...room.players.values()].map(p => p.slot));
  for (let s = 1; s <= MAX_PLAYERS; s++) {
    if (!used.has(s)) return s;
  }
  return null; // full
}

function roomInfo (roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  return {
    id: roomId,
    host: room.host,
    players: [...room.players.entries()].map(([id, p]) => ({ id, ...p }))
  };
}

// ─── Socket.IO events ──────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connected`);

  // ── Join a room ──────────────────────────────────────────────────────────────
  socket.on('room:join', ({ roomId, playerName, role }) => {
    roomId = String(roomId || 'default').slice(0, 32);
    const room  = getOrCreateRoom(roomId);
    const slot  = assignSlot(room);

    if (slot === null) {
      socket.emit('room:error', { message: 'Room is full (max 4 players).' });
      return;
    }

    const isHost       = room.players.size === 0;
    const isEmulator   = (role === 'emulator');     // page running EmulatorJS
    room.players.set(socket.id, { slot, name: playerName || `Player ${slot}`, role: role || 'controller' });
    if (isHost)     room.host           = socket.id;
    if (isEmulator) room.emulatorSocket = socket.id; // always track who owns the emulator

    socket.join(roomId);
    socket.data.roomId    = roomId;
    socket.data.slot      = slot;
    socket.data.isEmulator = isEmulator;

    socket.emit('room:joined', { slot, isHost, roomId, info: roomInfo(roomId) });
    socket.to(roomId).emit('room:updated', roomInfo(roomId));
    broadcastRoomList();

    // Notify emulator host of new viewer so they can initiate a WebRTC stream
    if (!isEmulator && room.emulatorSocket) {
      io.to(room.emulatorSocket).emit('viewer:joined', {
        socketId: socket.id,
        slot,
        name: playerName || `Player ${slot}`,
      });
    }

    // When a new emulator joins, notify it of ALL existing viewers so it can
    // immediately start WebRTC offers to viewers already waiting in the room.
    if (isEmulator) {
      for (const [viewerSockId, p] of room.players) {
        if (viewerSockId === socket.id) continue;       // skip self
        if (p.role === 'emulator') continue;            // skip other emulators
        socket.emit('viewer:joined', {
          socketId: viewerSockId,
          slot:     p.slot,
          name:     p.name,
        });
      }
      // Tell all existing viewers that an emulator host is now present so they
      // can re-arm their offer-wait timers and request a stream automatically.
      socket.to(roomId).emit('emulator:joined', {});
    }

    console.log(`  ↳ ${socket.id} joined room "${roomId}" as Player ${slot}${isHost ? ' [HOST]' : ''}`);
  });

  // ── Joypad input ─────────────────────────────────────────────────────────────
  /**
   * payload: { buttons: number, axes: { x: number, y: number } }
   * buttons is a 16-bit bitmask matching SNES button layout:
   *   bit 0  = B     bit 1  = Y     bit 2  = Select  bit 3  = Start
   *   bit 4  = Up    bit 5  = Down  bit 6  = Left    bit 7  = Right
   *   bit 8  = A     bit 9  = X     bit 10 = L       bit 11 = R
   */
  socket.on('joypad:input', (payload) => {
    // Prefer socket.data (set at room:join time); accept payload as fallback
    // in case of a mid-session reconnect where socket.data wasn't rehydrated yet.
    const roomId = socket.data.roomId || String(payload.roomId || '');
    const slot   = socket.data.slot   || Number(payload.slot)  || null;
    if (!roomId || !slot) return;

    const room = rooms.get(roomId);
    if (!room) return;

    // Route ONLY to the emulator host — they inject inputs into EmulatorJS
    const target = room.emulatorSocket || room.host;
    if (!target) return;

    io.to(target).emit('joypad:state', {
      slot,
      buttons: payload.buttons >>> 0,
      axes:    payload.axes || { x: 0, y: 0 }
    });
  });

  // ── Host broadcasts emulator state (for spectators) ──────────────────────────
  socket.on('emu:frame', (frameData) => {
    const { roomId } = socket.data;
    if (!roomId) return;
    socket.to(roomId).emit('emu:frame', frameData);
  });

  // ── Host requests save-state sync ────────────────────────────────────────────
  socket.on('emu:savestate', (data) => {
    const { roomId } = socket.data;
    if (!roomId) return;
    socket.to(roomId).emit('emu:savestate', data);
  });

  // ── Host sets the ROM name (shown in lobby) ────────────────────────────────
  socket.on('room:setrom', ({ romName }) => {
    const { roomId } = socket.data;
    const room = rooms.get(roomId);
    if (!room) return;
    room.romName = String(romName || '').slice(0, 80);
    broadcastRoomList();
  });

  // ── WebRTC signaling relay ─────────────────────────────────────────────────
  socket.on('webrtc:offer', ({ to, offer }) => {
    io.to(to).emit('webrtc:offer', { from: socket.id, offer });
  });

  socket.on('webrtc:answer', ({ to, answer }) => {
    io.to(to).emit('webrtc:answer', { from: socket.id, answer });
  });

  socket.on('webrtc:ice', ({ to, candidate }) => {
    io.to(to).emit('webrtc:ice', { from: socket.id, candidate });
  });

  // ── Host signals that the emulator game is now live ───────────────────────
  // Broadcast to all viewers so they can (re-)request a WebRTC stream
  // immediately, without waiting for the grace-period timer.
  socket.on('emulator:game-started', () => {
    const { roomId } = socket.data;
    if (!roomId) return;
    socket.to(roomId).emit('emulator:game-started', {});
    console.log(`  ↳ emulator:game-started broadcast in room "${roomId}"`);
  });

  // ── Viewer requests a (re-)offer from the emulator host ───────────────────
  // Fired when the viewer didn't receive a stream within the timeout, or
  // when the user manually clicks "Retry stream".
  socket.on('webrtc:request-offer', () => {
    const { roomId } = socket.data;
    const room = rooms.get(roomId);
    if (!room || !room.emulatorSocket) return;
    io.to(room.emulatorSocket).emit('viewer:joined', {
      socketId: socket.id,
      slot:     socket.data.slot,
      name:     room.players.get(socket.id)?.name || 'Viewer',
    });
    console.log(`  ↳ viewer:joined re-emitted for ${socket.id} (request-offer)`);
  });

  // ── Latency probe — viewer uses this to measure round-trip time ────────────
  socket.on('perf:ping', (_, ack) => { if (typeof ack === 'function') ack(Date.now()); });

  // ── Chat message ─────────────────────────────────────────────────────────────
  socket.on('chat:msg', ({ text }) => {
    const { roomId, slot } = socket.data;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    io.to(roomId).emit('chat:msg', {
      from: player ? player.name : 'Unknown',
      slot,
      text: String(text).slice(0, 200)
    });
  });

  // ── Disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { roomId } = socket.data;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.players.delete(socket.id);

    // Clear emulator ownership when that socket leaves
    if (room.emulatorSocket === socket.id) {
      room.emulatorSocket = null;
      // Let remaining players know the emulator host left
      io.to(roomId).emit('emulator:left', {});
    }

    if (room.players.size === 0) {
      rooms.delete(roomId);
      broadcastRoomList();
      console.log(`  ↳ Room "${roomId}" deleted (empty)`);
    } else {
      // Re-assign UI-host if needed, but only to non-viewer players
      if (room.host === socket.id) {
        const next = [...room.players.entries()]
          .find(([, p]) => p.role !== 'viewer');
        room.host = next ? next[0] : room.players.keys().next().value;
        io.to(roomId).emit('room:newhost', { host: room.host });
        console.log(`  ↳ New host in room "${roomId}": ${room.host}`);
      }
      io.to(roomId).emit('room:updated', roomInfo(roomId));
      broadcastRoomList();
    }

    console.log(`[-] ${socket.id} disconnected`);
  });
});

// ─── Periodic stale-room cleanup ────────────────────────────────────────────
// Safety net: remove any rooms that somehow kept zero players
// (e.g. socket closed before disconnect event fired properly)
setInterval(() => {
  let cleaned = 0;
  for (const [id, room] of rooms) {
    if (room.players.size === 0) {
      rooms.delete(id);
      cleaned++;
      console.log(`  [cleanup] Room "${id}" removed (stale/empty)`);
    }
  }
  if (cleaned) broadcastRoomList();
}, 30_000); // every 30 s

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`SNES Multiplayer Emulator`);
  console.log(`  Game:       http://localhost:${PORT}/`);
  console.log(`  Controller: http://localhost:${PORT}/controller.html`);
  console.log(`  Rooms:      share the room ID with friends`);
});
