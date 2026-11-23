// Music visualizer for the full screen player: bars, ring around the cover, or layered waves.
// Data comes from player.spectrum(): WebAudio in the browser / desktop, the system visualizer on
// Android. Songs from other platforms give no audio access, then a calm decorative motion runs.
export const VIZ_MODES = ['off', 'bars', 'ring', 'wave'];
export const MINI_MODES = ['off', 'bars', 'wave', 'glow'];
const N = 64;

/** Settings shared by both visualizers: how strong they react, which part of the sound counts most, colours. */
export const vizTune = { sens: 1, bass: 1, mid: 1, high: 1, color: 'accent', speed: 1, delay: 0 };
const weightAt = (i) => {
  // smooth blend: lows up to band 14, mids around 28, highs from 44
  const x = i / (N - 1);
  const wb = Math.max(0, 1 - x / 0.28);
  const wh = Math.max(0, (x - 0.55) / 0.45);
  const wm = Math.max(0, 1 - wb - wh);
  return wb * vizTune.bass + wm * vizTune.mid + wh * vizTune.high;
};
/** Rainbow or accent colours for this moment: [from, to] plus a hue offset for per bar colouring. */
function palette(base) {
  if (vizTune.color === 'flow') {
    // rainbow gradient: just two colour points that run through all hues together
    const h = ((performance.now() / 1000) * 40 * vizTune.speed) % 360;
    return [`hsl(${h} 90% 62%)`, `hsl(${(h + 110) % 360} 90% 62%)`];
  }
  if (vizTune.color !== 'rainbow') return base;
  const h = ((performance.now() / 1000) * 40 * vizTune.speed) % 360;
  return [`hsl(${h} 90% 62%)`, `hsl(${(h + 70) % 360} 90% 62%)`, h];
}

export class Visualizer {
  constructor(player) {
    this.player = player;
    this.mode = 'off';
    this.bands = new Float32Array(N);
    this.smooth = new Float32Array(N);
    this.peaks = new Float32Array(N);
    this.canvas = null;
    this.box = null;
    this.raf = 0;
    this.running = false;
    this.real = false;
    this.colors = ['#4c8dff', '#9b7bff'];
    this.frame = 0;
    this.calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  attach(box) {
    if (this.box === box && this.canvas?.isConnected) return;
    this.box = box;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viz';
    this.canvas.setAttribute('aria-hidden', 'true');
    box.prepend(this.canvas);
  }

  setMode(mode) {
    this.mode = VIZ_MODES.includes(mode) ? mode : 'off';
    this.box?.closest('.fs')?.setAttribute('data-viz', this.mode);
    if (this.mode === 'off') this.stop();
  }

  start() {
    if (this.running || this.mode === 'off' || !this.canvas) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.drawFrame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.box) this.box.style.removeProperty('--pulse');
  }

  drawFrame() {
    this.#draw();
  }
  /** Read and smooth the sound for this frame; also refreshes the colours. */
  readFrame() {
    if (this.frame++ % 30 === 0) {
      const cs = getComputedStyle(document.documentElement);
      this.base = [cs.getPropertyValue('--accent').trim() || '#4c8dff', cs.getPropertyValue('--accent2').trim() || cs.getPropertyValue('--accent').trim() || '#9b7bff'];
    }
    this.colors = palette(this.base || this.colors);
    this.#read();
  }
  gradient(g, x0, y0, x1, y1) {
    return this.#grad(g, x0, y0, x1, y1);
  }
  size() {
    return this.#size();
  }

  #size() {
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(r.width * dpr);
    const h = Math.round(r.height * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return { w, h, dpr };
  }

