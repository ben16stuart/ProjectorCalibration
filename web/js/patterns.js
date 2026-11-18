// Test pattern definitions. Coordinates are normalized to the full image
// (x, y, w, h in 0..1). SDR levels are 8-bit full-range codes (what the Mac
// renders; the Apple TV maps 0..255 to video levels 16..235). HDR levels are
// 10-bit limited-range PQ codes (64 = 0 nits, 940 = 10,000 nits) and exist only
// in the generated videos, because a browser on a Mac cannot send HDR over AirPlay.
//
// The top 9% of the frame is kept free for an instruction banner.

import { pq10, nitsFromPq10, linearToSrgb, clamp } from './color.js';

const gray = (v) => ({ type: 'solid', rgb: [v, v, v] });
const solid = (r, g, b) => ({ type: 'solid', rgb: [r, g, b] });
const pqGray = (code) => ({ type: 'solid', pq10: code });
const dither = (type) => ({ type, a: [0, 0, 0], b: [255, 255, 255] });

function barLayout({ n, x0, x1, gap, y0, y1, outerGap = gap }) {
  const w = (x1 - x0 - gap * (n - 1)) / n;
  const h = y1 - y0;
  const barRects = [];
  const gapRects = [[x0 - outerGap, y0, outerGap, h]];
  for (let i = 0; i < n; i++) {
    const x = x0 + i * (w + gap);
    barRects.push([x, y0, w, h]);
    if (i < n - 1) gapRects.push([x + w, y0, gap, h]);
  }
  gapRects.push([x1, y0, outerGap, h]);
  return { barRects, gapRects };
}

function labelRow(rects, texts, y, color, size = 0.035) {
  return rects.map((r, i) => ({ text: texts[i], x: r[0] + r[2] / 2, y, size, rgb: color }));
}

// ---------------------------------------------------------------- SDR patterns

function blackPattern() {
  // Near-black bars on 0% black. 2% should be visible, 1% at most barely.
  const levels = [3, 5, 8, 10, 15, 26];
  const pct = ['1%', '2%', '3%', '4%', '6%', '10%'];
  const { barRects, gapRects } = barLayout({ n: 6, x0: 0.1, x1: 0.9, gap: 0.04, y0: 0.16, y1: 0.78 });
  const bars = barRects.map((rect, i) => ({ id: `b${i}`, rect, fill: gray(levels[i]) }));
  const gaps = gapRects.map((rect, i) => ({ id: `g${i}`, rect, fill: gray(0) }));
  return {
    id: 'black',
    kind: 'sdr',
    title: 'Black level (Brightness)',
    bg: gray(0),
    bannerRgb: [48, 48, 48],
    elements: [...gaps, ...bars],
    labels: labelRow(barRects, pct, 0.86, [40, 40, 40]),
    meta: {
      bars: bars.map((b) => b.id),
      gaps: gaps.map((g) => g.id),
      levels,
      labels: pct,
      nominal: levels.map((c) => c / 255),
      targetIndex: 1, // the 2% bar must stay visible
    },
    howTo: 'Bars at 1, 2, 3, 4, 6 and 10% above black. Set Brightness as low as possible while the 2% bar stays visible; 1% may disappear.',
  };
}

function whitePattern() {
  // Near-white bars on a 75% background. Every bar should stay distinct.
  const levels = [217, 230, 240, 245, 250, 253, 255];
  const pct = ['85', '90', '94', '96', '98', '99', '100'];
  const { barRects, gapRects } = barLayout({ n: 7, x0: 0.075, x1: 0.925, gap: 0.025, y0: 0.16, y1: 0.78 });
  const bars = barRects.map((rect, i) => ({ id: `w${i}`, rect, fill: gray(levels[i]) }));
  const gaps = gapRects.map((rect, i) => ({ id: `g${i}`, rect, fill: gray(191) }));
  return {
    id: 'white',
    kind: 'sdr',
    title: 'White clipping (Contrast)',
    bg: gray(191),
    bannerRgb: [90, 90, 90],
    elements: [...gaps, ...bars],
    labels: labelRow(barRects, pct, 0.86, [120, 120, 120]),
    meta: {
      bars: bars.map((b) => b.id),
      gaps: gaps.map((g) => g.id),
      levels,
      labels: pct,
      nominal: levels.map((c) => c / 255),
      slopeRef: [0, 2], // 85% -> 94% sets the expected step size
      checkSteps: [[2, 3], [3, 4], [4, 5], [5, 6]],
    },
    howTo: 'Bars from 85% to 100% white. Raise Contrast until the top bars start to merge or tint, then back off.',
  };
}

