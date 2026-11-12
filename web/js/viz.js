// Music visualizer for the full screen player: bars, ring around the cover, or layered waves.
// Data comes from player.spectrum(): WebAudio in the browser / desktop, the system visualizer on
// Android. Songs from other platforms give no audio access, then a calm decorative motion runs.
export const VIZ_MODES = ['off', 'bars', 'ring', 'wave'];
const N = 64;

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
      this.#draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.box) this.box.style.removeProperty('--pulse');
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
    const playing = this.player.playing;
    this.real = this.player.spectrum(this.bands);
    if (!this.real) {
      // decorative motion for platform songs: slow, layered sines that only move while playing
      const t = performance.now() / 1000;
      for (let i = 0; i < N; i++) {
        const x = i / N;
        const base = 0.55 * Math.exp(-x * 2.2) + 0.12;
        const wob = 0.5 + 0.5 * Math.sin(t * 2.1 + i * 0.37) * Math.sin(t * 0.7 + i * 0.11);
        this.bands[i] = playing ? base * (0.55 + 0.45 * wob) : 0;
      }
    }
    const up = this.calm ? 0.12 : 0.5;
    const down = this.calm ? 0.06 : 0.14;
    for (let i = 0; i < N; i++) {
      const v = this.bands[i];
      const s = this.smooth[i];
      this.smooth[i] = v > s ? s + (v - s) * up : s + (v - s) * down;
      this.peaks[i] = Math.max(this.smooth[i], this.peaks[i] - 0.008);
    }
  }

  #draw() {
    if (this.frame++ % 30 === 0) {
      const cs = getComputedStyle(document.documentElement);
      this.colors = [cs.getPropertyValue('--accent').trim() || '#4c8dff', cs.getPropertyValue('--accent2').trim() || cs.getPropertyValue('--accent').trim() || '#9b7bff'];
    }
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
    const side = Math.min(w, h);
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