  #read() {
    // the mini player and the big player read the same sound once per frame
    const now = performance.now();
    if (this.shared && this.shared.at > now - 8 && this.shared !== this) {
      this.smooth.set(this.shared.smooth);
      this.peaks.set(this.shared.peaks);
      this.real = this.shared.real;
      return;
    }
    if (this.shared) this.shared.at = now;
    const playing = this.player.playing;
    this.real = this.player.spectrum(this.bands);
    if (this.real) this.#delay(now);
    if (!this.real && playing && performance.now() - (this.lastReal || 0) < 2500) {
      // the real sound paused for a moment (seek, other screen, new song): let the bars sink, no imitation in between
      this.bands.fill(0);
    } else if (!this.real) {
      // platform players (YouTube, Spotify) give no access to their sound: an imitation that
      // follows a beat, with a kick in the lows, snare in the mids and shimmer in the highs
      const t = performance.now() / 1000;
      const bpm = 118;
      const beat = (t * bpm) / 60;
      const ph = beat % 1;
      const kick = Math.exp(-ph * 7);
      const snare = Math.floor(beat) % 2 ? Math.exp(-ph * 9) : 0;
      if (!this.noise || this.frame % 3 === 0) this.noise = Array.from({ length: N }, () => Math.random());
      for (let i = 0; i < N; i++) {
        const x = i / N;
        const body = 0.5 * Math.exp(-x * 2.4) + 0.14;
        const wob = 0.5 + 0.5 * Math.sin(t * 1.7 + i * 0.45) * Math.sin(t * 0.53 + i * 0.13);
        const k = kick * Math.max(0, 1 - x * 3.2) * 0.55;
        const sn = snare * Math.exp(-((x - 0.42) ** 2) / 0.02) * 0.35;
        const hat = x > 0.6 ? this.noise[i] * 0.22 * (0.4 + 0.6 * Math.exp(-((beat * 2) % 1) * 5)) : 0;
        const v = body * (0.45 + 0.4 * wob) + k + sn + hat + (this.noise[i] - 0.5) * 0.08;
        this.bands[i] = playing ? Math.min(1, Math.max(0, v)) : 0;
      }
    }
    if (this.real) {
      // the real sound gets louder and quieter with the volume (and jumps after a seek): an automatic level
      // keeps the bars the same size whatever the volume is, and limits sudden jumps
      let lvl = 0;
      for (let i = 0; i < N; i++) lvl = Math.max(lvl, this.bands[i]);
      const now2 = performance.now();
      const gap = now2 - (this.lastReal || 0);
      this.lastReal = now2;
      if (!this.agc || gap > 1500) this.agc = Math.max(0.15, lvl);
      else this.agc = lvl > this.agc ? this.agc + (lvl - this.agc) * 0.05 : this.agc * 0.996 + lvl * 0.004;
      const g = 0.8 / Math.max(0.06, this.agc);
      for (let i = 0; i < N; i++) this.bands[i] = Math.min(1, this.bands[i] * g);
    }
    for (let i = 0; i < N; i++) this.bands[i] = Math.min(1, this.bands[i] * vizTune.sens * weightAt(i));
    const settling = performance.now() - (this.player.seekedAt || 0) < 700;
    const up = this.calm || settling ? 0.12 : 0.62;
    const down = this.calm ? 0.06 : 0.14;
    for (let i = 0; i < N; i++) {
      const v = this.bands[i];
      const s = this.smooth[i];
      this.smooth[i] = v > s ? s + (v - s) * up : s + (v - s) * down;
      this.peaks[i] = Math.max(this.smooth[i], this.peaks[i] - 0.008);
    }
  }

  /** Bluetooth and some sound cards play later than the screen: the bars wait for the sound to reach the ear. */
  #delay(now) {
    const ms = vizTune.delay > 0 ? vizTune.delay : this.player.outputLatency?.() || 0;
    if (ms < 15) {
      this.hist = null;
      return;
    }
    const h = (this.hist ||= []);
    h.push({ t: now, b: Float32Array.from(this.bands) });
    while (h.length > 2 && h[1].t <= now - ms) h.shift();
    if (h.length > 90) h.splice(0, h.length - 90);
    if (h[0].t <= now - ms + 20) this.bands.set(h[0].b);
    else this.bands.fill(0);
  }

  #draw() {
    if (this.frame++ % 30 === 0) {
      const cs = getComputedStyle(document.documentElement);
      this.base = [cs.getPropertyValue('--accent').trim() || '#4c8dff', cs.getPropertyValue('--accent2').trim() || cs.getPropertyValue('--accent').trim() || '#9b7bff'];
    }
    this.colors = palette(this.base || this.colors);
    this.#read();
    const { w, h, dpr } = this.#size();
    const g = this.canvas.getContext('2d');
    g.clearRect(0, 0, w, h);
    if (!w || !h) return;
    let bass = 0;
    for (let i = 0; i < 6; i++) bass += this.smooth[i];
    bass /= 6;
    this.box.style.setProperty('--pulse', (1 + bass * (this.calm ? 0.02 : 0.06)).toFixed(4));
    if (this.mode === 'bars') this.#bars(g, w, h, dpr);
    else if (this.mode === 'ring') this.#ring(g, w, h, dpr, bass);
    else if (this.mode === 'wave') this.#wave(g, w, h, dpr);
  }

  #grad(g, x0, y0, x1, y1) {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    if (this.colors[2] != null) {
      // rainbow: the whole spectrum of hues along the shape, slowly moving
      for (let k = 0; k <= 6; k++) gr.addColorStop(k / 6, `hsl(${(this.colors[2] + k * 60) % 360} 90% 62%)`);
      return gr;
    }
    gr.addColorStop(0, this.colors[0]);
    gr.addColorStop(1, this.colors[1]);
    return gr;
  }

  // mirrored rounded bars around the middle line, with slowly falling peak caps
  #bars(g, w, h, dpr) {
    const n = 48;
    const gap = 3 * dpr;
    const bw = Math.max(2 * dpr, (w - gap * (n - 1)) / n);
    const mid = h / 2;
    const maxH = h * 0.46;
    g.fillStyle = this.#grad(g, 0, mid - maxH, w, mid + maxH);
    g.shadowColor = this.colors[0];
    g.shadowBlur = 18 * dpr;
    for (let i = 0; i < n; i++) {
      const k = Math.floor((i / n) * N);
      const v = Math.min(1, Math.sqrt(this.smooth[k]) * (0.8 + (i / n) * 0.35));
      const bh = Math.max(bw * 0.6, v * maxH);
      const x = i * (bw + gap);
      round(g, x, mid - bh, bw, bh * 2, bw / 2);
      g.fill();
    }
    g.shadowBlur = 0;
    g.globalAlpha = 0.7;
    for (let i = 0; i < n; i++) {
      const k = Math.floor((i / n) * N);
      const p = Math.min(1, Math.sqrt(this.peaks[k]) * (0.8 + (i / n) * 0.35)) * maxH;
      const x = i * (bw + gap);
      g.fillRect(x, mid - p - 5 * dpr, bw, 2 * dpr);
      g.fillRect(x, mid + p + 3 * dpr, bw, 2 * dpr);
    }
    g.globalAlpha = 1;
  }

  // spectrum radiating from a circle around the (shrunken) cover
  #ring(g, w, h, dpr, bass) {
    const cx = w / 2;
    const cy = h / 2;
    // the canvas is 136% of the cover box (CSS), the ring keeps its size relative to the box
    const side = Math.min(w, h) / 1.36;
    const r0 = side * 0.33 * (1 + bass * 0.04);
    const len = side * 0.16;
    const n = 96;
    g.lineCap = 'round';
    g.lineWidth = Math.max(2 * dpr, ((2 * Math.PI * r0) / n) * 0.55);
    g.strokeStyle = this.#grad(g, cx - r0, cy - r0, cx + r0, cy + r0);
    g.shadowColor = this.colors[1];
    g.shadowBlur = 16 * dpr;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      // mirror left / right so bass sits at the bottom on both sides
      const half = i < n / 2 ? i : n - 1 - i;
      const v = this.smooth[Math.floor((half / (n / 2)) * (N - 8))];
      const a = Math.PI / 2 + (i / n) * Math.PI * 2;
      const l = 3 * dpr + Math.sqrt(v) * len;
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * (r0 + l), cy + Math.sin(a) * (r0 + l));
    }
    g.stroke();
    g.shadowBlur = 0;
    g.globalAlpha = 0.25 + bass * 0.5;
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    g.arc(cx, cy, r0 - 6 * dpr, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
  }

  // three soft filled waves: bass, mids, highs
  #wave(g, w, h, dpr) {
    const layers = [
      [30, 64, 0.5, 0.55],
      [12, 36, 0.62, 0.7],
      [0, 16, 0.75, 0.9]
    ];
    const t = performance.now() / 1000;
    layers.forEach(([a, b, amp, alpha], li) => {
      const pts = 9;
      const ys = [];
      for (let p = 0; p <= pts; p++) {
        const k = a + Math.floor((p / pts) * (b - a - 1));
        const v = this.smooth[k];
        const drift = Math.sin(t * (0.6 + li * 0.3) + p * 0.9) * 0.04;
        ys.push(h * (0.96 - (Math.sqrt(v) * amp + 0.1 + drift + (2 - li) * 0.05)));
      }
      g.beginPath();
      g.moveTo(0, h);
      g.lineTo(0, ys[0]);
      for (let p = 0; p < pts; p++) {
        const x0 = (p / pts) * w;
        const x1 = ((p + 1) / pts) * w;
        const xm = (x0 + x1) / 2;
        g.bezierCurveTo(xm, ys[p], xm, ys[p + 1], x1, ys[p + 1]);
      }
      g.lineTo(w, h);
      g.closePath();
      const gr = g.createLinearGradient(0, h * 0.15, 0, h);
      gr.addColorStop(0, this.colors[li % 2]);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = alpha;
      g.fillStyle = gr;
      g.fill();
      g.globalAlpha = Math.min(1, alpha + 0.2);
      g.lineWidth = 2 * dpr;
      g.strokeStyle = this.colors[li % 2];
      g.shadowColor = this.colors[li % 2];
      g.shadowBlur = 14 * dpr;
      g.beginPath();
      g.moveTo(0, ys[0]);
      for (let p = 0; p < pts; p++) {
        const x0 = (p / pts) * w;
        const x1 = ((p + 1) / pts) * w;
        const xm = (x0 + x1) / 2;
        g.bezierCurveTo(xm, ys[p], xm, ys[p + 1], x1, ys[p + 1]);
      }
      g.stroke();
      g.shadowBlur = 0;
    });
    g.globalAlpha = 1;
  }
}

