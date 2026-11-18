// The pattern window: lives on the AirPlay display and draws whatever the
// control page asks for, at native device-pixel resolution.
import { getPattern, renderPattern } from './patterns.js';
import { CHANNEL, drawMessage } from './display.js';

const canvas = document.getElementById('c');
const chan = new BroadcastChannel(CHANNEL);
let current = null;

const isFs = () => !!document.fullscreenElement;

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(window.innerWidth * dpr);
  const H = Math.round(window.innerHeight * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext('2d');
  if (!current) {
    drawMessage(ctx, W, H, 'ProjectorCal pattern window\nDrag this window onto the projector (AirPlay) display, then click it to go full screen.\nKeep it full screen while calibrating.');
    return;
  }
  if (current.message != null) {
    const hint = isFs() ? '' : '\n(click to go full screen)';
    drawMessage(ctx, W, H, current.message + hint);
    return;
  }
  renderPattern(ctx, getPattern(current.patternId), W, H, { banner: current.banner });
}

function hello(needsPattern = false) {
  const dpr = window.devicePixelRatio || 1;
  chan.postMessage({
    type: 'hello',
    needsPattern,
    devW: Math.round(window.innerWidth * dpr),
    devH: Math.round(window.innerHeight * dpr),
    dpr,
    screenW: Math.round(screen.width * dpr),
    screenH: Math.round(screen.height * dpr),
    fullscreen: isFs(),
  });
}

chan.onmessage = (e) => {
  const m = e.data;
  if (m?.type === 'show') {
    current = m;
    draw();
  }
};

window.addEventListener('resize', () => {
  draw();
  hello();
});
document.addEventListener('fullscreenchange', () => {
  document.body.classList.toggle('fs', isFs());
  draw();
  hello();
});
canvas.addEventListener('click', () => {
  if (!isFs()) document.documentElement.requestFullscreen().catch(() => {});
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'f') document.documentElement.requestFullscreen().catch(() => {});
  if ([' ', 'Enter', 'p', 'y', 'n', 'Y', 'N', 'Escape'].includes(e.key)) {
    e.preventDefault();
    chan.postMessage({ type: 'key', key: e.key });
  }
});

draw();
hello(true);
setInterval(() => hello(), 2000);
