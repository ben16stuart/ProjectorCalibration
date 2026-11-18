import { PRESETS, defaultProfile, ADVISORS, controlPosition, formatValue, processingTips, targetGamma } from './advisor.js';
import { ANALYZERS, patternCheck, describeTint } from './analysis.js';
import { cameraModel } from './color.js';
import { getPattern, measuredElements } from './patterns.js';
import { HDR_QUESTIONS, diagnoseHdr, estimateNits } from './hdr.js';
import { Camera, CAMERA_GONE, CAMERA_PAUSED, cameraErrorMessage } from './camera.js';
import { PatternDisplay } from './display.js';
import { Measurer } from './measure.js';
import { applyH } from './geometry.js';
import * as store from './store.js';

// ------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pctf = (x, d = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
function el(tag, attrs = {}, html = '') {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  if (html) e.innerHTML = html;
  return e;
}
function toast(msg, ms = 3200) {
  const t = el('div', { class: 'toast' });
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ------------------------------------------------------------ state
function freshState(presetId = 'acer_h7850') {
  return {
    v: 1,
    presetId,
    model: PRESETS[presetId].name,
    room: 'dark',
    screenIn: 100,
    gain: 1.0,
    lumens: presetId === 'acer_h7850' ? 3000 : 2000,
    profiles: { sdr: defaultProfile('sdr', presetId), hdr: defaultProfile('hdr', presetId) },
    initial: { sdr: null, hdr: null },
    searches: {},
    results: {},
    log: [],
    hdrAnswers: {},
    camera: { deviceId: '', exponent: null, wbLock: false },
    geometry: null,
    displayMode: 'window',
    refRect: null,
  };
}
let state = store.load() || freshState();
if (!state.profiles?.sdr || !state.profiles?.hdr) state = freshState();
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.save(state), 200);
}
const camModel = () => (state.camera.exponent ? cameraModel('power', state.camera.exponent) : cameraModel('srgb'));

// ------------------------------------------------------------ tests
const SDR_TESTS = [
  { id: 'overscan', pattern: 'overscan', title: 'Overscan / framing', frames: 20 },
  { id: 'black', pattern: 'black', title: 'Brightness (black level)', control: 'brightness', frames: 60, live: true, manualQ: 'By eye: can you see the 2% bar (second from left)?' },
  { id: 'white', pattern: 'white', title: 'Contrast (white clipping)', control: 'contrast', frames: 30, live: true, manualQ: 'By eye: are the bars up to 99% all distinct from each other?' },
  { id: 'black2', pattern: 'black', title: 'Brightness re-check (after Contrast)', control: 'brightness', frames: 60, live: true, manualQ: 'By eye: can you see the 2% bar?' },
  { id: 'colorclip', pattern: 'colorclip', title: 'Saturation (color clipping)', control: 'color', frames: 30, manualQ: 'By eye: are the 95% and 100% bars distinct in all three rows?' },
  { id: 'gamma', pattern: 'gamma', title: 'Gamma', control: 'gamma', frames: 40 },
  { id: 'grayscale', pattern: 'grayscale', title: 'Grayscale: RGB Gain & Bias', controls: ['redGain', 'greenGain', 'blueGain', 'redOffset', 'greenOffset', 'blueOffset', 'colorTemp'], frames: 40, withRef: true },
];
const HDR_TESTS = [
  { id: 'hdr_black', pattern: 'hdr_black', title: 'HDR black level (Brightness in HDR mode)', control: 'brightness', frames: 60, external: true, video: 'hdr_black.mp4', manualQ: 'By eye: can you see the bar labelled 80?' },
  { id: 'hdr_hl1000', pattern: 'hdr_hl1000', title: 'HDR highlights & tone mapping (1,000-nit content)', control: 'hdrToneMap', frames: 40, external: true, video: 'hdr_hl1000.mp4' },
  { id: 'hdr_hl4000', pattern: 'hdr_hl4000', title: 'HDR highlights (4,000-nit content, optional)', control: 'hdrToneMap', frames: 40, external: true, video: 'hdr_hl4000.mp4' },
];
const testById = (id) => [...SDR_TESTS, ...HDR_TESTS].find((t) => t.id === id);
const modeOf = (test) => (HDR_TESTS.includes(test) ? 'hdr' : 'sdr');
const resultKey = (test) => `${modeOf(test)}:${test.id}`;

// ------------------------------------------------------------ hardware
const video = $('#video');
const camera = new Camera(video);
camera.onChange = (what) => {
  const st = $('#camera-status');
  if (what === 'ended') {
    measurer.abort();
    st.textContent = CAMERA_GONE;
    st.className = 'status-line bad';
    toast('Camera disconnected.', 5000);
  } else if (what === 'paused') {
    measurer.abort();
    st.textContent = CAMERA_PAUSED;
    st.className = 'status-line bad';
    toast('Camera paused.', 5000);
  } else {
    st.textContent = 'Camera running again.';
    st.className = 'status-line ok';
  }
  updateChips();
};
const display = new PatternDisplay({
  overlay: $('#overlay'),
  overlayCanvas: $('#overlay-canvas'),
  onKey: (k) => handleKey(k),
  onStatus: () => updateChips(),
});
const measurer = new Measurer(camera, display);
display.setMode(state.displayMode);
if (state.refRect) measurer.refRect = state.refRect;

let activeTestId = 'black';
let showRegions = false;
const lastResults = {};
const cards = {};

