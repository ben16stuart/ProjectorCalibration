// End-to-end checks against the synthetic projector + camera in sim.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getPattern, measuredElements } from '../web/js/patterns.js';
import { detectQuad, homographyFromQuad, buildSampler, applyH } from '../web/js/geometry.js';
import { PatchStats, lumaOf } from '../web/js/stats.js';
import { cameraModel } from '../web/js/color.js';
import { ANALYZERS } from '../web/js/analysis.js';
import { ADVISORS, defaultProfile } from '../web/js/advisor.js';
import { makeProjector, makeCamera, shootPattern, CW, CH, TRUE_CORNERS } from './sim.mjs';

const cam = makeCamera();
const srgbCam = cameraModel('srgb');

function avgLuma(frames) {
  const acc = new Float32Array(CW * CH);
  for (const f of frames) {
    const l = lumaOf(f, CW, CH);
    for (let i = 0; i < acc.length; i++) acc[i] += l[i] / frames.length;
  }
  return acc;
}

function locate(proj, camera = cam) {
  const b = avgLuma(shootPattern('black-full', proj, camera, 3));
  const w = avgLuma(shootPattern('white-full', proj, camera, 3));
  const diff = new Float32Array(b.length);
  for (let i = 0; i < diff.length; i++) diff[i] = w[i] - b[i];
  return detectQuad(diff, CW, CH, { edgeImage: w });
}

function cornerErrors(r) {
  return r.corners.map((c, i) => Math.hypot(c[0] - TRUE_CORNERS[i][0], c[1] - TRUE_CORNERS[i][1]));
}

const located = locate(makeProjector());
const H = homographyFromQuad(located.corners);

function measure(id, proj, n = 6) {
  const pat = getPattern(id);
  const ps = new PatchStats(buildSampler(H, measuredElements(pat), CW, CH));
  for (const f of shootPattern(id, proj, cam, n)) ps.addFrame(f);
  return ps.result();
}

function analyze(id, proj, camModel = srgbCam, opts) {
  return ANALYZERS[id](getPattern(id), measure(id, proj), camModel, opts);
}

/** Run the guided loop: measure, follow the suggestion, repeat. */
function runLoop(id, control, start, projOver = {}, maxIt = 16) {
  const profile = defaultProfile('sdr');
  profile.controls[control].value = start;
  const searches = {};
  const proj = makeProjector(projOver);
  const visited = [];
  for (let it = 0; it < maxIt; it++) {
    proj[control] = profile.controls[control].value;
    visited.push(proj[control]);
    const res = analyze(id, proj);
    const adv = ADVISORS[id](res, { profile, searches, room: 'dark' });
    if (adv.done) return { best: adv.best?.value ?? null, adv, visited };
    assert.ok(adv.suggestion, `no suggestion at iteration ${it}: ${adv.headline}`);
    profile.controls[control].value = adv.suggestion.to;
  }
  throw new Error(`no convergence; visited ${visited.join(',')}`);
}

test('finds the projected image to within ~1.5 camera pixels', () => {
  assert.ok(located.ok, located.reason);
  located.corners.forEach((c, i) => {
    const err = Math.hypot(c[0] - TRUE_CORNERS[i][0], c[1] - TRUE_CORNERS[i][1]);
    assert.ok(err < 1.5, `corner ${i} off by ${err.toFixed(2)} px`);
  });
  const [x, y] = applyH(H, 0.5, 0.5);
  assert.ok(x > 300 && x < 360 && y > 160 && y < 210);
});

test('finds the image edge, not the glow, when a phone camera overexposes the white flash', () => {
  // A phone keeps the long exposure it chose for the dark screen: the white flash clips
  // and a wide halo spreads past the picture. A plain threshold put the outline ~15 px
  // outside the picture here, so every patch was sampled in the wrong place.
  const r = locate(makeProjector(), makeCamera({ flare: 0.6, flareRadius: 16, exposureBias: 14 }));
  assert.ok(r.ok, r.reason);
  cornerErrors(r).forEach((err, i) => assert.ok(err < 1.5, `corner ${i} off by ${err.toFixed(2)} px`));
});

test('brightness: guided search lands on the lowest setting that keeps the 2% bar (expected 48)', () => {
  for (const start of [60, 35]) {
    const r = runLoop('black', 'brightness', start);
    assert.ok(r.best >= 47 && r.best <= 49, `start ${start}: best ${r.best}, visited ${r.visited.join(',')}`);
    assert.ok(r.visited.length <= 9, `too many steps: ${r.visited.join(',')}`);
  }
});

test('brightness: crushed blacks are reported as crushed', () => {
  const res = analyze('black', makeProjector({ brightness: 40 }));
  assert.equal(res.pass, false);
  assert.ok(res.firstVisible >= 3, `first visible ${res.firstVisibleLabel}`);
  const ok = analyze('black', makeProjector({ brightness: 50 }));
  assert.equal(ok.pass, true);
  assert.equal(ok.confidence, 'high');
});

