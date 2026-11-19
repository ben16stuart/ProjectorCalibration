// Turns per-patch camera statistics into measurements. Pure functions.
//
// Ground rules (why a webcam can do this at all):
//  * Every comparison is between patches in the SAME frame, so auto-exposure
//    and auto white balance (global gains) cancel out.
//  * Bars are compared with the background immediately beside them, which
//    cancels screen hot-spotting and lens vignetting.
//  * Where possible the camera only judges "equal or not" (gamma test), so its
//    unknown tone curve does not matter.

import { linRGB, linY, luma709, fitLine, mean, std, spearman, srgbToLinear, nitsFromPq10 } from './color.js';
import { GAMMA_STEPS } from './patterns.js';

const lumaCode = (m) => luma709(m[0], m[1], m[2]);

// Uncertainty (1 sigma) of a patch's linearized luminance from frame-to-frame noise.
function tempSigmaY(st, cam) {
  const c = lumaCode(st.mean);
  const tsd = lumaCode(st.tsd);
  const d = cam.lin(Math.min(255, c + 0.5)) - cam.lin(Math.max(0, c - 0.5));
  return (d * tsd) / Math.sqrt(Math.max(1, st.frames));
}

function cameraSaturated(st) {
  return Math.max(...st.mean) > 247 || st.sat > 0.02;
}

// Noise of a row of patches that should all read the same, using second
// differences so smooth fall-off (vignetting, hot-spotting) does not count as noise.
function localNoise(values) {
  if (values.length < 3) return 0;
  const r = [];
  for (let j = 1; j < values.length - 1; j++) r.push(values[j] - (values[j - 1] + values[j + 1]) / 2);
  const rms = Math.sqrt(r.reduce((a, b) => a + b * b, 0) / r.length);
  return rms / Math.sqrt(1.5);
}

function requireStats(stats, ids) {
  const missing = ids.filter((id) => !stats[id] || !stats[id].n);
  if (missing.length) throw new Error(`Patches not visible to the camera: ${missing.join(', ')}. Re-run "Locate screen".`);
}

// ------------------------------------------------------------ black level

