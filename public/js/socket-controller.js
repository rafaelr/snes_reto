/**
 * Socket Controller Client  (EmulatorJS edition)
 *
 * Connects this page to the Socket.IO room so that:
 *   – Remote controller pages can send joypad inputs that are injected into
 *     EmulatorJS via  window.EJS_emulator.gameManager.simulateInput()
 *   – Chat and room events are relayed to the page UI
 *
 * SNES bitmask layout (matches controller-client.js):
 *   Bit 0  B    Bit 1  Y    Bit 2  SELECT  Bit 3  START
 *   Bit 4  UP   Bit 5  DOWN Bit 6  LEFT    Bit 7  RIGHT
 *   Bit 8  A    Bit 9  X    Bit 10 L       Bit 11 R
 *
 * EmulatorJS simulateInput(player, index, value) uses the same indices 0-11
 * for the SNES control scheme, so bits map 1-to-1 to EJS button indices.
 */

'use strict';

class SocketController {
  /**
   * @param {string} roomId
   * @param {string} playerName
   */
  constructor (roomId, playerName) {
    this.roomId      = roomId;
    this.playerName  = playerName;
    this.socket      = null;
    this.slot        = null;
    this.isHost      = false;
    this.connected   = false;
    this._ejsReady   = false;
    this._prevState  = new Uint32Array(5);   // index 1-4 = player slots
    this._handlers   = {};
  }

  // ── Notify when EmulatorJS game has started ──────────────────────────────────
  setEmulatorReady (ready) {
    this._ejsReady = ready;
    if (ready) {
      // Replay any queued button states that arrived before EJS was initialised
      for (let slot = 1; slot <= 4; slot++) {
        if (this._prevState[slot]) {
          const buttons = this._prevState[slot];
          this._prevState[slot] = 0;  // reset so _injectInput sees all as "changed"
          this._injectInput(slot, buttons);
        }
      }
    }
  }

  // ── Connect ──────────────────────────────────────────────────────────────────
  connect () {
    this.socket = io();

    this.socket.on('connect', () => {
      this.connected = true;
      this.socket.emit('room:join', {
        roomId:     this.roomId,
        playerName: this.playerName,
        role:       'emulator',   // this page runs EmulatorJS
      });
    });

    this.socket.on('room:joined', ({ slot, isHost, roomId, info }) => {
      this.slot   = slot;
      this.isHost = isHost;
      this._emit('joined', { slot, isHost, roomId, info });
    });

    this.socket.on('room:updated', info => {
      this._emit('roomUpdated', info);
    });

    this.socket.on('room:newhost', ({ host }) => {
      if (this.socket.id === host) {
        this.isHost = true;
        this._emit('newHost', {});
      }
    });

    this.socket.on('room:error', ({ message }) => {
      this._emit('error', { message });
    });

    // ── Remote joypad → EmulatorJS input injection ──────────────────────────
    this.socket.on('joypad:state', ({ slot, buttons }) => {
      // Skip our own slot; the host uses keyboard/gamepad natively in EJS
      if (slot === this.slot) return;
      this._injectInput(slot, buttons);
    });

    this.socket.on('chat:msg', msg => this._emit('chat', msg));

    this.socket.on('disconnect', () => {
      this.connected = false;
      this._emit('disconnected', {});
    });
  }

  // ── Inject a bitmask change into EmulatorJS for a given player slot ──────────
  _injectInput (slot, buttons) {
    // Slot is 1-based; host (slot 1) uses keyboard/gamepad in EJS natively.
    // Remote controllers start at slot 2 → EJS player index 1, 2, 3.
    const ejsPlayer = slot - 1;  // EJS players are 0-based

    const prev    = this._prevState[slot] || 0;
    const changed = prev ^ buttons;
    if (!changed) return;

    const ejs = window.EJS_emulator;
    if (!ejs || !this._ejsReady) {
      this._prevState[slot] = buttons;
      return;
    }

    // SNES has 12 buttons (indices 0–11 in EmulatorJS)
    for (let i = 0; i < 12; i++) {
      if (changed & (1 << i)) {
        const pressed = (buttons >> i) & 1;
        try {
          ejs.gameManager.simulateInput(ejsPlayer, i, pressed);
        } catch (_) { /* EJS not fully initialised yet */ }
      }
    }
    this._prevState[slot] = buttons;
  }

  // ── Tell server which ROM is loaded (for lobby display) ───────────────────
  setRom (romName) {
    if (!this.socket || !this.connected) return;
    this.socket.emit('room:setrom', { romName });
  }

  // ── Send chat ─────────────────────────────────────────────────────────────────
  sendChat (text) {
    if (!this.socket || !this.connected) return;
    this.socket.emit('chat:msg', { text });
  }

  // ── Disconnect ───────────────────────────────────────────────────────────────
  disconnect () {
    if (this.socket) { this.socket.disconnect(); this.socket = null; }
    this.connected = false;
  }

  // ── Simple event emitter ──────────────────────────────────────────────────────
  on  (event, fn) { (this._handlers[event] = this._handlers[event] || []).push(fn); }
  off (event, fn) {
    if (!this._handlers[event]) return;
    this._handlers[event] = this._handlers[event].filter(h => h !== fn);
  }
  _emit (event, data) {
    (this._handlers[event] || []).forEach(fn => fn(data));
  }
}
