// Turns measurements into "set X to Y" suggestions. Pure and serializable:
// search states are plain objects so they can live in localStorage.

import { describeTint } from './analysis.js';

// ------------------------------------------------------------ control model

const num = (label, min, max, def, extra = {}) => ({ label, kind: 'number', min, max, def, value: def, enabled: true, ...extra });
const list = (label, options, value, extra = {}) => ({ label, kind: 'list', options, value, def: value, enabled: true, ...extra });

// Projector presets: control names as they appear in that projector's menu.
// Ranges are starting guesses; the Setup page lets you correct them.
export const PRESETS = {
  generic: {
    name: 'Generic projector',
    pictureModes: ['Cinema', 'Movie', 'Standard', 'User', 'Bright'],
    build: (mode) => {
      const c = {
        brightness: num('Brightness', 0, 100, 50),
        contrast: num('Contrast', 0, 100, 50),
        color: num('Color (saturation)', 0, 100, 50),
        tint: num('Tint (hue)', -50, 50, 0),
        sharpness: num('Sharpness', 0, 100, 50),
        gamma: list('Gamma', ['1.8', '2.0', '2.2', '2.4', '2.6'], '2.2', { darkerLater: true }),
        colorTemp: list('Color temperature', ['Warm', 'Normal', 'Cool'], 'Normal'),
        redGain: num('Red gain', -50, 50, 0, { enabled: false }),
        greenGain: num('Green gain', -50, 50, 0, { enabled: false }),
        blueGain: num('Blue gain', -50, 50, 0, { enabled: false }),
        redOffset: num('Red offset / bias', -50, 50, 0, { enabled: false }),
        greenOffset: num('Green offset / bias', -50, 50, 0, { enabled: false }),
        blueOffset: num('Blue offset / bias', -50, 50, 0, { enabled: false }),
        lightOutput: list('Laser / lamp power', ['Eco', 'Normal', 'High', 'Max'], 'Normal'),
      };
      if (mode === 'hdr') c.hdrToneMap = num('HDR tone mapping / HDR brightness', -5, 5, 0, { higherIsBrighter: true });
      return c;
    },
    tips: [],
  },
  acer_h7850: {
    name: 'Acer H7850 (4K DLP, lamp)',
    pictureModes: ['User', 'Standard', 'Movie', 'Bright', 'Game', 'Sports', 'ISF Day', 'ISF Night'],
    build: (mode) => {
      const c = {
        brightness: num('Brightness', 0, 100, 50),
        contrast: num('Contrast', 0, 100, 50),
        color: num('Saturation', 0, 100, 50),
        tint: num('Tint', 0, 100, 50),
        sharpness: num('Sharpness', 0, 100, 50),
        superResolution: list('Super Resolution', ['Off', '1', '2', '3', '4', '5'], 'Off', { advisory: true }),
        gamma: list('Gamma', ['1.8', '2.0', '2.2', '2.4', '2.6'], '2.2', { darkerLater: true }),
        colorTemp: list('Color Temperature', ['Warm', 'Normal', 'Cool'], 'Warm'),
        redGain: num('Red Gain', 0, 100, 50),
        greenGain: num('Green Gain', 0, 100, 50),
        blueGain: num('Blue Gain', 0, 100, 50),
        redOffset: num('Red Bias', 0, 100, 50),
        greenOffset: num('Green Bias', 0, 100, 50),
        blueOffset: num('Blue Bias', 0, 100, 50),
        wallColor: list('Wall Color', ['White', 'Light Yellow', 'Light Blue', 'Pink', 'Dark Green'], 'White', { advisory: true }),
        acuEngine: list('AcuEngine', ['Off', 'On'], 'Off', { advisory: true }),
        dynamicBlack: list('Dynamic Black', ['Off', 'On'], 'Off', { advisory: true }),
        lightOutput: list('Lamp mode (Brightness Mode / ECO)', ['ECO', 'Normal'], 'Normal'),
        hdr: list('HDR', ['Off', 'Auto'], 'Auto', { advisory: true }),
      };
      // HDR level 1-4: the projector picks 4 by itself when HDR arrives (seen on a
      // real H7850). Which end leaves more room for highlights isn't documented; the
      // guided search starts by assuming higher = brighter and learns the real
      // direction from the second measurement.
      if (mode === 'hdr') c.hdrToneMap = list('HDR level', ['1', '2', '3', '4'], '4', { higherIsBrighter: true });
      return c;
    },
    tips: [
      { key: 'wallColor', want: 'White', why: 'Wall Color tints the whole picture to compensate for a coloured wall. On a white or gray screen it should be White (no correction).' },
      { key: 'superResolution', want: 'Off', why: 'Super Resolution is edge sharpening. With 4K sources it adds halos and grain rather than detail. Turn it off, or try 1 if the picture looks soft from your seat.' },
      { key: 'acuEngine', want: 'Off', why: 'AcuEngine is Acer\'s picture-enhancement processing. Calibrate with it off so the measurements describe the projector itself; afterwards compare it on and off by eye with real content.' },
      { key: 'dynamicBlack', want: 'On', why: 'Dynamic Black dims the lamp in dark scenes, which makes blacks visibly deeper. That matters most for HDR and dark films. Calibrate with it Off (it changes brightness between test patterns), then turn it On for watching if you don\'t notice brightness pumping.' },
      { key: 'hdr', want: 'Auto', why: 'With HDR on Auto the projector switches to HDR processing only when it receives an HDR10 signal. "Off" shows HDR content with SDR processing, which looks washed out.' },
      { key: 'lightOutput', want: 'Normal', why: 'ECO lamp mode costs a large share of brightness. For HDR, use Normal.' },
      { key: 'pictureMode', want: 'User / Movie', why: 'Start from User or Movie. "Bright" modes on lamp DLP projectors boost white segment brightness and usually look greenish. ISF Day/Night are reserved for a professional ISF calibration and are often locked.' },
    ],
  },
};