export function analyzeBlack(pattern, stats, cam, { threshold = 0.04 } = {}) {
  const { bars, gaps, labels, targetIndex } = pattern.meta;
  requireStats(stats, [...bars, ...gaps]);
  const gY = gaps.map((id) => linY(stats[id].mean, cam));
  const bY = bars.map((id) => linY(stats[id].mean, cam));
  const notes = [];

  // Background under each bar: the two gaps beside it, corrected for the local
  // curvature (4-point cubic interpolation). A hot spot bends the background; this
  // follows it instead of treating the bend as noise.
  const curv = gY.map((g, j) => (j > 0 && j < gY.length - 1 ? g - (gY[j - 1] + gY[j + 1]) / 2 : null));
  const camBlackCode = Math.max(...gaps.map((id) => Math.max(...stats[id].mean)));

  const rows = bars.map((id, i) => {
    const cs = [curv[i], curv[i + 1]].filter((c) => c != null);
    const bg = (gY[i] + gY[i + 1]) / 2 + (cs.length ? (cs.reduce((a, b) => a + b, 0) / cs.length) / 4 : 0);
    // How far that estimate can be off: how much the curvature changes across this
    // bar (small for a smooth hot spot or vignetting), plus 1% for unevenness that no
    // interpolation sees.
    const shape = cs.length === 2 ? Math.abs(cs[0] - cs[1]) / 4 : cs.length ? Math.abs(cs[0]) / 4 : 0;
    const sigSp = Math.hypot(shape, 0.01 * bg);
    const tBar = tempSigmaY(stats[id], cam);
    const tBg = (tempSigmaY(stats[gaps[i]], cam) + tempSigmaY(stats[gaps[i + 1]], cam)) / 2;
    const sigma = Math.sqrt(sigSp * sigSp + tBar * tBar + tBg * tBg);
    const contrast = bg > 0 ? (bY[i] - bg) / bg : 0;
    const noise = bg > 0 ? sigma / bg : Infinity;
    const mdc = Math.max(threshold, 3 * noise);
    // Between "clearly there" (3 sigma) and "no sign of it" (1.5 sigma) the camera
    // cannot call it. That band matters: raising Brightness lifts the black under
    // the bars, which shrinks their contrast, so a forced "hidden" there would keep
    // pushing Brightness up.
    const unsure = contrast < mdc && contrast >= Math.max(threshold / 2, 1.5 * noise);
    return { label: labels[i], contrast, noise, mdc, visible: contrast >= mdc, unsure };
  });

  let firstVisible = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].visible) firstVisible = i;
    else break;
  }

  let confidence = 'high';
  const tgt = rows[targetIndex];
  if (camBlackCode < 1.5) {
    confidence = 'none';
    notes.push('The camera records the black background as pure 0: it is crushing shadows itself, so it cannot judge near-black detail. Try the iPhone (Continuity Camera), a darker room, or judge by eye.');
  } else if (!rows[rows.length - 1].visible) {
    confidence = 'none';
    notes.push(`Even the ${labels[labels.length - 1]} bar is not visible to the camera. Either the projector is crushing a lot of shadow detail, or the camera is not sensitive enough. Check by eye: can you see the brightest bar?`);
  } else if (tgt.mdc > 0.15) {
    confidence = 'low';
    notes.push('The camera picture is noisy at this light level, so faint bars are hard to call. A better camera (iPhone via Continuity Camera) or a closer position helps.');
  } else if (tgt.mdc > 0.08) {
    confidence = 'medium';
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].contrast < rows[i - 1].contrast - 3 * rows[i].noise - 0.02) {
      if (confidence === 'high' || confidence === 'medium') confidence = 'low';
      notes.push('Bars do not get steadily brighter left to right. Something may be covering part of the pattern (projector menu, a shadow) or the camera moved.');
      break;
    }
  }

  let pass = confidence === 'none' ? null : rows.slice(targetIndex).every((r) => r.visible);
  if (pass === false && tgt.unsure) {
    pass = null;
    confidence = 'none';
    notes.unshift(`The ${labels[targetIndex]} bar shows faintly in the camera picture, but too close to the camera's noise to call. Judge it by eye: can you see the ${labels[targetIndex]} bar?`);
  }
  return {
    test: pattern.id,
    pass,
    confidence,
    firstVisible,
    firstVisibleLabel: firstVisible == null ? null : labels[firstVisible],
    rows,
    noiseFloor: rows[targetIndex].mdc,
    targetLabel: labels[targetIndex],
    belowTargetVisible: targetIndex > 0 ? rows[targetIndex - 1].visible : null,
    notes,
  };
}

// ------------------------------------------------------------ clipping (white / color)

function clipRows(values, nominal, slopeRef, checkSteps, noise) {
  // values: normalized brightness per bar (one channel). Expected step sizes are
  // extrapolated from the lower bars with a 2.2 power law; a step that grows by
  // much less than expected is clipping.
  const w = nominal.map((v) => Math.pow(v, 2.2));
  const [r0, r1] = slopeRef;
  const s = (values[r1] - values[r0]) / (w[r1] - w[r0]);
  if (!(s > 0)) return { ok: false, reason: 'no-slope', steps: [] };
  const steps = checkSteps.map(([a, b]) => {
    const exp = s * (w[b] - w[a]);
    const got = values[b] - values[a];
    const ratio = got / exp;
    const resolvable = exp > 3 * noise;
    return { from: a, to: b, ratio, resolvable, clipped: resolvable && ratio < 0.35 };
  });
  return { ok: true, steps };
}