// ------------------------------------------------------------ navigation
function showView(name) {
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
  if (name === 'report') renderReport();
  if (name === 'sdr' || name === 'hdr') refreshCardControls();
  location.hash = name;
}
$$('#nav button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ------------------------------------------------------------ chips
function updateChips() {
  const ci = camera.info();
  const cc = $('#chip-camera');
  const name = (ci?.label || '').replace(/\(.*?\)/g, '').trim();
  const short = name.length > 28 ? name.slice(0, 27) + '…' : name || 'on';
  if (!ci) cc.textContent = 'Camera: off';
  else if (!camera.running) cc.textContent = `Camera: ${short} disconnected`;
  else if (camera.paused) cc.textContent = `Camera: ${short} paused`;
  else cc.textContent = `Camera: ${short} ${ci.width}×${ci.height}`;
  cc.className = `chip ${ci && camera.running && !camera.paused ? 'ok' : 'bad'}`;
  const ds = display.status();
  const dc = $('#chip-display');
  dc.textContent = `Display: ${ds.text}`;
  dc.className = `chip ${ds.ok ? (ds.fullscreen === false ? '' : 'ok') : 'bad'}`;
  const ws = $('#window-status');
  if (ws) {
    ws.textContent = ds.ok ? `Pattern window connected: ${ds.text}.${ds.fullscreen === false ? ' Click inside it to make it full screen.' : ''}` : 'Pattern window not open (or not reachable).';
    ws.className = `status-line ${ds.ok && ds.fullscreen !== false ? 'ok' : ''}`;
  }
  const sc = $('#chip-screen');
  sc.textContent = measurer.H ? 'Screen: located' : 'Screen: not located';
  sc.className = `chip ${measurer.H ? 'ok' : 'bad'}`;
  const cv = $('#chip-curve');
  cv.textContent = state.camera.exponent ? `Camera curve: calibrated ${state.camera.exponent.toFixed(2)}` : 'Camera curve: assumed sRGB';
  cv.className = `chip ${state.camera.exponent ? 'ok' : ''}`;
}

// ------------------------------------------------------------ setup view
let editingMode = 'sdr';
function renderSetup() {
  const ps = $('#preset');
  ps.innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('');
  ps.value = state.presetId;
  $('#model').value = state.model || '';
  $('#room').value = state.room;
  $('#screenIn').value = state.screenIn ?? '';
  $('#gain').value = state.gain ?? 1;
  $('#lumens').value = state.lumens ?? '';
  renderNits();
  renderProfileEditor();
}
function renderNits() {
  const n = estimateNits({ lumens: Number(state.lumens), diagonalIn: Number(state.screenIn), gain: Number(state.gain) || 1 });
  $('#nits-est').textContent = n
    ? `Estimated peak on screen: about ${Math.round(n)} nits in a calibrated mode (brochure lumens × 0.6). HDR is mastered for 1,000+ nit TVs, so a projector always compresses it heavily.`
    : '';
}
$('#preset').addEventListener('change', (e) => {
  const id = e.target.value;
  if (!confirm(`Load the ${PRESETS[id].name} control list? This replaces both profiles and clears measurement history.`)) {
    e.target.value = state.presetId;
    return;
  }
  const keep = { camera: state.camera, geometry: state.geometry, displayMode: state.displayMode, hdrAnswers: state.hdrAnswers, refRect: state.refRect, room: state.room, screenIn: state.screenIn, gain: state.gain };
  state = { ...freshState(id), ...keep };
  save();
  renderSetup();
  buildCards();
});
for (const [id, key, num] of [['model', 'model', false], ['room', 'room', false], ['screenIn', 'screenIn', true], ['gain', 'gain', true], ['lumens', 'lumens', true]]) {
  $(`#${id}`).addEventListener('input', (e) => {
    state[key] = num ? Number(e.target.value) : e.target.value;
    save();
    renderNits();
    renderFindings();
  });
}
$$('#profile-tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    editingMode = b.dataset.mode;
    $$('#profile-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    renderProfileEditor();
  }),
);

function valueInput(ctrl, onChange) {
  let inp;
  if (ctrl.kind === 'list') {
    inp = el('select');
    inp.innerHTML = ctrl.options.map((o) => `<option${String(o) === String(ctrl.value) ? ' selected' : ''}>${esc(o)}</option>`).join('');
  } else {
    inp = el('input', { type: 'number', min: ctrl.min, max: ctrl.max, step: 1 });
    inp.value = ctrl.value;
  }
  inp.addEventListener('change', () => {
    ctrl.value = ctrl.kind === 'list' ? inp.value : Number(inp.value);
    save();
    onChange?.();
  });
  return inp;
}

function renderProfileEditor() {
  const prof = state.profiles[editingMode];
  const preset = PRESETS[prof.presetId] || PRESETS.generic;
  const box = $('#profile-editor');
  box.innerHTML = '';
  const pm = el('label', {}, `Display mode / picture mode used for ${editingMode.toUpperCase()}`);
  const pmIn = el('input', { type: 'text', list: 'pm-list' });
  pmIn.value = prof.pictureMode || '';
  pmIn.addEventListener('input', () => {
    prof.pictureMode = pmIn.value;
    save();
    renderTips();
  });
  const dl = el('datalist', { id: 'pm-list' }, preset.pictureModes.map((m) => `<option value="${esc(m)}">`).join(''));
  pm.append(pmIn, dl);
  box.append(pm);
  const tbl = el('table', { class: 'ctrl-table' });
  tbl.innerHTML = '<tr><th title="Your projector has this setting">Has</th><th>Setting</th><th>Value now</th><th>Range / options</th><th>Default</th></tr>';
  for (const [key, c] of Object.entries(prof.controls)) {
    const tr = el('tr', { class: c.enabled ? '' : 'disabled' });
    const en = el('input', { type: 'checkbox' });
    en.checked = !!c.enabled;
    en.addEventListener('change', () => {
      c.enabled = en.checked;
      tr.className = c.enabled ? '' : 'disabled';
      save();
      refreshCardControls();
    });
    const lab = el('input', { type: 'text' });
    lab.value = c.label;
    lab.addEventListener('change', () => {
      c.label = lab.value;
      save();
    });
    const valTd = el('td');
    valTd.append(valueInput(c, () => {
      renderTips();
      refreshCardControls();
    }));
    const rangeTd = el('td');
    const defTd = el('td');
    if (c.kind === 'list') {
      const opts = el('input', { type: 'text', title: 'Comma-separated, in menu order' });
      opts.value = c.options.join(', ');
      opts.addEventListener('change', () => {
        c.options = opts.value.split(',').map((s) => s.trim()).filter(Boolean);
        if (!c.options.includes(String(c.value))) c.value = c.options[0];
        save();
        renderProfileEditor();
      });
      rangeTd.append(opts);
      if (key === 'gamma') {
        const dir = el('label', { class: 'inline small' });
        const cb = el('input', { type: 'checkbox' });
        cb.checked = c.darkerLater !== false;
        cb.addEventListener('change', () => {
          c.darkerLater = cb.checked;
          save();
        });
        dir.append(cb, document.createTextNode(' later options are darker (higher gamma)'));
        rangeTd.append(dir);
      }
      if (key === 'hdrToneMap') {
        const dir = el('label', { class: 'inline small' });
        const cb = el('input', { type: 'checkbox' });
        cb.checked = c.higherIsBrighter !== false;
        cb.addEventListener('change', () => {
          c.higherIsBrighter = cb.checked;
          save();
        });
        dir.append(cb, document.createTextNode(' later options are brighter'));
        rangeTd.append(dir);
      }
      defTd.textContent = c.def ?? '';
    } else {
      const wrap = el('div', { class: 'row', style: 'margin:0;flex-wrap:nowrap' });
      for (const f of ['min', 'max']) {
        const i = el('input', { type: 'number', title: f, style: 'width:70px' });
        i.value = c[f];
        i.addEventListener('change', () => {
          c[f] = Number(i.value);
          save();
        });
        wrap.append(i);
      }
      rangeTd.append(wrap);
      const d = el('input', { type: 'number', style: 'width:70px' });
      d.value = c.def;
      d.addEventListener('change', () => {
        c.def = Number(d.value);
        save();
      });
      defTd.append(d);
      if (key === 'hdrToneMap') {
        const dir = el('label', { class: 'inline small' });
        const cb = el('input', { type: 'checkbox' });
        cb.checked = c.higherIsBrighter !== false;
        cb.addEventListener('change', () => {
          c.higherIsBrighter = cb.checked;
          save();
        });
        dir.append(cb, document.createTextNode(' higher = brighter'));
        rangeTd.append(dir);
      }
    }
    const t0 = el('td');
    t0.append(en);
    const t1 = el('td');
    t1.append(lab);
    tr.append(t0, t1, valTd, rangeTd, defTd);
    tbl.append(tr);
  }
  box.append(tbl);
  renderTips();
}