export function defaultProfile(mode, presetId = 'generic') {
  const preset = PRESETS[presetId] || PRESETS.generic;
  return { mode, presetId, pictureMode: mode === 'hdr' ? 'HDR' : preset.pictureModes[0], controls: preset.build(mode) };
}

export function formatValue(ctrl, v) {
  if (ctrl.kind === 'list') return ctrl.options[v] ?? String(v);
  return String(v);
}

// For list controls searches work on the option index.
export function controlPosition(ctrl) {
  if (ctrl.kind === 'list') return Math.max(0, ctrl.options.indexOf(String(ctrl.value)));
  return Number(ctrl.value);
}

export function controlRange(ctrl) {
  if (ctrl.kind === 'list') return { min: 0, max: ctrl.options.length - 1 };
  return { min: Number(ctrl.min), max: Number(ctrl.max) };
}

// ------------------------------------------------------------ threshold search
// Finds the lowest ('min-pass') or highest ('max-pass') setting at which a
// yes/no test still passes. Steps outward until the answer flips, then bisects.

export function newThresholdSearch({ goal, min, max, step, resolution = 1 }) {
  const base = step ?? Math.max(resolution, Math.round((max - min) / 20));
  return { kind: 'threshold', goal, min, max, step: base, resolution, history: [] };
}

export function thresholdRecord(s, value, pass) {
  s.history.push({ value: Number(value), pass: !!pass, at: Date.now() });
  return s;
}