function normalizedByGaps(stats, bars, gaps, cam, ch) {
  // value of each bar divided by the mean of its two neighbouring gaps
  const pick = (id) => (ch === 'Y' ? linY(stats[id].mean, cam) : linRGB(stats[id].mean, cam)[ch]);
  const g = gaps.map(pick);
  const vals = bars.map((id, i) => pick(id) / ((g[i] + g[i + 1]) / 2));
  const rel = Math.max(0.0015, localNoise(g) / Math.max(1e-9, mean(g)));
  // noise of the difference between two normalized bars
  return { vals, noise: Math.SQRT2 * rel * Math.max(...vals) };
}

export function analyzeWhite(pattern, stats, cam) {
  const { bars, gaps, nominal, slopeRef, checkSteps, labels } = pattern.meta;
  requireStats(stats, [...bars, ...gaps]);
  const notes = [];
  if (bars.some((id) => cameraSaturated(stats[id]))) {
    return {
      test: pattern.id,
      pass: null,
      confidence: 'none',
      notes: ['The camera itself is overexposed on the brightest bars, so it cannot see clipping. Let the screen fill more of the camera view (auto-exposure then darkens), or move further back.'],
      channels: {},
    };
  }
  const channels = {};
  for (const [name, ch] of [['Luminance', 'Y'], ['Red', 0], ['Green', 1], ['Blue', 2]]) {
    const { vals, noise } = normalizedByGaps(stats, bars, gaps, cam, ch);
    channels[name] = clipRows(vals, nominal, slopeRef, checkSteps, noise);
  }
  // A clip in the top 99->100 step only is cosmetic; anything lower fails.
  const lastIdx = checkSteps.length - 1;
  const failing = [];
  let slight = false;
  for (const [name, r] of Object.entries(channels)) {
    if (!r.ok) {
      notes.push(`${name}: the camera could not see the lower bars getting brighter; result uncertain.`);
      continue;
    }
    r.steps.forEach((s, k) => {
      if (!s.clipped) return;
      if (k === lastIdx) slight = true;
      else failing.push({ channel: name, k, step: `${labels[s.from]}→${labels[s.to]}` });
    });
  }
  const stepLabel = (k) => `${labels[checkSteps[k][0]]}→${labels[checkSteps[k][1]]}`;
  const anyOk = Object.values(channels).some((r) => r.ok);
  const unresolvable = Object.values(channels).every((r) => !r.ok || r.steps.slice(0, lastIdx).every((s) => !s.resolvable));
  let confidence = anyOk ? (unresolvable ? 'low' : 'high') : 'none';
  if (unresolvable && anyOk) notes.push('Differences between the top bars are too small for the camera to resolve reliably.');
  const firstClip = failing.length ? stepLabel(Math.min(...failing.map((f) => f.k))) : slight ? stepLabel(lastIdx) : null;
  const tinted = failing.filter((f) => f.channel !== 'Luminance').map((f) => f.channel);
  if (tinted.length && !failing.some((f) => f.channel === 'Luminance')) {
    notes.push(`${[...new Set(tinted)].join(' and ')} reaches its maximum before the others, so near-white highlights pick up a tint.`);
  }
  if (slight && !failing.length) notes.push('Only the last 99%→100% step merges. That is not visible in real content.');
  return {
    test: pattern.id,
    pass: confidence === 'none' ? null : failing.length === 0,
    confidence,
    failing,
    slight,
    firstClip,
    channels,
    notes,
  };
}

