// Where test patterns are shown:
//  'window'   - a separate pattern window, dragged onto the AirPlay display
//               (extended desktop). Talks to this page over BroadcastChannel.
//  'mirror'   - a full-viewport overlay in this page (screen mirroring).
//  'external' - the patterns are generated videos playing on the Apple TV;
//               nothing is drawn here.

import { getPattern, renderPattern } from './patterns.js';

export const CHANNEL = 'projectorcal';

export class PatternDisplay {
  constructor({ overlay, overlayCanvas, onKey, onStatus }) {
    this.mode = 'window';
    this.overlay = overlay;
    this.overlayCanvas = overlayCanvas;
    this.onKey = onKey || (() => {});
    this.onStatus = onStatus || (() => {});
    this.win = null;
    this.remote = null; // last 'hello' from the pattern window
    this.current = null;
    this.chan = new BroadcastChannel(CHANNEL);
    this.chan.onmessage = (e) => this.#onMessage(e.data);
    window.addEventListener('resize', () => this.mode === 'mirror' && this.current && this.#renderOverlay());
    setInterval(() => this.onStatus(this.status()), 1500);
  }

  #onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'hello') {
      this.remote = { ...m, at: Date.now() };
      if (this.current && m.needsPattern) this.#post();
      this.onStatus(this.status());
    } else if (m.type === 'key') this.onKey(m.key);
  }

  status() {
    if (this.mode === 'external') return { ok: true, text: 'Apple TV video' };
    if (this.mode === 'mirror') return { ok: true, text: 'Mirror (this window)' };
    const r = this.remote;
    if (!r || Date.now() - r.at > 5000) return { ok: false, text: 'Pattern window not open' };
    return { ok: true, fullscreen: r.fullscreen, text: `${r.devW}×${r.devH} px${r.fullscreen ? ', full screen' : ', not full screen'}`, ...r };
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'mirror') this.hideOverlay();
  }

  async openWindow() {
    let features = 'popup,width=960,height=540';
    // Chrome's Window Management API can place the window on the other display.
    try {
      if ('getScreenDetails' in window) {
        const d = await window.getScreenDetails();
        const other = d.screens.find((s) => s !== d.currentScreen);
        if (other) features = `popup,left=${other.availLeft + 40},top=${other.availTop + 40},width=${Math.min(1280, other.availWidth - 80)},height=${Math.min(720, other.availHeight - 80)}`;
      }
    } catch {
      /* permission denied: fall back to a normal popup */
    }
    this.win = window.open('pattern.html', 'projectorcal-pattern', features);
    return !!this.win;
  }

  #post() {
    this.chan.postMessage({ type: 'show', ...this.current });
  }

  #renderOverlay() {
    const c = this.overlayCanvas;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(window.innerWidth * dpr);
    c.height = Math.round(window.innerHeight * dpr);
    const ctx = c.getContext('2d');
    if (this.current.message != null) {
      drawMessage(ctx, c.width, c.height, this.current.message);
    } else {
      renderPattern(ctx, getPattern(this.current.patternId), c.width, c.height, { banner: this.current.banner });
    }
    this.overlay.hidden = false;
  }

  hideOverlay() {
    if (this.overlay) this.overlay.hidden = true;
  }

  show(patternId, banner = '') {
    this.current = { patternId, banner, message: null };
    if (this.mode === 'window') this.#post();
    else if (this.mode === 'mirror') this.#renderOverlay();
  }

  message(text) {
    this.current = { patternId: 'standby', banner: '', message: text };
    if (this.mode === 'window') this.#post();
    else if (this.mode === 'mirror') this.hideOverlay();
  }

  setBanner(banner) {
    if (!this.current || this.current.message != null) return;
    this.current.banner = banner;
    if (this.mode === 'window') this.#post();
    else if (this.mode === 'mirror' && !this.overlay.hidden) this.#renderOverlay();
  }
}

export function drawMessage(ctx, W, H, text) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = 'rgb(14,14,16)';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgb(150,150,155)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = String(text).split('\n');
  const size = Math.round(H * 0.045);
  lines.forEach((ln, i) => {
    ctx.font = `${i === 0 ? 600 : 400} ${i === 0 ? size : Math.round(size * 0.7)}px -apple-system, Helvetica, Arial, sans-serif`;
    ctx.fillText(ln, W / 2, H / 2 + (i - (lines.length - 1) / 2) * size * 1.4, W * 0.9);
  });
}
