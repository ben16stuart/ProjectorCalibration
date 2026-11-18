// Locating the projected image in the camera frame and mapping pattern
// coordinates (0..1) to camera pixels. Pure functions: no DOM.

// Solve the 3x3 homography H (h33 = 1) with dst ~ H * src for 4 point pairs.
export function solveHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i];
    const [x, y] = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  const h = solveLinear(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('Degenerate corner layout');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function applyH(H, u, v) {
  const w = H[6] * u + H[7] * v + H[8];
  return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w];
}

export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error('Singular homography');
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
  return inv.map((x) => x / det);
}

// corners: [TL, TR, BR, BL] in camera pixels -> homography from pattern space.
export function homographyFromQuad(corners) {
  return solveHomography(
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    corners,
  );
}

function percentile(arr, p) {
  // Histogram percentile for values in 0..255 (or more); arr is Float32Array.
  let max = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  if (max <= 0) return 0;
  const bins = 1024;
  const hist = new Uint32Array(bins);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v > 0) hist[Math.min(bins - 1, Math.floor((v / max) * (bins - 1)))]++;
  }
  const target = arr.length * p;
  let acc = arr.length - hist.reduce((a, b) => a + b, 0); // zeros / negatives
  for (let k = 0; k < bins; k++) {
    acc += hist[k];
    if (acc >= target) return ((k + 0.5) / bins) * max;
  }
  return max;
}

function fitLineTLS(pts) {
  // Total least squares line through points: returns {p: [x,y], d: [dx,dy]}
  let mx = 0;
  let my = 0;
  for (const [x, y] of pts) {
    mx += x;
    my += y;
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: [mx, my], d: [Math.cos(theta), Math.sin(theta)] };
}

function intersect(l1, l2) {
  const [x1, y1] = l1.p;
  const [dx1, dy1] = l1.d;
  const [x2, y2] = l2.p;
  const [dx2, dy2] = l2.d;
  const den = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((x2 - x1) * dy2 - (y2 - y1) * dx2) / den;
  return [x1 + t * dx1, y1 + t * dy1];
}

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(px - (ax + t * vx), py - (ay + t * vy)), t };
}

function polygonArea(c) {
  let a = 0;
  for (let i = 0; i < c.length; i++) {
    const [x1, y1] = c[i];
    const [x2, y2] = c[(i + 1) % c.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function isConvex(c) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = c[i];
    const [bx, by] = c[(i + 1) % 4];
    const [cx, cy] = c[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/**
 * Find the projected image from a white-minus-black difference image.
 * diff: Float32Array of length w*h (luma difference, 0..255).
 * Returns { ok, corners:[TL,TR,BR,BL], reason, touchesEdge, coverage }.
 */
export function detectQuad(diff, w, h) {
  const p99 = percentile(diff, 0.995);
  if (p99 < 12) return { ok: false, reason: 'The camera saw almost no change between the black and white frames. Is the pattern on the projector, and is the camera pointed at the screen?' };
  const thr = 0.4 * p99;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = diff[i] > thr ? 1 : 0;

  // Largest 4-connected component.
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let best = -1;
  let bestSize = 0;
  let next = 1;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue;
    let qh = 0;
    let qt = 0;
    queue[qt++] = s;
    label[s] = next;
    while (qh < qt) {
      const p = queue[qh++];
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && mask[p - 1] && !label[p - 1]) (label[p - 1] = next), (queue[qt++] = p - 1);
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) (label[p + 1] = next), (queue[qt++] = p + 1);
      if (y > 0 && mask[p - w] && !label[p - w]) (label[p - w] = next), (queue[qt++] = p - w);
      if (y < h - 1 && mask[p + w] && !label[p + w]) (label[p + w] = next), (queue[qt++] = p + w);
    }
    if (qt > bestSize) {
      bestSize = qt;
      best = next;
    }
    next++;
  }
  if (bestSize < 0.01 * w * h) return { ok: false, reason: 'The bright area the camera found is too small. Move the camera closer or zoom so the screen fills most of the frame.' };

  // Fill holes is unnecessary for corner finding; use extreme points.
  let tl = null;
  let tr = null;
  let br = null;
  let bl = null;
  let sMin = Infinity;
  let sMax = -Infinity;
  let dMin = Infinity;
  let dMax = -Infinity;
  let touches = 0;
  const boundary = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (label[p] !== best) continue;
      const s = x + y;
      const d = x - y;
      if (s < sMin) (sMin = s), (tl = [x, y]);
      if (s > sMax) (sMax = s), (br = [x, y]);
      if (d > dMax) (dMax = d), (tr = [x, y]);
      if (d < dMin) (dMin = d), (bl = [x, y]);
      const edge =
        x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        label[p - 1] !== best || label[p + 1] !== best || label[p - w] !== best || label[p + w] !== best;
      if (edge) {
        boundary.push([x + 0.5, y + 0.5]);
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches++;
      }
    }
  }
  let corners = [tl, tr, br, bl];

  // Refine: fit a straight line to the boundary pixels along each edge, away
  // from the corners, and intersect neighbouring lines.
  const edgePts = [[], [], [], []];
  for (const [x, y] of boundary) {
    let bestE = -1;
    let bestD = Infinity;
    let bestT = 0;
    for (let e = 0; e < 4; e++) {
      const r = distToSegment(x, y, corners[e], corners[(e + 1) % 4]);
      if (r.d < bestD) (bestD = r.d), (bestE = e), (bestT = r.t);
    }
    if (bestT > 0.12 && bestT < 0.88 && bestD < 0.03 * Math.max(w, h)) edgePts[bestE].push([x, y]);
  }
  if (edgePts.every((p) => p.length > 20)) {
    const lines = edgePts.map(fitLineTLS);
    const refined = [intersect(lines[3], lines[0]), intersect(lines[0], lines[1]), intersect(lines[1], lines[2]), intersect(lines[2], lines[3])];
    const sane = refined.every((c, i) => c && Math.hypot(c[0] - corners[i][0], c[1] - corners[i][1]) < 0.05 * Math.max(w, h));
    if (sane) corners = refined;
  }

  if (!isConvex(corners)) return { ok: false, reason: 'The detected outline is not a clean rectangle. Make sure nothing blocks the screen and the room is dark.' };
  const coverage = polygonArea(corners) / (w * h);
  const touchesEdge = touches > 0.02 * boundary.length;
  return {
    ok: true,
    corners,
    coverage,
    touchesEdge,
    reason: touchesEdge ? 'The projected image runs off the edge of the camera view; the whole screen must be visible.' : null,
  };
}

