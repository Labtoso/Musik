// Liquid Glass motion, after Apple's material: glass that flexes and lights up from the finger when pressed,
// menus that grow out of the button that opened them and melt back into it, panes that materialise by bending
// the light more and more until they settle.
// Everything here only runs while the Liquid Glass theme is on.

const root = document.documentElement;
const on = () => root.dataset.theme === 'glass';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const SPRING = 'linear(0, 0.009, 0.035 2.1%, 0.141 4.4%, 0.723 12.9%, 0.938 16.7%, 1.017, 1.077, 1.121, 1.149 24.3%, 1.159, 1.163, 1.161, 1.154 29.9%, 1.129 32.8%, 1.051 39.6%, 1.017 43.1%, 0.991, 0.977 51%, 0.974 53.8%, 0.975 57.1%, 0.997 69.8%, 1.003 76.9%, 1.004 83.8%, 1)';
// a softer spring for big shapes (menus, sheets): one small overshoot
const SOFT = 'linear(0, 0.017, 0.067 3.6%, 0.264 7.6%, 0.588 13.5%, 0.825 19.4%, 0.962 25.1%, 1.03 30.7%, 1.054 36.2%, 1.052 42%, 1.035 48.3%, 1.013 58.8%, 1.002 70.2%, 0.998 82.9%, 1)';
const easing = (e) => (CSS.supports('transition-timing-function', 'linear(0, 1)') ? e : 'cubic-bezier(0.3, 1.4, 0.5, 1)');

// ---------- press: the glass grows a little under the finger, glows from the touch point and stretches after it ----------
// small round controls grow most, wide buttons a little, big cards give way instead
const GROW = '.icon-btn, .playpause, .swatch, .chip, .tab, .seg button, .btn, .fs-dev, .cp-chip';
const SINK = '.card, .qt, .themeopt, .srccard';
const GLOW_ONLY = '.menu button, .side-nav a, .set-row .select';
const PRESS = `${GROW}, ${SINK}, ${GLOW_ONLY}`;
let press = null;
function glowIn(el, x, y) {
  const r = el.getBoundingClientRect();
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  // own tag names, so no rule of the app (".switch span", ".btn i") ever styles the glow
  const g = document.createElement('lg-glow');
  const d = Math.max(r.width, r.height) * 2.2;
  const i = document.createElement('lg-dot');
  i.style.cssText = `left:${x - r.left}px;top:${y - r.top}px;width:${d}px;height:${d}px`;
  g.appendChild(i);
  el.appendChild(g);
  return g;
}
function glowOut(g) {
  if (!g) return;
  g.classList.add('out');
  setTimeout(() => g.remove(), 520);
}
function pressStart(e) {
  if (!on() || e.button > 0) return;
  const el = e.target.closest?.(PRESS);
  if (!el || el.disabled) return;
  if (press) pressEnd();
  const r = el.getBoundingClientRect();
  const grow = el.matches(GROW), sink = el.matches(SINK);
  // the smaller the control, the more it swells, like a drop of water under a fingertip
  const s = sink ? 0.97 : grow ? (r.width <= 64 ? 1.16 : r.width <= 180 ? 1.08 : 1.04) : 1;
  press = { el, id: e.pointerId, x0: e.clientX, y0: e.clientY, s, w: r.width, glow: reduced() ? null : glowIn(el, e.clientX, e.clientY), moved: false };
  el.classList.remove('lg-rel');
  el.classList.add('lg-p');
  if (s !== 1 && !reduced()) el.style.scale = String(s);
}
function pressMove(e) {
  if (!press || e.pointerId !== press.id || reduced() || press.s === 1) return;
  // the glass follows the finger a little and stretches towards it, then snaps back when let go
  const dx = e.clientX - press.x0, dy = e.clientY - press.y0;
  if (Math.hypot(dx, dy) > 70) return pressEnd(); // scrolling, not pressing
  const lim = Math.min(8, press.w * 0.12);
  const tx = Math.max(-lim, Math.min(lim, dx * 0.22)), ty = Math.max(-lim, Math.min(lim, dy * 0.22));
  const st = Math.min(0.09, Math.abs(dx) / 260), sy = Math.min(0.09, Math.abs(dy) / 260);
  press.el.style.translate = `${tx.toFixed(1)}px ${ty.toFixed(1)}px`;
  press.el.style.scale = `${(press.s + st - sy * 0.5).toFixed(3)} ${(press.s + sy - st * 0.5).toFixed(3)}`;
  const i = press.glow?.firstChild;
  if (i) {
    const r = press.el.getBoundingClientRect();
    i.style.left = (e.clientX - r.left) / (press.s || 1) + 'px';
    i.style.top = (e.clientY - r.top) / (press.s || 1) + 'px';
  }
}
function pressEnd() {
  if (!press) return;
  const { el, glow } = press;
  press = null;
  glowOut(glow);
  el.classList.remove('lg-p');
  el.classList.add('lg-rel');
  el.style.scale = '';
  el.style.translate = '';
  setTimeout(() => el.classList.remove('lg-rel'), 700);
}
addEventListener('pointerdown', pressStart, { capture: true, passive: true });
addEventListener('pointermove', pressMove, { capture: true, passive: true });
addEventListener('pointerup', pressEnd, { capture: true, passive: true });
addEventListener('pointercancel', pressEnd, { capture: true, passive: true });
addEventListener('blur', pressEnd);

