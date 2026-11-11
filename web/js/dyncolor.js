// Picks a colour from a cover image and turns it into accent colours that read well on the dark UI.

const cache = new Map();

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
const hsl = (h, s, l) => `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;

/** Most vivid hue of an image, weighted by how much of the image it covers. */
export function pickColor(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 40;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, 40, 40);
  const px = g.getImageData(0, 0, 40, 40).data;
  const bins = new Array(36).fill(0).map(() => ({ w: 0, s: 0, l: 0 }));
  let grey = 0, greyL = 0;
  for (let i = 0; i < px.length; i += 4) {
    const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
    if (s < 0.18 || l < 0.08 || l > 0.94) { grey++; greyL += l; continue; }
    const w = s * (1 - Math.abs(l - 0.5) * 1.4);
    const b = bins[Math.floor(h * 36) % 36];
    b.w += w; b.s += s * w; b.l += l * w; b.h = (b.h || 0) + h * w;
  }
  let best = null;
  for (let i = 0; i < 36; i++) {
    const w = bins[(i + 35) % 36].w * 0.5 + bins[i].w + bins[(i + 1) % 36].w * 0.5;
    if (!best || w > best.w) best = { w, i };
  }
  const b = bins[best.i];
  if (!b.w || b.w < 12) return null; // almost no colour in the cover
  return { h: b.h / b.w, s: b.s / b.w, l: b.l / b.w };
}

/** Accent set for the UI: accent, a second hue for gradients, dark ink for text on accent, a deep tint for backgrounds. */
export function palette(c) {
  const s = Math.min(0.85, Math.max(0.5, c.s));
  return {
    accent: hsl(c.h, s, 0.64),
    accent2: hsl((c.h + 0.08) % 1, Math.min(0.9, s + 0.05), 0.62),
    ink: hsl(c.h, 0.6, 0.09),
    bg: hsl(c.h, Math.min(0.55, s), 0.2),
  };
}

export function colorFromUrl(url) {
  if (cache.has(url)) return cache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try { const c = pickColor(img); resolve(c ? palette(c) : null); } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
  cache.set(url, p);
  return p;
}