/**
 * Precompute which camera pixels belong to each measured element.
 * Returns Map(id -> { idx: Int32Array, n, quad }).
 */
export function buildSampler(H, elements, camW, camH, { margin = 0.2, maxPixels = 30000 } = {}) {
  const Hinv = invert3(H);
  const out = new Map();
  for (const el of elements) {
    const m = el.margin ?? margin;
    const [x, y, w, h] = el.rect;
    const u0 = x + m * w;
    const u1 = x + w - m * w;
    const v0 = y + m * h;
    const v1 = y + h - m * h;
    const quad = [applyH(H, u0, v0), applyH(H, u1, v0), applyH(H, u1, v1), applyH(H, u0, v1)];
    const xs = quad.map((q) => q[0]);
    const ys = quad.map((q) => q[1]);
    const bx0 = Math.max(0, Math.floor(Math.min(...xs)));
    const bx1 = Math.min(camW - 1, Math.ceil(Math.max(...xs)));
    const by0 = Math.max(0, Math.floor(Math.min(...ys)));
    const by1 = Math.min(camH - 1, Math.ceil(Math.max(...ys)));
    const area = Math.max(1, (bx1 - bx0 + 1) * (by1 - by0 + 1));
    const stride = Math.max(1, Math.ceil(Math.sqrt(area / maxPixels)));
    const idx = [];
    for (let py = by0; py <= by1; py += stride) {
      for (let px = bx0; px <= bx1; px += stride) {
        const [u, v] = applyH(Hinv, px + 0.5, py + 0.5);
        if (u >= u0 && u <= u1 && v >= v0 && v <= v1) idx.push(py * camW + px);
      }
    }
    out.set(el.id, { idx: Int32Array.from(idx), n: idx.length, quad });
  }
  return out;
}

/** Camera-space rectangle sampler (for a reference device region the user drew). */
export function rectSampler(rect, camW, camH, maxPixels = 20000) {
  const [x0, y0, x1, y1] = rect.map(Math.round);
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  const stride = Math.max(1, Math.ceil(Math.sqrt(area / maxPixels)));
  const idx = [];
  for (let y = Math.max(0, y0); y < Math.min(camH, y1); y += stride) {
    for (let x = Math.max(0, x0); x < Math.min(camW, x1); x += stride) idx.push(y * camW + x);
  }
  return { idx: Int32Array.from(idx), n: idx.length, quad: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
}