function renderTips() {
  const prof = state.profiles[editingMode];
  const tips = processingTips(prof);
  const box = $('#processing-tips');
  if (!tips.length) {
    box.innerHTML = '<h2>Picture processing</h2><p class="hint">Turn off sharpening/"detail" enhancers, noise reduction and motion smoothing while calibrating; use a Movie/Cinema/User mode as the starting point.</p>';
    return;
  }
  box.innerHTML = `<h2>Settings the camera can't measure (${editingMode.toUpperCase()} profile)</h2><ul class="tips-list">${tips
    .map((t) => `<li><span class="t">${t.ok ? '<span class="ok-cell">✓</span>' : '<span class="bad-cell">→</span>'} ${esc(t.label)}: ${esc(t.current)}${t.ok ? '' : ` → <b>${esc(t.want)}</b>`}</span><div class="why">${esc(t.why)}</div></li>`)
    .join('')}</ul>`;
}

// ------------------------------------------------------------ connect view
$$('input[name="dmode"]').forEach((r) => {
  r.checked = r.value === state.displayMode;
  r.addEventListener('change', () => {
    state.displayMode = r.value;
    display.setMode(r.value);
    $$('.mode-help').forEach((m) => (m.hidden = m.dataset.for !== r.value));
    save();
    updateChips();
  });
});
$$('.mode-help').forEach((m) => (m.hidden = m.dataset.for !== state.displayMode));
$('#open-window').addEventListener('click', async () => {
  const ok = await display.openWindow();
  if (!ok) toast('The browser blocked the pop-up. Allow pop-ups for localhost and try again.');
  setTimeout(() => display.message('Pattern window connected\nKeep this full screen on the projector'), 800);
});
$('#go-fullscreen').addEventListener('click', () => document.documentElement.requestFullscreen().catch(() => {}));

async function listCameras() {
  try {
    // Before camera permission Safari lists cameras without ids or names; those can't be chosen.
    const cams = (await Camera.list()).filter((c) => c.deviceId);
    const sel = $('#camera-select');
    const saved = state.camera.label && !cams.length ? `Last used: ${state.camera.label}` : 'Default camera';
    sel.innerHTML = `<option value="">${esc(saved)}</option>` + cams.map((c, i) => `<option value="${esc(c.deviceId)}">${esc(c.label || `Camera ${i + 1}`)}</option>`).join('');
    const match = cams.find((c) => c.deviceId === state.camera.deviceId) || (state.camera.label && cams.find((c) => c.label === state.camera.label));
    if (match) sel.value = match.deviceId;
  } catch {
    /* ignore */
  }
}

// Open the chosen camera. Saved ids can go stale (Safari renews them; an iPhone may be
// disconnected), so fall back to any camera — which also grants permission and reveals
// the camera names — and then switch to the saved camera by name if it is there.
async function openCamera() {
  const wanted = $('#camera-select').value || state.camera.deviceId || undefined;
  try {
    return await camera.start(wanted);
  } catch (e) {
    if (!wanted || !['OverconstrainedError', 'NotFoundError'].includes(e.name)) throw e;
  }
  let info = await camera.start();
  const match = state.camera.label && (await Camera.list()).find((c) => c.label === state.camera.label && c.deviceId);
  if (match && match.deviceId !== info.deviceId) info = await camera.start(match.deviceId);
  else if (!match && state.camera.label && info.label !== state.camera.label) toast(`${state.camera.label} is not available; using ${info.label}.`, 5000);
  return info;
}
$('#camera-start').addEventListener('click', startCamera);
async function startCamera() {
  const st = $('#camera-status');
  try {
    st.textContent = 'Starting camera…';
    const info = await openCamera();
    state.camera.deviceId = info.deviceId || $('#camera-select').value;
    state.camera.label = info.label;
    await listCameras();
    $('#preview-empty').hidden = true;
    let msg = `${info.label} — ${info.width}×${info.height}${info.frameRate ? ` @ ${Math.round(info.frameRate)} fps` : ''}.`;
    msg += info.canLockWB ? ' White balance can be locked.' : ' White balance cannot be locked on this camera (fine: tests compare patches within the same frame).';
    if (info.width < 1280) msg += ' Low resolution; choose a better camera if you have one.';
    st.textContent = msg;
    st.className = 'status-line ok';
    $('#wb-lock').disabled = !info.canLockWB;
    if (state.camera.wbLock && info.canLockWB) await camera.lockWhiteBalance(6500);
    if (state.geometry && state.geometry.camW === info.width && state.geometry.camH === info.height) {
      measurer.setCorners(state.geometry.corners);
      $('#locate-status').textContent = 'Using the screen position from last time. Re-locate if the camera or projector moved.';
    }
    save();
  } catch (e) {
    st.textContent = `Camera error: ${cameraErrorMessage(e)}`;
    st.className = 'status-line bad';
  }
  updateChips();
}
$('#camera-select').addEventListener('change', () => {
  state.camera.deviceId = $('#camera-select').value;
  save();
  if (camera.running) startCamera();
});
$('#wb-lock').checked = !!state.camera.wbLock;
$('#wb-lock').addEventListener('change', async (e) => {
  state.camera.wbLock = e.target.checked;
  save();
  if (!camera.running) return;
  if (e.target.checked) {
    const ok = await camera.lockWhiteBalance(6500);
    if (!ok) toast('This camera does not accept a manual white balance.');
  } else await camera.autoWhiteBalance();
});