export function thresholdNext(s) {
  const sgn = s.goal === 'min-pass' ? 1 : -1;
  const toT = (v) => sgn * v;
  const toV = (t) => sgn * t;
  const tLo = Math.min(toT(s.min), toT(s.max));
  const tHi = Math.max(toT(s.min), toT(s.max));
  if (!s.history.length) return { done: false, value: null };

  // Latest observation per value, then drop older observations that the most
  // recent one contradicts (noise or a changed setup).
  const latest = new Map();
  for (const h of s.history) latest.set(h.value, h.pass);
  let pts = [...latest].map(([v, p]) => ({ t: toT(v), v, p }));
  const last = s.history[s.history.length - 1];
  const lt = toT(last.value);
  pts = pts.filter((q) => q.v === last.value || (last.pass ? !(q.p === false && q.t >= lt) : !(q.p === true && q.t <= lt)));

  const passes = pts.filter((q) => q.p);
  const fails = pts.filter((q) => !q.p);
  // widen the step while the answer keeps coming back the same at new settings
  // (measuring again at the same setting is not a reason to jump further)
  const sameRun = new Set();
  for (let i = s.history.length - 1; i >= 0 && s.history[i].pass === last.pass; i--) sameRun.add(s.history[i].value);
  const trailing = sameRun.size;
  const step = Math.min(s.step * 2 ** Math.min(4, trailing - 1), Math.max(s.resolution, Math.round((tHi - tLo) / 4)));
  const snap = (t) => Math.round(t / s.resolution) * s.resolution;

  if (!passes.length) {
    const hiFail = Math.max(...fails.map((q) => q.t));
    if (hiFail >= tHi) return { done: true, reason: 'limit-fail', value: toV(tHi) };
    return { done: false, value: toV(Math.min(tHi, snap(hiFail + step))), direction: sgn > 0 ? 'up' : 'down' };
  }
  const loPass = Math.min(...passes.map((q) => q.t));
  const below = fails.filter((q) => q.t < loPass);
  if (!below.length) {
    if (loPass <= tLo) return { done: true, reason: 'limit-pass', value: toV(tLo) };
    return { done: false, value: toV(Math.max(tLo, snap(loPass - step))), direction: sgn > 0 ? 'down' : 'up' };
  }
  const hiFail = Math.max(...below.map((q) => q.t));
  if (loPass - hiFail <= s.resolution) return { done: true, reason: 'bracketed', value: toV(loPass), bracket: [toV(hiFail), toV(loPass)] };
  let mid = snap((loPass + hiFail) / 2);
  if (mid <= hiFail) mid = hiFail + s.resolution;
  if (mid >= loPass) mid = loPass - s.resolution;
  return { done: false, value: toV(mid), direction: 'bisect', bracket: [toV(hiFail), toV(loPass)] };
}

// ------------------------------------------------------------ proportional search
// For continuous targets (gamma, RGB balance): learn how much the metric moves
// per click of the control and step toward the target.

export function newPropSearch({ target, tol, min, max, gainGuess, maxStep, resolution = 1 }) {
  return { kind: 'prop', target, tol, min, max, gainGuess, maxStep, resolution, history: [] };
}

export function propRecord(s, value, metric) {
  s.history.push({ value: Number(value), metric, at: Date.now() });
  return s;
}

export function propNext(s) {
  const last = s.history[s.history.length - 1];
  if (!last) return { done: false, value: null };
  const err = last.metric - s.target;
  if (Math.abs(err) <= s.tol) return { done: true, reason: 'on-target', value: last.value, err };
  const recent = s.history.slice(-4);
  const distinct = new Set(recent.map((h) => h.value));
  let slope = s.gainGuess;
  if (distinct.size >= 2) {
    const xs = recent.map((h) => h.value);
    const ys = recent.map((h) => h.metric);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxx = 0;
    let sxy = 0;
    xs.forEach((x, i) => {
      sxx += (x - mx) ** 2;
      sxy += (x - mx) * (ys[i] - my);
    });
    const m = sxx > 0 ? sxy / sxx : 0;
    const spread = Math.max(...ys) - Math.min(...ys);
    if (Math.abs(m) > 1e-9 && spread > s.tol * 0.5) slope = m;
  }
  let delta = -err / slope;
  delta = Math.max(-s.maxStep, Math.min(s.maxStep, delta));
  delta = Math.round(delta / s.resolution) * s.resolution;
  if (delta === 0) return { done: true, reason: 'resolution', value: last.value, err };
  const next = Math.max(s.min, Math.min(s.max, last.value + delta));
  if (next === last.value) return { done: true, reason: 'limit', value: last.value, err };
  return { done: false, value: next, err, slope };
}

// ------------------------------------------------------------ per-test advice
// Each returns { headline, detail[], suggestion|null, done, best|null, status }
// status: 'good' | 'adjust' | 'warn' | 'info'

const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

