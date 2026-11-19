// A synthetic projector + camera. Renders a test pattern, runs it through a
// projector model with known errors, then photographs it with a camera that
// has perspective, lens blur, vignetting, auto-exposure, auto white balance,
// an sRGB tone curve and noise. Used to check that the analysis recovers the
// projector's true behaviour.

import { getPattern } from '../web/js/patterns.js';
import { linearToSrgb, nitsFromPq10 } from '../web/js/color.js';
import { solveHomography, applyH, invert3 } from '../web/js/geometry.js';

export const SW = 960; // projector framebuffer
export const SH = 540;
export const CW = 640; // camera
export const CH = 360;

export const TRUE_CORNERS = [
  [92, 48],
  [566, 66],
  [578, 318],
  [74, 300],
];

export function makeProjector(over = {}) {
  return {
    brightness: 50,
    contrast: 50,
    color: 50,
    gamma: 2.3,
    black: 1 / 2000, // native black relative to white
    kb: 0.004, // signal offset per brightness click
    kc: 0.004, // gain per contrast click
    ks: 0.01, // saturation per color click
    chanGain: [1, 1, 1],
    chanOffset: [0, 0, 0], // added linear light, mostly visible near black
    overscan: 0,
    hdrClip: 1000,
    hdrExp: 0.8,
    sharp: false, // skip the lens blur: fine lines reach the camera sensor
    hotspot: 0, // extra brightness at the centre (screen gain / lens), e.g. 0.6 = +60%
    hotspotWidth: 0.15, // its spread, as a fraction of the picture
    ...over,
  };
}

// --- pattern rasterizer (same rules as renderPattern, minus text)
export function rasterize(pattern) {
  const n = SW * SH;
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  const isHdr = pattern.kind === 'hdr';
  const val = (fill) => (fill.rgb ? fill.rgb.map((c) => c / 255) : [nitsFromPq10(fill.pq10), nitsFromPq10(fill.pq10), nitsFromPq10(fill.pq10)]);
  const fillRect = (x0, y0, x1, y1, fill) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let c;
        if (fill.type === 'solid') c = val(fill);
        else {
          let on;
          if (fill.type === 'hlines') on = y % 2 === 0;
          else if (fill.type === 'vlines') on = x % 2 === 0;
          else if (fill.type === 'checker') on = (x + y) % 2 === 0;
          else on = x % 2 === 0 && y % 2 === 0;
          c = (on ? fill.b : fill.a).map((v) => v / 255);
        }
        const i = y * SW + x;
        R[i] = c[0];
        G[i] = c[1];
        B[i] = c[2];
      }
    }
  };
  fillRect(0, 0, SW, SH, pattern.bg);
  for (const el of pattern.elements) {
    if (!el.fill) continue;
    const x0 = Math.round(el.rect[0] * SW);
    const y0 = Math.round(el.rect[1] * SH);
    const x1 = Math.round((el.rect[0] + el.rect[2]) * SW);
    const y1 = Math.round((el.rect[1] + el.rect[3]) * SH);
    fillRect(x0, y0, x1, y1, el.fill);
  }
  return { R, G, B, isHdr };
}

// --- projector: signal -> linear light on screen (1.0 = peak white)
function projectSdr(v, ch, p, sat) {
  let x = v + p.kb * (p.brightness - 50);
  x *= (1 + p.kc * (p.contrast - 50)) * p.chanGain[ch];
  x = Math.min(1, Math.max(0, x));
  return p.black + (1 - p.black) * Math.pow(x, p.gamma) + p.chanOffset[ch] * (1 - x);
}

/** A viewer's answer for an SDR bar (8-bit code) on black: visible above a Weber fraction. */
export function eyeSeesBar(p, code, jnd = 0.04) {
  const black = projectSdr(0, 1, p, 1);
  return (projectSdr(code / 255, 1, p, 1) - black) / black > jnd;
}

function projectHdr(nits, p) {
  const sig = Math.max(0, nits);
  let rel = Math.pow(Math.min(sig, p.hdrClip) / p.hdrClip, p.hdrExp);
  // brightness offset acts near black, like SDR
  const off = p.kb * (p.brightness - 50) * 0.02;
  rel = Math.max(0, rel + off);
  return p.black + (1 - p.black) * rel;
}

export function screenImage(pattern, p) {
  const { R, G, B, isHdr } = rasterize(pattern);
  const n = SW * SH;
  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const s = 1 + p.ks * (p.color - 50);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      // overscan: the screen shows a magnified centre crop
      const u = p.overscan + (x / SW) * (1 - 2 * p.overscan);
      const v = p.overscan + (y / SH) * (1 - 2 * p.overscan);
      const sx = Math.min(SW - 1, Math.floor(u * SW + 1e-6));
      const sy = Math.min(SH - 1, Math.floor(v * SH + 1e-6));
      const i = sy * SW + sx;
      const o = y * SW + x;
      const hs = p.hotspot ? 1 + p.hotspot * Math.exp(-(((x + 0.5) / SW - 0.5) ** 2 + ((y + 0.5) / SH - 0.5) ** 2) / (2 * p.hotspotWidth ** 2)) : 1;
      if (isHdr) {
        const L = projectHdr(R[i], p);
        out[0][o] = out[1][o] = out[2][o] = L;
      } else {
        let r = R[i];
        let g = G[i];
        let b = B[i];
        if (s !== 1) {
          const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          r = Y + s * (r - Y);
          g = Y + s * (g - Y);
          b = Y + s * (b - Y);
        }
        out[0][o] = hs * projectSdr(r, 0, p, s);
        out[1][o] = hs * projectSdr(g, 1, p, s);
        out[2][o] = hs * projectSdr(b, 2, p, s);
      }
    }
  }
  // lens blur (3-tap binomial twice ~ sigma 1 px) so fine lines average in linear light;
  // sharp: a sharp phone lens that leaves the camera to sample the lines (moire)
  if (!p.sharp) for (const ch of out) blur(ch);
  return out;
}