export function analyzeColorClip(pattern, stats, cam) {
  const { rows, nominal, slopeRef, checkSteps, labels } = pattern.meta;
  const notes = [];
  const out = [];
  for (const row of rows) {
    requireStats(stats, [...row.bars, ...row.gaps]);
    if (row.bars.some((id) => cameraSaturated(stats[id]))) {
      out.push({ name: row.name, ok: false, saturated: true, clipped: false });
      continue;
    }
    const { vals, noise } = normalizedByGaps(stats, row.bars, row.gaps, cam, row.ch);
    const r = clipRows(vals, nominal, slopeRef, checkSteps, noise);
    out.push({ name: row.name, ok: r.ok, steps: r.steps, clipped: r.ok && r.steps.some((s) => s.clipped) });
  }
  if (out.some((r) => r.saturated)) notes.push('The camera is overexposed on some colour bars; those rows were skipped.');
  const valid = out.filter((r) => r.ok);
  const clipped = valid.filter((r) => r.clipped).map((r) => r.name);
  return {
    test: pattern.id,
    pass: valid.length ? clipped.length === 0 : null,
    confidence: valid.length === 3 ? 'high' : valid.length ? 'medium' : 'none',
    clipped,
    rows: out,
    labels,
    notes,
  };
}

// ------------------------------------------------------------ gamma

/**
 * Camera tone-curve exponent from two dither patches whose light output has a
 * known ratio: 50% lines vs 25% dots (both mid-gray, so neither saturates the
 * camera). With a power-law camera, (c50/c25)^g = (0.5+0.5b)/(0.25+0.75b),
 * where b is the projector's black floor, estimated from the black patch.
 */
function cameraExponentFromDithers(c50, c25, cK) {
  if (!(c50 > c25 && c25 > 0)) return null;
  let b = 0;
  let g = 2.2;
  for (let k = 0; k < 8; k++) {
    g = Math.log((0.5 + 0.5 * b) / (0.25 + 0.75 * b)) / Math.log(c50 / c25);
    const q = Math.pow(Math.max(0, cK) / c50, g);
    b = Math.min(0.2, (0.5 * q) / Math.max(1e-6, 1 - 0.5 * q));
  }
  return g;
}