function searchFor(searches, key, factory) {
  if (!searches[key]) searches[key] = factory();
  return searches[key];
}

function suggestion(ctrlKey, ctrl, fromPos, toPos) {
  return {
    control: ctrlKey,
    label: ctrl.label,
    from: fromPos,
    to: toPos,
    fromText: formatValue(ctrl, fromPos),
    toText: formatValue(ctrl, toPos),
  };
}

function inconclusive(result, extra = []) {
  return {
    status: 'warn',
    headline: 'The camera could not judge this one reliably',
    detail: [...(result.notes || []), ...extra],
    suggestion: null,
    done: false,
    best: null,
  };
}

export function adviseBlack(result, { profile, searches, manualPass = null }) {
  const ctrl = profile.controls.brightness;
  const pass = manualPass ?? result.pass;
  if (pass == null) return inconclusive(result, ['Answer by eye with the Yes (Y) / No (N) buttons; the search continues from your answers.']);
  const key = `${profile.mode}:${result.test}:brightness`;
  const { min, max } = controlRange(ctrl);
  const s = searchFor(searches, key, () => newThresholdSearch({ goal: 'min-pass', min, max }));
  const cur = controlPosition(ctrl);
  thresholdRecord(s, cur, pass);
  const nx = thresholdNext(s);
  const tgt = result.targetLabel;
  const seen = pass ? `The ${tgt} bar is visible.` : `The ${tgt} bar is hidden, so shadow detail is being crushed.`;
  const detail = [seen];
  if (result.firstVisibleLabel) detail.push(`Darkest bar the camera can see: ${result.firstVisibleLabel}.`);
  detail.push(...(result.notes || []));
  if (nx.done) {
    if (nx.reason === 'limit-fail') {
      return {
        status: 'warn',
        headline: `Even at Brightness ${formatValue(ctrl, nx.value)} the ${tgt} bar stays hidden`,
        detail: [...detail, 'This usually means a black-level mismatch on the HDMI link: the Apple TV sends full-range RGB ("RGB High") while the projector expects limited range, or the reverse. On the Apple TV, try Settings › Video and Audio › HDMI Output › YCbCr, and set the projector HDMI range / "HDMI black level" to Auto.'],
        suggestion: null,
        done: true,
        best: null,
      };
    }
    const best = nx.value;
    return {
      status: 'good',
      headline: `Best Brightness: ${formatValue(ctrl, best)}`,
      detail: [
        nx.reason === 'limit-pass'
          ? `Even the lowest setting keeps the ${tgt} bar visible, so use the minimum. If black still looks gray, the HDMI range may be mismatched (projector expecting full range).`
          : `That is the lowest setting where the ${tgt} bar is still visible: the deepest black without losing shadow detail.`,
        ...(result.notes || []),
      ],
      suggestion: best !== cur ? suggestion('brightness', ctrl, cur, best) : null,
      done: true,
      best: { control: 'brightness', value: best },
    };
  }
  return {
    status: 'adjust',
    headline: `Set Brightness to ${formatValue(ctrl, nx.value)} (now ${formatValue(ctrl, cur)}), then measure again`,
    detail: [...detail, pass ? 'Trying a lower setting to find the darkest black that still keeps that bar.' : 'Raising Brightness to bring the shadows back.'],
    suggestion: suggestion('brightness', ctrl, cur, nx.value),
    done: false,
    best: null,
  };
}