export const GAMMA_STEPS = [1.7, 1.9, 2.1, 2.3, 2.5, 2.7];

function gammaPattern() {
  // Each pair is [fine black/white dither | solid gray]. The dither averages
  // optically to a known fraction of white in *linear light*; the solid gray
  // that matches it reveals the projector's gamma. The camera only has to judge
  // "equal or not", so its own tone curve does not matter.
  const rows = [
    { key: 'h', fill: 'hlines', p: 0.5, y: 0.11, name: '50% (horizontal lines)' },
    { key: 'v', fill: 'vlines', p: 0.5, y: 0.35, name: '50% (vertical lines)' },
    { key: 'd', fill: 'dots25', p: 0.25, y: 0.59, name: '25% (dot grid)' },
  ];
  // Layout per row: D S D S ... S D. Every solid sits between two identical
  // dithers and is compared with their average, which cancels any brightness
  // gradient across the screen (hot-spotting, camera vignetting).
  const rowH = 0.19;
  const x0 = 0.06;
  const n = GAMMA_STEPS.length;
  const pw = 0.88 / (2 * n + 1);
  const elements = [];
  const metaRows = [];
  for (const row of rows) {
    const pairs = [];
    for (let k = 0; k <= n; k++) {
      elements.push({ id: `${row.key}d${k}`, rect: [x0 + 2 * k * pw, row.y, pw, rowH], fill: dither(row.fill) });
    }
    GAMMA_STEPS.forEach((gm, k) => {
      const code = Math.round(255 * Math.pow(row.p, 1 / gm));
      const sId = `${row.key}s${k}`;
      elements.push({ id: sId, rect: [x0 + (2 * k + 1) * pw, row.y, pw, rowH], fill: gray(code) });
      pairs.push({ gamma: gm, dither: `${row.key}d${k}`, ditherRight: `${row.key}d${k + 1}`, solid: sId, code });
    });
    metaRows.push({ key: row.key, p: row.p, name: row.name, pairs });
  }
  elements.push({ id: 'refK', rect: [0.06, 0.83, 0.2, 0.12], fill: gray(0) });
  return {
    id: 'gamma',
    kind: 'sdr',
    title: 'Gamma (mid-tone brightness)',
    bg: gray(128),
    bannerRgb: [200, 200, 200],
    elements,
    labels: [
      // gamma value under each solid column
      ...GAMMA_STEPS.map((gm, k) => ({ text: gm.toFixed(1), x: x0 + (2 * k + 1.5) * pw, y: 0.805, size: 0.026, rgb: [200, 200, 200] })),
      { text: 'numbers = gamma of the solid gray in that column', x: 0.62, y: 0.89, size: 0.026, rgb: [170, 170, 170] },
    ],
    meta: { rows: metaRows, refs: { black: 'refK' } },
    howTo: 'Each row pairs a fine line pattern with solid grays for gamma 1.7 to 2.7. The solid that blends into its neighbour shows your gamma.',
  };
}

function grayscalePattern() {
  const levels = [77, 102, 128, 153, 179, 204, 230, 255];
  const pct = ['30', '40', '50', '60', '70', '80', '90', '100'];
  const { barRects } = barLayout({ n: 8, x0: 0.06, x1: 0.94, gap: 0.012, y0: 0.2, y1: 0.8 });
  const els = barRects.map((rect, i) => ({ id: `s${i}`, rect, fill: gray(levels[i]) }));
  return {
    id: 'grayscale',
    kind: 'sdr',
    title: 'Grayscale tracking (white balance)',
    bg: gray(150),
    bannerRgb: [60, 60, 60],
    elements: els,
    labels: labelRow(barRects, pct, 0.87, [80, 80, 80]),
    meta: { patches: els.map((e) => e.id), levels, labels: pct, lowIdx: [0, 1], highIdx: [5, 6, 7] },
    howTo: 'Grays from 30% to 100%. All of them should have the same tint; dark grays turning blue or red means the RGB offsets need work.',
  };
}