test('brightness: an insensitive camera is flagged instead of giving a wrong answer', () => {
  const blind = makeCamera({ kmax: 0.5 });
  const pat = getPattern('black');
  const ps = new PatchStats(buildSampler(H, measuredElements(pat), CW, CH));
  for (const f of shootPattern('black', makeProjector(), blind, 4)) ps.addFrame(f);
  const res = ANALYZERS.black(pat, ps.result(), srgbCam);
  assert.equal(res.pass, null);
  assert.equal(res.confidence, 'none');
});

test('contrast: guided search stops just below white clipping', () => {
  const r = runLoop('white', 'contrast', 50);
  assert.ok(r.best >= 50 && r.best <= 55, `best ${r.best}, visited ${r.visited.join(',')}`);
  const clipped = analyze('white', makeProjector({ contrast: 62 }));
  assert.equal(clipped.pass, false);
});

test('contrast: one channel clipping early is caught as a tint', () => {
  const res = analyze('white', makeProjector({ contrast: 50, chanGain: [1, 1, 1.03] }));
  assert.equal(res.pass, false);
  assert.ok(res.failing.some((f) => f.channel === 'Blue'));
  assert.ok(!res.failing.some((f) => f.channel === 'Red'));
});

test('gamma: recovers the projector gamma from the dither/solid pairs', () => {
  for (const g of [2.0, 2.2, 2.4, 2.6]) {
    const res = analyze('gamma', makeProjector({ gamma: g }));
    assert.ok(Math.abs(res.gamma - g) < 0.08, `true ${g}, measured ${res.gamma}`);
    assert.equal(res.confidence, 'high');
    assert.ok(Math.abs(res.gamma25 - g) < 0.12, `25% point: true ${g}, measured ${res.gamma25}`);
  }
});

test('gamma: estimates the camera tone-curve exponent', () => {
  const res = analyze('gamma', makeProjector({ gamma: 2.3 }));
  assert.ok(res.cameraExponent > 1.9 && res.cameraExponent < 2.7, `camera exponent ${res.cameraExponent}`);
});

test('gamma: guided search walks a preset list to the target', () => {
  // gamma list index i -> true gamma 1.9 + 0.2 i (1.8 label is a lie on purpose)
  const profile = defaultProfile('sdr');
  profile.controls.gamma.value = '1.8';
  const searches = {};
  let done = null;
  for (let it = 0; it < 6 && !done; it++) {
    const idx = profile.controls.gamma.options.indexOf(profile.controls.gamma.value);
    const res = analyze('gamma', makeProjector({ gamma: 1.9 + 0.2 * idx }));
    const adv = ADVISORS.gamma(res, { profile, searches, room: 'dark' });
    if (adv.done) done = adv;
    else profile.controls.gamma.value = profile.controls.gamma.options[adv.suggestion.to];
  }
  assert.ok(done, 'did not finish');
  // index 2 -> 2.3, index 3 -> 2.5; target 2.4 -> either is acceptable
  assert.ok(['2.2', '2.4'].includes(profile.controls.gamma.value), profile.controls.gamma.value);
});

test('grayscale: a blue low end is detected and the blue offset is lowered', () => {
  const res = analyze('grayscale', makeProjector({ chanOffset: [0, 0, 0.006] }));
  assert.ok(res.lowVsHigh.blue > 0.03, `blue ${res.lowVsHigh.blue}`);
  assert.ok(Math.abs(res.lowVsHigh.red) < 0.012, `red ${res.lowVsHigh.red}`);
  const profile = defaultProfile('sdr');
  profile.controls.blueOffset.enabled = true;
  profile.controls.redOffset.enabled = true;
  const adv = ADVISORS.grayscale(res, { profile, searches: {} });
  assert.equal(adv.suggestion.control, 'blueOffset');
  assert.ok(adv.suggestion.to < 0);
  const clean = analyze('grayscale', makeProjector());
  assert.equal(clean.pass, true);
});

test('overscan: detects a cropped picture and how much is cut', () => {
  assert.equal(analyze('overscan', makeProjector()).pass, true);
  const res = analyze('overscan', makeProjector({ overscan: 0.02 }));
  assert.equal(res.pass, false);
  for (const e of Object.values(res.edges)) assert.equal(e.ring, 'blue');
});

test('color: over-saturation clips the colour bars', () => {
  assert.equal(analyze('colorclip', makeProjector()).pass, true);
  const res = analyze('colorclip', makeProjector({ color: 75 }));
  assert.equal(res.pass, false);
  assert.ok(res.clipped.includes('Red'));
});

test('HDR: finds the tone-mapping clip point and paper-white level', () => {
  const res = analyze('hdr_hl1000', makeProjector({ hdrClip: 1000, hdrExp: 0.8 }));
  assert.equal(res.clipNits, 1000);
  assert.ok(Math.abs(res.dwf - Math.pow(0.203, 0.8)) < 0.05, `dwf ${res.dwf}`);
  assert.equal(res.regime, 'balanced');
  const early = analyze('hdr_hl1000', makeProjector({ hdrClip: 400, hdrExp: 0.8 }));
  assert.equal(early.clipNits, 400);
  assert.equal(early.regime, 'early-clip');
  const none = analyze('hdr_hl1000', makeProjector({ hdrClip: 10000, hdrExp: 0.45 }));
  assert.equal(none.regime, 'no-tonemap');
});
