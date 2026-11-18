// Webcam / Continuity Camera access. Frames are read through a canvas as RGBA.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A camera that stops delivering frames must stop a measurement: otherwise the
// last picture is frozen in the video element and gets measured as if it were live.
const STALL_MS = 3000;
const IPHONE_HINT = 'With an iPhone: keep it locked, still and close to the Mac (unlocking it, picking it up or a call pauses Continuity Camera).';
export const CAMERA_PAUSED = `The camera stopped sending pictures. ${IPHONE_HINT} Then measure again.`;
export const CAMERA_GONE = `The camera disconnected. ${IPHONE_HINT} Then press Start camera again.`;

/** A readable message for getUserMedia failures (Safari's own messages are terse). */
export function cameraErrorMessage(e) {
  switch (e?.name) {
    case 'NotAllowedError':
      return 'Camera permission was denied. Safari: Safari › Settings › Websites › Camera › localhost › Allow. Chrome: the camera icon in the address bar. Then reload.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is busy or could not start. Quit other apps using it (FaceTime, Photo Booth, Zoom), then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'That camera is not available right now. Pick another one in the list, or reconnect the iPhone and press Start camera.';
    default:
      return e?.message || String(e);
  }
}

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.canvas = document.createElement('canvas');
    this.ctx = null;
    this.width = 0;
    this.height = 0;
    this.onChange = () => {}; // called with 'ended' | 'paused' | 'live'
    this.lastFrameAt = 0; // last requestVideoFrameCallback
    this.lastChangeAt = 0; // last time grabbed pixels differed from the previous grab
    this.sig = null;
  }

  static async list() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'videoinput');
  }

  get running() {
    return !!(this.track && this.track.readyState === 'live');
  }

  /** Live but not delivering frames (Continuity Camera paused, capture interrupted). */
  get paused() {
    return this.running && this.track.muted;
  }

  async start(deviceId) {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not allow camera access here. Open the app at http://localhost (not a file:// path).');
    const video = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.track = this.stream.getVideoTracks()[0];
    const track = this.track;
    // stop() does not fire 'ended', so these only report the camera going away by itself.
    track.addEventListener('ended', () => track === this.track && this.onChange('ended'));
    track.addEventListener('mute', () => track === this.track && this.onChange('paused'));
    track.addEventListener('unmute', () => track === this.track && this.onChange('live'));
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    for (let i = 0; i < 100 && !this.video.videoWidth; i++) await sleep(30);
    this.width = this.video.videoWidth;
    this.height = this.video.videoHeight;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.lastFrameAt = this.lastChangeAt = performance.now();
    this.sig = null;
    return this.info();
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
  }

  info() {
    if (!this.track) return null;
    const s = this.track.getSettings ? this.track.getSettings() : {};
    const c = this.track.getCapabilities ? this.track.getCapabilities() : {};
    return {
      label: this.track.label,
      deviceId: s.deviceId,
      width: this.width,
      height: this.height,
      frameRate: s.frameRate,
      canLockWB: Array.isArray(c.whiteBalanceMode) && c.whiteBalanceMode.includes('manual') && !!c.colorTemperature,
      canLockExposure: Array.isArray(c.exposureMode) && c.exposureMode.includes('manual'),
      hasExposureComp: !!c.exposureCompensation,
      whiteBalanceMode: s.whiteBalanceMode,
      exposureMode: s.exposureMode,
    };
  }

  async lockWhiteBalance(kelvin = 6500) {
    if (!this.info()?.canLockWB) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ whiteBalanceMode: 'manual', colorTemperature: kelvin }] });
      return true;
    } catch {
      return false;
    }
  }

  async autoWhiteBalance() {
    try {
      await this.track.applyConstraints({ advanced: [{ whiteBalanceMode: 'continuous' }] });
    } catch {
      /* not supported */
    }
  }

  #checkLive() {
    if (!this.running) throw new Error(this.track ? CAMERA_GONE : 'Start the camera first.');
    if (this.track.muted) throw new Error(CAMERA_PAUSED);
  }

  /** Resolve when the camera has delivered a new frame (or after a short timeout). */
  async waitFrame() {
    this.#checkLive();
    const v = this.video;
    if ('requestVideoFrameCallback' in v) {
      const fresh = await Promise.race([new Promise((r) => v.requestVideoFrameCallback(() => r(true))), sleep(120).then(() => false)]);
      if (fresh) this.lastFrameAt = performance.now();
      return;
    }
    await sleep(34);
  }

  grab() {
    this.#checkLive();
    this.ctx.drawImage(this.video, 0, 0, this.width, this.height);
    const d = this.ctx.getImageData(0, 0, this.width, this.height).data;
    // Sensor noise makes consecutive real frames differ; a frozen picture repeats exactly.
    // Only call it a stall when frame callbacks have stopped too (they can pause while
    // the preview is covered, so neither signal is trusted alone).
    const now = performance.now();
    let h = 0;
    for (let i = 0; i < d.length; i += 997) h = (Math.imul(h, 31) + d[i]) | 0;
    if (h !== this.sig) {
      this.sig = h;
      this.lastChangeAt = now;
    }
    if (now - this.lastChangeAt > STALL_MS && now - this.lastFrameAt > STALL_MS) throw new Error(CAMERA_PAUSED);
    return d;
  }

  async nextFrame() {
    await this.waitFrame();
    return this.grab();
  }
}