function colorClipPattern() {
  const levels = [204, 217, 230, 242, 255];
  const pct = ['80', '85', '90', '95', '100'];
  const chans = [
    { ch: 0, name: 'Red', y: 0.11 },
    { ch: 1, name: 'Green', y: 0.4 },
    { ch: 2, name: 'Blue', y: 0.69 },
  ];
  const elements = [];
  const rows = [];
  for (const c of chans) {
    const { barRects, gapRects } = barLayout({ n: 5, x0: 0.1, x1: 0.9, gap: 0.03, y0: c.y, y1: c.y + 0.2 });
    const bars = barRects.map((rect, i) => {
      const rgb = [0, 0, 0];
      rgb[c.ch] = levels[i];
      return { id: `${c.name[0]}${i}`, rect, fill: solid(...rgb) };
    });
    const gaps = gapRects.map((rect, i) => ({ id: `${c.name[0]}g${i}`, rect, fill: gray(191) }));
    elements.push(...gaps, ...bars);
    rows.push({ ch: c.ch, name: c.name, bars: bars.map((b) => b.id), gaps: gaps.map((g) => g.id) });
  }
  return {
    id: 'colorclip',
    kind: 'sdr',
    title: 'Color clipping (Color / saturation)',
    bg: gray(191),
    bannerRgb: [90, 90, 90],
    elements,
    labels: [],
    meta: { rows, levels, labels: pct, nominal: levels.map((c) => c / 255), slopeRef: [0, 2], checkSteps: [[2, 3], [3, 4]] },
    howTo: 'Red, green and blue bars from 80% to 100%. If the brightest bars merge, Color (saturation) is set too high.',
  };
}

export const OVERSCAN_RINGS = [
  { inset: 0.0, rgb: [255, 0, 0], name: 'red' },
  { inset: 0.0075, rgb: [0, 255, 0], name: 'green' },
  { inset: 0.0175, rgb: [0, 0, 255], name: 'blue' },
  { inset: 0.0275, rgb: [255, 255, 0], name: 'yellow' },
  { inset: 0.04, rgb: [255, 0, 255], name: 'magenta' },
  { inset: 0.06, rgb: [102, 102, 102], name: 'gray' },
];

function overscanPattern() {
  const elements = OVERSCAN_RINGS.map((r, i) => ({
    id: `ring${i}`,
    rect: [r.inset, r.inset, 1 - 2 * r.inset, 1 - 2 * r.inset],
    fill: solid(...r.rgb),
    measure: false,
  }));
  // Thin strips sampled just inside each visible edge.
  const t = 0.0015;
  const d = 0.0045;
  const strip = { margin: 0 };
  elements.push({ id: 'eT', rect: [0.2, t, 0.6, d], fill: null, ...strip });
  elements.push({ id: 'eB', rect: [0.2, 1 - t - d, 0.6, d], fill: null, ...strip });
  elements.push({ id: 'eL', rect: [t, 0.2, d, 0.6], fill: null, ...strip });
  elements.push({ id: 'eR', rect: [1 - t - d, 0.2, d, 0.6], fill: null, ...strip });
  elements.push({ id: 'center', rect: [0.3, 0.3, 0.4, 0.4], fill: null });
  return {
    id: 'overscan',
    kind: 'sdr',
    title: 'Overscan (is the picture cropped?)',
    bg: gray(0),
    bannerRgb: [200, 200, 200],
    elements,
    labels: [{ text: 'You should see a thin RED border on all four edges', x: 0.5, y: 0.55, size: 0.035, rgb: [200, 200, 200] }],
    meta: { strips: { top: 'eT', bottom: 'eB', left: 'eL', right: 'eR' }, center: 'center', rings: OVERSCAN_RINGS },
    howTo: 'Coloured frames 0, 0.75, 1.75, 2.75, 4 and 6% in from the edge. With overscan off you see the thin red border on every edge.',
  };
}