export function adviseWhite(result, { profile, searches, manualPass = null }) {
  const ctrl = profile.controls.contrast;
  const pass = manualPass ?? result.pass;
  if (pass == null) return inconclusive(result);
  const key = `${profile.mode}:white:contrast`;
  const { min, max } = controlRange(ctrl);
  const s = searchFor(searches, key, () => newThresholdSearch({ goal: 'max-pass', min, max }));
  const cur = controlPosition(ctrl);
  thresholdRecord(s, cur, pass);
  const nx = thresholdNext(s);
  const detail = [];
  if (pass) detail.push('All bars up to 99% stay distinct: no white clipping.');
  else detail.push(`Highlights are clipping: bars merge from ${result.firstClip}${result.failing?.length ? ` (${[...new Set(result.failing.map((f) => f.channel))].join(', ')})` : ''}.`);
  detail.push(...(result.notes || []));
  if (!pass && cur <= Number(ctrl.def) && result.firstClip && result.firstClip.startsWith('94')) {
    detail.push('Clipping this early at a normal Contrast setting points to an HDMI range mismatch (see the Brightness step).');
  }
  if (nx.done) {
    if (nx.reason === 'limit-fail') {
      return { status: 'warn', headline: 'Whites clip even at the lowest Contrast', detail: [...detail, 'Check the HDMI range settings on the Apple TV and the projector.'], suggestion: null, done: true, best: null };
    }
    const best = nx.value;
    return {
      status: 'good',
      headline: `Best Contrast: ${formatValue(ctrl, best)}`,
      detail: [
        nx.reason === 'limit-pass' ? 'No clipping even at maximum Contrast, so you can use the maximum (or stay a step or two below if whites look harsh).' : 'That is the highest setting before highlights clip or pick up a tint: maximum punch without losing detail in clouds, snow and skin highlights.',
        'Contrast can affect the black level slightly, so run the Brightness step once more afterwards.',
      ],
      suggestion: best !== cur ? suggestion('contrast', ctrl, cur, best) : null,
      done: true,
      best: { control: 'contrast', value: best },
    };
  }
  return {
    status: 'adjust',
    headline: `Set Contrast to ${formatValue(ctrl, nx.value)} (now ${formatValue(ctrl, cur)}), then measure again`,
    detail: [...detail, pass ? 'Trying higher to find the brightest white that does not clip.' : 'Lowering Contrast to recover highlight detail.'],
    suggestion: suggestion('contrast', ctrl, cur, nx.value),
    done: false,
    best: null,
  };
}

export function adviseColorClip(result, { profile, searches, manualPass = null }) {
  const ctrl = profile.controls.color;
  const pass = manualPass ?? result.pass;
  if (pass == null) return inconclusive(result);
  const key = `${profile.mode}:colorclip:color`;
  const { min, max } = controlRange(ctrl);
  const s = searchFor(searches, key, () => newThresholdSearch({ goal: 'max-pass', min, max: Math.min(max, Number(ctrl.def) + Math.round((max - min) / 5)) }));
  const cur = controlPosition(ctrl);
  thresholdRecord(s, cur, pass);
  const nx = thresholdNext(s);
  const detail = [pass ? 'Red, green and blue bars stay distinct up to 100%.' : `Colour clipping in ${result.clipped.join(', ')}: saturated colours lose detail.`, ...(result.notes || [])];
  const def = Number(ctrl.def);
  if (pass && cur === def) {
    return { status: 'good', headline: `Color ${cur} (default) is fine`, detail: [...detail, 'With a digital source like the Apple TV, the default Color and Tint are normally correct. Leave them unless something looks obviously off.'], suggestion: null, done: true, best: { control: 'color', value: cur } };
  }
  if (nx.done) {
    let best = nx.value;
    const extra = [];
    if (best > def) {
      extra.push(`Settings up to ${best} don't clip, but going above the default (${def}) only exaggerates colours, so use the default.`);
      best = def;
    }
    return { status: 'good', headline: `Best Color: ${best}`, detail: [...detail, ...extra], suggestion: best !== cur ? suggestion('color', ctrl, cur, best) : null, done: true, best: { control: 'color', value: best } };
  }
  return {
    status: 'adjust',
    headline: `Set Color to ${nx.value} (now ${cur}), then measure again`,
    detail,
    suggestion: suggestion('color', ctrl, cur, nx.value),
    done: false,
    best: null,
  };
}

export function targetGamma(room) {
  return room === 'dark' ? 2.4 : room === 'dim' ? 2.3 : 2.2;
}

