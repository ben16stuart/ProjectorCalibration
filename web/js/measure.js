// Orchestrates "show a pattern, wait for it to arrive, average camera frames".

import { getPattern, measuredElements } from './patterns.js';
import { detectQuad, homographyFromQuad, buildSampler, rectSampler } from './geometry.js';
import { PatchStats, fingerprint, fingerprintDistance, lumaOf } from './stats.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Measurer {
  constructor(camera, display) {
    this.camera = camera;
    this.display = display;
    this.corners = null;
    this.H = null;
    this.refRect = null; // camera-space rectangle around a reference screen
    this.busy = false;
    this.abortFlag = false;
  }

  setCorners(corners) {
    this.corners = corners;
    this.H = corners ? homographyFromQuad(corners) : null;
  }

  abort() {
    this.abortFlag = true;
  }

  async #averageLuma(n) {
    const { width: w, height: h } = this.camera;
    const acc = new Float32Array(w * h);
    for (let k = 0; k < n; k++) {
      const l = lumaOf(await this.camera.nextFrame(), w, h);
      for (let i = 0; i < acc.length; i++) acc[i] += l[i] / n;
    }
    return acc;
  }

  // Wait until the whole frame stops changing (pattern arrived, exposure settled).
  async #settleFull(minDelay, onStatus) {
    const t0 = performance.now();
    const grid = 24;
    let prev = null;
    let calm = 0;
    while (performance.now() - t0 < 10000) {
      const d = await this.camera.nextFrame();
      const { width: w, height: h } = this.camera;
      const fp = [];
      for (let gy = 0; gy < grid; gy++) {
        for (let gx = 0; gx < grid; gx++) {
          const p = (Math.floor(((gy + 0.5) / grid) * h) * w + Math.floor(((gx + 0.5) / grid) * w)) * 4;
          fp.push(0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]);
        }
      }
      if (prev) {
        let diff = 0;
        for (let i = 0; i < fp.length; i++) diff += Math.abs(fp[i] - prev[i]);
        calm = diff / fp.length < 1.5 ? calm + 1 : 0;
      }
      prev = fp;
      if (performance.now() - t0 > minDelay && calm >= 6) return true;
      onStatus?.('Waiting for the picture to settle…');
    }
    return false;
  }

  /** Flash black then white with our own display and find the screen. */
  async locate({ onStatus } = {}) {
    if (!this.camera.running) throw new Error('Start the camera first.');
    this.busy = true;
    try {
      this.display.show('black-full');
      onStatus?.('Showing black…');
      await this.#settleFull(1800, onStatus);
      const black = await this.#averageLuma(6);
      this.display.show('white-full');
      onStatus?.('Showing white…');
      await this.#settleFull(1800, onStatus);
      const white = await this.#averageLuma(6);
      const diff = new Float32Array(black.length);
      for (let i = 0; i < diff.length; i++) diff[i] = white[i] - black[i];
      const r = detectQuad(diff, this.camera.width, this.camera.height);
      if (r.ok) this.setCorners(r.corners);
      return r;
    } finally {
      this.busy = false;
    }
  }

  /** Watch an external video's black/white flashes for up to `seconds`. */
  async locateFromFlashes({ seconds = 30, onStatus } = {}) {
    if (!this.camera.running) throw new Error('Start the camera first.');
    this.busy = true;
    this.abortFlag = false;
    try {
      const { width: w, height: h } = this.camera;
      const lo = new Float32Array(w * h).fill(255);
      const hi = new Float32Array(w * h);
      const t0 = performance.now();
      let last = null;
      let lastCheck = t0;
      while (performance.now() - t0 < seconds * 1000 && !this.abortFlag) {
        const l = lumaOf(await this.camera.nextFrame(), w, h);
        for (let i = 0; i < l.length; i++) {
          if (l[i] < lo[i]) lo[i] = l[i];
          if (l[i] > hi[i]) hi[i] = l[i];
        }
        const now = performance.now();
        onStatus?.(`Watching for the black/white flashes… ${Math.round((now - t0) / 1000)} s`);
        if (now - lastCheck > 1000) {
          lastCheck = now;
          const diff = new Float32Array(w * h);
          for (let i = 0; i < diff.length; i++) diff[i] = hi[i] - lo[i];
          const r = detectQuad(diff, w, h);
          if (r.ok && r.coverage > 0.05) {
            if (last && r.corners.every((c, i) => Math.hypot(c[0] - last[i][0], c[1] - last[i][1]) < 2)) {
              this.setCorners(r.corners);
              return r;
            }
            last = r.corners;
          }
        }
      }
      return { ok: false, reason: this.abortFlag ? 'Stopped.' : 'Did not see the black/white flash. Start the video from the beginning while the app is watching.' };
    } finally {
      this.busy = false;
    }
  }

  samplerFor(pattern, { withRef = false } = {}) {
    const s = buildSampler(this.H, measuredElements(pattern), this.camera.width, this.camera.height);
    if (withRef && this.refRect) s.set('__ref', rectSampler(this.refRect, this.camera.width, this.camera.height));
    return s;
  }

  /**
   * Show a pattern, wait until it is stable in the camera, then average frames.
   * Returns { stats, pattern, settled }.
   */
  async measure(patternId, { frames = 30, minDelay = 1500, external = false, banner = '', withRef = false, show = true, onStatus } = {}) {
    if (!this.camera.running) throw new Error('Start the camera first.');
    if (!this.H) throw new Error('Locate the screen first (Connect step).');
    this.busy = true;
    this.abortFlag = false;
    try {
      const pattern = getPattern(patternId);
      const sampler = this.samplerFor(pattern, { withRef });
      if (!external && show) this.display.show(patternId, banner);
      const t0 = performance.now();
      let prev = null;
      let calm = 0;
      let settled = false;
      while (performance.now() - t0 < 9000 && !this.abortFlag) {
        const fp = fingerprint(sampler, await this.camera.nextFrame());
        calm = prev && fingerprintDistance(fp, prev) < 0.015 ? calm + 1 : 0;
        prev = fp;
        if (performance.now() - t0 > minDelay && calm >= 5) {
          settled = true;
          break;
        }
        onStatus?.('Waiting for the pattern to settle…');
      }
      if (this.abortFlag) throw new Error('Stopped.');
      const ps = new PatchStats(sampler);
      for (let k = 0; k < frames && !this.abortFlag; k++) {
        ps.addFrame(await this.camera.nextFrame());
        if (k % 5 === 0) onStatus?.(`Measuring… ${Math.round((100 * k) / frames)}%`);
      }
      const stats = ps.result();
      return { stats, pattern, settled };
    } finally {
      this.busy = false;
    }
  }
}

export { sleep };