function setBusy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busy-text').textContent = text;
}
$('#abort').addEventListener('click', () => {
  measurer.abort();
  for (const c of Object.values(cards)) c.live = false;
});

function geometryResult(r, statusEl) {
  if (r.ok) {
    state.geometry = { corners: r.corners, camW: camera.width, camH: camera.height };
    save();
    statusEl.textContent = `Found the picture: it fills ${(r.coverage * 100).toFixed(0)}% of the camera view.${r.coverage < 0.25 ? ' Small: move the camera closer or zoom for more accurate results.' : ''}${r.touchesEdge ? ' ' + r.reason : ''}`;
    statusEl.className = `status-line ${r.touchesEdge ? 'bad' : 'ok'}`;
    showRegions = true;
  } else {
    statusEl.textContent = r.reason;
    statusEl.className = 'status-line bad';
  }
  updateChips();
}
$('#locate').addEventListener('click', async () => {
  const st = $('#locate-status');
  if (state.displayMode === 'external') {
    toast('In Apple TV video mode, use "Locate from video flashes".');
    return;
  }
  if (state.displayMode === 'window' && !display.status().ok) {
    st.textContent = 'Open the pattern window first and put it full screen on the projector.';
    st.className = 'status-line bad';
    return;
  }
  try {
    setBusy('Locating…');
    const r = await measurer.locate({ onStatus: (s) => (st.textContent = s) });
    geometryResult(r, st);
    display.message('Screen located\nGo back to the laptop to continue');
  } catch (e) {
    st.textContent = e.message;
    st.className = 'status-line bad';
    display.message('Stopped\nSee the laptop'); // also takes the mirror-mode pattern off the screen
  } finally {
    setBusy(null);
  }
});
$('#locate-flash').addEventListener('click', async () => {
  const st = $('#locate-status');
  try {
    setBusy('Watching for flashes… start the video now');
    const r = await measurer.locateFromFlashes({ onStatus: (s) => (st.textContent = s) });
    geometryResult(r, st);
  } catch (e) {
    st.textContent = e.message;
    st.className = 'status-line bad';
  } finally {
    setBusy(null);
  }
});
$('#show-overscan').addEventListener('click', () => {
  showRegions = !showRegions;
  $('#show-overscan').textContent = showRegions ? 'Hide sample regions' : 'Show sample regions';
});