export function adviseGamma(result, { profile, searches, room }) {
  const ctrl = profile.controls.gamma;
  const target = targetGamma(room);
  if (result.gamma == null) return inconclusive(result);
  const g = result.gamma;
  const shape = result.gamma25 != null ? ` (darker mid-tones measure ${result.gamma25.toFixed(2)})` : '';
  const detail = [`Measured gamma ≈ ${g.toFixed(2)}${result.bound ? (result.bound === 'above' ? ' or higher' : ' or lower') : ''}${shape}. Target for a ${room} room: ${target}.`];
  if (g < target - 0.1) detail.push('Mid-tones are too bright, so the picture looks flat and washed out.');
  else if (g > target + 0.1) detail.push('Mid-tones are too dark, so the picture looks heavy and shadows hide detail.');
  detail.push(...(result.notes || []));
  if (!ctrl || !ctrl.enabled) {
    return { status: Math.abs(g - target) <= 0.1 ? 'good' : 'info', headline: `Gamma ≈ ${g.toFixed(2)}`, detail: [...detail, 'Your projector has no gamma control listed; a different picture mode may have a different gamma.'], suggestion: null, done: true, best: null };
  }
  const { min, max } = controlRange(ctrl);
  const perStep = ctrl.kind === 'list' ? 0.15 : 0.1;
  const dir = ctrl.kind === 'list' ? (ctrl.darkerLater === false ? -1 : 1) : ctrl.higherIsDarker === false ? -1 : 1;
  const key = `${profile.mode}:gamma:gamma`;
  const s = searchFor(searches, key, () => newPropSearch({ target, tol: 0.08, min, max, gainGuess: dir * perStep, maxStep: ctrl.kind === 'list' ? 2 : 3 }));
  const cur = controlPosition(ctrl);
  propRecord(s, cur, g);
  const nx = propNext(s);
  if (nx.done) {
    return {
      status: Math.abs(g - target) <= 0.12 ? 'good' : 'info',
      headline: nx.reason === 'on-target' ? `Gamma is on target (${g.toFixed(2)})` : `Closest available gamma setting: ${formatValue(ctrl, nx.value)}`,
      detail,
      suggestion: nx.value !== cur ? suggestion('gamma', ctrl, cur, nx.value) : null,
      done: true,
      best: { control: 'gamma', value: nx.value },
    };
  }
  return {
    status: 'adjust',
    headline: `Set Gamma to ${formatValue(ctrl, nx.value)} (now ${formatValue(ctrl, cur)}), then measure again`,
    detail,
    suggestion: suggestion('gamma', ctrl, cur, nx.value),
    done: false,
    best: null,
  };
}