function blur(a) {
  const tmp = new Float32Array(a.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        const i = y * SW + x;
        const l = a[i - (x > 0 ? 1 : 0)];
        const r = a[i + (x < SW - 1 ? 1 : 0)];
        tmp[i] = 0.25 * l + 0.5 * a[i] + 0.25 * r;
      }
    }
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        const i = y * SW + x;
        const u = tmp[i - (y > 0 ? SW : 0)];
        const d = tmp[i + (y < SH - 1 ? SW : 0)];
        a[i] = 0.25 * u + 0.5 * tmp[i] + 0.25 * d;
      }
    }
  }
}

// deterministic noise
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function gauss(r) {
  const u = Math.max(1e-12, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function makeCamera(over = {}) {
  // flare: share of light scattered into a wide glow around bright areas (lens flare,
  // phone-camera halo); exposureBias: >1 overexposes like a phone that keeps the
  // exposure it chose for a dark scene, so a white screen clips and blooms.
  return { corners: TRUE_CORNERS, kmax: 30, noise: 1.5, ambient: 0.0001, vignette: 0.18, awb: true, seed: 7, flare: 0, flareRadius: 8, exposureBias: 1, ...over };
}

/** In-place approximate Gaussian blur of a CW×CH plane (three box passes each way). */
function wideBlur(a, r) {
  const tmp = new Float32Array(a.length);
  const pass = (src, dst, n, stride, count, step) => {
    for (let line = 0; line < count; line++) {
      const base = line * step;
      let acc = 0;
      const at = (k) => src[base + Math.max(0, Math.min(n - 1, k)) * stride];
      for (let k = -r; k <= r; k++) acc += at(k);
      for (let k = 0; k < n; k++) {
        dst[base + k * stride] = acc / (2 * r + 1);
        acc += at(k + r + 1) - at(k - r);
      }
    }
  };
  for (let i = 0; i < 3; i++) {
    pass(a, tmp, CW, 1, CH, CW);
    pass(tmp, a, CH, CW, CW, 1);
  }
}

/** Photograph a screen image. Returns an array of RGBA Uint8ClampedArray frames. */
export function shoot(screen, cam, nFrames = 8) {
  const H = solveHomography([[0, 0], [1, 0], [1, 1], [0, 1]], cam.corners);
  const Hinv = invert3(H);
  const n = CW * CH;
  const lin = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const sub = [0.25, 0.75];
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      const o = y * CW + x;
      let acc = [0, 0, 0];
      for (const dy of sub) {
        for (const dx of sub) {
          const [u, v] = applyH(Hinv, x + dx, y + dy);
          if (u < 0 || u >= 1 || v < 0 || v >= 1) {
            acc = acc.map((a) => a + cam.ambient);
            continue;
          }
          const fx = u * SW - 0.5;
          const fy = v * SH - 0.5;
          const x0 = Math.max(0, Math.min(SW - 2, Math.floor(fx)));
          const y0 = Math.max(0, Math.min(SH - 2, Math.floor(fy)));
          const ax = Math.min(1, Math.max(0, fx - x0));
          const ay = Math.min(1, Math.max(0, fy - y0));
          const vig = 1 - cam.vignette * ((u - 0.5) ** 2 + (v - 0.5) ** 2) * 2;
          for (let c = 0; c < 3; c++) {
            const s = screen[c];
            const i = y0 * SW + x0;
            const val = (1 - ay) * ((1 - ax) * s[i] + ax * s[i + 1]) + ay * ((1 - ax) * s[i + SW] + ax * s[i + SW + 1]);
            acc[c] += val * vig;
          }
        }
      }
      for (let c = 0; c < 3; c++) lin[c][o] = acc[c] / 4;
    }
  }
  if (cam.flare > 0) {
    for (const ch of lin) {
      const glow = Float32Array.from(ch);
      wideBlur(glow, cam.flareRadius);
      for (let i = 0; i < ch.length; i++) ch[i] += cam.flare * glow[i];
    }
  }
  // centre-weighted auto exposure + gray-world white balance (like real webcams)
  const m = [0, 0, 0];
  let cnt = 0;
  for (let y = Math.floor(CH * 0.2); y < CH * 0.8; y++) {
    for (let x = Math.floor(CW * 0.2); x < CW * 0.8; x++) {
      const i = y * CW + x;
      for (let c = 0; c < 3; c++) m[c] += lin[c][i];
      cnt++;
    }
  }
  for (let c = 0; c < 3; c++) m[c] /= cnt;
  const Y = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
  const k = Math.min(cam.kmax, 0.18 / Math.max(1e-9, Y)) * cam.exposureBias;
  const wb = cam.awb ? m.map((x) => Math.min(2, Math.max(0.5, Y / Math.max(1e-9, x)))) : [1, 1, 1];
  const r = rng(cam.seed);
  const frames = [];
  for (let f = 0; f < nFrames; f++) {
    const d = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const e = linearToSrgb(Math.min(1, k * wb[c] * lin[c][i])) * 255 + cam.noise * gauss(r);
        d[i * 4 + c] = Math.round(e);
      }
      d[i * 4 + 3] = 255;
    }
    frames.push(d);
  }
  return frames;
}

export function shootPattern(id, proj, cam, nFrames = 8) {
  return shoot(screenImage(getPattern(id), proj), cam, nFrames);
}