export function analyzeGamma(pattern, stats, cam) {
  const { rows, refs } = pattern.meta;
  const notes = [];
  const out = [];
  const black = stats[refs.black];
  requireStats(stats, [refs.black]);
  for (const row of rows) {
    requireStats(stats, row.pairs.flatMap((p) => [p.dither, p.ditherRight, p.solid]));
    const rel = row.pairs.map((p) => {
      // average of the dithers on both sides cancels brightness gradients
      const d = (linY(stats[p.dither].mean, cam) + linY(stats[p.ditherRight].mean, cam)) / 2;
      const s = linY(stats[p.solid].mean, cam);
      return (s - d) / d;
    });
    // Is the camera resolving the individual lines? Then it is not averaging
    // them in linear light and the row is unusable.
    const sdRatio = mean(row.pairs.map((p) => stats[p.dither].sd[1] / Math.max(0.5, stats[p.solid].sd[1])));
    const resolved = sdRatio > 2.5;
    let gamma = null;
    let bound = null;
    const gs = row.pairs.map((p) => p.gamma);
    for (let k = 0; k < rel.length - 1; k++) {
      if (rel[k] <= 0 && rel[k + 1] >= 0) {
        gamma = gs[k] + ((gs[k + 1] - gs[k]) * -rel[k]) / (rel[k + 1] - rel[k]);
        break;
      }
    }
    if (gamma == null) {
      const n = rel.length;
      if (rel.every((r) => r < 0)) {
        const slope = (rel[n - 1] - rel[n - 2]) / (gs[n - 1] - gs[n - 2]);
        gamma = slope > 0 ? Math.min(3.2, gs[n - 1] - rel[n - 1] / slope) : 3.2;
        bound = 'above';
      } else if (rel.every((r) => r > 0)) {
        const slope = (rel[1] - rel[0]) / (gs[1] - gs[0]);
        gamma = slope > 0 ? Math.max(1.3, gs[0] - rel[0] / slope) : 1.3;
        bound = 'below';
      }
    }
    const monotone = rel.every((r, k) => k === 0 || r >= rel[k - 1] - 0.01);
    const ditherCode = mean(row.pairs.map((p) => lumaCode(stats[p.dither].mean)));
    out.push({ key: row.key, name: row.name, p: row.p, rel, gamma, bound, resolved, sdRatio, monotone, ditherCode, reliable: !resolved && monotone && gamma != null });
  }

  const h = out.find((r) => r.key === 'h');
  const v = out.find((r) => r.key === 'v');
  const d = out.find((r) => r.key === 'd');
  const fifty = [h, v].filter((r) => r.reliable);
  let gamma50 = null;
  if (fifty.length === 2) {
    if (Math.abs(h.gamma - v.gamma) > 0.25) {
      notes.push('Horizontal and vertical line patterns disagree, which usually means the picture is being rescaled somewhere (Mac → AirPlay → Apple TV → projector). Using the higher reading. Setting the AirPlay display to the Apple TV\'s output resolution, or playing the generated video on the Apple TV, avoids this.');
      gamma50 = Math.max(h.gamma, v.gamma);
    } else gamma50 = (h.gamma + v.gamma) / 2;
  } else if (fifty.length === 1) gamma50 = fifty[0].gamma;
  if (out.some((r) => r.resolved)) notes.push('The camera can make out the individual fine lines in some patches, so those rows were skipped. Move the camera back a little, or zoom out.');
  const gamma25 = d && d.reliable ? d.gamma : null;

  let cameraExponent = null;
  const r50 = [h, v].filter((r) => r && !r.resolved);
  if (r50.length && d && !d.resolved && !r50.some((r) => cameraSaturated(stats[`${r.key}d0`]))) {
    const g = cameraExponentFromDithers(mean(r50.map((r) => r.ditherCode)), d.ditherCode, lumaCode(black.mean));
    if (g != null && g > 1.4 && g < 3.5) cameraExponent = g;
  }

  let confidence = gamma50 == null ? 'none' : fifty.length === 2 && Math.abs(h.gamma - v.gamma) <= 0.25 ? 'high' : 'medium';
  if (gamma50 != null && (gamma50 < 1.5 || gamma50 > 3.1)) {
    confidence = 'low';
    notes.push('This reading is outside the normal range for a projector. It usually means scaling or compression is blurring the fine lines; treat it with caution.');
  }
  return {
    test: 'gamma',
    gamma: gamma50,
    gamma25,
    bound: gamma50 != null ? (fifty[0] || {}).bound : null,
    rows: out,
    cameraExponent,
    confidence,
    pass: null,
    notes,
  };
}

// ------------------------------------------------------------ grayscale

export function analyzeGrayscale(pattern, stats, cam, { refStat = null } = {}) {
  const { patches, labels, lowIdx, highIdx } = pattern.meta;
  requireStats(stats, patches);
  const notes = [];
  const rgbs = patches.map((id) => (cameraSaturated(stats[id]) ? null : linRGB(stats[id].mean, cam)));
  if (rgbs[rgbs.length - 1] == null) notes.push('The camera is overexposed on the 100% patch; it was left out.');
  const ratio = (c) => (c ? [c[0] / c[1], c[2] / c[1]] : null);
  const ratios = rgbs.map(ratio);
  const usableHigh = highIdx.filter((i) => ratios[i]);
  if (!usableHigh.length) return { test: 'grayscale', pass: null, confidence: 'none', notes: ['Bright patches are overexposed in the camera.'] };
  const highRef = [mean(usableHigh.map((i) => ratios[i][0])), mean(usableHigh.map((i) => ratios[i][1]))];
  let ref = highRef;
  let refUsed = 'projector high end';
  if (refStat && !cameraSaturated(refStat)) {
    ref = ratio(linRGB(refStat.mean, cam));
    refUsed = 'reference device';
  } else if (refStat) notes.push('The reference device is overexposed in the camera; lower its screen brightness.');
  const dev = ratios.map((r) => (r ? { red: r[0] / ref[0] - 1, blue: r[1] / ref[1] - 1 } : null));
  const avgDev = (idx) => {
    const v = idx.map((i) => dev[i]).filter(Boolean);
    return { red: mean(v.map((x) => x.red)), blue: mean(v.map((x) => x.blue)) };
  };
  const low = avgDev(lowIdx);
  const high = avgDev(highIdx.filter((i) => dev[i]));
  // offsets/bias: make the low end match the high end
  const lowVsHigh = { red: (1 + low.red) / (1 + high.red) - 1, blue: (1 + low.blue) / (1 + high.blue) - 1 };
  const worst = Math.max(Math.abs(lowVsHigh.red), Math.abs(lowVsHigh.blue), refUsed === 'reference device' ? Math.max(Math.abs(high.red), Math.abs(high.blue)) : 0);
  return {
    test: 'grayscale',
    labels,
    dev,
    low,
    high,
    lowVsHigh,
    refUsed,
    pass: worst <= 0.03,
    confidence: refUsed === 'reference device' ? 'medium' : 'medium',
    notes,
  };
}

