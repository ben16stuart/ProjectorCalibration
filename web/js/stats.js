// Per-patch statistics accumulated over camera frames. Pure: frames are plain
// RGBA byte arrays (ImageData.data), so the Node simulator can feed them too.

export class PatchStats {
  constructor(sampler) {
    this.sampler = sampler; // Map(id -> {idx, n})
    this.frames = 0;
    this.acc = new Map();
    for (const [id] of sampler) {
      this.acc.set(id, { m: [0, 0, 0], m2: [0, 0, 0], sv: [0, 0, 0], sat: 0 });
    }
  }

  addFrame(data) {
    for (const [id, s] of this.sampler) {
      const { idx, n } = s;
      if (!n) continue;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let qr = 0;
      let qg = 0;
      let qb = 0;
      let sat = 0;
      for (let k = 0; k < n; k++) {
        const p = idx[k] * 4;
        const r = data[p];
        const g = data[p + 1];
        const b = data[p + 2];
        sr += r;
        sg += g;
        sb += b;
        qr += r * r;
        qg += g * g;
        qb += b * b;
        if (r >= 254 || g >= 254 || b >= 254) sat++;
      }
      const m = [sr / n, sg / n, sb / n];
      const v = [qr / n - m[0] ** 2, qg / n - m[1] ** 2, qb / n - m[2] ** 2];
      const a = this.acc.get(id);
      for (let c = 0; c < 3; c++) {
        a.m[c] += m[c];
        a.m2[c] += m[c] * m[c];
        a.sv[c] += Math.max(0, v[c]);
      }
      a.sat += sat / n;
    }
    this.frames++;
  }

  result() {
    const out = {};
    const F = Math.max(1, this.frames);
    for (const [id, a] of this.acc) {
      const mean = a.m.map((x) => x / F);
      out[id] = {
        mean,
        sd: a.sv.map((x) => Math.sqrt(x / F)),
        tsd: a.m2.map((x, c) => Math.sqrt(Math.max(0, x / F - mean[c] ** 2))),
        n: this.sampler.get(id).n,
        frames: this.frames,
        sat: a.sat / F,
      };
    }
    return out;
  }
}

/** Mean luma of every sampled patch in one frame: a cheap fingerprint used to
 * decide when the picture has stopped changing after a pattern switch. */
export function fingerprint(sampler, data) {
  const out = [];
  for (const [, s] of sampler) {
    const { idx, n } = s;
    if (!n) {
      out.push(0);
      continue;
    }
    let acc = 0;
    const step = Math.max(1, Math.floor(n / 400));
    let cnt = 0;
    for (let k = 0; k < n; k += step) {
      const p = idx[k] * 4;
      acc += 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
      cnt++;
    }
    out.push(acc / cnt);
  }
  return out;
}

export function fingerprintDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const rel = Math.abs(a[i] - b[i]) / Math.max(8, (a[i] + b[i]) / 2);
    if (rel > worst) worst = rel;
  }
  return worst;
}

export function lumaOf(data, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  return out;
}