export function adviseGrayscale(result, { profile, searches }) {
  if (result.pass == null) return inconclusive(result);
  const c = profile.controls;
  const detail = [];
  const lowTint = describeTint(result.lowVsHigh);
  detail.push(`Dark grays (30–40%) compared with bright grays: red ${pct(result.lowVsHigh.red)}, blue ${pct(result.lowVsHigh.blue)} (${lowTint}).`);
  if (result.refUsed === 'reference device') {
    detail.push(`Bright grays compared with the reference screen: red ${pct(result.high.red)}, blue ${pct(result.high.blue)} (${describeTint(result.high)}).`);
  } else {
    detail.push('Without a reference screen in view, the camera\'s auto white balance hides the overall colour temperature. This test can only make the dark and bright grays match each other.');
  }
  detail.push(...(result.notes || []));

  // Which control would help most? Gains need the reference; offsets fix the low end.
  const candidates = [];
  if (result.refUsed === 'reference device') {
    candidates.push({ key: 'redGain', metric: result.high.red, guess: 0.008 });
    candidates.push({ key: 'blueGain', metric: result.high.blue, guess: 0.008 });
  }
  candidates.push({ key: 'redOffset', metric: result.lowVsHigh.red, guess: 0.012 });
  candidates.push({ key: 'blueOffset', metric: result.lowVsHigh.blue, guess: 0.012 });
  const usable = candidates.filter((k) => c[k.key] && c[k.key].enabled);
  const tol = 0.02;

  if (result.pass) {
    return { status: 'good', headline: 'Grayscale is even', detail, suggestion: null, done: true, best: null };
  }
  if (!usable.length) {
    let tip = 'Your projector has no RGB gain/offset controls listed. Try each Color Temperature preset and keep the one where this pattern looks most even and neutral.';
    if (result.refUsed === 'reference device') {
      const warm = result.high.red - result.high.blue;
      if (warm > 0.04) tip = 'The projector\'s white is warmer (redder) than the reference. Try a cooler Color Temperature preset.';
      else if (warm < -0.04) tip = 'The projector\'s white is cooler (bluer) than the reference. Try a warmer Color Temperature preset, often called "Warm", "Low" or "6500K".';
    }
    return { status: 'info', headline: `Grayscale tint: ${lowTint} in the dark grays`, detail: [...detail, tip], suggestion: null, done: false, best: null };
  }
  // record every candidate (so slopes are learned), then pick the worst offender
  for (const k of usable) {
    const ctrl = c[k.key];
    const { min, max } = controlRange(ctrl);
    const s = searchFor(searches, `${profile.mode}:grayscale:${k.key}`, () => newPropSearch({ target: 0, tol, min, max, gainGuess: k.guess, maxStep: Math.max(2, Math.round((max - min) / 20)) }));
    propRecord(s, controlPosition(ctrl), k.metric);
  }
  const worst = usable.filter((k) => Math.abs(k.metric) > tol).sort((a, b) => Math.abs(b.metric) - Math.abs(a.metric))[0];
  if (!worst) return { status: 'good', headline: 'Grayscale is within tolerance', detail, suggestion: null, done: true, best: null };
  const ctrl = c[worst.key];
  const s = searches[`${profile.mode}:grayscale:${worst.key}`];
  const nx = propNext(s);
  const cur = controlPosition(ctrl);
  if (nx.done) {
    return { status: 'info', headline: `${ctrl.label} is as close as its steps allow`, detail, suggestion: null, done: true, best: null };
  }
  return {
    status: 'adjust',
    headline: `Set ${ctrl.label} to ${nx.value} (now ${cur}), then measure again`,
    detail: [...detail, 'Change one control at a time; the app learns how strongly each one acts.'],
    suggestion: suggestion(worst.key, ctrl, cur, nx.value),
    done: false,
    best: null,
  };
}

export function adviseOverscan(result) {
  if (result.pass) {
    return { status: 'good', headline: 'No overscan: the whole picture is visible', detail: ['The thin red outer border is visible on all four edges.'], suggestion: null, done: true, best: null };
  }
  const e = result.edges;
  const lines = Object.entries(e).map(([k, v]) => `${k}: ${v.lo === 0 ? 'complete' : `about ${(v.lo * 100).toFixed(1)}–${v.hi != null ? (v.hi * 100).toFixed(1) : '6+'}% cut off`} (outermost visible frame: ${v.ring})`);
  return {
    status: 'adjust',
    headline: `The picture is cropped (overscan ≈ ${result.cropPercent.toFixed(1)}% per edge)`,
    detail: [
      ...lines,
      'Overscan cuts off the edges and rescales the image, which softens 4K detail. On the projector, look for Overscan → Off, Aspect → Native / "Just Scan" / Full, or Over-Scan → 0%.',
      'Also check the Apple TV: Settings › Video and Audio › Calibrate › Zoom and Overscan.',
      'If keystone or digital zoom is on, it causes a similar loss; use lens shift and optical zoom instead where you can.',
    ],
    suggestion: null,
    done: false,
    best: null,
  };
}