function fullPattern(id, v, title) {
  return { id, kind: 'sdr', title, bg: gray(v), bannerRgb: v > 128 ? [40, 40, 40] : [200, 200, 200], elements: [], labels: [], meta: {} };
}

// ---------------------------------------------------------------- HDR patterns
// HDR10 PQ codes. 64 = black. These only exist as generated video files.

function hdrBlackPattern() {
  const codes = [72, 76, 80, 88, 96, 120];
  const { barRects, gapRects } = barLayout({ n: 6, x0: 0.1, x1: 0.9, gap: 0.04, y0: 0.16, y1: 0.78 });
  const bars = barRects.map((rect, i) => ({ id: `b${i}`, rect, fill: pqGray(codes[i]) }));
  const gaps = gapRects.map((rect, i) => ({ id: `g${i}`, rect, fill: pqGray(64) }));
  const labels = codes.map((c) => String(c));
  return {
    id: 'hdr_black',
    kind: 'hdr',
    title: 'HDR black level',
    bg: pqGray(64),
    elements: [...gaps, ...bars],
    labels: labelRow(barRects, labels, 0.86, null).map((l) => ({ ...l, pq10: 300 })),
    meta: {
      bars: bars.map((b) => b.id),
      gaps: gaps.map((g) => g.id),
      levels: codes,
      labels: codes.map((c) => `${c} (${fmtNits(nitsFromPq10(c))})`),
      targetIndex: 2, // code 80, about 0.007 nits: the HDR equivalent of the 2% bar
      maxcll: 1000,
    },
    howTo: 'PQ code 72 to 120 bars on code-64 black. Code 80 should stay visible.',
  };
}

export const HDR_HIGHLIGHT_NITS = [100, 203, 300, 400, 500, 600, 800, 1000, 1500, 2000, 4000, 10000];

function hdrHighlightPattern(maxcll) {
  const n = 6;
  const r1 = barLayout({ n, x0: 0.08, x1: 0.92, gap: 0.03, y0: 0.13, y1: 0.43 });
  const r2 = barLayout({ n, x0: 0.08, x1: 0.92, gap: 0.03, y0: 0.53, y1: 0.83 });
  const rects = [...r1.barRects, ...r2.barRects];
  const gapRects = [...r1.gapRects, ...r2.gapRects];
  // 100-nit background keeps the camera's auto-exposure from blowing out the highlights
  const bg = pq10(100);
  const patches = rects.map((rect, i) => ({ id: `h${i}`, rect, fill: pqGray(pq10(HDR_HIGHLIGHT_NITS[i])) }));
  const gaps = gapRects.map((rect, i) => ({ id: `g${i}`, rect, fill: pqGray(bg) }));
  const texts = HDR_HIGHLIGHT_NITS.map((x) => (x >= 1000 ? `${x / 1000}k` : String(x)));
  return {
    id: `hdr_hl${maxcll}`,
    kind: 'hdr',
    title: `HDR highlights / tone mapping (${maxcll}-nit metadata)`,
    bg: pqGray(bg),
    elements: [...gaps, ...patches],
    labels: [
      ...labelRow(r1.barRects, texts.slice(0, 6), 0.47, null),
      ...labelRow(r2.barRects, texts.slice(6), 0.87, null),
    ].map((l) => ({ ...l, pq10: 400 })),
    meta: {
      patches: patches.map((p) => p.id),
      gapsRow1: gaps.slice(0, n + 1).map((g) => g.id),
      gapsRow2: gaps.slice(n + 1).map((g) => g.id),
      nits: HDR_HIGHLIGHT_NITS,
      maxcll,
    },
    howTo: 'Gray patches mastered at 100 to 10,000 nits. Shows where your projector stops getting brighter and how much brighter highlights are than ordinary white.',
  };
}

function fmtNits(n) {
  if (n < 0.01) return `${n.toFixed(4)} nit`;
  if (n < 1) return `${n.toFixed(3)} nit`;
  return `${Math.round(n)} nit`;
}

// ---------------------------------------------------------------- registry