// ---------- materialise: a pane appears by bending the light ever less until it is clear glass ----------
/** Animates the bend of the SVG lens `id` from `from` times its strength back to normal. */
export function lensSettle(id, from = 3, ms = 620) {
  if (!on() || reduced()) return;
  const f = document.getElementById(id);
  const maps = f ? [...f.querySelectorAll('feDisplacementMap')] : [];
  if (!maps.length) return;
  const base = maps.map((m) => Number(m.dataset.base || m.getAttribute('scale')));
  maps.forEach((m, i) => (m.dataset.base = base[i]));
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    const k = 1 + (from - 1) * Math.pow(1 - p, 3);
    maps.forEach((m, i) => m.setAttribute('scale', (base[i] * k).toFixed(1)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- morph: a menu grows out of its button like a drop that swells, and melts back into it ----------
function rectOf(anchor) {
  if (!anchor) return null;
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    return r.width ? { x: r.left, y: r.top, w: r.width, h: r.height, r: parseFloat(getComputedStyle(anchor).borderTopLeftRadius) || r.height / 2 } : null;
  }
  if (anchor.clientX != null) return { x: anchor.clientX - 14, y: anchor.clientY - 14, w: 28, h: 28, r: 14 };
  return null;
}
function morphFrames(el, a) {
  const m = el.getBoundingClientRect();
  const sx = Math.max(0.08, a.w / m.width), sy = Math.max(0.08, a.h / m.height);
  const dx = a.x + a.w / 2 - (m.left + m.width / 2), dy = a.y + a.h / 2 - (m.top + m.height / 2);
  const r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 18;
  // the radius is counter-scaled so the small shape is as round as the button it comes from
  const rad = `${Math.min(a.r, a.w / 2) / sx}px / ${Math.min(a.r, a.h / 2) / sy}px`;
  return [
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, borderRadius: rad, opacity: 0.35, filter: 'blur(4px) brightness(1.35)' },
    { transform: 'none', borderRadius: `${r}px`, opacity: 1, filter: 'blur(0) brightness(1)' },
  ];
}
export function morphIn(el, anchor) {
  if (!on() || reduced()) return;
  const a = rectOf(anchor);
  if (!a) return;
  el.classList.add('lg-morph');
  el.style.transformOrigin = '50% 50%';
  const anim = el.animate(morphFrames(el, a), { duration: 560, easing: easing(SOFT) });
  // the content fades in once the glass has nearly grown, so the words never look squashed
  [...el.children].forEach((c, i) => c.animate([{ opacity: 0, transform: 'translateY(-4px) scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 110 + i * 18, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'backwards' }));
  anim.onfinish = () => (el.style.transformOrigin = '');
  requestAnimationFrame(() => lensSettle('lg-menu', 3.2, 600));
}
/** Melts the menu back into its button. Resolves when the shape is gone; the element is removed by the caller. */
export function morphOut(el, anchor) {
  if (!on() || reduced() || !el.isConnected) return Promise.resolve();
  const a = rectOf(anchor);
  if (!a) return el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.9)' }], { duration: 180, easing: 'ease-in' }).finished.catch(() => {});
  el.style.pointerEvents = 'none';
  [...el.children].forEach((c) => c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' }));
  return el.animate(morphFrames(el, a).reverse(), { duration: 340, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }).finished.catch(() => {});
}

// The tab bar stays full while scrolling, like in the standard theme (Sebastian 2026-11-17).
