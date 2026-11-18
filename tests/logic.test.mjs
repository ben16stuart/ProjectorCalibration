import test from 'node:test';
import assert from 'node:assert/strict';
import { newThresholdSearch, thresholdRecord, thresholdNext, newPropSearch, propRecord, propNext } from '../web/js/advisor.js';
import { diagnoseHdr, estimateNits } from '../web/js/hdr.js';
import { pq10, nitsFromPq10, pqEncode, pqDecode } from '../web/js/color.js';
import { solveHomography, applyH, invert3 } from '../web/js/geometry.js';

function drive(goal, truth, start, min = 0, max = 100) {
  const s = newThresholdSearch({ goal, min, max });
  let v = start;
  for (let i = 0; i < 20; i++) {
    thresholdRecord(s, v, truth(v));
    const nx = thresholdNext(s);
    if (nx.done) return { ...nx, steps: i + 1 };
    v = nx.value;
  }
  throw new Error('no convergence');
}

test('threshold search: min-pass converges from either side', () => {
  for (const start of [50, 10, 95]) {
    const r = drive('min-pass', (v) => v >= 37, start);
    assert.equal(r.value, 37);
    assert.equal(r.reason, 'bracketed');
    assert.ok(r.steps <= (start === 95 ? 11 : 9), `${r.steps} steps from ${start}`);
  }
});

test('threshold search: max-pass converges', () => {
  const r = drive('max-pass', (v) => v <= 63, 50);
  assert.equal(r.value, 63);
});

test('threshold search: reports limits', () => {
  assert.equal(drive('min-pass', () => true, 50).reason, 'limit-pass');
  assert.equal(drive('min-pass', () => false, 50).reason, 'limit-fail');
});

test('threshold search: a contradicting newer reading wins', () => {
  const s = newThresholdSearch({ goal: 'min-pass', min: 0, max: 100 });
  thresholdRecord(s, 50, true);
  thresholdRecord(s, 45, false);
  thresholdRecord(s, 48, true);
  thresholdRecord(s, 52, false); // newer: 52 fails, so the old 50 pass is suspect
  const nx = thresholdNext(s);
  assert.equal(nx.done, false);
  assert.ok(nx.value > 52);
});

test('proportional search: steps a preset list to the target', () => {
  const s = newPropSearch({ target: 2.4, tol: 0.08, min: 0, max: 4, gainGuess: 0.15, maxStep: 2 });
  let idx = 1;
  for (let i = 0; i < 6; i++) {
    propRecord(s, idx, 2.0 + 0.15 * idx);
    const nx = propNext(s);
    if (nx.done) break;
    idx = nx.value;
  }
  assert.equal(idx, 3);
});

test('PQ round trip and code values', () => {
  for (const n of [0.005, 0.1, 100, 203, 1000, 4000]) assert.ok(Math.abs(pqDecode(pqEncode(n)) - n) / n < 1e-6);
  assert.equal(pq10(0), 64);
  assert.equal(pq10(10000), 940);
  assert.ok(Math.abs(nitsFromPq10(80) - 0.0073) < 0.001);
});

test('homography maps the unit square onto a quad and back', () => {
  const quad = [[10, 20], [300, 15], [320, 200], [5, 190]];
  const H = solveHomography([[0, 0], [1, 0], [1, 1], [0, 1]], quad);
  quad.forEach((q, i) => {
    const [x, y] = applyH(H, [0, 1, 1, 0][i], [0, 0, 1, 1][i]);
    assert.ok(Math.hypot(x - q[0], y - q[1]) < 1e-6);
  });
  const [u, v] = applyH(invert3(H), ...applyH(H, 0.3, 0.7));
  assert.ok(Math.abs(u - 0.3) < 1e-9 && Math.abs(v - 0.7) < 1e-9);
});

test('HDR diagnosis puts the always-HDR Apple TV setting first', () => {
  const f = diagnoseHdr({ atvFormat: '4K HDR', matchRange: 'Off', lightOutput: 'Eco / Low', service: 'Netflix Standard or Basic' });
  assert.equal(f[0].sev, 'high');
  assert.match(f[0].title, /sent as HDR/);
  assert.ok(f.some((x) => /Eco/.test(x.title)));
});

test('screen luminance estimate is in a sensible range', () => {
  const n = estimateNits({ lumens: 2000, diagonalIn: 100 });
  assert.ok(n > 100 && n < 200, String(n));
});