const BUILDERS = {
  black: blackPattern,
  white: whitePattern,
  gamma: gammaPattern,
  grayscale: grayscalePattern,
  colorclip: colorClipPattern,
  overscan: overscanPattern,
  'black-full': () => fullPattern('black-full', 0, 'Black (locating screen)'),
  'white-full': () => fullPattern('white-full', 255, 'White (locating screen)'),
  standby: () => fullPattern('standby', 18, 'Standby'),
  hdr_black: hdrBlackPattern,
  hdr_hl1000: () => hdrHighlightPattern(1000),
  hdr_hl4000: () => hdrHighlightPattern(4000),
};

const cache = new Map();
export function getPattern(id) {
  if (!BUILDERS[id]) throw new Error(`Unknown pattern ${id}`);
  if (!cache.has(id)) cache.set(id, BUILDERS[id]());
  return cache.get(id);
}

export const VIDEO_PATTERNS = ['black', 'white', 'gamma', 'grayscale', 'colorclip', 'overscan', 'hdr_black', 'hdr_hl1000', 'hdr_hl4000'];

export function measuredElements(pattern) {
  return pattern.elements.filter((e) => e.measure !== false && e.id);
}

// ---------------------------------------------------------------- rendering

// HDR patterns cannot be shown by the browser; this gives a rough SDR preview.
function previewRgb(fill) {
  if (!fill) return null;
  if (fill.rgb) return fill.rgb;
  if (fill.pq10 != null) {
    const nits = nitsFromPq10(fill.pq10);
    const v = Math.round(255 * linearToSrgb(clamp(nits / 1000, 0, 1)));
    return [v, v, v];
  }
  return null;
}

const css = (rgb) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

/**
 * Draw a pattern onto a 2D canvas context of W x H *device* pixels. Fine
 * dither fills are written pixel by pixel so they stay exact.
 */
export function renderPattern(ctx, pattern, W, H, opts = {}) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = css(previewRgb(pattern.bg) || [0, 0, 0]);
  ctx.fillRect(0, 0, W, H);
  for (const el of pattern.elements) {
    if (!el.fill) continue;
    const x0 = Math.round(el.rect[0] * W);
    const y0 = Math.round(el.rect[1] * H);
    const x1 = Math.round((el.rect[0] + el.rect[2]) * W);
    const y1 = Math.round((el.rect[1] + el.rect[3]) * H);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) continue;
    if (el.fill.type === 'solid') {
      ctx.fillStyle = css(previewRgb(el.fill));
      ctx.fillRect(x0, y0, w, h);
    } else {
      const img = ctx.createImageData(w, h);
      const d = img.data;
      const { a, b } = el.fill;
      for (let y = 0; y < h; y++) {
        const ay = y0 + y;
        for (let x = 0; x < w; x++) {
          const ax = x0 + x;
          let on;
          if (el.fill.type === 'hlines') on = ay % 2 === 0;
          else if (el.fill.type === 'vlines') on = ax % 2 === 0;
          else if (el.fill.type === 'checker') on = (ax + ay) % 2 === 0;
          else on = ax % 2 === 0 && ay % 2 === 0; // dots25
          const c = on ? b : a;
          const i = (y * w + x) * 4;
          d[i] = c[0];
          d[i + 1] = c[1];
          d[i + 2] = c[2];
          d[i + 3] = 255;
        }
      }
      ctx.putImageData(img, x0, y0);
    }
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const l of pattern.labels || []) {
    const rgb = l.rgb || previewRgb({ pq10: l.pq10 }) || [128, 128, 128];
    ctx.fillStyle = css(rgb);
    ctx.font = `600 ${Math.round(l.size * H)}px -apple-system, Helvetica, Arial, sans-serif`;
    ctx.fillText(l.text, l.x * W, l.y * H);
  }
  if (opts.banner) {
    ctx.fillStyle = css(pattern.bannerRgb || [160, 160, 160]);
    ctx.font = `600 ${Math.round(0.038 * H)}px -apple-system, Helvetica, Arial, sans-serif`;
    ctx.fillText(opts.banner, W / 2, 0.045 * H, W * 0.94);
  }
  ctx.restore();
}
