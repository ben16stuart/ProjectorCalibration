// Transfer functions and small numeric helpers. No DOM: shared by the browser,
// the Node tests and (via tools/export_patterns.mjs) the video generator.

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function srgbToLinear(c) {
  // c: encoded value 0..1
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(l) {
  l = clamp(l, 0, 1);
  return l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}

// SMPTE ST 2084 (PQ). nits <-> normalized signal 0..1
const M1 = 2610 / 16384;
const M2 = (2523 / 4096) * 128;
const C1 = 3424 / 4096;
const C2 = (2413 / 4096) * 32;
const C3 = (2392 / 4096) * 32;

export function pqEncode(nits) {
  const y = clamp(nits / 10000, 0, 1);
  const p = Math.pow(y, M1);
  return Math.pow((C1 + C2 * p) / (1 + C3 * p), M2);
}

export function pqDecode(e) {
  const p = Math.pow(clamp(e, 0, 1), 1 / M2);
  const num = Math.max(p - C1, 0);
  const den = C2 - C3 * p;
  return 10000 * Math.pow(num / den, 1 / M1);
}

// 10-bit limited-range ("video level") PQ code for a gray level in nits.
export const pq10 = (nits) => Math.round(64 + 876 * pqEncode(nits));
export const nitsFromPq10 = (code) => pqDecode((code - 64) / 876);

export const luma709 = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Camera response model. Webcams output roughly sRGB-encoded values, but the
 * exact curve is unknown; the gamma test can calibrate a power-law exponent.
 * Within one frame, ratios of linearized values are independent of exposure
 * and of global (per-channel) white-balance gains, which is what every
 * analysis in this app relies on.
 */
export function cameraModel(kind = 'srgb', exponent = 2.2) {
  if (kind === 'power') {
    return {
      kind,
      exponent,
      lin: (c) => Math.pow(clamp(c, 0, 255) / 255, exponent),
      describe: `calibrated power curve (exponent ${exponent.toFixed(2)})`,
    };
  }
  return {
    kind: 'srgb',
    exponent: null,
    lin: (c) => srgbToLinear(clamp(c, 0, 255) / 255),
    describe: 'assumed sRGB curve (uncalibrated)',
  };
}

export function linRGB(mean, cam) {
  return [cam.lin(mean[0]), cam.lin(mean[1]), cam.lin(mean[2])];
}

export function linY(mean, cam) {
  const [r, g, b] = linRGB(mean, cam);
  return luma709(r, g, b);
}

export function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1));
}

// Least-squares line fit y = a + b x. Returns {a, b, residuals}.
export function fitLine(xs, ys) {
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  const a = my - b * mx;
  return { a, b, residuals: ys.map((y, i) => y - (a + b * xs[i])) };
}

// Spearman rank correlation, used to check that the camera is looking at the
// pattern we think it is.
export function spearman(xs, ys) {
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(v.length);
    idx.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (rx[i] - ry[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}
