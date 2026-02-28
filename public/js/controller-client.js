/**
 * Controller Client
 * Runs on the controller.html page.
 * Handles virtual button presses and sends them via Socket.IO.
 */

'use strict';

// ── Button bit positions ────────────────────────────────────────────────
// Bits 0–11 match EmulatorJS simulateInput() button indices for SNES:
//   0=B  1=Y  2=SEL  3=START  4=UP  5=DOWN  6=LEFT  7=RIGHT  8=A  9=X  10=L  11=R
const BTN_MAP = {
  B:      1 << 0,
  Y:      1 << 1,
  SELECT: 1 << 2,
  START:  1 << 3,
  UP:     1 << 4,
  DOWN:   1 << 5,
  LEFT:   1 << 6,
  RIGHT:  1 << 7,
  A:      1 << 8,
  X:      1 << 9,
  L:      1 << 10,
  R:      1 << 11,
};

class ControllerClient {
  constructor () {
    this.socket    = null;
    this.roomId    = '';
    this.name      = '';
    this.slot      = null;
    this.buttons   = 0;      // current bitmask
    this._tickId   = null;
    this._lastSent = 0;
    this._SEND_HZ  = 60;     // send at up to 60 Hz
  }

  // ── Connect ───────────────────────────────────────────────────────────────────
  connect (roomId, name) {
    this.roomId = roomId;
    this.name   = name;
    this.socket = io();

    this.socket.on('connect', () => {
      console.log('[Controller] Connected');
      this.socket.emit('room:join', { roomId, playerName: name, role: 'controller' });
      this._startSendLoop();
    });

    this.socket.on('room:joined', ({ slot, isHost, roomId }) => {
      this.slot = slot;
      const slotColors = ['','#e94560','#0f9460','#c8a000','#7b44d4'];
      const color = slotColors[slot] || '#888';
      document.getElementById('status').innerHTML =
        `Sala: <strong>${roomId}</strong> &nbsp;|&nbsp; ` +
        `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:12px;font-weight:bold">Jogador ${slot}${isHost ? ' (Host)' : ''}</span>`;
      document.getElementById('status').className = 'status connected';
      document.getElementById('controller').style.display = 'grid';
      document.getElementById('connect-form').style.display = 'none';
    });

    this.socket.on('room:error', ({ message }) => {
      alert('Error: ' + message);
    });

    this.socket.on('room:updated', (info) => {
      const count = info.players.length;
      document.getElementById('player-count').textContent = `${count} / 4 players`;
    });

    this.socket.on('chat:msg', ({ from, text }) => {
      const box = document.getElementById('chat-log');
      if (box) {
        box.innerHTML += `<div><b>${from}:</b> ${text}</div>`;
        box.scrollTop = box.scrollHeight;
      }
    });

    this.socket.on('disconnect', () => {
      document.getElementById('status').textContent = 'Disconnected';
      document.getElementById('status').className = 'status disconnected';
      clearInterval(this._tickId);
    });
  }

  // ── Button press/release ──────────────────────────────────────────────────────
  press (btnName) {
    const bit = BTN_MAP[btnName];
    if (bit) this.buttons |= bit;
  }

  release (btnName) {
    const bit = BTN_MAP[btnName];
    if (bit) this.buttons &= ~bit;
  }

  // ── Send loop (throttled) ─────────────────────────────────────────────────────
  _startSendLoop () {
    setInterval(() => {
      if (!this.socket || !this.socket.connected) return;
      this.socket.emit('joypad:input', {
        buttons: this.buttons >>> 0,
        roomId:  this.roomId,   // fallback if socket.data is stale
        slot:    this.slot,
      });
    }, Math.floor(1000 / this._SEND_HZ));
  }

  // ── Gamepad API integration ───────────────────────────────────────────────────
  startGamepadPolling () {
    const poll = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const pad  = pads[0];
      if (pad && pad.connected) {
        let state = 0;
        const GM = ['B','A','Y','X','L','R',null,null,'SELECT','START',null,null,'UP','DOWN','LEFT','RIGHT'];
        for (let b = 0; b < Math.min(pad.buttons.length, 16); b++) {
          if (GM[b] && pad.buttons[b].pressed) state |= BTN_MAP[GM[b]];
        }
        if (pad.axes.length >= 2) {
          if (pad.axes[0] > 0.5)  state |= BTN_MAP.RIGHT;
          if (pad.axes[0] < -0.5) state |= BTN_MAP.LEFT;
          if (pad.axes[1] > 0.5)  state |= BTN_MAP.DOWN;
          if (pad.axes[1] < -0.5) state |= BTN_MAP.UP;
        }
        this.buttons = state;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }

  // ── Chat ──────────────────────────────────────────────────────────────────────
  sendChat (text) {
    if (this.socket) this.socket.emit('chat:msg', { text });
  }
}

// Touch / mouse helpers bound to buttons in controller.html
function bindControllerButtons (client) {
  document.querySelectorAll('[data-btn]').forEach(el => {
    const btn = el.dataset.btn;

    // Touch
    el.addEventListener('touchstart', e => { e.preventDefault(); client.press(btn); }, { passive: false });
    el.addEventListener('touchend',   e => { e.preventDefault(); client.release(btn); }, { passive: false });
    el.addEventListener('touchcancel',e => { e.preventDefault(); client.release(btn); }, { passive: false });

    // Mouse (fallback for desktop testing)
    el.addEventListener('mousedown', () => client.press(btn));
    el.addEventListener('mouseup',   () => client.release(btn));
    el.addEventListener('mouseleave',() => client.release(btn));
  });

  // D-pad touch drag
  const dpad = document.getElementById('dpad');
  if (dpad) {
    const DIRS = ['UP','DOWN','LEFT','RIGHT'];
    dpad.addEventListener('touchmove', e => {
      e.preventDefault();
      const touch = e.touches[0];
      const rect  = dpad.getBoundingClientRect();
      const cx    = rect.left + rect.width  / 2;
      const cy    = rect.top  + rect.height / 2;
      const dx    = touch.clientX - cx;
      const dy    = touch.clientY - cy;
      DIRS.forEach(d => client.release(d));
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        if (Math.abs(dx) > Math.abs(dy)) {
          client.press(dx > 0 ? 'RIGHT' : 'LEFT');
        } else {
          client.press(dy > 0 ? 'DOWN' : 'UP');
        }
      }
    }, { passive: false });
    dpad.addEventListener('touchend', e => {
      e.preventDefault();
      ['UP','DOWN','LEFT','RIGHT'].forEach(d => client.release(d));
    }, { passive: false });
  }
}

if (typeof window !== 'undefined') {
  window.ControllerClient   = ControllerClient;
  window.bindControllerButtons = bindControllerButtons;
}