export function describeTint(dev) {
  // dev: {red, blue} relative channel excess vs green. Returns plain words.
  const r = dev.red;
  const b = dev.blue;
  if (Math.abs(r) < 0.015 && Math.abs(b) < 0.015) return 'neutral';
  const parts = [];
  if (r < -0.015 && b < -0.015) parts.push('greenish');
  else if (r > 0.015 && b > 0.015) parts.push('magenta/pink');
  else {
    if (r - b > 0.03) parts.push('warm (red/yellow)');
    else if (b - r > 0.03) parts.push('cool (blue)');
    else if (r > 0.015) parts.push('slightly red');
    else if (b > 0.015) parts.push('slightly blue');
    else parts.push('slightly green');
  }
  return parts.join(', ');
}

// ------------------------------------------------------------ overscan

function hueSat([r, g, b]) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const s = mx > 0 ? (mx - mn) / mx : 0;
  if (mx === mn) return { h: 0, s };
  let h;
  if (mx === r) h = 60 * (((g - b) / (mx - mn)) % 6);
  else if (mx === g) h = 60 * ((b - r) / (mx - mn) + 2);
  else h = 60 * ((r - g) / (mx - mn) + 4);
  if (h < 0) h += 360;
  return { h, s };
}

export function analyzeOverscan(pattern, stats, cam) {
  const { strips, center, rings } = pattern.meta;
  requireStats(stats, [...Object.values(strips), center]);
  const wb = linRGB(stats[center].mean, cam);
  const ringHue = rings.map((r) => (r.name === 'gray' ? null : hueSat(r.rgb.map((c) => srgbToLinear(c / 255))).h));
  const edges = {};
  for (const [edge, id] of Object.entries(strips)) {
    const c = linRGB(stats[id].mean, cam).map((x, i) => x / Math.max(1e-6, wb[i]));
    const { h, s } = hueSat(c);
    let idx;
    if (s < 0.3) idx = rings.length - 1; // gray: cropped past every ring
    else {
      let best = Infinity;
      ringHue.forEach((rh, i) => {
        if (rh == null) return;
        const d = Math.min(Math.abs(h - rh), 360 - Math.abs(h - rh));
        if (d < best) (best = d), (idx = i);
      });
    }
    const lo = rings[idx].inset;
    const hi = idx + 1 < rings.length ? rings[idx + 1].inset : null;
    edges[edge] = { ring: rings[idx].name, lo, hi, hue: h, sat: s };
  }
  const cropped = Object.values(edges).some((e) => e.lo > 0);
  const maxLo = Math.max(...Object.values(edges).map((e) => e.lo));
  return {
    test: 'overscan',
    pass: !cropped,
    confidence: 'high',
    edges,
    cropPercent: cropped ? maxLo * 100 : 0,
    notes: [],
  };
}