export function adviseHdrHighlights(result, { profile, searches }) {
  if (result.pass == null && result.confidence === 'none') return inconclusive(result);
  const ctrl = profile.controls.hdrToneMap;
  const detail = [
    `Highlights stop getting brighter at about ${result.clipNits >= 1000 ? `${result.clipNits / 1000}k` : result.clipNits} nits (content level).`,
    `Ordinary "paper white" (203 nits) is shown at ${(result.dwf * 100).toFixed(0)}% of the projector's peak, leaving ${result.headroomStops.toFixed(1)} stops of headroom for highlights.`,
  ];
  if (result.confidence === 'low') detail.push('The camera\'s response is uncalibrated. Run the Gamma test first so the app can calibrate the camera; the ratios above then become more trustworthy.');
  let dirWord = null;
  let headline;
  switch (result.regime) {
    case 'no-tonemap':
      headline = 'The projector may not be treating this as HDR';
      break;
    case 'flat':
      headline = 'HDR is being squashed to look like SDR';
      detail.push('First check the projector\'s info screen says HDR while the video plays. If it says SDR, something upstream converted the video and squashed it: a media server transcoding it (Plex: check its dashboard shows Direct Play, not Transcode) or the Apple TV not switching to HDR (turn on Match Dynamic Range).');
      detail.push('If the projector does show HDR: highlights get barely any extra brightness above ordinary white, which is the classic cause of "HDR looks barely better than SDR". A darker tone-mapping setting gives highlights room to stand out.');
      dirWord = 'darker';
      break;
    case 'early-clip':
      headline = 'Highlights clip early';
      detail.push('Bright detail such as clouds, sun reflections and specular highlights is lost above this level. A darker tone-mapping setting keeps it.');
      dirWord = 'darker';
      break;
    case 'dim':
      headline = 'Ordinary scenes are being shown very dim';
      detail.push('The projector reserves lots of room for highlights but makes everyday content dark and flat. A brighter tone-mapping setting usually looks better on a projector.');
      dirWord = 'brighter';
      break;
    default:
      headline = 'HDR tone mapping looks balanced';
  }
  detail.push(...(result.notes || []));
  if (!dirWord || !ctrl || !ctrl.enabled) {
    if (dirWord) detail.push(`Look for a setting called HDR Brightness, HDR Tone Mapping, "HDR10 Setting", Dynamic Range or similar, and move it one step ${dirWord}.`);
    return { status: result.regime === 'balanced' ? 'good' : 'warn', headline, detail, suggestion: null, done: result.regime === 'balanced', best: null };
  }
  const { min, max } = controlRange(ctrl);
  const sign = ctrl.higherIsBrighter === false ? -1 : 1;
  const s = searchFor(searches, `hdr:${result.test}:hdrToneMap`, () => newPropSearch({ target: 0.42, tol: 0.1, min, max, gainGuess: sign * 0.06, maxStep: 2 }));
  const cur = controlPosition(ctrl);
  propRecord(s, cur, result.dwf);
  let nx = propNext(s);
  if (result.regime === 'early-clip' && (nx.done || (nx.value - cur) * sign > 0)) {
    const v = Math.max(min, Math.min(max, cur - sign));
    nx = v === cur ? { done: true, value: cur } : { done: false, value: v };
  }
  if (nx.done) return { status: 'info', headline, detail: [...detail, `${ctrl.label} is already at its limit.`], suggestion: null, done: true, best: null };
  return {
    status: 'adjust',
    headline: `${headline}: set ${ctrl.label} to ${formatValue(ctrl, nx.value)} (now ${formatValue(ctrl, cur)})`,
    detail,
    suggestion: suggestion('hdrToneMap', ctrl, cur, nx.value),
    done: false,
    best: null,
  };
}

export const ADVISORS = {
  black: adviseBlack,
  hdr_black: adviseBlack,
  white: adviseWhite,
  colorclip: adviseColorClip,
  gamma: adviseGamma,
  grayscale: adviseGrayscale,
  overscan: adviseOverscan,
  hdr_hl1000: adviseHdrHighlights,
  hdr_hl4000: adviseHdrHighlights,
};

/** Non-measured settings: compare the profile against the preset's advice. */
export function processingTips(profile) {
  const preset = PRESETS[profile.presetId] || PRESETS.generic;
  const out = [];
  for (const t of preset.tips) {
    if (t.key === 'pictureMode') {
      out.push({ label: 'Display mode', current: profile.pictureMode, want: t.want, ok: /user|movie|cinema/i.test(profile.pictureMode || ''), why: t.why });
      continue;
    }
    const c = profile.controls[t.key];
    if (!c) continue;
    if (profile.mode === 'sdr' && t.key === 'hdr') continue;
    out.push({ label: c.label, current: c.value, want: t.want, ok: String(c.value) === t.want, why: t.why });
  }
  return out;
}