// ------------------------------------------------------------ preview overlay
const pv = $('#preview-overlay');
let dragCorner = -1;
let refDrawing = false;
let refStart = null;
const regionCache = new Map();
function camToCanvas() {
  const r = pv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const vw = camera.width || 16;
  const vh = camera.height || 9;
  const s = Math.min(r.width / vw, r.height / vh);
  return { s: s * dpr, ox: ((r.width - vw * s) / 2) * dpr, oy: ((r.height - vh * s) / 2) * dpr, dpr, r };
}
function drawPreview() {
  const r = pv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (pv.width !== Math.round(r.width * dpr)) pv.width = Math.round(r.width * dpr);
  if (pv.height !== Math.round(r.height * dpr)) pv.height = Math.round(r.height * dpr);
  const ctx = pv.getContext('2d');
  ctx.clearRect(0, 0, pv.width, pv.height);
  if (!camera.running) return;
  const { s, ox, oy } = camToCanvas();
  const P = ([x, y]) => [ox + x * s, oy + y * s];
  if (measurer.corners) {
    ctx.strokeStyle = 'rgba(80,220,120,0.95)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    measurer.corners.forEach((c, i) => {
      const [x, y] = P(c);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = 'rgba(80,220,120,0.95)';
    measurer.corners.forEach((c) => {
      const [x, y] = P(c);
      ctx.fillRect(x - 5 * dpr, y - 5 * dpr, 10 * dpr, 10 * dpr);
    });
    if (showRegions && measurer.H) {
      const test = testById(activeTestId);
      const pid = test ? test.pattern : 'black';
      const key = `${pid}:${measurer.corners.flat().join(',')}`;
      if (!regionCache.has(key)) {
        regionCache.clear();
        const quads = measuredElements(getPattern(pid)).map((e) => {
          const m = e.margin ?? 0.2;
          const [x, y, w, h] = e.rect;
          return [
            [x + m * w, y + m * h],
            [x + w - m * w, y + m * h],
            [x + w - m * w, y + h - m * h],
            [x + m * w, y + h - m * h],
          ].map(([u, v]) => applyH(measurer.H, u, v));
        });
        regionCache.set(key, quads);
      }
      ctx.strokeStyle = 'rgba(110,168,254,0.85)';
      ctx.lineWidth = 1 * dpr;
      for (const q of regionCache.get(key)) {
        ctx.beginPath();
        q.forEach((c, i) => {
          const [x, y] = P(c);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        ctx.closePath();
        ctx.stroke();
      }
    }
  }
  const rr = refDrawing && refStart && refStart.cur ? [refStart.x, refStart.y, refStart.cur.x, refStart.cur.y] : state.refRect;
  if (rr) {
    const [a, b] = P([Math.min(rr[0], rr[2]), Math.min(rr[1], rr[3])]);
    const [c, d] = P([Math.max(rr[0], rr[2]), Math.max(rr[1], rr[3])]);
    ctx.strokeStyle = 'rgba(240,200,80,0.95)';
    ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(a, b, c - a, d - b);
    ctx.fillStyle = 'rgba(240,200,80,0.95)';
    ctx.font = `${11 * dpr}px -apple-system, sans-serif`;
    ctx.fillText('reference', a + 4 * dpr, b - 4 * dpr);
  }
}
setInterval(drawPreview, 100);
function eventCam(e) {
  const { s, ox, oy, dpr, r } = camToCanvas();
  return { x: ((e.clientX - r.left) * dpr - ox) / s, y: ((e.clientY - r.top) * dpr - oy) / s, s: s / dpr };
}
pv.addEventListener('pointerdown', (e) => {
  if (!camera.running) return;
  const p = eventCam(e);
  if (refDrawing) {
    refStart = { x: p.x, y: p.y, cur: null };
    pv.setPointerCapture(e.pointerId);
    return;
  }
  if (!measurer.corners) return;
  let best = -1;
  let bd = 16 / p.s;
  measurer.corners.forEach((c, i) => {
    const d = Math.hypot(c[0] - p.x, c[1] - p.y);
    if (d < bd) (bd = d), (best = i);
  });
  if (best >= 0) {
    dragCorner = best;
    pv.setPointerCapture(e.pointerId);
  }
});
pv.addEventListener('pointermove', (e) => {
  const p = eventCam(e);
  if (refDrawing && refStart) refStart.cur = p;
  else if (dragCorner >= 0) {
    const c = measurer.corners.map((q) => [...q]);
    c[dragCorner] = [p.x, p.y];
    measurer.setCorners(c);
  }
});
pv.addEventListener('pointerup', () => {
  if (refDrawing && refStart?.cur) {
    const r = [Math.min(refStart.x, refStart.cur.x), Math.min(refStart.y, refStart.cur.y), Math.max(refStart.x, refStart.cur.x), Math.max(refStart.y, refStart.cur.y)];
    if ((r[2] - r[0]) * (r[3] - r[1]) > 100) {
      state.refRect = r;
      measurer.refRect = r;
      toast('Reference box set. The Grayscale test now compares against it.');
    }
    refDrawing = false;
    refStart = null;
    save();
  }
  if (dragCorner >= 0) {
    dragCorner = -1;
    state.geometry = { corners: measurer.corners, camW: camera.width, camH: camera.height };
    save();
  }
});
$('#ref-draw').addEventListener('click', () => {
  refDrawing = true;
  toast('Drag a box on the camera preview around the reference screen (an iPhone/iPad showing plain white, True Tone and Night Shift off).', 5000);
});
$('#ref-clear').addEventListener('click', () => {
  state.refRect = null;
  measurer.refRect = null;
  save();
});

// ------------------------------------------------------------ test cards
function buildCards() {
  for (const [list, box] of [[SDR_TESTS, $('#sdr-cards')], [HDR_TESTS, $('#hdr-cards')]]) {
    box.innerHTML = '';
    for (const t of list) box.append(buildCard(t));
  }
  setActive(activeTestId);
}

function buildCard(test) {
  const pattern = getPattern(test.pattern);
  const root = el('div', { class: 'test', 'data-test': test.id });
  const head = el('div', { class: 'test-head' });
  head.innerHTML = `<div><h3>${esc(test.title)}</h3><p>${esc(pattern.howTo || '')}${test.video ? ` Video: <code>${esc(test.video)}</code>.` : ''}</p></div>`;
  const badge = el('span', { class: 'badge' }, 'not measured');
  head.append(badge);
  const body = el('div', { class: 'test-body' });
  const ctrlNow = el('div', { class: 'ctrl-now' });
  const btns = el('div', { class: 'row' });
  const showBtn = el('button', {}, 'Show pattern');
  const measBtn = el('button', { class: 'primary' }, 'Measure');
  btns.append(showBtn, measBtn);
  let liveBtn = null;
  if (test.live) {
    liveBtn = el('button', { title: 'Re-measure continuously while you adjust with the remote' }, 'Live check');
    btns.append(liveBtn);
  }
  const resetBtn = el('button', { title: 'Forget earlier readings for this step' }, 'Restart step');
  btns.append(resetBtn);
  const manual = test.manualQ ? el('div', { class: 'manual' }, `${esc(test.manualQ)} `) : null;
  if (manual) {
    const y = el('button', {}, 'Yes (Y)');
    const n = el('button', {}, 'No (N)');
    y.addEventListener('click', () => runMeasure(test, { manualPass: true }));
    n.addEventListener('click', () => runMeasure(test, { manualPass: false }));
    manual.append(y, n);
  }
  const live = el('div', { class: 'live' });
  const advice = el('div');
  const metrics = el('div', { class: 'metrics' });
  const history = el('div', { class: 'history' });
  body.append(ctrlNow, btns);
  if (manual) body.append(manual);
  body.append(live, advice, metrics, history);
  root.append(head, body);
  root.addEventListener('pointerdown', () => setActive(test.id));
  showBtn.addEventListener('click', () => showPattern(test));
  measBtn.addEventListener('click', () => runMeasure(test));
  liveBtn?.addEventListener('click', () => toggleLive(test));
  resetBtn.addEventListener('click', () => {
    const mode = modeOf(test);
    for (const k of Object.keys(state.searches)) if (k.startsWith(`${mode}:${test.id}:`)) delete state.searches[k];
    delete state.results[resultKey(test)];
    save();
    renderCardState(test);
  });
  cards[test.id] = { root, badge, ctrlNow, advice, metrics, history, live, liveBtn, liveOn: false };
  renderCardControls(test);
  renderCardState(test);
  return root;
}

function setActive(id) {
  activeTestId = id;
  $$('.test').forEach((t) => t.classList.toggle('active', t.dataset.test === id));
}

function testControls(test) {
  const prof = state.profiles[modeOf(test)];
  const keys = test.controls || (test.control ? [test.control] : []);
  return keys.filter((k) => prof.controls[k] && prof.controls[k].enabled).map((k) => [k, prof.controls[k]]);
}

function renderCardControls(test) {
  const c = cards[test.id];
  if (!c) return;
  c.ctrlNow.innerHTML = '';
  const ctrls = testControls(test);
  if (!ctrls.length) {
    if (test.control === 'hdrToneMap') c.ctrlNow.innerHTML = '<span class="hint">No HDR tone-mapping control is enabled in the HDR profile. The test still shows which direction to go. If your HDR menu has an HDR brightness or HDR mode setting, enable it in Setup.</span>';
    return;
  }
  c.ctrlNow.append(el('span', { class: 'hint' }, 'On the projector now:'));
  for (const [, ctrl] of ctrls) {
    const lab = el('label', { class: 'inline' }, esc(ctrl.label));
    lab.append(valueInput(ctrl, () => renderProfileEditor()));
    c.ctrlNow.append(lab);
  }
}
function refreshCardControls() {
  for (const t of [...SDR_TESTS, ...HDR_TESTS]) renderCardControls(t);
}

function renderCardState(test) {
  const c = cards[test.id];
  const r = state.results[resultKey(test)];
  if (!r) {
    c.badge.className = 'badge';
    c.badge.textContent = 'not measured';
    c.advice.innerHTML = '';
    c.metrics.innerHTML = '';
  } else {
    c.badge.className = `badge ${r.status}`;
    c.badge.textContent = { good: 'done', adjust: 'adjusting', warn: 'check', info: 'info' }[r.status] || r.status;
    renderAdvice(test, r);
    c.metrics.innerHTML = r.metricsHtml || '';
  }
  const prof = state.profiles[modeOf(test)];
  const hist = Object.entries(state.searches)
    .filter(([k]) => k.startsWith(`${modeOf(test)}:${test.id}:`))
    .map(([k, s]) => {
      const key = k.split(':')[2];
      const ctrl = prof.controls[key];
      if (!ctrl) return '';
      const steps = s.history.map((h) => `${formatValue(ctrl, h.value)}${h.pass != null ? (h.pass ? ' ✓' : ' ✗') : h.metric != null ? ` (${typeof h.metric === 'number' ? h.metric.toFixed(2) : h.metric})` : ''}`);
      return steps.length ? `${esc(ctrl.label)}: ${steps.join(' → ')}` : '';
    })
    .filter(Boolean);
  c.history.innerHTML = hist.length ? `History: ${hist.join('<br>')}` : '';
}

function renderAdvice(test, r) {
  const c = cards[test.id];
  c.advice.innerHTML = `<div class="advice ${r.status}"><div class="headline">${esc(r.headline)}</div><ul>${(r.detail || []).map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>`;
  const prof = state.profiles[modeOf(test)];
  if (r.suggestion && prof.controls[r.suggestion.control]) {
    const ctrl = prof.controls[r.suggestion.control];
    const box = el('div', { class: 'suggest' });
    box.append(el('span', {}, r.done ? `Set ${esc(ctrl.label)} to` : `After changing it, ${esc(ctrl.label)} is now`));
    let inp;
    if (ctrl.kind === 'list') {
      inp = el('select');
      inp.innerHTML = ctrl.options.map((o, i) => `<option value="${esc(o)}"${i === r.suggestion.to ? ' selected' : ''}>${esc(o)}</option>`).join('');
    } else {
      inp = el('input', { type: 'number', min: ctrl.min, max: ctrl.max });
      inp.value = r.suggestion.to;
    }
    box.append(inp);
    const go = el('button', { class: 'primary' }, r.done ? 'Done, I set it' : 'Measure again');
    go.addEventListener('click', () => {
      ctrl.value = ctrl.kind === 'list' ? inp.value : Number(inp.value);
      save();
      refreshCardControls();
      renderProfileEditor();
      if (r.done) {
        r.suggestion = null;
        save();
        renderCardState(test);
        toast(`${ctrl.label} recorded as ${ctrl.value}.`);
      } else runMeasure(test);
    });
    box.append(go);
    if (!r.done) box.append(el('span', { class: 'hint' }, '(edit the number if you set something else)'));
    c.advice.append(box);
  }
}

function bannerFor(test) {
  const r = state.results[resultKey(test)];
  if (!r) return `${test.title} — press Space to measure`;
  if (r.suggestion) {
    const prof = state.profiles[modeOf(test)];
    const ctrl = prof.controls[r.suggestion.control];
    return r.done ? `${ctrl.label}: set ${r.suggestion.toText}  ✓ done` : `${ctrl.label}: ${r.suggestion.fromText} → ${r.suggestion.toText}, close the menu, then press Space`;
  }
  return r.headline;
}

function showPattern(test) {
  setActive(test.id);
  const external = test.external || state.displayMode === 'external';
  if (external) {
    toast(test.video ? `Play ${test.video} on the Apple TV.` : `Play ${test.pattern}.mp4 on the Apple TV.`);
    return;
  }
  display.show(test.pattern, bannerFor(test));
}

function stubResult(test) {
  const p = getPattern(test.pattern);
  return {
    test: test.id,
    pass: null,
    notes: ['Judged by eye.'],
    targetLabel: p.meta.labels ? p.meta.labels[p.meta.targetIndex ?? 1] : '',
    firstVisibleLabel: null,
    failing: [],
    firstClip: 'the top bars',
    clipped: ['one or more colours'],
  };
}

async function runMeasure(test, { manualPass = null } = {}) {
  setActive(test.id);
  const c = cards[test.id];
  if (c.liveOn) toggleLive(test);
  if (measurer.busy) return;
  const mode = modeOf(test);
  const prof = state.profiles[mode];
  const external = test.external || state.displayMode === 'external';
  if (!state.initial[mode]) state.initial[mode] = { pictureMode: prof.pictureMode, values: Object.fromEntries(Object.entries(prof.controls).map(([k, v]) => [k, v.value])) };
  let result;
  try {
    if (manualPass == null && !external && state.displayMode === 'window' && !display.status().ok) {
      throw new Error('The pattern window is not open. Open it from the Connect step and put it full screen on the projector.');
    }
    if (manualPass == null) {
      setBusy('Measuring…');
      const { stats, pattern, settled } = await measurer.measure(test.pattern, {
        frames: test.frames,
        external,
        banner: `Measuring ${test.title}…`,
        withRef: !!test.withRef,
        onStatus: (s) => setBusy(s),
      });
      const opts = test.withRef && stats.__ref ? { refStat: stats.__ref } : undefined;
      result = ANALYZERS[test.pattern](pattern, stats, camModel(), opts);
      // searches are keyed by test id, so the Brightness re-check starts fresh
      result.test = test.id;
      if (!settled) (result.notes ||= []).push('The picture never fully settled (flicker, a moving camera or the projector menu?). Results may be noisy.');
      if (external) {
        const chk = patternCheck(pattern, stats, camModel());
        if (!chk.ok) (result.notes ||= []).unshift(`The camera picture does not look like the ${test.pattern} pattern (correlation ${chk.rho?.toFixed(2)}). Is ${test.video || test.pattern + '.mp4'} playing, and is the screen located?`);
      }
      if (test.pattern === 'gamma' && result.cameraExponent && result.confidence !== 'none') {
        state.camera.exponent = Math.round(result.cameraExponent * 100) / 100;
        (result.notes ||= []).push(`Camera response calibrated (exponent ${state.camera.exponent}). HDR and grayscale readings now use it.`);
      }
      lastResults[test.id] = result;
    } else {
      result = { ...(lastResults[test.id] || stubResult(test)), notes: ['Judged by eye.'] };
    }
    const adv = ADVISORS[test.pattern](result, { profile: prof, searches: state.searches, room: state.room, manualPass });
    const rec = {
      at: Date.now(),
      status: adv.status,
      headline: adv.headline,
      detail: adv.detail,
      suggestion: adv.suggestion,
      done: adv.done,
      best: adv.best,
      metricsHtml: manualPass == null ? metricsHtml(test, result) : state.results[resultKey(test)]?.metricsHtml || '',
    };
    state.results[resultKey(test)] = rec;
    state.log.push({ at: rec.at, mode, test: test.id, headline: rec.headline, manual: manualPass != null });
    if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
    save();
    renderCardState(test);
    if (!external) display.setBanner(bannerFor(test));
    updateChips();
  } catch (e) {
    c.advice.innerHTML = `<div class="advice warn"><div class="headline">${esc(e.message)}</div></div>`;
    display.message('Stopped\nSee the laptop');
  } finally {
    setBusy(null);
  }
}

async function toggleLive(test) {
  const c = cards[test.id];
  if (c.liveOn) {
    c.liveOn = false;
    c.liveBtn.textContent = 'Live check';
    return;
  }
  if (measurer.busy) return;
  c.liveOn = true;
  c.liveBtn.textContent = 'Stop live';
  const external = test.external || state.displayMode === 'external';
  let first = true;
  while (c.liveOn) {
    try {
      const { stats, pattern } = await measurer.measure(test.pattern, { frames: 12, minDelay: first ? 1500 : 150, external, show: first, banner: 'Live check — adjust with the remote', onStatus: () => {} });
      first = false;
      const r = ANALYZERS[test.pattern](pattern, stats, camModel());
      c.live.textContent = `Live: ${liveText(test, r)}`;
    } catch (e) {
      c.live.textContent = e.message;
      break;
    }
  }
  c.liveOn = false;
  if (c.liveBtn) c.liveBtn.textContent = 'Live check';
}

function liveText(test, r) {
  if (r.pass == null) return 'camera cannot judge — ' + (r.notes?.[0] || '');
  if (test.pattern === 'black' || test.pattern === 'hdr_black') {
    const t = r.rows[getPattern(test.pattern).meta.targetIndex];
    const b = r.rows[getPattern(test.pattern).meta.targetIndex - 1];
    return `${t.label} bar ${t.visible ? 'visible ✓' : 'hidden ✗'} (${pctf(t.contrast, 0)} vs black) · ${b.label} ${b.visible ? 'visible' : 'hidden'} — aim for the lowest Brightness that keeps ${t.label} visible`;
  }
  if (test.pattern === 'white') return r.pass ? `no clipping ✓${r.slight ? ' (99→100 merges slightly)' : ''} — try one step higher` : `clipping from ${r.firstClip} ✗ — go lower`;
  return r.pass ? 'pass ✓' : 'fail ✗';
}

function metricsHtml(test, r) {
  try {
    switch (test.pattern) {
      case 'black':
      case 'hdr_black':
        if (!r.rows) return '';
        return `<table><tr><th>Bar</th><th>Brighter than black by</th><th>Camera threshold</th><th></th></tr>${r.rows
          .map((x) => `<tr><td>${esc(x.label)}</td><td class="num">${pctf(x.contrast, 1)}</td><td class="num">${(x.mdc * 100).toFixed(1)}%</td><td class="${x.visible ? 'ok-cell' : 'bad-cell'}">${x.visible ? 'visible' : 'hidden'}</td></tr>`)
          .join('')}</table><p class="hint">Confidence: ${esc(r.confidence)}.</p>`;
      case 'white': {
        if (!r.channels || !r.channels.Luminance) return '';
        const labels = getPattern('white').meta.labels;
        const steps = getPattern('white').meta.checkSteps;
        return `<table><tr><th>Step</th>${Object.keys(r.channels).map((k) => `<th>${k}</th>`).join('')}</tr>${steps
          .map(
            ([a, b], k) =>
              `<tr><td>${labels[a]}→${labels[b]}%</td>${Object.values(r.channels)
                .map((ch) => {
                  const s = ch.steps?.[k];
                  if (!s) return '<td>–</td>';
                  return `<td class="num ${s.clipped ? 'bad-cell' : ''}">${Math.round(s.ratio * 100)}%${s.resolvable ? '' : ' ?'}</td>`;
                })
                .join('')}</tr>`,
          )
          .join('')}</table><p class="hint">How much of the expected brightness step each bar pair shows (100% = normal; under 35% = clipped; "?" = too small for the camera to resolve).</p>`;
      }
      case 'colorclip':
        return r.rows ? `<table><tr><th>Colour</th><th>90→95%</th><th>95→100%</th></tr>${r.rows.map((x) => `<tr><td>${x.name}</td>${(x.steps || [{}, {}]).map((s) => `<td class="num ${s.clipped ? 'bad-cell' : ''}">${s.ratio != null ? Math.round(s.ratio * 100) + '%' : x.saturated ? 'camera overexposed' : '–'}</td>`).join('')}</tr>`).join('')}</table>` : '';
      case 'gamma':
        return `<table><tr><th>Row</th><th>Gamma</th><th>Usable</th></tr>${r.rows
          .map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${x.gamma != null ? x.gamma.toFixed(2) : '–'}${x.bound ? (x.bound === 'above' ? '+' : '−') : ''}</td><td class="${x.reliable ? 'ok-cell' : 'bad-cell'}">${x.reliable ? 'yes' : x.resolved ? 'camera sees the lines' : 'no'}</td></tr>`)
          .join('')}</table><p class="hint">Target for your room: ${targetGamma(state.room)}. Camera curve: ${r.cameraExponent ? `exponent ${r.cameraExponent.toFixed(2)}` : 'not calibrated this time'}.</p>`;
      case 'grayscale':
        if (!r.dev) return '';
        return `<table><tr><th>Gray</th><th>Red vs ${esc(r.refUsed)}</th><th>Blue vs ${esc(r.refUsed)}</th><th>Looks</th></tr>${r.labels
          .map((l, i) => {
            const d = r.dev[i];
            if (!d) return `<tr><td>${l}%</td><td colspan="3">camera overexposed</td></tr>`;
            return `<tr><td>${l}%</td><td class="num">${pctf(d.red)}</td><td class="num">${pctf(d.blue)}</td><td>${esc(describeTint(d))}</td></tr>`;
          })
          .join('')}</table>`;
      case 'overscan':
        return r.edges ? `<table><tr><th>Edge</th><th>Outermost visible frame</th></tr>${Object.entries(r.edges).map(([k, v]) => `<tr><td>${k}</td><td>${v.ring}</td></tr>`).join('')}</table>` : '';
      case 'hdr_hl1000':
      case 'hdr_hl4000':
        if (!r.rel) return '';
        return `<table><tr><th>Content level</th><th>Shown at (% of peak)</th><th></th></tr>${r.nits
          .map((n, i) => `<tr><td>${n} nits</td><td class="num">${(r.rel[i] * 100).toFixed(0)}%</td><td><span class="bar" style="width:${Math.round(r.rel[i] * 160)}px"></span></td></tr>`)
          .join('')}</table>`;
      default:
        return '';
    }
  } catch {
    return '';
  }
}

// ------------------------------------------------------------ keyboard
function handleKey(k) {
  const test = testById(activeTestId);
  if (!test) return;
  if (k === ' ' || k === 'Enter') runMeasure(test);
  else if (k === 'y' || k === 'Y') test.manualQ && runMeasure(test, { manualPass: true });
  else if (k === 'n' || k === 'N') test.manualQ && runMeasure(test, { manualPass: false });
  else if (k === 'p') showPattern(test);
  else if (k === 'Escape') display.hideOverlay();
}
document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (e.key === 'Escape') {
    display.hideOverlay();
    return;
  }
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || e.metaKey || e.ctrlKey) return;
  const view = $$('.view').find((v) => !v.hidden)?.id;
  const overlayUp = !$('#overlay').hidden;
  if (!overlayUp && view !== 'view-sdr' && view !== 'view-hdr') return;
  if ([' ', 'Enter', 'y', 'Y', 'n', 'N', 'p'].includes(e.key)) {
    e.preventDefault();
    handleKey(e.key);
  }
});
$('#overlay').addEventListener('click', () => display.hideOverlay());

// ------------------------------------------------------------ HDR view
function renderQuestions() {
  const box = $('#hdr-questions');
  box.innerHTML = '<h2>Your setup</h2>';
  for (const q of HDR_QUESTIONS) {
    const wrap = el('div', { class: 'q' });
    wrap.innerHTML = `<div class="group">${esc(q.group)}</div>`;
    const lab = el('label', {}, esc(q.q));
    const sel = el('select');
    sel.innerHTML = '<option value="">—</option>' + q.options.map((o) => `<option${state.hdrAnswers[q.id] === o ? ' selected' : ''}>${esc(o)}</option>`).join('');
    sel.addEventListener('change', () => {
      if (sel.value) state.hdrAnswers[q.id] = sel.value;
      else delete state.hdrAnswers[q.id];
      save();
      renderFindings();
    });
    lab.append(sel);
    wrap.append(lab);
    box.append(wrap);
  }
}
function currentFindings() {
  const nits = estimateNits({ lumens: Number(state.lumens), diagonalIn: Number(state.screenIn), gain: Number(state.gain) || 1 });
  return diagnoseHdr(state.hdrAnswers, { nits });
}
function renderFindings() {
  const box = $('#hdr-findings');
  const f = currentFindings();
  const answered = Object.keys(state.hdrAnswers).length;
  box.innerHTML = `<h2>Likely causes, most important first</h2>${answered ? '' : '<p class="hint">Answer the questions on the left.</p>'}${f
    .map((x) => `<div class="finding ${x.sev}"><div class="t">${esc(x.title)}</div><div class="why">${esc(x.why)}</div><div class="fix">${esc(x.fix)}</div></div>`)
    .join('')}`;
}

// ------------------------------------------------------------ report
function reportData() {
  const out = [];
  for (const mode of ['sdr', 'hdr']) {
    const prof = state.profiles[mode];
    const init = state.initial[mode];
    const rows = Object.entries(prof.controls)
      .filter(([, c]) => c.enabled)
      .map(([k, c]) => ({ label: c.label, before: init ? init.values[k] : null, now: c.value, changed: init ? String(init.values[k]) !== String(c.value) : false }));
    const tests = (mode === 'sdr' ? SDR_TESTS : HDR_TESTS).map((t) => ({ title: t.title, r: state.results[resultKey(t)] })).filter((x) => x.r);
    out.push({ mode, pictureMode: prof.pictureMode, rows, tests });
  }
  return out;
}
function renderReport() {
  const box = $('#report');
  const data = reportData();
  box.innerHTML = data
    .map(
      (d) => `<div class="card"><h2>${d.mode.toUpperCase()} — ${esc(d.pictureMode || '')}</h2>
      <table><tr><th>Setting</th><th>Before</th><th>Now</th></tr>${d.rows
        .map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${r.before == null ? '–' : esc(r.before)}</td><td class="num">${r.changed ? `<b>${esc(r.now)}</b>` : esc(r.now)}</td></tr>`)
        .join('')}</table>
      ${d.tests.length ? `<h3 style="margin-top:14px">Results</h3><ul>${d.tests.map((t) => `<li><b>${esc(t.title)}:</b> ${esc(t.r.headline)} <span class="hint">(${new Date(t.r.at).toLocaleString()})</span></li>`).join('')}</ul>` : '<p class="hint">No measurements yet.</p>'}
    </div>`,
    )
    .join('');
  const f = currentFindings().filter((x) => x.sev !== 'info');
  if (f.length) box.innerHTML += `<div class="card"><h2>HDR chain issues to fix</h2><ul>${f.map((x) => `<li><b>${esc(x.title)}</b> — ${esc(x.fix)}</li>`).join('')}</ul></div>`;
}
function reportText() {
  const lines = [`ProjectorCal report — ${state.model || ''} — ${new Date().toLocaleString()}`, ''];
  for (const d of reportData()) {
    lines.push(`${d.mode.toUpperCase()} (${d.pictureMode || ''})`);
    for (const r of d.rows) lines.push(`  ${r.label}: ${r.before == null ? '' : `${r.before} → `}${r.now}${r.changed ? '  *' : ''}`);
    for (const t of d.tests) lines.push(`  - ${t.title}: ${t.r.headline}`);
    lines.push('');
  }
  const f = currentFindings().filter((x) => x.sev !== 'info');
  if (f.length) {
    lines.push('HDR chain issues:');
    for (const x of f) lines.push(`  - ${x.title}: ${x.fix}`);
  }
  return lines.join('\n');
}
$('#copy-report').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(reportText());
    toast('Report copied.');
  } catch {
    toast('Clipboard not available.');
  }
});
$('#export-json').addEventListener('click', () => store.download(`projectorcal-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state, null, 2)));
$('#import-json').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    if (!s.profiles) throw new Error('Not a ProjectorCal export.');
    state = s;
    save();
    init();
    toast('Imported.');
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
});
$('#reset-all').addEventListener('click', () => {
  if (!confirm('Reset all settings, measurements and history?')) return;
  store.clear();
  state = freshState(state.presetId);
  save();
  init();
});

// ------------------------------------------------------------ init
function init() {
  renderSetup();
  renderQuestions();
  renderFindings();
  buildCards();
  if (state.refRect) measurer.refRect = state.refRect;
  updateChips();
}
init();
listCameras();
// An iPhone (Continuity Camera) can connect after the page loads; keep the list current.
navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  const before = $('#camera-select').options.length;
  await listCameras();
  if ($('#camera-select').options.length > before) toast('A new camera is available in the camera list.');
});
const startView = location.hash.slice(1);
showView(['setup', 'connect', 'sdr', 'hdr', 'report'].includes(startView) ? startView : 'setup');