function round(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Turn a linear FFT (0..255 per bin, bin 0 = 0 Hz) into N log-spaced bands from 40 Hz to 16 kHz, 0..1. */
export function toBands(bins, sampleRate, out) {
  const hzPerBin = sampleRate / 2 / bins.length;
  const lo = Math.log(40);
  const hi = Math.log(16000);
  for (let i = 0; i < out.length; i++) {
    const f0 = Math.exp(lo + ((hi - lo) * i) / out.length);
    const f1 = Math.exp(lo + ((hi - lo) * (i + 1)) / out.length);
    const b0 = Math.max(1, Math.floor(f0 / hzPerBin));
    const b1 = Math.min(bins.length - 1, Math.max(b0, Math.ceil(f1 / hzPerBin)));
    let m = 0;
    for (let b = b0; b <= b1; b++) if (bins[b] > m) m = bins[b];
    out[i] = m / 255;
  }
  return out;
}

/** Small visualizer in the mini player: bars, a wave or a soft glow, behind the song name. */
export class MiniViz extends Visualizer {
  constructor(player, big) {
    super(player);
    this.shared = big ? (big.shared = big.shared || { at: 0, smooth: big.smooth, peaks: big.peaks, real: false }) : null;
    this.big = big;
    this.dim = { w: 0, h: 0, dpr: 1 };
  }
  attach(box) {
    if (this.box === box && this.canvas?.isConnected) return;
    this.box = box;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'miniviz';
    this.canvas.setAttribute('aria-hidden', 'true');
    box.prepend(this.canvas);
    // the size is measured only when it changes, never per frame (no layout work while it runs)
    this.ro?.disconnect();
    this.ro = new ResizeObserver(([e]) => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const w = Math.round(e.contentRect.width * dpr), h = Math.round(e.contentRect.height * dpr);
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      this.dim = { w, h, dpr };
      this.grad = null;
    });
    this.ro.observe(this.canvas);
    this.g = this.canvas.getContext('2d');
  }
  setMode(mode) {
    this.mode = MINI_MODES.includes(mode) ? mode : 'off';
    this.box?.setAttribute('data-miniviz', this.mode);
    if (this.mode === 'off') this.stop();
  }
  size() {
    return this.dim;
  }
  gradient(g, x0, y0, x1, y1) {
    // one gradient per size and colour, not a new one every frame
    const key = this.colors[0] + this.colors[1] + this.dim.w;
    if (this.colors[2] != null || !this.grad || this.gradKey !== key) { this.grad = super.gradient(g, x0, y0, x1, y1); this.gradKey = key; }
    return this.grad;
  }
  drawFrame() {
    // while the big player is open it does the reading; the mini player just copies it
    if (this.big?.running && this.shared) {
      this.smooth.set(this.big.smooth);
      this.colors = this.big.colors;
    } else {
      this.readFrame();
      if (this.shared) {
        this.shared.at = performance.now();
        this.shared.smooth = this.smooth;
      }
    }
    const { w, h, dpr } = this.dim;
    const g = this.g;
    if (!w || !h || !g) return;
    g.clearRect(0, 0, w, h);
    if (this.mode === 'bars') {
      const n = Math.max(24, Math.min(96, Math.round(w / (7 * dpr))));
      const gap = 2 * dpr;
      const bw = (w - gap * (n - 1)) / n;
      g.fillStyle = this.gradient(g, 0, 0, w, 0);
      for (let i = 0; i < n; i++) {
        // mirrored around the middle like an equalizer strip: lows in the centre
        const m = Math.abs(i - (n - 1) / 2) / (n / 2);
        const v = Math.sqrt(this.smooth[Math.min(59, Math.floor(m * 60))]);
        const bh = v * h;
        if (bh < 2.5 * dpr) continue; // silence draws nothing
        g.fillRect(i * (bw + gap), h - bh, bw, bh);
      }
    } else if (this.mode === 'wave') {
      const pts = 14;
      const t = performance.now() / 1000;
      const ys = [];
      for (let p = 0; p <= pts; p++) {
        const v = Math.sqrt(this.smooth[Math.floor((p / pts) * 56)]);
        ys.push(h * (1 - (0.12 + v * 0.8 + Math.sin(t * 1.3 + p) * 0.03)));
      }
      const path = () => {
        g.moveTo(0, ys[0]);
        for (let p = 0; p < pts; p++) {
          const x0 = (p / pts) * w;
          const x1 = ((p + 1) / pts) * w;
          const xm = (x0 + x1) / 2;
          g.bezierCurveTo(xm, ys[p], xm, ys[p + 1], x1, ys[p + 1]);
        }
      };
      g.beginPath();
      g.moveTo(0, h);
      g.lineTo(0, ys[0]);
      path();
      g.lineTo(w, h);
      g.closePath();
      g.globalAlpha = 0.45;
      g.fillStyle = this.gradient(g, 0, 0, w, 0);
      g.fill();
      g.globalAlpha = 1;
      g.lineWidth = 2 * dpr;
      g.strokeStyle = this.gradient(g, 0, 0, w, 0);
      g.beginPath();
      path();
      g.stroke();
    } else if (this.mode === 'glow') {
      // soft lights that swell with lows, mids and highs
      const parts = [[0, 12], [14, 34], [36, 60]];
      parts.forEach(([a, b], k) => {
        let v = 0;
        for (let i = a; i < b; i++) v += this.smooth[i];
        v = Math.sqrt(v / (b - a));
        const cx = w * (0.18 + k * 0.32);
        const r = h * (0.5 + v * 1.6);
        const col = this.colors[2] != null ? `hsl(${(this.colors[2] + k * 80) % 360} 90% 62%)` : this.colors[k % 2];
        const gr = g.createRadialGradient(cx, h, 0, cx, h, r);
        gr.addColorStop(0, col);
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.globalAlpha = 0.25 + v * 0.6;
        g.fillStyle = gr;
        g.fillRect(0, 0, w, h);
      });
      g.globalAlpha = 1;
    }
  }
}
