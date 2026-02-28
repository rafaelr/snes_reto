# SNES Multiplayer Emulator

A full Super Nintendo emulator written in JavaScript with real-time multiplayer joypad support via **Socket.IO**.  
Up to **4 players** can connect — each controls one SNES joypad from any device.

---

## Architecture

```
snes-multiplayer/
├── server.js                  # Express + Socket.IO server
├── package.json
├── roms/                      # Uploaded ROMs (auto-created)
└── public/
    ├── index.html             # Game host page
    ├── controller.html        # Mobile controller page
    ├── css/
    │   ├── game.css
    │   └── controller.css
    └── js/
        ├── cpu.js             # WDC 65816 CPU (full instruction set)
        ├── ppu.js             # PPU – BG modes 0-7, sprites, Mode 7
        ├── apu.js             # SPC700 + DSP (BRR, ADSR envelopes)
        ├── memory.js          # Memory bus, LoROM/HiROM, DMA engine
        ├── rom.js             # ROM parser & header detection
        ├── joypad.js          # JoypadManager (keyboard, Gamepad API, sockets)
        ├── emulator.js        # Main emulator orchestrator + render loop
        ├── socket-controller.js # Client socket bridge (game page)
        └── controller-client.js # Virtual controller logic (controller page)
```

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Start the server

```bash
npm start
# or for auto-reload during development:
npm run dev
```

### 3. Open the game

```
http://localhost:3000/
```

### 4. Connect a remote controller

On any phone or second device:
```
http://localhost:3000/controller.html?room=room1
```
Or from the game page – after joining a room a controller URL is copied to your clipboard automatically.

---

## How Multiplayer Works

```
┌─────────────────────┐        Socket.IO         ┌──────────────────────┐
│   Game Host         │ ◄───────────────────────► │  Server (Node.js)    │
│   index.html        │                           │  server.js           │
│                     │  joypad:input events      │                      │
│  Runs emulator      │ ◄───────────────────────► │  Rooms / slots       │
│  P1 = local         │                           │  Max 4 players       │
│  P2-P4 = socket     │                           └──────────┬───────────┘
└─────────────────────┘                                      │
                                                             │ Socket.IO
                                        ┌────────────────────┴────────────────┐
                                        │                                     │
                              ┌─────────▼──────┐                  ┌──────────▼─────┐
                              │ Player 2       │                  │ Player 3/4     │
                              │ controller.html│                  │ controller.html│
                              │ (smartphone)   │                  │ (tablet, etc.) │
                              └────────────────┘                  └────────────────┘
```

### Room system

| Event | Direction | Description |
|-------|-----------|-------------|
| `room:join` | Client → Server | Join/create a room |
| `room:joined` | Server → Client | Slot & host assignment |
| `room:updated` | Server → All | Player list changed |
| `room:newhost` | Server → All | Host reassigned |
| `joypad:input` | Controller → Server | Button bitmask |
| `joypad:state` | Server → All | Broadcast input to emulator |
| `emu:savestate` | Host → All | Save-state sync |
| `chat:msg` | Any ↔ All | In-room chat |

### Joypad button bitmask

```
Bit 15 = B        Bit 14 = Y        Bit 13 = Select   Bit 12 = Start
Bit 11 = Up       Bit 10 = Down     Bit  9 = Left      Bit  8 = Right
Bit  7 = A        Bit  6 = X        Bit  5 = L         Bit  4 = R
Bit  3..0 = 0 (unused)
```

---

## Emulator Components

### CPU – WDC 65816 (`cpu.js`)
- Full 256-opcode implementation
- Native / emulation mode switching (`XCE`)
- All addressing modes (24-bit)
- DMA-aware timing stubs
- NMI / IRQ / BRK / COP vectors

### PPU – Picture Processing Unit (`ppu.js`)
- BG modes 0–7
- Mode 7 affine transformation
- 4 background layers with independent scroll
- OAM sprite rendering (4bpp, flip X/Y, palettes)
- 256-colour CGRAM with BGR555 → RGBA8888 decode
- Full VRAM read/write tracking

### APU – SPC700 + DSP (`apu.js`)
- IPL ROM boot stub
- SPC700 core (key opcodes, timer subsystem)
- 8-voice DSP with BRR decoding
- Gaussian interpolation, ADSR envelopes
- Web Audio API integration (32 kHz stereo)

### Memory Bus (`memory.js`)
- LoROM / HiROM address decode
- 128 KB WRAM (banks 7E-7F)
- DMA engine (8 channels, all transfer modes)
- WRAM access port ($2180-$2183)
- Hardware multiply / divide ($4202-$4206)
- Auto-joypad read ($4218-$421F)

### ROM Loader (`rom.js`)
- Strips SMC copier headers (.smc files)
- Scores LoROM vs HiROM candidates
- Decodes title, region, size, SRAM, checksum

---

## Controls

### Player 1 (keyboard)

| SNES     | Key        |
|----------|-----------|
| D-Pad    | Arrow keys |
| A        | X         |
| B        | Z         |
| X        | S         |
| Y        | A         |
| L        | Q         |
| R        | W         |
| Start    | Enter     |
| Select   | Tab       |

### Player 2 (keyboard)

| SNES  | Key |
|-------|-----|
| D-Pad | I / K / J / L |
| A     | B  |
| B     | V  |
| X     | H  |
| Y     | G  |
| L     | T  |
| R     | R  |
| Start | U  |
| Select| Y  |

### Gamepad API
Any standard gamepad (Xbox, PS, 8BitDo, etc.) is automatically mapped when connected.

---

## ROM Upload API

```http
GET  /api/roms          – List uploaded ROMs
POST /api/upload        – Upload a ROM (multipart/form-data, field "rom")
GET  /roms/:filename    – Serve a ROM file
```

Max upload size: **8 MB**. Accepted extensions: `.smc`, `.sfc`, `.rom`, `.bin`.

---

## Legal Notice

This emulator does **not** include any copyrighted BIOS or game ROMs.  
You must supply your own legally-owned ROM files.

---

## License

MIT