// ------------------------------------------------------------ HDR highlights

export function analyzeHdrHighlights(pattern, stats, cam) {
  const { patches, gapsRow1, gapsRow2, nits, maxcll } = pattern.meta;
  requireStats(stats, [...patches, ...gapsRow1, ...gapsRow2]);
  const notes = [];
  if (patches.some((id) => cameraSaturated(stats[id]))) {
    return { test: pattern.id, pass: null, confidence: 'none', notes: ['The camera is overexposed on the brightest patches. Make the screen fill more of the camera frame so auto-exposure darkens.'] };
  }
  const n = patches.length / 2;
  const gY = [...gapsRow1, ...gapsRow2].map((id) => linY(stats[id].mean, cam));
  const g1 = gY.slice(0, n + 1);
  const g2 = gY.slice(n + 1);
  const gm = mean(gY);
  const N = patches.map((id, i) => {
    const row = i < n ? g1 : g2;
    const k = i % n;
    return (linY(stats[id].mean, cam) / ((row[k] + row[k + 1]) / 2)) * gm;
  });
  const peak = Math.max(...N);
  const rel = N.map((x) => x / peak);
  // clip point: first level after which nothing gets meaningfully brighter
  let clipIdx = N.length - 1;
  for (let i = 0; i < N.length; i++) {
    if (N.slice(i + 1).every((x) => x <= N[i] * 1.03)) {
      clipIdx = i;
      break;
    }
  }
  const i203 = nits.indexOf(203);
  const i1000 = nits.indexOf(1000);
  const dwf = rel[i203];
  const headroomStops = Math.log2(1 / Math.max(1e-6, dwf));
  const clipNits = nits[clipIdx];
  let regime = 'balanced';
  if (clipIdx === N.length - 1 && maxcll <= 1000) {
    regime = 'no-tonemap';
    notes.push('Brightness keeps rising all the way to 10,000 nits even though the video says its brightest content is 1,000 nits. The projector may not be in HDR mode, or it ignores the HDR metadata. Check its info screen while this video plays.');
  } else if (dwf > 0.7) regime = 'flat';
  else if (clipNits < 600) regime = 'early-clip';
  else if (dwf < 0.25 && clipNits >= 1000) regime = 'dim';
  return {
    test: pattern.id,
    rel,
    nits,
    clipNits,
    dwf,
    headroomStops,
    rel1000: rel[i1000],
    regime,
    pass: regime === 'balanced',
    confidence: cam.kind === 'power' ? 'medium' : 'low',
    notes,
  };
}

// ------------------------------------------------------------ sanity check

/** Does the camera picture plausibly show this pattern? (used for external videos) */
export function patternCheck(pattern, stats, cam) {
  const els = pattern.elements.filter((e) => e.fill && e.measure !== false && stats[e.id]);
  if (els.length < 4 || pattern.id === 'black' || pattern.id === 'hdr_black') return { ok: true, rho: null };
  const expected = els.map((e) => {
    const f = e.fill;
    if (f.rgb) return luma709(...f.rgb.map((c) => srgbToLinear(c / 255)));
    if (f.pq10 != null) return Math.min(nitsFromPq10(f.pq10), 1000);
    if (f.type === 'dots25') return 0.25;
    return 0.5;
  });
  const measured = els.map((e) => linY(stats[e.id].mean, cam));
  const rho = spearman(expected, measured);
  return { ok: rho > 0.6, rho };
}

export const ANALYZERS = {
  black: analyzeBlack,
  hdr_black: analyzeBlack,
  white: analyzeWhite,
  colorclip: analyzeColorClip,
  gamma: analyzeGamma,
  grayscale: analyzeGrayscale,
  overscan: analyzeOverscan,
  hdr_hl1000: analyzeHdrHighlights,
  hdr_hl4000: analyzeHdrHighlights,
};

export { GAMMA_STEPS };
