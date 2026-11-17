import { audioOut, conn, saveConn, normalizeServer, detectSameOrigin, sameInfo, api, get, post, put, del, coverUrl, upload, setUnauthorizedHandler, ApiError, extCovers } from './api.js';
import { LOGOS } from './logos.js';
import { Player, EQ_FREQS, warmSongs, preloadSongs } from './player.js';
import { settings, loadSettings, saveSettings, enabled, SOURCES, spotify, fetchLink, parseFile, saveImport, spotifyPlaylist, spotifyLiked, playableItems, searchYouTube, searchSpotify, searchSpotifyAll, searchYouTubeFree, searchYouTubeMusic, spotifyArtist, spotifyFindArtist, spotifyAlbum, extTrack, sameSong, DISCORD_URL, openExternal as openExt } from './sources.js';
import { placeStage } from './engines.js';
import { Visualizer, MiniViz, VIZ_MODES, MINI_MODES, vizTune } from './viz.js';
import { t, setLang, getLang } from './i18n.js';
import { icon } from './icons.js';
import { colorFromUrl } from './dyncolor.js';
import { lensSettle, morphIn, morphOut } from './liquid.js';

const RELEASES = 'https://github.com/Labtoso/Musik/releases/latest';
const GUIDE = 'https://github.com/Labtoso/Musik/blob/main/docs/tailscale.md';
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- settings ----------
const PREFS_KEY = 'musik.prefs';
// English unless the person picked a language (kept on this device, in the Android app and on the server)
const nativeLang = (() => {
  try {
    return window.MusikAndroid?.getLang?.() || '';
  } catch {
    return '';
  }
})();
const prefs = Object.assign({ lang: nativeLang || 'en', accent: 'cover', volume: 1, autoplay: true, dynamic: true }, (() => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
})());
// older versions stored the browser language without being asked: only a real choice counts
if (!prefs.langChosen && !nativeLang) prefs.lang = 'en';
if (nativeLang) prefs.lang = nativeLang;
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}
/** Remember a language choice everywhere it can be read again: this browser, the Android app, the account. */
function rememberLang(lang) {
  prefs.lang = lang;
  prefs.langChosen = true;
  savePrefs();
  try {
    window.MusikAndroid?.setLang?.(lang);
  } catch {}
  if (conn.token) saveSettings({ lang, langChosen: true }).catch(() => {});
}
// the Android app keeps the page clear of the status and navigation bars itself
if (window.MusikAndroid) {
  document.documentElement.style.setProperty('--safe-t', '0px');
  document.documentElement.style.setProperty('--safe-b', '0px');
}
if (prefs.sink) audioOut.id = prefs.sink;
function applyPrefs() {
  setLang(prefs.lang);
  document.documentElement.dataset.accent = isHex(accentNow()) ? 'custom' : accentNow();
  document.documentElement.dataset.theme = curTheme();
  // Green is dark only
  const light = prefs.mode === 'light' && curTheme() !== 'green';
  document.documentElement.dataset.mode = light ? 'light' : 'dark';
  // OLED: a setting of dark mode, not a theme of its own. Every theme turns pure black
  const oled = !!prefs.oled && !light;
  if (oled) document.documentElement.dataset.oled = '1';
  else delete document.documentElement.dataset.oled;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f5f5f7' : oled ? '#000000' : '#111214');
  customAccent();
  window.MusikAndroid?.setMode?.(light ? 'light' : 'dark');
  window.MusikAndroid?.setAccent?.(accentNow());
  if (document.getElementById('gpanel')) gSync();
}
document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-savepublic]')) return;
  const url = ($('#publicurl')?.value || '').trim();
  try {
    const r = await put('/api/public-url', { url: url || '-' });
    toast(t(r.public ? 'saved' : 'publicOffSaved'));
  } catch (err) {
    toast(t(err.code === 'bad_url' ? 'remoteBad' : 'error'));
  }
});
document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-saveremote]')) return;
  const url = ($('#remoteurl')?.value || '').trim();
  try {
    await put('/api/remote', { url });
    window.MusikAndroid?.setRemote?.(url);
    toast(t('saved'));
  } catch (err) {
    toast(t(err.code === 'bad_url' ? 'remoteBad' : 'error'));
  }
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode-pick]');
  if (!b) return;
  prefs.mode = b.dataset.modePick;
  savePrefs();
  applyPrefs();
  applyDyn(player?.current, true);
  b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
});
// eye button next to a hidden field (client id, keys): show or hide what is typed
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-eye]');
  if (!b) return;
  e.preventDefault();
  const inp = b.parentElement.querySelector('input');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  b.innerHTML = icon(show ? 'eyeOff' : 'eye');
});
// ---------- themes ----------
const THEMES_ALL = ['default', 'glass', 'green'];
// extra themes only show once "Themes +" is switched on
const themeList = () => (prefs.themesPlus ? THEMES_ALL : THEMES_ALL.filter((k) => k !== 'green'));
const curTheme = () => (themeList().includes(prefs.theme) ? prefs.theme : 'default');
// Green keeps its own accent (green unless changed there), the other themes share prefs.accent
const accentNow = () => (curTheme() === 'green' ? prefs.greenAccent || 'green' : prefs.accent);
// ---------- own accent colour: any colour, from the picker or typed as hex ----------
const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v || '');
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgbToHex = (r, g, b) => '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((h * 60) + 360) % 360, mx ? d / mx : 0, mx];
}
function hsvToHex(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return rgbToHex(f(5) * 255, f(3) * 255, f(1) * 255);
}
const lum = (hex) => {
  const c = hexToRgb(hex).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** Typed hex: "#abc", "abc", "aabbcc" and "#AABBCC" all work. */
function parseHex(v) {
  v = String(v || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(v)) v = v.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(v) ? '#' + v.toLowerCase() : null;
}
/** The accent set for an own colour: stays readable on the background (darker in light mode, lighter on black) and gets dark or white text. */
function accentSet(hex, light) {
  let [h, s, v] = rgbToHsv(hexToRgb(hex));
  let a = hex;
  const bg = light ? '#f5f5f7' : '#111214';
  for (let i = 0; i < 24 && contrast(a, bg) < 2.6; i++) {
    if (light) v = Math.max(0, v - 0.04);
    else { v = Math.min(1, v + 0.04); s = Math.max(0, s - 0.02); }
    a = hsvToHex(h, s, v);
  }
  const ink = contrast(a, '#ffffff') >= contrast(a, '#0b0c10') ? '#ffffff' : hsvToHex(h, Math.min(1, s * 0.8), 0.09);
  return { accent: a, accent2: hsvToHex((h + 28) % 360, Math.min(1, s * 1.05), Math.min(1, v * 0.97)), ink };
}
/** Puts an own colour on the page (or takes it off again when a named colour is picked). */
function customAccent() {
  const a = accentNow(), r = document.documentElement;
  if (!isHex(a)) return ['--accent', '--accent-ink', '--accent2'].forEach((k) => r.style.removeProperty(k));
  const c = accentSet(a, r.dataset.mode === 'light');
  r.style.setProperty('--accent', c.accent);
  r.style.setProperty('--accent2', c.accent2);
  r.style.setProperty('--accent-ink', c.ink);
}
/** Picks an accent (a name, "cover" or a hex colour); `keep` false while dragging so only the end of the drag is stored. */
function setAccentPref(v, keep = true) {
  if (curTheme() === 'green') prefs.greenAccent = v;
  else prefs.accent = v;
  if (isHex(v)) prefs.customAccent = v;
  if (keep) {
    if (isHex(v)) prefs.recentAccents = [v, ...(prefs.recentAccents || []).filter((x) => x !== v)].slice(0, 8);
    savePrefs();
  }
  applyPrefs();
  if (typeof player !== 'undefined' && player) applyDyn(player.current, true);
  syncAccentUi();
}
function syncAccentUi() {
  const a = accentNow();
  document.querySelectorAll('.swatch[data-accent]').forEach((s) => s.classList.toggle('on', s.dataset.accent === a));
  document.querySelectorAll('.swatch.custom').forEach((s) => {
    s.classList.toggle('on', isHex(a));
    s.style.setProperty('--c', isHex(a) ? a : prefs.customAccent || '');
    s.classList.toggle('has', isHex(a) || isHex(prefs.customAccent));
  });
  document.querySelectorAll('.cpick').forEach((p) => cpickSync(p, isHex(a) ? a : null));
}
const ACCENT_IDEAS = ['#ff2d55', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#0a84ff', '#5e5ce6', '#bf5af2', '#ac8e68', '#e8e8ed'];
/** The swatches plus the "own colour" swatch and its picker: a field for saturation and brightness, a hue strip, hex input and recent colours. */
function accentPicker(list) {
  const a = accentNow();
  const own = isHex(a) ? a : prefs.customAccent || '';
  const recent = (prefs.recentAccents || []).filter(isHex);
  return `<div class="accentpick"><div class="swatches">${list.map((x) => `<button class="swatch ${x} ${a === x ? 'on' : ''}" data-accent="${x}" title="${t(x)}" aria-label="${t(x)}"></button>`).join('')}<button class="swatch custom ${isHex(a) ? 'on' : ''} ${own ? 'has' : ''}" data-cpick style="--c:${own}" title="${t('customColor')}" aria-label="${t('customColor')}" aria-expanded="false">${icon('plus')}</button></div>
  <div class="cpick" hidden><div class="cp-in">
    <div class="cp-sv" data-cpdrag="sv" role="slider" aria-label="${t('cpShade')}" tabindex="0"><i class="cp-thumb"></i></div>
    <div class="cp-hue" data-cpdrag="hue" role="slider" aria-label="${t('cpHue')}" tabindex="0"><i class="cp-thumb"></i></div>
    <div class="cp-row"><span class="cp-prev"></span><label class="cp-hex"><span>#</span><input data-cphex maxlength="7" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Hex"></label>${'EyeDropper' in window ? `<button type="button" class="icon-btn cp-eye" data-cpeye title="${t('cpEye')}" aria-label="${t('cpEye')}">${icon('pipette')}</button>` : ''}</div>
    <div class="cp-list"><small>${t(recent.length ? 'cpRecent' : 'cpIdeas')}</small><div>${(recent.length ? recent : ACCENT_IDEAS).map((c) => `<button type="button" class="cp-chip" data-cphexset="${c}" style="--c:${c}" title="${c}" aria-label="${c}"></button>`).join('')}</div></div>
  </div></div></div>`;
}
function cpickSync(p, hex) {
  if (!hex) return;
  const st = p._hsv && hsvToHex(...p._hsv) === hex ? p._hsv : rgbToHsv(hexToRgb(hex));
  // grey has no hue: keep the hue the picker had, so the strip does not jump to red
  if (p._hsv && (st[1] === 0 || st[2] === 0)) st[0] = p._hsv[0];
  p._hsv = st;
  const [h, sv, v] = st;
  p.style.setProperty('--h', h.toFixed(1));
  p.style.setProperty('--cur', hex);
  p.querySelector('.cp-sv .cp-thumb').style.cssText = `left:${(sv * 100).toFixed(2)}%;top:${((1 - v) * 100).toFixed(2)}%`;
  p.querySelector('.cp-hue .cp-thumb').style.left = ((h / 360) * 100).toFixed(2) + '%';
  const inp = p.querySelector('[data-cphex]');
  if (document.activeElement !== inp) inp.value = hex.slice(1).toUpperCase();
  inp.classList.remove('bad');
}
function cpickOpen(p, open) {
  p.hidden = false;
  if (open && isHex(accentNow())) cpickSync(p, accentNow());
  p.closest('.accentpick')?.querySelector('[data-cpick]')?.setAttribute('aria-expanded', String(open));
  p.classList.toggle('open', open);
  if (!open) setTimeout(() => !p.classList.contains('open') && (p.hidden = true), 420);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cpick]');
  if (b) {
    const p = b.closest('.accentpick').querySelector('.cpick');
    const a = accentNow();
    if (!isHex(a)) {
      // first time: start from the colour the app shows right now, so nothing jumps
      const now = prefs.customAccent || parseHex(getComputedStyle(document.documentElement).getPropertyValue('--accent')) || '#4c8dff';
      setAccentPref(now);
      return cpickOpen(p, true);
    }
    return cpickOpen(p, !p.classList.contains('open'));
  }
  const c = e.target.closest('[data-cphexset]');
  if (c) return setAccentPref(c.dataset.cphexset);
  if (e.target.closest('[data-cpeye]')) {
    new window.EyeDropper().open().then((r) => { const h = parseHex(r.sRGBHex); if (h) setAccentPref(h); }).catch(() => {});
  }
});
// dragging in the field or on the hue strip: the whole app takes the colour live, it is stored when let go
document.addEventListener('pointerdown', (e) => {
  const area = e.target.closest('[data-cpdrag]');
  if (!area) return;
  e.preventDefault();
  const p = area.closest('.cpick');
  const kind = area.dataset.cpdrag;
  let raf = 0, last = null;
  const at = (ev) => {
    const r = area.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), y = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
    const [h, s, v] = p._hsv || [220, 0.7, 1];
    p._hsv = kind === 'sv' ? [h, x, 1 - y] : [x * 359.9, s, v];
    last = hsvToHex(...p._hsv);
    cpickSync(p, last);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; setAccentPref(last, false); });
  };
  area.classList.add('drag');
  try { area.setPointerCapture(e.pointerId); } catch {}
  at(e);
  const mv = (ev) => ev.pointerId === e.pointerId && at(ev);
  const up = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    area.classList.remove('drag');
    area.removeEventListener('pointermove', mv);
    area.removeEventListener('pointerup', up);
    area.removeEventListener('pointercancel', up);
    cancelAnimationFrame(raf);
    if (last) setAccentPref(last);
  };
  area.addEventListener('pointermove', mv);
  area.addEventListener('pointerup', up);
  area.addEventListener('pointercancel', up);
});
// arrow keys on the field and the strip
document.addEventListener('keydown', (e) => {
  const area = e.target.closest?.('[data-cpdrag]');
  if (!area || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const p = area.closest('.cpick');
  let [h, s, v] = p._hsv || [220, 0.7, 1];
  const st = e.shiftKey ? 0.1 : 0.02;
  if (area.dataset.cpdrag === 'hue') h = (h + (e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 1) * st * 360 + 360) % 360;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') s = Math.max(0, Math.min(1, s + (e.key === 'ArrowLeft' ? -st : st)));
  else v = Math.max(0, Math.min(1, v + (e.key === 'ArrowDown' ? -st : st)));
  p._hsv = [h, s, v];
  setAccentPref(hsvToHex(h, s, v));
});
// typing a hex colour: applied as soon as it is complete, marked red while it is not
document.addEventListener('input', (e) => {
  if (!e.target.matches?.('[data-cphex]')) return;
  const h = parseHex(e.target.value);
  e.target.classList.toggle('bad', !h && e.target.value.replace('#', '').length >= 3);
  if (h && e.target.value.replace('#', '').length !== 3) setAccentPref(h);
});
document.addEventListener('change', (e) => {
  if (!e.target.matches?.('[data-cphex]')) return;
  const h = parseHex(e.target.value);
  if (h) setAccentPref(h);
  e.target.value = (isHex(accentNow()) ? accentNow() : prefs.customAccent || '').slice(1).toUpperCase();
  e.target.classList.remove('bad');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches?.('[data-cphex]')) e.target.blur();
});
function themePicker() {
  const cur = curTheme();
  return `<div class="themesplus"><div><b>${t('themesPlus')}</b><small>${t('themesPlusHint')}</small></div>${sw('themesplus', !!prefs.themesPlus)}</div><div class="themes">${themeList().map(
    (k) => `<button type="button" class="themeopt ${k === cur ? 'on' : ''}" data-theme-pick="${k}"><span class="themeprev ${k}"><i></i><i></i><i></i><b></b></span><span class="themename">${t('theme_' + k)}</span></button>`
  ).join('')}</div>`;
}
document.addEventListener('change', (e) => {
  if (e.target.id !== 'themesplus') return;
  prefs.themesPlus = e.target.checked;
  if (!prefs.themesPlus && prefs.theme === 'green') prefs.theme = 'default';
  savePrefs();
  applyPrefs();
  document.querySelectorAll('.themes').forEach((x) => (x.parentElement.innerHTML = themePicker()));
  requestAnimationFrame(() => {
    navBlob.place(false);
    glassPanes.scan();
  });
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-pick]');
  if (!b) return;
  prefs.theme = b.dataset.themePick;
  savePrefs();
  applyPrefs();
  if (typeof player !== 'undefined' && player) applyDyn(player.current, true);
  syncAccentUi();
  document.querySelectorAll('.themeopt').forEach((x) => x.classList.toggle('on', x.dataset.themePick === prefs.theme));
  requestAnimationFrame(() => {
    navBlob.place(false);
    glassPanes.scan();
    if (prefs.theme === 'glass') glassPanes.materialize();
  });
});

// ---------- Liquid Glass: light bends at the rim of a pane ----------
// backdrop-filter with an SVG filter exists in Chromium only (Android app, Windows app, Chrome, Edge); elsewhere the glass is frosted without the bend
const LENS_OK = /Chrome\//.test(navigator.userAgent);
document.documentElement.classList.toggle('lg-lens', LENS_OK);
/** Builds (or rebuilds) the SVG filter `id` for a pane of w x h with corner radius r: a displacement map that pushes
 *  what lies under the rim towards the middle, the way thick glass does, optionally split by colour. */
function lensFilter(id, w, h, r, bezel, scale, split = 0, mag = 1) {
  const k = mag > 1 ? 1 - 1 / mag : 0; // the middle of a lens that is thicker than its rim magnifies what lies under it
  const W = Math.max(2, Math.round(w)), H = Math.max(2, Math.round(h));
  r = Math.min(r, W / 2, H / 2);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d8 = img.data;
  for (let py = 0; py < H; py++)
    for (let px = 0; px < W; px++) {
      const cx = px + 0.5 - W / 2, cy = py + 0.5 - H / 2;
      const qx = Math.abs(cx) - (W / 2 - r), qy = Math.abs(cy) - (H / 2 - r);
      let d, nx = 0, ny = 0;
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy) || 1;
        d = r - len; nx = (qx / len) * Math.sign(cx); ny = (qy / len) * Math.sign(cy);
      } else if (qx > qy) {
        d = r - qx; nx = Math.sign(cx);
      } else {
        d = r - qy; ny = Math.sign(cy);
      }
      let m = 0;
      if (d >= 0 && d < bezel) {
        const tt = 1 - d / bezel;
        m = 1 - Math.sqrt(1 - tt * tt); // convex (circular) rim: flat inside, bends hard right at the edge
        m = Math.min(1, m * 1.15);
      }
      const i = (py * W + px) * 4;
      const zx = k ? (cx * k) / scale : 0, zy = k ? (cy * k) / scale : 0;
      d8[i] = Math.max(0, Math.min(255, 128 - nx * m * 127 - zx * 255));
      d8[i + 1] = Math.max(0, Math.min(255, 128 - ny * m * 127 - zy * 255));
      d8[i + 2] = 128;
      d8[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  let svg = document.getElementById('lg-defs');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'lg-defs';
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
    document.body.appendChild(svg);
  }
  const pass = (ch, k, row) => `<feDisplacementMap in="SourceGraphic" in2="map" scale="${(scale * k).toFixed(1)}" xChannelSelector="R" yChannelSelector="G" result="d${ch}"/><feColorMatrix in="d${ch}" type="matrix" values="${row}" result="${ch}"/>`;
  const body = split
    ? pass('r', 1 + split, '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0') + pass('g', 1, '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0') + pass('b', 1 - split, '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0') + '<feBlend in="r" in2="g" mode="screen" result="rg"/><feBlend in="rg" in2="b" mode="screen"/>'
    : `<feDisplacementMap in="SourceGraphic" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>`;
  const html = `<feImage href="${cv.toDataURL()}" x="0" y="0" width="${W}" height="${H}" result="map"/>${body}`;
  let f = document.getElementById(id);
  if (!f) {
    f = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    f.id = id;
    f.setAttribute('filterUnits', 'userSpaceOnUse');
    f.setAttribute('primitiveUnits', 'userSpaceOnUse');
    f.setAttribute('color-interpolation-filters', 'sRGB');
    svg.appendChild(f);
  }
  f.setAttribute('x', '0'); f.setAttribute('y', '0'); f.setAttribute('width', W); f.setAttribute('height', H);
  f.innerHTML = html;
}
/** In the glass theme the floating panes (tab bar, player, toast, menus) get their own lens, sized to them. */
const glassPanes = (() => {
  // every floating layer is real glass: it bends what lies under its rim (Chromium: Windows app, Android, browsers)
  // [selector, key, frost blur]: bars stay almost clear so the bend at the rim is plainly visible, big sheets frost more for reading
  // bars are clear glass like Apple's tab bar: you see what lies under them, bent at the rim, only a breath of blur (Sebastian: never just blur)
  const PANES = [['.bottomnav', 'nav', 2], ['.player', 'player', 2], ['.toast', 'toast', 3], ['.menu', 'menu', 5], ['.side', 'side', 8], ['.modal', 'modal', 14], ['.profile', 'profile', 14], ['.devsheet', 'devsheet', 14]];
  const sizes = new Map();
  const seen = new WeakSet();
  let ro = null;
  const fit = (el, key, frost) => {
    if (document.documentElement.dataset.theme !== 'glass' || !LENS_OK) return void (el.style.backdropFilter = '');
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) return;
    const sig = `${w}x${h}`;
    if (sizes.get(key) !== sig) {
      sizes.set(key, sig);
      // a thick convex rim: the bezel grows with the pane, the bend is strongest right at the edge, colours split a little like real glass
      const bezel = Math.max(14, Math.min(30, Math.min(w, h) * 0.34));
      lensFilter('lg-' + key, w, h, parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, bezel, bezel * 2.8, 0.07);
    }
    el.style.backdropFilter = `url(#lg-${key}) blur(${frost}px) saturate(1.8) brightness(1.06)`;
    // a pane that just appeared materialises: its rim bends the light strongly at first and settles into clear glass
    if (!seen.has(el)) {
      seen.add(el);
      if (['modal', 'devsheet', 'profile', 'toast'].includes(key)) lensSettle('lg-' + key, 3, 640);
    }
  };
  const scan = () => {
    ro ||= new ResizeObserver(scan);
    for (const [sel, key, frost] of PANES) {
      const el = document.querySelector(sel === '.menu' ? '.menu:not(.lg-ghost)' : sel);
      if (!el) continue;
      ro.observe(el);
      fit(el, key, frost);
    }
  };
  new MutationObserver((list) => {
    if (list.some((m) => [...m.addedNodes].some((n) => ['menu', 'shell', 'modal-wrap', 'profile-wrap', 'sheet-wrap'].some((c) => n.classList?.contains(c))))) requestAnimationFrame(scan);
  }).observe(document.body, { childList: true, subtree: true });
  /** Switching to Liquid Glass: every bar materialises at once. */
  const materialize = () => requestAnimationFrame(() => ['nav', 'player', 'side', 'lens'].forEach((k) => lensSettle('lg-' + k, 3.4, 760)));
  return { scan, materialize };
})();
// the light on the glass rims turns with the pointer (PC) or with the tilt of the phone, like real glass catching a lamp
(() => {
  let raf = 0, ang = 135;
  const set = (a) => { ang = a; if (!raf) raf = requestAnimationFrame(() => { raf = 0; document.documentElement.style.setProperty('--lg-a', ang.toFixed(1) + 'deg'); }); };
  const on = () => document.documentElement.dataset.theme === 'glass';
  addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && on()) set(135 + ((e.clientX / innerWidth) - 0.5) * 70 + ((e.clientY / innerHeight) - 0.5) * 30); }, { passive: true });
  addEventListener('deviceorientation', (e) => { if (on() && e.gamma != null) set(135 + Math.max(-40, Math.min(40, e.gamma)) * 1.2 + Math.max(-30, Math.min(30, (e.beta || 45) - 45)) * 0.6); }, { passive: true });
})();
// ---------- tab bar with a glass blob that can be dragged from tab to tab ----------
const navBlob = (() => {
  let watched = null, nav = null, blob = null, x = 0, v = 0, target = 0, w = 0, raf = 0, last = 0, drag = null, hover = -1;
  const items = () => [...nav.querySelectorAll('a[data-nav]')];
  const slot = (i) => {
    const a = items()[i];
    return a ? a.offsetLeft + a.offsetWidth / 2 : 0;
  };
  const activeIndex = () => Math.max(0, items().findIndex((a) => a.classList.contains('on')));
  const draw = () => {
    // stretched in the direction of travel, flatter the faster it moves, like a drop of liquid
    const sp = Math.min(Math.abs(v) / 2600, 0.42);
    const lift = drag?.moved ? 1.14 : 1;
    blob.style.transform = `translate3d(${x - w / 2}px, -50%, 0) scale(${(1 + sp) * lift}, ${(1 - sp * 0.42) * lift})`;
  };
  const tick = (now) => {
    const dt = Math.min(0.032, (now - last) / 1000 || 0.016);
    last = now;
    const k = drag?.moved ? 420 : 260, c = drag?.moved ? 30 : 21;
    v += (-k * (x - target) - c * v) * dt;
    x += v * dt;
    draw();
    if (drag?.moved || Math.abs(v) > 4 || Math.abs(x - target) > 0.3) raf = requestAnimationFrame(tick);
    else {
      x = target; v = 0; raf = 0;
      draw();
    }
  };
  const run = () => {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  };
  const lens = () => {
    const h = blob.offsetHeight;
    if (!w || !h || !LENS_OK) return document.documentElement.classList.remove('lg-refract');
    lensFilter('lg-lens', w, h, h / 2, h * 0.3, h * 0.42, 0.03);
    // held and dragged, the drop becomes a thicker lens that magnifies the icons under it, like the original
    lensFilter('lg-lens-drag', w, h, h / 2, h * 0.3, h * 0.42, 0.02, 1.12);
    document.documentElement.classList.add('lg-refract');
  };
  const place = (animate = true) => {
    nav = document.querySelector('.bottomnav');
    blob = nav?.querySelector('.navblob');
    if (nav && nav !== watched && window.ResizeObserver) {
      watched = nav;
      new ResizeObserver(() => { if (!drag && nav.offsetWidth) { w = 0; place(false); } }).observe(nav);
    }
    if (!blob || !nav.offsetWidth) return;
    const list = items();
    const nw = list[0].offsetWidth; // the marker fills its tab, so the gap to the bar is the same on every side
    if (nw !== w) {
      w = nw;
      blob.style.width = w + 'px';
      lens();
    }
    target = slot(activeIndex());
    if (!animate || !x) {
      x = target; v = 0;
      draw();
    } else run();
  };
  const preview = (i) => {
    if (i === hover) return;
    hover = i;
    items().forEach((a, n) => a.classList.toggle('peek', n === i));
    if (i >= 0) navigator.vibrate?.(6);
  };
  document.addEventListener('pointerdown', (e) => {
    const n = e.target.closest?.('.bottomnav');
    if (!n || !n.querySelector('.navblob')) return;
    nav = n; blob = n.querySelector('.navblob');
    drag = { id: e.pointerId, x0: e.clientX, moved: false, left: n.getBoundingClientRect().left };
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.x0) < 8) return;
      drag.moved = true;
      nav.classList.add('dragging');
      try { nav.setPointerCapture(drag.id); } catch {}
    }
    const list = items();
    target = Math.max(slot(0), Math.min(slot(list.length - 1), e.clientX - drag.left));
    let best = 0;
    list.forEach((a, i) => { if (Math.abs(slot(i) - target) < Math.abs(slot(best) - target)) best = i; });
    preview(best);
    run();
  });
  const up = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.moved) return;
    nav.classList.remove('dragging');
    const list = items();
    const i = hover >= 0 ? hover : activeIndex();
    preview(-1);
    target = slot(i);
    run();
    nav.dataset.dragged = '1';
    setTimeout(() => delete nav.dataset.dragged, 300);
    if (e.type === 'pointerup' && !list[i].classList.contains('on')) location.hash = list[i].getAttribute('href');
    else place();
  };
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
  // the tap that ends a drag must not count as a tap on the tab under the finger
  document.addEventListener('click', (e) => {
    const n = e.target.closest?.('.bottomnav');
    if (n?.dataset.dragged) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  addEventListener('resize', () => { w = 0; place(false); });
  // back from the background (phone app, other tab) or a late layout: measure again so the pill is always there
  const again = () => { w = 0; cancelAnimationFrame(raf); raf = 0; x = 0; place(false); };
  document.addEventListener('visibilitychange', () => document.hidden || again());
  addEventListener('pageshow', again);
  addEventListener('focus', again);
  return { place };
})();
// Colours from the current cover: the accent when "From cover" is picked, the background tint when dynamic colours are on
let dynFor = null;
const ACCENT_VARS = ['--accent', '--accent-ink', '--accent2'];
function applyDyn(tr, force = false) {
  const root = document.documentElement;
  // Green keeps its green; it only takes the cover's colour for the player background
  const green = curTheme() === 'green';
  const wantAccent = accentNow() === 'cover';
  const clear = () => {
    root.classList.remove('dyn');
    [...ACCENT_VARS, '--dyn-bg'].forEach((k) => root.style.removeProperty(k));
    customAccent();
  };
  const id = (prefs.dynamic || wantAccent || green) && tr ? tr.id : null;
  if (id === dynFor && !force) return;
  dynFor = id;
  if (!id) return clear();
  const url = coverUrl(id);
  if (!url) return clear();
  colorFromUrl(url).then((p) => {
    if (dynFor !== id) return;
    if (!p) return clear();
    if (wantAccent) {
      root.style.setProperty('--accent', p.accent);
      root.style.setProperty('--accent2', p.accent2);
      root.style.setProperty('--accent-ink', p.ink);
    } else customAccent();
    if (prefs.dynamic || green) {
      root.style.setProperty('--dyn-bg', p.bg);
      root.classList.toggle('dyn', !!prefs.dynamic);
    } else {
      root.style.removeProperty('--dyn-bg');
      root.classList.remove('dyn');
    }
    paintBars?.();
  });
}
applyPrefs();

/* Android: the strip behind the status bar takes the colour of what is at the top of the page right now
   (big player, a tinted album or artist header, or the plain background), nothing moves. */
const paintBars = (() => {
  if (!window.MusikAndroid?.setBars) return () => {};
  const probe = document.createElement('i');
  probe.style.cssText = 'position:fixed;width:0;height:0;visibility:hidden;pointer-events:none';
  const hex = (css) => {
    if (!probe.isConnected) document.body.appendChild(probe);
    probe.style.backgroundColor = '';
    probe.style.backgroundColor = css;
    const v = getComputedStyle(probe).backgroundColor;
    const m = v.match(/[\d.]+/g);
    if (!m) return null;
    let [r, g, b] = m.map(Number);
    if (/color\(srgb/.test(v)) [r, g, b] = [r, g, b].map((x) => x * 255);
    return '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
  };
  let last = '', lastB = '', raf = 0;
  const now = () => {
    raf = 0;
    const root = getComputedStyle(document.documentElement);
    const bg = root.getPropertyValue('--bg').trim() || '#111214';
    let c = bg;
    const fs = document.getElementById('fs');
    if (fs?.classList.contains('open')) {
      const full = document.querySelector('.fs-queue.full');
      if (full) c = getComputedStyle(full).backgroundColor !== 'rgba(0, 0, 0, 0)' ? getComputedStyle(full).backgroundColor : bg;
      else if (document.documentElement.classList.contains('dyn') || curTheme() === 'green') c = root.getPropertyValue('--dyn-bg').trim() || bg;
    } else {
      const head = document.querySelector('#view .detail-head.tinted');
      const sc = document.getElementById('content')?.scrollTop || 0;
      const tint = head && getComputedStyle(head).getPropertyValue('--tint').trim();
      if (tint && head.getBoundingClientRect().top > -200) c = `color-mix(in srgb, ${tint} ${Math.max(0, 100 - sc / 3).toFixed(0)}%, ${bg})`;
    }
    // the navigation bar at the bottom takes the colour of the bottom of the page (plain background, or the open sheet)
    let cb = bg;
    const fullSheet = fs?.classList.contains('open') && document.querySelector('.fs-queue.full');
    if (fullSheet && getComputedStyle(fullSheet).backgroundColor !== 'rgba(0, 0, 0, 0)') cb = getComputedStyle(fullSheet).backgroundColor;
    const h = hex(c) || hex(bg);
    const hb = hex(cb) || hex(bg);
    if (h && h !== last) { last = h; window.MusikAndroid.setBars(h); }
    if (hb && hb !== lastB && window.MusikAndroid.setNavBar) { lastB = hb; window.MusikAndroid.setNavBar(hb); }
  };
  const later = () => { if (!raf) raf = requestAnimationFrame(now); };
  document.addEventListener('scroll', later, { capture: true, passive: true });
  new MutationObserver(later).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-mode', 'data-oled'] });
  return later;
})();

let player = null;
let viz = null;
let miniViz = null;
// visualizer tuning from the settings: sensitivity, lows / mids / highs, accent or rainbow colours
function applyVizTune() {
  Object.assign(vizTune, {
    sens: Number(prefs.vizSens ?? 1),
    bass: Number(prefs.vizBass ?? 1),
    mid: Number(prefs.vizMid ?? 1),
    high: Number(prefs.vizHigh ?? 1),
    color: ['rainbow', 'flow'].includes(prefs.vizColor) ? prefs.vizColor : 'accent',
    speed: Number(prefs.vizSpeed ?? 1),
    delay: Number(prefs.vizDelay || 0)
  });
}
applyVizTune();
/** Platform logos (Spotify, YouTube ...) next to songs and lists can be switched off in the settings. */
function applyLogos() {
  document.documentElement.classList.toggle('nologos', prefs.logos === false);
}
applyLogos();
let sameOrigin = null;
// ---------- offline: the apps run a small server on the device that keeps copies of playlists ----------
let offlineMode = false; // this page comes from that server on the device
const OFFCB = {};
let offN = 0;
const offline = {
  ok: () => !!(window.MusikAndroid?.offlineCall || window.musikDesktop?.offlineCall),
  call(method, path, body) {
    const A = window.MusikAndroid;
    const b = body === undefined ? '' : JSON.stringify(body);
    if (A?.offlineCall)
      return new Promise((res) => setTimeout(() => {
        let r = null;
        try { r = JSON.parse(A.offlineCall(method, path, b) || 'null'); } catch {}
        res(r);
      }, 0));
    return new Promise((res) => {
      const id = ++offN;
      OFFCB[id] = res;
      window.musikDesktop.offlineCall(method, path, b, id);
      setTimeout(() => OFFCB[id] && (delete OFFCB[id], res(null)), 20000);
    });
  },
  status: () => offline.call('GET', '/api/offline/status').then((r) => r?.sets || []),
  add: (key, name, tracks) =>
    offline.call('POST', '/api/offline/add', {
      server: conn.server,
      token: conn.token,
      id: Number(String(key).replace(/^pl/, '')) || 0,
      key,
      name,
      user: conn.user?.name || '',
      // every song of the list: own files by id, streaming songs by name (the server finds them on YouTube)
      items: tracks.filter((x) => x && !x._off).map((x) => (x.ext ? { ext: true, title: x.title, artist: x.artist || '', album: x.album || '', duration: x.duration || 0, cover: extCovers.get(x.id) || '' } : { id: x.id, title: x.title, artist: x.artist || '', has_cover: x.has_cover !== false }))
    }),
  remove: (key) => offline.call('POST', '/api/offline/remove', { key })
};
window.__musikOff = (id, txt) => {
  const f = OFFCB[id];
  delete OFFCB[id];
  let r = null;
  try { r = JSON.parse(txt); } catch {}
  f?.(r);
};
const goOnline = () => (window.MusikAndroid?.goOnline ? window.MusikAndroid.goOnline() : window.musikDesktop?.goOnline?.());
let state = { route: '', cache: {} };

// ---------- helpers ----------
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
// every artist name leads straight to that artist's page
const findArtistHref = (name, src = '') => `#/findartist?name=${encodeURIComponent(name)}${src ? '&src=' + encodeURIComponent(src) : ''}`;
function artistRefs(tr) {
  if (!tr) return [];
  if (!tr.ext) {
    const n = tr.artist || tr.album_artist;
    return n ? [{ name: n, href: `#/artist?name=${encodeURIComponent(n)}` }] : [];
  }
  const src = tr.ext.source;
  if (tr.artists?.length) return tr.artists.map((a) => ({ name: a.name, href: src === 'spotify' && a.id ? `#/spartist?id=${encodeURIComponent(a.id)}` : findArtistHref(a.name, src) }));
  return String(tr.artist || '').replace(/\s*[-–]\s*Topic\b/gi, '').split(/,\s+/).map((n) => n.trim()).filter(Boolean).map((n) => ({ name: n, href: findArtistHref(n, src) }));
}
function artistLinks(tr) {
  const refs = artistRefs(tr);
  return refs.length ? refs.map((a) => `<a class="alink" href="${a.href}">${esc(a.name)}</a>`).join(', ') : esc(artistName(tr));
}
function artistText(tr) {
  const refs = artistRefs(tr);
  return refs.length ? refs.map((a) => esc(a.name)).join(', ') : esc(artistName(tr));
}
function albumLink(tr) {
  if (!tr.album) return '';
  const href = !tr.ext ? albumHref(tr.album, tr.album_artist || tr.artist) : tr.ext.source === 'spotify' && tr.album_id ? `#/spalbum?id=${encodeURIComponent(tr.album_id)}` : '';
  return href ? `<a class="alink" href="${href}">${esc(tr.album)}</a>` : esc(tr.album);
}
function artistName(tr) {
  return String(tr.artist || tr.album_artist || '').replace(/\s*[-–]\s*Topic\b/gi, '').trim() || t('unknownArtist');
}
/** The sharpest version a platform offers of a cover, for the places where it is shown large. */
function sharpCover(u) {
  if (!u) return u;
  if (/dzcdn\.net|deezer/.test(u)) return u.replace(/\/\d+x\d+-/, '/1000x1000-');
  if (/i\.scdn\.co\/image\//.test(u)) return u.replace(/ab67616d0000(1e02|4851)/, 'ab67616d0000b273').replace(/ab676161000(05174|0f178)/, 'ab6761610000e5eb').replace(/ab67706c0000(da84|d72c)/, 'ab67706c0000bebb');
  if (/i\.ytimg\.com\/vi\//.test(u)) return u.replace(/\/(mq|hq|sd)?default\.jpg/, '/maxresdefault.jpg');
  if (/googleusercontent\.com|ggpht\.com/.test(u)) return u.replace(/=w\d+-h\d+[^?]*/, '=w1000-h1000-l90-rj').replace(/=s\d+[^?]*/, '=s1000');
  return u;
}
function coverImg(id, cls = '') {
  if (typeof id === 'string' && genCovers.has(id)) return genCoverHtml(id, cls);
  if (!id) return `<div class="cover ${cls} ph">${icon('note')}</div>`;
  const ph = `this.parentNode.classList.add('ph');this.parentNode.innerHTML='${icon('note').replace(/"/g, '&quot;')}'`;
  const url = coverUrl(id);
  const sharp = /\b(huge|xl)\b/.test(cls) ? sharpCover(url) : url;
  // the sharp one may be missing (YouTube has no large picture for every video): fall back to the normal one first
  const onerr = sharp !== url ? `if(!this.dataset.fb){this.dataset.fb=1;this.src='${esc(url)}'}else{${ph}}` : ph;
  // YouTube answers a missing large picture with a grey 120px placeholder instead of an error
  const onload = sharp !== url && /ytimg/.test(url) ? ` onload="if(this.naturalWidth<=120&&!this.dataset.fb){this.dataset.fb=1;this.src='${esc(url)}'}"` : '';
  return `<div class="cover ${cls}"><img loading="lazy" alt="" src="${esc(sharp)}"${onload} onerror="${onerr}"></div>`;
}
function songCount(n) {
  return n === 1 ? t('song') : t('songs', { n });
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function errorText(e) {
  if (e instanceof ApiError) {
    if (e.code === 'offline') return t('serverUnreachable');
    const k = t(e.code);
    return k === e.code ? t('error') : k;
  }
  const m = e?.message && t(e.message);
  return m && m !== e.message ? m : t('error');
}

// Simple modal dialog. fields: [{name, label, type, value}]
function dialog({ title, text = '', fields = [], ok = t('save'), danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<form class="modal" novalidate>
      <h3>${esc(title)}</h3>${text ? `<p class="muted">${esc(text)}</p>` : ''}
      ${fields
        .map((f) =>
          f.type === 'checkbox'
            ? `<label class="check"><input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''}><span>${esc(f.label)}</span></label>`
            : `<label class="field"><span>${esc(f.label)}</span><input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value || '')}" autocomplete="off"></label>`
        )
        .join('')}
      <div class="modal-actions"><button type="button" class="btn ghost" data-x>${t('cancel')}</button><button class="btn ${danger ? 'danger' : 'primary'}">${esc(ok)}</button></div>
    </form>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form');
    const close = (v) => {
      wrap.remove();
      resolve(v);
    };
    wrap.addEventListener('mousedown', (e) => e.target === wrap && close(null));
    wrap.querySelector('[data-x]').onclick = () => close(null);
    form.onsubmit = (e) => {
      e.preventDefault();
      const out = {};
      for (const f of fields) out[f.name] = f.type === 'checkbox' ? form.elements[f.name].checked : form.elements[f.name].value;
      close(out);
    };
    setTimeout(() => (form.querySelector('input') || form.querySelector('.btn.primary,.btn.danger'))?.focus(), 30);
  });
}

// ---------- context menu ----------
let menuClosed = { el: null, at: 0 };
function menu(anchor, items) {
  // a second press on the button of an open menu just closes it
  const el = anchor instanceof Element ? anchor : null;
  if (el && menuClosed.el === el && Date.now() - menuClosed.at < 500) return (menuClosed = { el: null, at: 0 });
  closeMenu();
  const m = document.createElement('div');
  m._anchor = el;
  m.className = 'menu';
  // no separator at the start, the end or twice in a row
  items = items.filter(Boolean).filter((it, i, a) => it !== '-' || (i > 0 && i < a.length - 1 && a[i - 1] !== '-'));
  m.innerHTML = items
    .map((it, i) => (it === '-' ? '<hr>' : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span></button>`))
    .join('');
  document.body.appendChild(m);
  const list = items.filter(Boolean);
  m.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    closeMenu();
    Promise.resolve(list[Number(b.dataset.i)]?.run?.()).catch((err) => toast(errorText(err)));
  });
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  // at the pointer for right click and long press, under the button otherwise
  const atPoint = anchor.clientX != null;
  let x = atPoint ? Math.min(anchor.clientX, innerWidth - mw - 8) : Math.min(r.right - mw, innerWidth - mw - 8);
  let y = atPoint ? anchor.clientY : r.bottom + 4;
  if (y + mh > innerHeight - 8) y = Math.max(8, (atPoint ? anchor.clientY : r.top) - mh - 4);
  m.style.left = Math.max(8, x) + 'px';
  m.style.top = y + 'px';
  m._from = anchor;
  morphIn(m, anchor);
  setTimeout(() => addEventListener('mousedown', outside), 0);
  function outside(e) {
    if (m.contains(e.target)) return;
    if (m._anchor && m._anchor.contains(e.target)) menuClosed = { el: m._anchor, at: Date.now() };
    closeMenu();
  }
  m._outside = outside;
}
function closeMenu() {
  const m = $('.menu:not(.lg-ghost)');
  if (m) {
    removeEventListener('mousedown', m._outside);
    // Liquid Glass: the menu melts back into its button, the rest of the app already sees it closed
    m.classList.add('lg-ghost');
    morphOut(m, m._from instanceof Element && m._from.isConnected ? m._from : null).then(() => m.remove());
  }
}

// a song as an entry of an imported playlist (works for own files and songs from other platforms)
function itemOf(tr) {
  if (tr.ext) return { source: tr.ext.source, ext_id: String(tr.ext.id || ''), title: tr.title, artist: artistName(tr), album: tr.album || '', duration: tr.duration || 0, cover: extCovers.get(tr.id) || '', url: tr.ext.url || '' };
  return { source: 'files', ext_id: '', title: tr.title, artist: tr.artist || '', album: tr.album || '', duration: tr.duration || 0, cover: '', url: '' };
}
/** "Add to playlist": every own playlist and imported playlist, newest order like the sidebar, plus a new one. */
async function pickPlaylist(tracks) {
  tracks = tracks.filter((x) => x && !x._off);
  const [lists, imps] = await Promise.all([get('/api/playlists').catch(() => []), get('/api/imports').catch(() => [])]);
  const local = tracks.every((x) => !x.ext && typeof x.id === 'number');
  const done = (name) => {
    toast(t('addedTo', { name }));
    state.cache.playlists = null;
    renderSidebarPlaylists();
  };
  const all = [
    // own playlists hold songs from this server; songs from other platforms go into the imported ones
    ...(local ? lists.filter((p) => p.canEdit !== false) : []).map((p) => ['playlist:' + p.id, {
      label: p.name,
      icon: 'queue',
      run: async () => {
        await post(`/api/playlists/${p.id}/tracks`, { trackIds: tracks.map((x) => x.id) });
        done(p.name);
      }
    }]),
    ...imps.map((im) => ['import:' + im.id, {
      label: im.name,
      icon: 'queue',
      run: async () => {
        await post(`/api/imports/${im.id}/items`, { items: tracks.map(itemOf) });
        done(im.name);
      }
    }])
  ];
  const items = [];
  if (tracks.length === 1 && !tracks[0]._off) {
    const tr = tracks[0];
    items.push({ label: isLiked(tr) ? t('unlike') : t('likes'), icon: isLiked(tr) ? 'heartFill' : 'heart', run: () => toggleLike(tr) }, '-');
  }
  items.push(...byPlOrder(all, (x) => x[0]).map((x) => x[1]));
  if (all.length) items.push('-');
  items.push({
    label: t('newPlaylist'),
    icon: 'plus',
    run: async () => {
      const r = await dialog({ title: t('newPlaylist'), fields: [{ name: 'name', label: t('playlistName') }], ok: t('create') });
      const name = r?.name?.trim();
      if (!name) return;
      if (local) await post('/api/playlists', { name, trackIds: tracks.map((x) => x.id) });
      else {
        const im = await post('/api/imports', { source: tracks.find((x) => x.ext)?.ext.source || 'files', name, items: tracks.map(itemOf) });
        await post(`/api/imports/${im.id}/playlist`, {});
      }
      done(name);
    }
  });
  return items;
}

function trackMenu(anchor, tr, ctx = {}) {
  const items = [
    { label: t('playNext'), icon: 'next', run: () => (player.playNext([tr]), toast(t('playsNext'))) },
    !tr._off && { label: isLiked(tr) ? t('unlike') : t('like'), icon: isLiked(tr) ? 'heartFill' : 'heart', run: () => toggleLike(tr) },
    { label: t('addQueue'), icon: 'queue', run: () => (player.add([tr]), toast(t('addedQueue'))) },
    {
      label: t('addPlaylist'),
      icon: 'plus',
      run: async () => menu(anchor, await pickPlaylist([tr]))
    },
    !tr.ext && { label: t('startRadio'), icon: 'radio', run: () => startRadio(tr) },
    !tr.ext && { label: t('share'), icon: 'share', run: () => shareThing('track', tr.id, tr.title) },
    tr.ext?.url && { label: t('openOn', { src: t('src_' + tr.ext.source) }), icon: 'link', run: () => openExt(tr.ext.url) },
    '-',
    ...artistRefs(tr).slice(0, 4).map((a, i, l) => ({ label: l.length > 1 ? `${t('goArtist')}: ${a.name}` : t('goArtist'), icon: 'user', run: () => go(a.href) })),
    tr.album && !tr.ext && {
      label: t('goAlbum'),
      icon: 'album',
      run: () => go(`#/album?album=${encodeURIComponent(tr.album)}&artist=${encodeURIComponent(tr.album_artist || tr.artist)}`)
    },
    tr.album && tr.album_id && tr.ext?.source === 'spotify' && { label: t('goAlbum'), icon: 'album', run: () => go(`#/spalbum?id=${encodeURIComponent(tr.album_id)}`) },
    ctx.queueIndex != null && { label: t('removeQueue'), icon: 'close', run: () => player.removeAt(ctx.queueIndex) },
    !tr._off && { label: tasteExcluded(tr) ? t('tasteInclude') : t('tasteExclude'), icon: 'eyeOff', run: () => setTasteExcluded(tr, !tasteExcluded(tr)) },
    !tr.ext && !tr._off && Number.isInteger(Number(tr.id)) && conn.user?.admin && {
      label: t('deleteSong'),
      icon: 'trash',
      danger: true,
      run: async () => {
        // only files on your own server, and only after a second yes
        if (!(await dialog({ title: t('deleteSongQ', { name: tr.title }), text: t('deleteSongText'), ok: t('delete'), danger: true }))) return;
        try {
          await api('DELETE', '/api/tracks/' + tr.id);
          toast(t('deletedSong', { name: tr.title }));
          render();
        } catch (err) {
          toast(errorText(err));
        }
      }
    },
    ctx.playlistId && {
      label: t('removePlaylist'),
      icon: 'close',
      run: async () => {
        const pl = await get(`/api/playlists/${ctx.playlistId}`);
        const ids = pl.tracks.map((x) => x.id);
        ids.splice(ctx.position, 1);
        await put(`/api/playlists/${ctx.playlistId}`, { trackIds: ids });
        render();
      }
    }
  ];
  menu(anchor, items);
}

// ---------- taste profile: songs left out of it (like Spotify's "exclude from your taste profile") ----------
const tasteKey = (tr) => norm(`${artistName(tr).split(',')[0]}|${tr.title}`);
const tasteList = () => (Array.isArray(settings.tasteExclude) ? settings.tasteExclude : []);
const tasteExcluded = (tr) => tasteList().some((x) => (x.id != null && !tr.ext && x.id === tr.id) || x.key === tasteKey(tr));
async function setTasteExcluded(tr, on) {
  const key = tasteKey(tr);
  const rest = tasteList().filter((x) => x.key !== key && !(x.id != null && !tr.ext && x.id === tr.id));
  const list = on ? [{ id: tr.ext ? null : tr.id, key, title: tr.title, artist: artistName(tr) }, ...rest].slice(0, 500) : rest;
  try {
    await saveSettings({ tasteExclude: list });
    toast(on ? t('tasteExcluded') : t('tasteIncluded'));
    dropHome();
  } catch (err) {
    toast(errorText(err));
  }
  const box = $('#tastelist');
  if (box) box.innerHTML = tasteListHtml();
}
const tasteListHtml = () => {
  const l = tasteList();
  return l.length
    ? l.map((x) => `<div class="tl-row"><div><b>${esc(x.title)}</b><small>${esc(x.artist || '')}</small></div><button class="btn small" data-tasteinc="${esc(x.key)}">${t('tasteInclude')}</button></div>`).join('')
    : `<p class="muted small">${t('tasteNone')}</p>`;
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tasteinc]');
  if (!b) return;
  const x = tasteList().find((y) => y.key === b.dataset.tasteinc);
  if (x) setTasteExcluded({ id: x.id, ext: x.id == null ? {} : null, title: x.title, artist: x.artist }, false);
});
// ---------- Discord: "Listening to Streyn" with the song and a button to the download page (desktop app) ----------
let discordT = 0, discordLast = '';
function discordSync() {
  clearTimeout(discordT);
  discordT = setTimeout(() => {
    const D = window.musikDesktop;
    if (!D?.discord) return;
    const client = String(prefs.discordId || '').trim();
    const tr = player?.current;
    let msg;
    if (!prefs.discord || !client || !tr || !player.playing) msg = { client, clear: true };
    else {
      const cover = tr.ext ? extCovers.get(tr.id) || '' : '';
      const dur = player.duration || tr.duration || 0;
      const start = Date.now() - Math.round((player.position || 0) * 1000);
      msg = { client, title: tr.title, artist: artistName(tr), album: tr.album || 'Streyn', cover: /^https:\/\//.test(cover) ? cover : '', start, end: dur ? start + Math.round(dur * 1000) : undefined, url: 'https://musik.labtoso.de', label: t('discordBtn') };
    }
    const key = JSON.stringify({ ...msg, start: msg.start && Math.round(msg.start / 3000), end: undefined });
    if (key === discordLast) return;
    discordLast = key;
    D.discord(JSON.stringify(msg));
  }, 800);
}
document.addEventListener('change', (e) => {
  if (e.target.id !== 'discordid') return;
  prefs.discordId = e.target.value.replace(/\D/g, '');
  e.target.value = prefs.discordId;
  savePrefs();
  discordLast = '';
  discordSync();
});
function saveTaste() {
  if (conn.token) saveSettings({ mixStream: Number(prefs.mixStream ?? 0.3) }).catch(() => {});
}
async function startRadio(tr) {
  try {
    const list = await get(`/api/recommend/radio/${tr.id}?limit=40`);
    player.playList([tr, ...list], 0);
    toast(t('radioStarted'));
  } catch (e) {
    toast(errorText(e));
  }
}

// songs from Spotify, Deezer and YouTube can be liked too: kept on the server with their names and cover
const extLikes = new Map();
async function loadExtLikes() {
  const list = await get('/api/extlikes').catch(() => null);
  if (!list) return;
  extLikes.clear();
  for (const x of list) if (x?.id) extLikes.set(x.id, x);
}
const isLiked = (tr) => !!tr && (tr.ext ? extLikes.has(tr.id) : !!tr.liked);
async function toggleLike(tr) {
  if (!tr || tr._off) return;
  const liked = !isLiked(tr);
  try {
    if (tr.ext) {
      if (liked) {
        const data = { id: tr.id, title: tr.title, artist: tr.artist || '', album: tr.album || '', duration: tr.duration || 0, cover: extCovers.get(tr.id) || '', ext: tr.ext };
        await put('/api/extlikes', { key: tr.id, data });
        extLikes.set(tr.id, data);
      } else {
        await del('/api/extlikes?key=' + encodeURIComponent(tr.id));
        extLikes.delete(tr.id);
      }
    } else {
      if (liked) await put(`/api/likes/${tr.id}`);
      else await del(`/api/likes/${tr.id}`);
    }
    tr.liked = liked;
    player.patch(tr.id, { liked });
    document.querySelectorAll(`[data-like="${CSS.escape(String(tr.id))}"]`).forEach((b) => {
      b.classList.toggle('on', liked);
      b.innerHTML = icon(liked ? 'heartFill' : 'heart');
      b.title = liked ? t('unlike') : t('like');
    });
    // Liked songs follow at once: an unliked song slides out, a liked one appears, no reload needed
    if (state.route === 'likes') {
      const rows = [...document.querySelectorAll(`#view .tracks .row[data-id="${CSS.escape(String(tr.id))}"]`)];
      if (!liked && rows.length) {
        rows.forEach((r) => r.classList.add('gone'));
        setTimeout(() => {
          for (const r of rows) {
            const box = r.closest('.tracks');
            const list = box && state.lists?.[box.dataset.list];
            if (list) list.splice(Number(r.dataset.i), 1);
            r.remove();
            box?.querySelectorAll('.row').forEach((x, i) => (x.dataset.i = i));
          }
          if (state.detail?.likes) state.detail.likes = state.detail.likes.filter((x) => String(x.id) !== String(tr.id));
          const sub = document.querySelector('#view .detail-head .dh-text > .muted:not(.kind)');
          if (sub && state.detail?.likes) sub.textContent = songCount(state.detail.likes.length);
        }, 240);
      } else if (liked) render();
    }
  } catch (e) {
    toast(errorText(e));
  }
}

// ---------- track list ----------
/** Columns in song lists, picked in Settings → Look. */
const COLS = ['cover', 'artist', 'album', 'source', 'duration', 'year', 'genre', 'added'];
const COLS_DEFAULT = ['cover', 'artist', 'album', 'source', 'duration'];
function cols() {
  const c = Array.isArray(prefs.cols) ? prefs.cols.filter((x) => COLS.includes(x)) : COLS_DEFAULT;
  return new Set(c);
}
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms > 1e11 ? ms : ms * 1000);
  return d.toLocaleDateString(getLang() === 'de' ? 'de-DE' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function trackList(tracks, { numbers = false, album = true, reasons = false, playlistId = null, reorder = false } = {}) {
  if (!tracks.length) return `<p class="muted empty">${t('empty')}</p>`;
  const id = 'tl' + Math.random().toString(36).slice(2, 8);
  state.lists = state.lists || {};
  state.lists[id] = tracks;
  const cur = player.current?.id;
  const c = cols();
  const showAlb = album && c.has('album');
  const extra = ['year', 'genre', 'added'].filter((k) => c.has(k));
  // grid: lead, title, [album], [extras], side, [duration], more
  const w = { year: '52px', genre: 'minmax(0, 1fr)', added: '104px' };
  const full = ['40px', 'minmax(0, 3fr)', showAlb && 'minmax(0, 2fr)', ...extra.map((k) => w[k]), '72px', c.has('duration') && '52px', '36px'].filter(Boolean).join(' ');
  const mid = ['40px', 'minmax(0, 1fr)', '72px', c.has('duration') && '52px', '36px'].filter(Boolean).join(' ');
  // Green on the desktop: Spotify's table, with a number column and a header line
  const gt = gOn();
  const nolead = numbers || !c.has('cover');
  const gcols = ['16px', !nolead && '40px', 'minmax(0, 6fr)', showAlb && 'minmax(0, 4fr)', ...extra.map(() => 'minmax(0, 3fr)'), '32px', c.has('duration') && '48px', '32px'].filter(Boolean).join(' ');
  const head = gt ? `<div class="row thead" aria-hidden="true"><span class="gix">#</span><div class="lead"></div><div class="main">${t('gTitle')}</div>${showAlb ? `<div class="alb">${t('col_album')}</div>` : ''}${extra.map((k) => `<div class="alb xcol">${t('col_' + k)}</div>`).join('')}<div class="acts"></div>${c.has('duration') ? `<div class="dur">${icon('clock')}</div>` : ''}<span></span></div>` : '';
  return `<div class="tracks ${c.has('cover') ? '' : 'nocover'}${gt ? ' gtable' + (nolead ? ' nolead' : '') : ''}" style="--cols:${full};--cols-mid:${mid};--gcols:${gcols}" data-list="${id}" ${playlistId ? `data-playlist="${playlistId}"` : ''} ${reorder ? 'data-reorder' : ''}>${head}${tracks
    .map((tr, i) => {
      const reason = reasons && tr.reason ? `<span class="reason">${esc(t('reason_' + tr.reason, { artist: artistName(tr) }))}</span>` : '';
      const src = tr.ext?.source || tr._src;
      const side = tr._off || (tr.ext && !extLikes.has(tr.id))
        ? `<span class="like-slot">${c.has('source') ? srcBadge(src) : ''}</span>`
        : tr.ext
        ? `<button class="icon-btn like on" data-like="${esc(String(tr.id))}" title="${t('unlike')}">${icon('heartFill')}</button>`
        : `<button class="icon-btn like ${tr.liked ? 'on' : ''}" data-like="${tr.id}" title="${tr.liked ? t('unlike') : t('like')}">${icon(tr.liked ? 'heartFill' : 'heart')}</button>`;
      const add = tr._off ? '' : `<button class="icon-btn addpl" title="${t('addPlaylist')}">${icon('plusCircle')}</button>`;
      const lead = numbers || !c.has('cover') ? `<span class="num">${(numbers && tr.track_no) || i + 1}</span>` : coverImg(tr.id, 'sm');
      // in lists the artist is only text (tapping the row plays it); the big player and the PC mini player link to the artist
      const sub = [c.has('artist') ? artistText(tr) : '', reason].filter(Boolean).join(' · ');
      const xc = { year: tr.year || '', genre: esc(tr.genre || ''), added: tr.added ? fmtDate(tr.added) : '' };
      return `<div class="row ${tr.id === cur ? 'current' : ''} ${tr._off ? 'off' : ''}" data-i="${i}" data-id="${esc(String(tr.id))}" ${reorder ? 'draggable="true"' : ''}>
        ${gt ? `<span class="gix"><b>${(numbers && tr.track_no) || i + 1}</b><span class="eqi" aria-hidden="true"><i></i><i></i><i></i><i></i></span><button class="playbtn" title="${t('play')}">${icon('play')}</button></span>` : ''}<div class="lead">${lead}<span class="eqi" aria-hidden="true"><i></i><i></i><i></i><i></i></span><button class="playbtn" title="${t('play')}">${icon('play')}</button></div>
        <div class="main"><div class="title">${esc(tr.title)}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
        ${showAlb ? `<div class="alb">${albumLink(tr)}</div>` : ''}
        ${extra.map((k) => `<div class="alb xcol">${xc[k]}</div>`).join('')}
        <div class="acts">${add}${side}</div>
        ${c.has('duration') ? `<div class="dur">${fmtTime(tr.duration)}</div>` : ''}
        <button class="icon-btn more" title="…">${icon('more')}</button>
      </div>`;
    })
    .join('')}</div>`;
}

document.addEventListener('click', (e) => {
  const row = e.target.closest('.tracks .row');
  if (!row || row.classList.contains('thead') || e.target.closest('a.alink')) return;
  const listEl = row.closest('.tracks');
  const tracks = state.lists?.[listEl.dataset.list];
  if (!tracks) return;
  const i = Number(row.dataset.i);
  const tr = tracks[i];
  if (tr._off) return toast(t('notAvailable', { src: t('src_' + tr._src) }));
  if (e.target.closest('.like')) return toggleLike(tr);
  if (e.target.closest('.addpl')) {
    const b = e.target.closest('.addpl');
    return pickPlaylist([tr]).then((items) => menu(b, items));
  }
  if (e.target.closest('.more')) {
    const qi = listEl.dataset.queue ? Number(row.dataset.q) : null;
    return trackMenu(e.target.closest('.more'), tr, {
      queueIndex: qi,
      playlistId: listEl.dataset.playlist ? Number(listEl.dataset.playlist) : null,
      position: i
    });
  }
  if (listEl.dataset.queue) return player.jump(Number(row.dataset.q));
  const isTouch = matchMedia('(hover: none)').matches;
  if (e.target.closest('.playbtn') || isTouch || e.detail >= 2) {
    const ok = tracks.filter((x) => !x._off);
    player.playList(ok, ok.indexOf(tr));
    gCtx = { queue: player.queue, name: listEl.closest('#view') ? $('#view .detail-head h1')?.textContent || '' : '' };
  }
});

const SRC_SHORT = { youtube: 'YT', ytmusic: 'YTM', spotify: 'SP', soundcloud: 'SC', deezer: 'DZ', files: 'TXT', local: 'LOK' };
function srcBadge(src) {
  const d = LOGOS[src];
  if (d) return `<span class="src logo src-${esc(src)}" title="${esc(t('src_' + src))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg></span>`;
  return `<span class="src logo src-${esc(src || '')}" title="${esc(t('src_' + src))}">${icon(src === 'files' ? 'download' : 'note')}</span>`;
}

// ---------- share ----------
async function shareThing(kind, ref, title) {
  try {
    const r = await post('/api/shares', { kind, ref: typeof ref === 'object' ? JSON.stringify(ref) : String(ref) });
    // a public link (musik.labtoso.de) when the server has one, otherwise the home address
    const url = r.url || (conn.server || location.origin) + r.path;
    if (window.MusikAndroid?.share) return window.MusikAndroid.share(title, url);
    if (navigator.share) {
      try {
        return await navigator.share({ title, text: t('shareText', { title }), url });
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    if (await copyText(url)) toast(t(r.url ? 'linkCopiedPublic' : 'linkHomeOnly'));
    else {
      dialog({ title: t('share'), fields: [{ name: 'url', label: 'Link', value: url }], ok: 'OK' });
    }
  } catch (e) {
    toast(errorText(e));
  }
}
/** Copy text everywhere: the clipboard API only exists on https, so the apps and plain http need other ways. */
async function copyText(text) {
  try {
    if (window.MusikAndroid?.copy) {
      window.MusikAndroid.copy(text);
      return true;
    }
  } catch {}
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  ta.remove();
  return ok;
}
function shareBtn(kind, ref, title) {
  return `<button class="btn" data-share="${esc(JSON.stringify({ kind, ref, title }))}" title="${t('share')}">${icon('share')}${t('share')}</button>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-share]');
  if (!b) return;
  const d = JSON.parse(b.dataset.share);
  shareThing(d.kind, d.ref, d.title);
});

// ---------- views ----------
const views = {};

// ---------- desktop title bar (the window has no system frame, like Spotify) ----------
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !e.target.closest('[data-drag]') || e.target.closest('button, a, input')) return;
  if (e.detail === 2) return window.musikDesktop?.win?.('max');
  window.musikDesktop?.win?.('drag');
});
document.addEventListener('click', (e) => {
  const w = e.target.closest('[data-win]');
  if (w) return window.musikDesktop?.win?.(w.dataset.win);
  const h = e.target.closest('[data-hist]');
  if (h) return history.go(Number(h.dataset.hist));
});
// desktop title bar: type right there, like Spotify; the search page follows without taking the focus
document.addEventListener('input', (e) => {
  if (e.target.id !== 'tbq') return;
  const v = e.target.value;
  const feed = () => {
    const q = $('#q');
    if (!q) return false;
    q.value = v;
    q.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  if (state.route === 'search' && feed()) return;
  go('#/search?q=' + encodeURIComponent(v));
  let n = 0;
  const wait = setInterval(() => (feed() || ++n > 40) && clearInterval(wait), 50);
});
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'tbq' && e.key === 'Enter') $('#q')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
});

// ---------- profile panel (tap the picture) ----------
/** The own picture, or the first letter of the name when there is none. */
function avatarInner() {
  const u = conn.user || {};
  return u.avatar ? `<img alt="" src="${esc(conn.server)}/api/art/user/${u.id}?t=${conn.token}&v=${u.avatar}">` : esc((u.name || '?').trim().charAt(0).toUpperCase() || '?');
}
function paintAvatars() {
  document.querySelectorAll('[data-profile], .pf-head .avatar').forEach((el) => (el.innerHTML = avatarInner()));
}
/** Change the own name and picture. The name is also the one for signing in. */
function profileDialog() {
  return new Promise((res) => {
    let blob = null, removeArt = false, preview = '';
    const u = conn.user || {};
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<form class="modal pld pfd" novalidate><div class="modal-head"><h2>${t('editProfile')}</h2><button type="button" class="icon-btn" data-x>${icon('close')}</button></div>
      <div class="pld-grid">
        <button type="button" class="pld-cover round" data-up title="${t('uploadPicture')}"><span class="pfd-pic">${avatarInner()}</span><span class="pld-over">${icon('image')}${t('uploadPicture')}</span></button>
        <div class="pld-fields">
          <label class="field"><span>${t('name')}</span><input name="name" maxlength="32" value="${esc(u.name || '')}" autocomplete="off"></label>
          <p class="muted small">${t('profileNameHint')}</p>
          <label class="field"><span>${t('bio')}</span><textarea name="bio" maxlength="160" rows="3" placeholder="${t('bioHint')}">${esc(settings.bio || '')}</textarea></label>
        </div>
      </div>
      <div class="pld-art"><button type="button" class="btn" data-up>${icon('image')}${t('uploadPicture')}</button><button type="button" class="btn ghost ${u.avatar ? '' : 'hide'}" data-rm>${t('removePicture')}</button></div>
      <div class="modal-actions"><button type="button" class="btn ghost" data-x>${t('cancel')}</button><button class="btn primary">${t('save')}</button></div></form>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form');
    const pic = wrap.querySelector('.pfd-pic');
    wrap.addEventListener('click', async (e) => {
      if (e.target.closest('[data-up]')) {
        const f = await pickImage();
        const b = f && (await cropImage(f));
        if (!b) return;
        blob = b;
        removeArt = false;
        if (preview) URL.revokeObjectURL(preview);
        preview = URL.createObjectURL(b);
        pic.innerHTML = `<img alt="" src="${preview}">`;
        wrap.querySelector('[data-rm]').classList.remove('hide');
      } else if (e.target.closest('[data-rm]')) {
        blob = null;
        removeArt = true;
        pic.textContent = (form.elements.name.value || '?').trim().charAt(0).toUpperCase() || '?';
        wrap.querySelector('[data-rm]').classList.add('hide');
      }
    });
    const close = (v) => (wrap.remove(), preview && URL.revokeObjectURL(preview), res(v));
    wrap.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => close(null)));
    wrap.addEventListener('mousedown', (e) => e.target === wrap && close(null));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      if (!name) return form.elements.name.focus();
      const btn = form.querySelector('.btn.primary');
      btn.disabled = true;
      try {
        if (name !== u.name) await put('/api/me', { name });
        const bio = form.elements.bio.value.trim().slice(0, 160);
        if (bio !== (settings.bio || '')) await saveSettings({ bio });
        if (blob) {
          const r = await fetch(`${conn.server}/api/art/user/${u.id}`, { method: 'PUT', headers: { Authorization: 'Bearer ' + conn.token, 'Content-Type': 'image/jpeg' }, body: blob });
          if (!r.ok) throw new Error('error');
        } else if (removeArt) await del(`/api/art/user/${u.id}`).catch(() => {});
        conn.user = await get('/api/me');
        saveConn();
        paintAvatars();
        toast(t('profileSaved'));
        close(true);
      } catch (err) {
        btn.disabled = false;
        toast(errorText(err));
      }
    };
  });
}
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-editprofile]') && (await profileDialog())) renderSettings();
});
function openProfile() {
  // a second tap on the picture closes the panel instead of stacking another one
  if (document.querySelector('.profile-wrap:not(.closing)')) return closeProfile();
  closeProfile();
  const name = (conn.user && conn.user.name) || '';
  const initial = avatarInner();
  const wrap = document.createElement('div');
  wrap.className = 'profile-wrap';
  const item = (attr, ic, label) => `<button ${attr}>${icon(ic)}<span>${label}</span></button>`;
  wrap.innerHTML = `<aside class="profile" role="dialog" aria-label="${t('profile')}">
    <div class="pf-head"><span class="avatar big">${initial}</span><div><b>${esc(name)}</b>${settings.bio ? `<p class="pf-bio">${esc(settings.bio)}</p>` : ''}<button class="pf-edit muted small" data-pfedit>${t('editProfile')}</button></div></div>
    <nav class="pf-nav">
      ${item('data-pfgo="#/add"', 'plus', t('importAdd'))}
      ${item('data-pfgo="#/sources"', 'link', t('manageSources'))}
      ${item('data-pfgo="#/likes"', 'heart', t('likes'))}
      ${item('data-pfgo="#/queue"', 'queue', t('queue'))}
      ${item('data-pfupd', 'download', t('updates'))}
    </nav>
    <div class="pf-foot">${item('data-pfset', 'gear', t('settings'))}</div>
  </aside>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) return closeProfile();
    const b = e.target.closest('button, a');
    if (!b) return;
    closeProfile();
    if (b.dataset.pfgo) go(b.dataset.pfgo);
    else if (b.hasAttribute('data-pfset')) openSettingsPage();
    else if (b.hasAttribute('data-pfupd')) openSettingsPage('updates');
    else if (b.hasAttribute('data-pfedit')) profileDialog();
  });
}
function closeProfile() {
  document.querySelectorAll('.profile-wrap:not(.closing)').forEach((w) => {
    w.classList.add('closing');
    w.classList.remove('open');
    setTimeout(() => w.remove(), 200);
  });
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-profile]')) openProfile();
});

function pageHead(title, extra = '') {
  const initial = avatarInner();
  return `<div class="mhead"><button class="avatar" data-profile title="${t('profile')}">${initial}</button><h1>${title}</h1>${extra}${discordBtn('m-only')}</div>`;
}
// Discord: a button next to the profile picture, always visible
// the link comes from links.json on the website, so it can change without an app update
let discordUrl = DISCORD_URL;
function discordBtn(cls = '') {
  return `<button type="button" class="discord-btn ${cls}" data-discord title="Discord" aria-label="Discord">${icon('discord')}<span>Discord</span></button>`;
}
fetch('https://musik.labtoso.de/links.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => {
  const u = String(j?.discord || '').trim();
  if (!/^https:\/\//.test(u)) return;
  discordUrl = u;
}).catch(() => {});
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-discord]') && discordUrl) openExt(discordUrl);
});
function greeting() {
  const h = new Date().getHours();
  return t(h < 5 ? 'greetNight' : h < 11 ? 'greetMorning' : h < 18 ? 'greetDay' : 'greetEvening');
}
const albumHref = (album, artist) => `#/album?album=${encodeURIComponent(album)}&artist=${encodeURIComponent(artist || '')}`;
// tint elements with the colour of their cover
function tintAll(root = document) {
  root.querySelectorAll('[data-tint]').forEach((el) => {
    const url = el.dataset.tint;
    el.removeAttribute('data-tint');
    colorFromUrl(url).then((c) => { if (c) { el.style.setProperty('--tint', c.bg); el.style.setProperty('--tint2', c.accent); el.classList.add('tinted'); paintBars(); } });
  });
}

function section(title, body, extra = '') {
  return `<section class="sec"><div class="sec-head"><h2>${esc(title)}</h2>${extra}</div>${body}</section>`;
}

function albumCards(albums) {
  return `<div class="cards">${albums
    .map(
      (a) => `<a class="card" href="#/album?album=${encodeURIComponent(a.album)}&artist=${encodeURIComponent(a.artist)}">
      ${coverImg(a.cover_id, 'lg')}<div class="c-title">${esc(a.album)}</div><div class="c-sub">${esc(a.artist || t('unknownArtist'))}${a.year ? ' · ' + a.year : ''}</div></a>`
    )
    .join('')}</div>`;
}

function trackCards(tracks, key) {
  state.lists = state.lists || {};
  state.lists[key] = tracks;
  return `<div class="cards" data-cards="${key}">${tracks
    .map(
      (tr, i) => `<button class="card" data-i="${i}">${coverImg(tr.id, 'lg')}<div class="c-title">${esc(tr.title)}</div><div class="c-sub">${esc(
        artistName(tr)
      )}</div></button>`
    )
    .join('')}</div>`;
}
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-cards] .card');
  if (!c) return;
  const list = state.lists?.[c.parentNode.dataset.cards];
  if (list) player.playList(list, Number(c.dataset.i));
});

// ---------- what was played from platforms, kept on this device for suggestions ----------
const HIST_KEY = 'musik.exthist';
function extHistory() {
  try {
    return JSON.parse(localStorage.getItem(HIST_KEY)) || [];
  } catch {
    return [];
  }
}
let lastRemembered = null;
function rememberPlay(tr) {
  if (!tr?.ext || tr.id === lastRemembered) return;
  lastRemembered = tr.id;
  const h = extHistory().filter((x) => x.id !== tr.id);
  h.unshift({ id: tr.id, title: tr.title, artist: tr.artist, album: tr.album, duration: tr.duration, cover: extCovers.get(tr.id) || '', ext: tr.ext, at: Date.now() });
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 200)));
  } catch {}
}
function histTrack(x) {
  if (x.cover) extCovers.set(x.id, x.cover);
  return { id: x.id, title: x.title, artist: x.artist, album: x.album || '', duration: x.duration || 0, has_cover: !!x.cover, ext: x.ext, liked: false };
}
/** Artists someone listens to most: local plays, platform plays, imported playlists. */
async function favouriteArtists(h) {
  const score = new Map();
  const add = (name, n) => {
    for (const a of String(name || '').split(/,|&| feat\.? | x /i).map((x) => x.trim()).filter(Boolean).slice(0, 1)) score.set(a, (score.get(a) || 0) + n);
  };
  (h?.topArtists || []).forEach((a, i) => add(a, 12 - i));
  (follows || []).forEach((f, i) => add(f.name, Math.max(2, 8 - i)));
  const skip = new Set(tasteList().map((x) => x.key));
  extHistory().forEach((x, i) => !skip.has(tasteKey(x)) && add(x.artist, Math.max(1, 6 - i / 10)));
  if (score.size < 3) {
    const imps = await get('/api/imports').catch(() => []);
    for (const im of imps.slice(0, 3)) {
      const r = await get('/api/imports/' + im.id).catch(() => null);
      r?.items?.slice(0, 40).forEach((x) => add(x.artist, 1));
    }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]).slice(0, 4);
}
// suggestions from the catalog, worked out on the server from plays, skips, likes, followed artists and the setup assistant
const fyLists = new Map();
let fyLoad = null;
function loadForYou(h) {
  if (!fyLoad || fyLoad.h !== h) fyLoad = { h, p: favouriteArtists(h).then((names) => get('/api/catalog/foryou?artists=' + encodeURIComponent(names.join('|')))).catch(() => null) };
  return fyLoad.p;
}
/** "Mix für dich" from the catalog when the own files give too little: the Daily Mixes woven together. */
async function catalogMixSection(h) {
  const r = await loadForYou(h);
  const lists = [...(r?.mixes || []).map((m) => m.tracks), r?.discover || [], r?.onRepeat || []].filter((l) => l.length);
  const out = [];
  const seen = new Set();
  for (let i = 0; out.length < 50 && lists.some((l) => l[i]); i++)
    for (const l of lists) {
      const x = l[i];
      const k = x && `${x.artist}|${x.title}`.toLowerCase();
      if (x && !seen.has(k)) seen.add(k), out.push(extTrack(x));
    }
  state.homeMixExt = out;
  if (!out.length) return '';
  return `<section class="sec home-mix"><div class="sec-head"><h2>${t('mixForYou')}</h2><button class="playcircle" data-playmix title="${t('playAll')}">${icon('play')}</button></div>${trackList(out.slice(0, 12))}</section>`;
}
async function forYouSections(h) {
  const r = await loadForYou(h);
  if (!r) return '';
  let html = '';
  const rows = (r.rows || []).map((row) => ({ ...row, tracks: row.tracks.map(extTrack) }));
  // mixes like on Spotify: one Daily Mix per corner of the taste, new music each week, the songs on repeat
  const cards = [];
  if (r.discover?.length >= 8) cards.push({ title: t('discoverMix'), sub: t('discoverHint'), picture: r.discover[0].cover, tracks: r.discover.map(extTrack) });
  if (r.onRepeat?.length >= 5) cards.push({ title: t('onRepeat'), sub: t('onRepeatHint'), picture: r.onRepeat[0].cover, tracks: r.onRepeat.map(extTrack) });
  // Streyn Mixes: Daily Mixes, genre and artist mixes, each with its own cover, name and description
  const smix = streynMixList(r);
  const tops = await loadTopSongs();
  if (smix.length || cards.length) {
    html += section(t('streynMixes'), `<div class="cards srow">${smix.map(mixCard).join('')}${cards
      .map((c) => {
        const id = 'fymix:' + Math.random().toString(36).slice(2, 9);
        fyLists.set(id, c.tracks);
        if (fyLists.size > 60) fyLists.delete(fyLists.keys().next().value);
        if (c.picture) extCovers.set(id, c.picture);
        return `<button class="card" data-fymix="${id}">${coverImg(c.picture ? id : c.tracks[0]?.id, 'lg')}<div class="c-title">${esc(c.title)}</div><div class="c-sub">${esc(c.sub)}</div></button>`;
      })
      .join('')}</div>`);
  }
  if (tops.length) html += section(t('yourTopSongs'), `<div class="cards srow">${tops.map(topCard).join('')}</div>`);
  const songs = (r.discover || []).slice(0, 8).map(extTrack);
  if (songs.length) html += section(t('songsForYou'), trackList(songs));
  if (r.playlists?.length) html += section(t('playlistsForYou'), plainAlbumCards(r.playlists.map(catPlaylist), true));
  if (r.artists?.length) html += section(t('suggestedArtists'), artistCards(r.artists.map(catArtist), true));
  for (const row of rows) html += section(t('becauseYouListen', { name: row.because }), trackCards(row.tracks, 'fy' + Math.random().toString(36).slice(2, 7)));
  return html;
}
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-fymix]');
  const list = c && fyLists.get(c.dataset.fymix);
  if (list?.length) player.playList(list, 0);
});

// ---------- Streyn Mixes and "Your Top Songs <year>" ----------
// Made by the server from what someone plays. Each one gets a cover, a name and a description of its own,
// like the mixes on Spotify. Both can be switched off in the settings (account settings, so on every device).
const MIX_COLORS = ['#e8115b', '#1e3264', '#8d67ab', '#e13300', '#148a08', '#509bf5', '#b49bc8', '#ba5d07', '#0d73ec', '#27856a', '#dc148c', '#477d95'];
const STREYN_MARK = '<svg viewBox="0 0 512 512" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M256 8a248 248 0 1 0 0 496 248 248 0 1 0 0-496Zm0 13a235 235 0 1 1 0 470 235 235 0 1 1 0-470Z"/><path fill="currentColor" transform="translate(-4 16)" d="M149 151 404 78q6-2 7 4l24 214q3 32-24 52-30 22-74 18-34-3-52-24-14-18-4-38 14-26 52-32 30-5 54 8l-16-138-151 36 18 154q4 32-24 52-30 22-74 18-34-3-52-24-14-18-4-38 14-26 52-32 30-5 54 8L142 158q-1-6 7-7Z"/></svg>';
/** id → { label, picture, color, year } for the covers drawn here instead of loaded */
const genCovers = new Map();
function mixColor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return MIX_COLORS[h % MIX_COLORS.length];
}
function genCoverHtml(id, cls) {
  const g = genCovers.get(id);
  if (g.year) {
    return `<div class="cover ${cls} gen year" style="--gc:${g.color};--gc2:${g.color2}"><div class="gen-ov"><span class="gen-mark">${STREYN_MARK}</span><small>${esc(t('topSongsShort'))}</small><b>${g.year}</b></div></div>`;
  }
  return `<div class="cover ${cls} gen" style="--gc:${g.color}">${g.picture ? `<img loading="lazy" alt="" src="${esc(g.picture)}" onerror="this.remove()">` : ''}<div class="gen-ov"><span class="gen-mark">${STREYN_MARK}</span><b>${esc(g.label)}</b></div></div>`;
}
const userName = () => conn.user?.name || '';
const namesText = (names) => (names.length ? t('mixAndMore', { names: names.slice(0, 3).join(', ') }) : '');
/** One mix from the server as the app shows it: name, description, cover, songs. */
function mixInfo(m) {
  const names = m.artists || [];
  let title, desc, label;
  if (m.kind === 'genre') {
    const genre = t('g_' + m.genre);
    title = label = t('mixGenre', { genre });
    desc = t('mixDescGenre', { genre, names: names.slice(0, 3).join(', ') });
  } else if (m.kind === 'artist') {
    title = label = t('mixArtist', { name: m.artist });
    desc = t('mixDescArtist', { name: m.artist, names: names.filter((n) => n !== m.artist).slice(0, 3).join(', ') || m.artist });
  } else {
    title = label = m.title;
    desc = namesText(names);
  }
  const cover = 'gen:mix:' + m.id;
  const picture = m.picture || m.tracks?.[0]?.cover || '';
  genCovers.set(cover, { label, picture, color: mixColor(m.id) });
  if (picture) extCovers.set(cover, picture);
  return { slug: m.id, title, desc, cover, tracks: (m.tracks || []).map(extTrack) };
}
function streynMixList(r) {
  if (!r || settings.streynMixes === false) return [];
  // like Spotify: Daily Mixes first, then the genres, then the artists
  return [...(r.mixes || []), ...(r.genreMixes || []), ...(r.artistMixes || [])].filter((m) => m.id && m.tracks?.length).map(mixInfo);
}
const mixCard = (m) => `<a class="card" href="#/mix/${encodeURIComponent(m.slug)}">${coverImg(m.cover, 'lg')}<div class="c-title">${esc(m.title)}</div><div class="c-sub">${esc(m.desc)}</div></a>`;

let topLoad = null;
/** The yearly top song lists, newest year first. Fetched again after a few minutes. */
function loadTopSongs() {
  if (settings.topSongs === false) return Promise.resolve([]);
  if (!topLoad || Date.now() - topLoad.at > 5 * 60 * 1000)
    topLoad = { at: Date.now(), p: get('/api/topsongs?tz=' + -new Date().getTimezoneOffset()).then((l) => l.map(topInfo)).catch(() => []) };
  return topLoad.p;
}
function topInfo(y) {
  const cover = 'gen:top:' + y.year;
  // every year its own colours, always the same ones
  const hue = (y.year * 67) % 360;
  const color = `hsl(${hue} 85% 58%)`, color2 = `hsl(${(hue + 140) % 360} 80% 42%)`;
  genCovers.set(cover, { year: y.year, color, color2 });
  extCovers.set(cover, `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${color2}"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>`)}`);
  return {
    year: y.year,
    title: t('topSongsTitle', { year: y.year }),
    desc: t('topSongsDesc', { year: y.year }),
    cover,
    plays: y.plays,
    tracks: y.tracks.map((x) => (x.track ? x.track : extTrack(x.ext))).filter(Boolean)
  };
}
const topCard = (y) => `<a class="card" href="#/topsongs/${y.year}">${coverImg(y.cover, 'lg')}<div class="c-title">${esc(y.title)}</div><div class="c-sub">${esc(t('playlist'))} · ${esc(t('forUser', { name: userName() }))}</div></a>`;

function genListActions(key, name) {
  return `<button class="btn primary" data-playkey="${key}">${icon('play')}${t('playAll')}</button>` +
    `<button class="icon-btn lg" data-shufflekey="${key}" title="${t('shuffle')}">${icon('shuffle')}</button>` +
    `<button class="icon-btn lg" data-preload="${key}" title="${t('preload')}">${icon('bolt')}</button>` +
    offBtn(key + ':' + location.hash, key, name) +
    `<button class="icon-btn lg" data-savegen="${key}" title="${t('saveAsPlaylist')}">${icon('plus')}</button>`;
}
views.mix = async (params, id) => {
  const r = await (fyLoad?.p || loadForYou(null));
  const m = streynMixList(r).find((x) => x.slug === decodeURIComponent(id || ''));
  if (!m) return `<button class="mback" data-back title="${t('back')}">${icon('back')}</button><p class="muted empty">${t(settings.streynMixes === false ? 'streynMixesOff' : 'mixGone')}</p>`;
  state.detail = { mix: m.tracks };
  state.genName = m.title;
  return detailHeader({
    coverId: m.cover,
    kind: t('streynMix'),
    title: m.title,
    sub: `<span class="pl-desc">${esc(m.desc)}</span>${esc(t('forUser', { name: userName() }))} · ${songCount(m.tracks.length)} · ${fmtTime(m.tracks.reduce((s, x) => s + (x.duration || 0), 0))}`,
    actions: genListActions('mix', m.title)
  }) + trackList(m.tracks);
};
views.topsongs = async (params, id) => {
  const y = (await loadTopSongs()).find((x) => String(x.year) === id);
  if (!y) return `<button class="mback" data-back title="${t('back')}">${icon('back')}</button><p class="muted empty">${t(settings.topSongs === false ? 'topSongsOff' : 'topSongsNone')}</p>`;
  state.detail = { top: y.tracks };
  state.genName = y.title;
  return detailHeader({
    coverId: y.cover,
    kind: t('playlist'),
    title: y.title,
    sub: `<span class="pl-desc">${esc(y.desc)}</span>${esc(t('forUser', { name: userName() }))} · ${songCount(y.tracks.length)} · ${fmtTime(y.tracks.reduce((s, x) => s + (x.duration || 0), 0))}`,
    actions: genListActions('top', y.title)
  }) + trackList(y.tracks, { numbers: true });
};
// keep a mix or a year as an own playlist (it then stays as it is, the mix itself goes on changing)
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-savegen]');
  const list = b && state.detail?.[b.dataset.savegen];
  if (!list?.length) return;
  const name = state.genName || t('streynMix');
  try {
    // same as "Add to playlist → New playlist": own files only = a normal playlist, else a kept import
    if (list.every((x) => !x.ext && typeof x.id === 'number')) await post('/api/playlists', { name, trackIds: list.map((x) => x.id) });
    else {
      const im = await post('/api/imports', { source: list.find((x) => x.ext)?.ext.source || 'files', name, items: list.map(itemOf) });
      await post(`/api/imports/${im.id}/playlist`, {});
    }
    state.cache.playlists = null;
    renderSidebarPlaylists();
    toast(t('savedAsPlaylist', { name: state.genName || '' }));
  } catch (err) {
    toast(errorText(err));
  }
});
// the switches in the settings
document.addEventListener('change', (e) => {
  const k = e.target.dataset?.aset;
  if (!k) return;
  saveSettings({ [k]: e.target.checked }).catch(() => {});
  fyLoad = null;
  topLoad = null;
  dropHome();
  renderSidebarPlaylists();
});
const asw = (k, d) => `<label class="switch"><input type="checkbox" data-aset="${k}" ${(settings[k] ?? d) ? 'checked' : ''}><span></span></label>`;

// The start page is kept in memory once it has been built: coming back to it is instant until the app is closed.
// A fresh copy is fetched quietly in the background when the kept one is older than a few minutes.
let homeKept = null;
const HOME_FRESH = 4 * 60 * 1000;
const homeReloadBtn = () => `<button class="icon-btn desktop-only" data-homereload title="${t('reload')}">${icon('refresh')}</button>`;
async function reloadHome() {
  dropHome();
  laterDone.clear();
  const v = $('#view');
  if (state.route !== 'home' || !v) return render();
  // like a web page that loads again: the old page stays, dims while the new one is fetched, then the new one fades in
  v.classList.add('reloading');
  try {
    const html = keepHome(await buildHome()).html;
    if (state.route === 'home') {
      v.innerHTML = html;
      tintAll(v);
      warmSoon(200);
    }
  } finally {
    v.classList.remove('reloading');
    v.classList.remove('reloaded');
    void v.offsetWidth;
    v.classList.add('reloaded');
    setTimeout(() => v.classList.remove('reloaded'), 450);
  }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-homereload]');
  if (!b) return;
  b.classList.add('spinning');
  await Promise.all([reloadHome().catch(() => {}), new Promise((r) => setTimeout(r, 600))]);
  document.querySelector('[data-homereload]')?.classList.remove('spinning');
});
// phone: pull the start page down to load it again, with the round arrow a browser shows
(() => {
  const NEED = 70, MAX = 118;
  let g = null, busy = false, ind = null;
  const make = () => {
    if (!ind) {
      ind = document.createElement('div');
      ind.className = 'ptr';
      ind.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="ptr-arc" cx="12" cy="12" r="7.5" pathLength="100"/><path class="ptr-head" d="M12 1.6 15.4 4.5 12 7.4Z"/></svg>';
      document.body.appendChild(ind);
    }
    return ind;
  };
  const set = (px, anim) => {
    const i = make();
    const p = Math.min(1, px / NEED);
    i.style.transition = anim ? 'transform .32s cubic-bezier(.2,.9,.3,1), opacity .22s' : 'none';
    i.style.transform = `translate(-50%, ${px}px) scale(${0.55 + 0.45 * p})`;
    i.style.opacity = px > 6 ? String(Math.min(1, 0.25 + p)) : '0';
    i.style.setProperty('--arc', String(Math.round(8 + p * 72)));
    i.style.setProperty('--rot', `${Math.round(px * 2.6)}deg`);
    i.classList.toggle('ready', px >= NEED);
  };
  const blocked = () => state.route !== 'home' || document.querySelector('.modal-wrap, .menu, .profile-wrap.open, .fs.open, .settings.open');
  document.addEventListener('touchstart', (e) => {
    g = null;
    if (busy || e.touches.length !== 1 || !e.target.closest?.('#content') || e.target.closest('input') || blocked()) return;
    const tc = e.touches[0];
    g = { x0: tc.clientX, y0: null, sy: tc.clientY, pull: 0, dir: null };
    if ($('#content').scrollTop <= 0) g.y0 = tc.clientY;
    const c = $('#content').getBoundingClientRect();
    make().style.top = `${Math.max(0, c.top) - 44}px`;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!g) return;
    const tc = e.touches[0];
    if (!g.dir) {
      const dx = Math.abs(tc.clientX - g.x0), dy = Math.abs(tc.clientY - g.sy);
      if (dx < 8 && dy < 8) return;
      g.dir = dx > dy ? 'x' : 'y';
    }
    if (g.dir === 'x') return void (g = null);
    // scrolled back up to the top during the same swipe: from here on it pulls, like in a browser
    if (g.y0 == null) {
      if ($('#content').scrollTop > 0) return;
      g.y0 = tc.clientY;
    }
    const d = tc.clientY - g.y0;
    if (d <= 0 || $('#content').scrollTop > 0) {
      if (g.pull) set(0, true);
      g.pull = 0;
      if (d < -4) g.y0 = null;
      return;
    }
    g.pull = MAX * (1 - Math.exp(-d / (MAX * 1.25)));
    set(g.pull, false);
  }, { passive: true });
  const end = async () => {
    if (!g) return;
    const pull = g.pull;
    g = null;
    if (pull < NEED) return pull && set(0, true);
    busy = true;
    set(NEED, true);
    ind.classList.add('spinning');
    navigator.vibrate?.(8);
    await Promise.all([reloadHome().catch(() => {}), new Promise((r) => setTimeout(r, 650))]);
    ind.classList.remove('spinning');
    ind.style.transition = 'transform .25s ease-in, opacity .25s';
    ind.style.transform = 'translate(-50%, 34px) scale(0.3)';
    ind.style.opacity = '0';
    setTimeout(() => (busy = false), 260);
  };
  document.addEventListener('touchend', end);
  document.addEventListener('touchcancel', end);
})();
function dropHome() {
  homeKept = null;
}
views.home = async () => {
  if (homeKept && homeKept.lang === getLang() && homeKept.user === conn.user?.id) {
    state.homeMix = homeKept.mix;
    if (Date.now() - homeKept.at > HOME_FRESH && !homeKept.busy) {
      homeKept.busy = true;
      buildHome().then((html) => keepHome(html)).catch(() => homeKept && (homeKept.busy = false));
    }
    return homeKept.html;
  }
  return keepHome(await buildHome()).html;
};
const laterDone = new Map();
function keepHome(html) {
  for (const [id, part] of laterDone) html = html.replace(`<div id="${id}"></div>`, part);
  return (homeKept = { html, mix: state.homeMix, at: Date.now(), lang: getLang(), user: conn.user?.id });
}
// the suggestions come from an outside catalog and take longest: the page shows without them and they slide in when ready
function laterSection(make) {
  const id = 'later' + Math.random().toString(36).slice(2, 8);
  make()
    .then((html) => {
      laterDone.set(id, html);
      if (laterDone.size > 6) laterDone.delete(laterDone.keys().next().value);
      if (homeKept?.html.includes(id)) homeKept.html = homeKept.html.replace(`<div id="${id}"></div>`, html);
      const slot = document.getElementById(id);
      if (slot) {
        slot.outerHTML = html;
        tintAll($('#view'));
      }
      return html;
    })
    .catch(() => {});
  return `<div id="${id}"></div>`;
}
/** Playlists pinned to the start page from their … menu: they come right after the liked songs, newest pin first. */
async function toggleHomePin(ref) {
  const pins = (settings.homePins || []).filter((r) => r !== ref);
  const on = pins.length === (settings.homePins || []).length;
  if (on) pins.unshift(ref);
  await saveSettings({ homePins: pins.slice(0, 8) }).catch(() => {});
  homeKept = null;
  toast(t(on ? 'pinnedHome' : 'unpinnedHome'));
  if (state.route === 'home') render();
}
async function pinnedTiles() {
  const pins = settings.homePins || [];
  if (!pins.length) return '';
  const [lists, imps] = await Promise.all([get('/api/playlists').catch(() => []), get('/api/imports').catch(() => [])]);
  return pins
    .map((ref) => {
      const [kind, id] = ref.split(':');
      if (kind === 'playlist') {
        const p = lists.find((x) => String(x.id) === id);
        return p && `<a class="qt pinned" href="#/playlist/${p.id}">${coverImg(artKey('playlist', p.id, p.art) || p.cover_id)}<span>${esc(p.name)}</span></a>`;
      }
      const im = imps.find((x) => String(x.id) === id);
      if (im?.cover && !im.art) extCovers.set('impc:' + im.id, im.cover);
      return im && `<a class="qt pinned" href="#/imported/${im.id}">${coverImg(artKey('import', im.id, im.art) || (im.cover ? 'impc:' + im.id : im.cover_id))}<span>${esc(im.name)}</span></a>`;
    })
    .filter(Boolean)
    .join('');
}
// always first on the start page, like Spotify: the liked songs
const likedTile = () => `<a class="qt" href="#/likes"><div class="cover liked">${icon('heartFill')}</div><span>${t('likes')}</span></a>`;
async function buildHome() {
  fyLoad = null;
  topLoad = null;
  const [h, lib, fol] = await Promise.all([get('/api/home'), get('/api/library'), loadFollows(true)]);
  const recentExt = extHistory().slice(0, 12).map(histTrack);
  if (!lib.tracks) {
    // no own files yet: suggestions from Spotify / YouTube listening instead of an empty page
    let html = pageHead(greeting(), homeReloadBtn());
    html += `<div class="quick">${likedTile()}${await pinnedTiles()}</div>`;
    const mixPart = await catalogMixSection(null);
    html += mixPart;
    if (recentExt.length) html += section(t('recent'), trackCards(recentExt, 'recentext'));
    if (fol.length) html += section(t('followedArtists'), artistCards(fol.map(followCard), true));
    const fy = (await forYouSections(null)) + '';
    if (mixPart && !fy) return html;
    html += fy || `<div class="emptystate">${icon('note', 'big')}<p>${t('emptyStart')}</p><div class="stack"><a class="btn primary" href="#/search">${icon('search')}${t('search')}</a><a class="btn" href="#/add">${icon('download')}${t('importAdd')}</a><button class="btn" data-upload>${icon('upload')}${t('upload')}</button></div></div>`;
    return html;
  }
  state.homeMix = h.mix;
  state.homeMixExt = null;
  // too few own songs for a real mix (e.g. mostly Spotify listening): the mix comes from the catalog instead, never an empty list
  const ownMix = h.mix.length >= 8;
  // quick tiles: the mix plus albums played lately and new ones
  const quick = [];
  const seenAlb = new Set();
  for (const x of [...h.recent.map((tr) => ({ album: tr.album, artist: tr.album_artist || tr.artist, cover_id: tr.id })), ...h.newAlbums]) {
    const k = (x.album || '').toLowerCase();
    if (!x.album || seenAlb.has(k)) continue;
    seenAlb.add(k);
    quick.push(x);
  }
  let html = pageHead(greeting(), homeReloadBtn());
  const pinHtml = await pinnedTiles();
  const nPins = (pinHtml.match(/class="qt pinned"/g) || []).length;
  html += `<div class="quick">${likedTile()}${pinHtml}<button class="qt" data-playmix><div class="cover accent">${icon('mix')}</div><span>${t('mixForYou')}</span></button>${quick
    .slice(0, Math.max(0, 6 - nPins))
    .map((a) => `<a class="qt" href="${albumHref(a.album, a.artist)}">${coverImg(a.cover_id)}<span>${esc(a.album)}</span></a>`)
    .join('')}</div>`;
  if (ownMix) html += `<div class="hero">
    <div class="hero-text"><h1>${t('mixForYou')}</h1><p class="muted">${h.cold ? t('coldHint') : esc(h.mix.slice(0, 4).map(artistName).filter((v, i, a) => a.indexOf(v) === i).join(', '))}</p></div>
    <button class="btn primary" data-playmix>${icon('play')}${t('playAll')}</button></div>`;
  html += ownMix
    ? `<section class="sec home-mix"><div class="sec-head m-only"><h2>${t('mixForYou')}</h2><button class="playcircle" data-playmix title="${t('playAll')}">${icon('play')}</button></div>${trackList(h.mix, { reasons: true })}</section>`
    : laterSection(() => catalogMixSection(h));
  const recentAll = [...h.recent, ...recentExt].slice(0, 14);
  if (recentAll.length) html += section(t('recent'), trackCards(recentAll, 'recent'));
  if (fol.length) html += section(t('followedArtists'), artistCards(fol.map(followCard), true));
  html += laterSection(() => forYouSections(h));
  if (h.rediscover.length) html += section(t('rediscover'), trackCards(h.rediscover, 'rediscover'));
  if (h.newAlbums.length) html += section(t('newAlbums'), albumCards(h.newAlbums));
  if (h.topArtists.length) {
    const all = await cached('artists', () => get('/api/artists')).catch(() => []);
    const cov = Object.fromEntries(all.map((a) => [a.name, a.cover_id]));
    html += section(
      t('yourArtists'),
      `<div class="cards">${h.topArtists
        .map((a) => `<a class="card artist" href="#/artist?name=${encodeURIComponent(a)}">${coverImg(cov[a], 'lg round')}<div class="c-title">${esc(a)}</div><div class="c-sub">${t('artist')}</div></a>`)
        .join('')}</div>`
    );
  }
  return html;
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-playmix]')) {
    if (sourceActive('mix')) return player.toggle();
    try {
      if (!state.homeMixExt && state.homeMix && state.homeMix.length < 8) await catalogMixSection(fyLoad?.h ?? null);
      const mix = state.homeMixExt?.length ? state.homeMixExt : await blendedMix();
      if (!mix.length) return toast(t('coldHint'));
      player.playList(mix, 0);
      markSource('mix');
    } catch (err) {
      toast(errorText(err));
    }
  }
  if (e.target.closest('[data-upload]')) pickUpload();
});

/** Your mix: own songs and streaming songs in the share set in the settings (Mix slider). */
async function blendedMix() {
  const share = Math.min(1, Math.max(0, Number(prefs.mixStream ?? 0.3)));
  const streaming = navigator.onLine !== false;
  const [own, ext] = await Promise.all([
    share < 1 || !streaming ? get('/api/recommend/mix?limit=60').catch(() => []) : [],
    share > 0 && streaming
      ? favouriteArtists(null).then((names) => (names.length ? get('/api/catalog/foryou?artists=' + encodeURIComponent(names.join('|'))) : null)).then((r) => {
          const rows = (r?.rows || []).map((row) => row.tracks.map(extTrack));
          const out = [];
          for (let k = 0; k < 20; k++) for (const row of rows) if (row[k]) out.push(row[k]);
          const skip = new Set(tasteList().map((x) => x.key));
          return out.filter((x) => !skip.has(tasteKey(x)));
        }).catch(() => [])
      : []
  ]);
  if (!ext.length) return own;
  if (!own.length) return ext.slice(0, 60);
  const out = [];
  let a = 0, b = 0;
  while (out.length < 60 && (a < own.length || b < ext.length)) {
    const wantExt = b < ext.length && (a >= own.length || (b + 1) / (out.length + 1) <= share + 1e-9);
    out.push(wantExt ? ext[b++] : own[a++]);
  }
  return out;
}

// ---------- search, laid out like Spotify: top result, songs, artists, albums, playlists, catalog ----------
const RECENT_KEY = 'musik.recent';
function recentSearches() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    return [];
  }
}
function rememberSearch(q) {
  q = q.trim();
  if (q.length < 2) return;
  const l = [q, ...recentSearches().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 10);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(l));
  } catch {}
}
const SFILTERS = ['all', 'songs', 'artists', 'albums', 'playlists'];
views.search = async (params) => {
  const q = params.get('q') || '';
  state.sfilter = 'all';
  const mode = searchMode();
  return `${pageHead(t('search'))}<div class="searchbar">${icon('search')}<input id="q" type="search" placeholder="${t('searchPlaceholder_' + mode)}" value="${esc(q)}" autocomplete="off"></div>
    <div class="smode" role="tablist">${SMODES.map((m) => `<button class="${m === mode ? 'on' : ''}" data-smode="${m}">${m === 'all' ? '' : srcBadge(m === 'spotify' ? 'spotify' : 'ytmusic')}${t('smode_' + m)}</button>`).join('')}</div><div id="results"></div>`;
};
/** Where search looks: everything, only Spotify, or only YouTube Music. */
const SMODES = ['all', 'spotify', 'ytmusic'];
function searchMode() {
  return SMODES.includes(prefs.searchIn) ? prefs.searchIn : 'all';
}
function setSearchMode(m) {
  prefs.searchIn = m;
  savePrefs();
  if (conn.token) saveSettings({ searchIn: m }).catch(() => {});
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-col]');
  if (!b) return;
  const c = cols();
  c.has(b.dataset.col) ? c.delete(b.dataset.col) : c.add(b.dataset.col);
  prefs.cols = COLS.filter((k) => c.has(k));
  savePrefs();
  if (conn.token) saveSettings({ cols: prefs.cols }).catch(() => {});
  b.classList.toggle('on', c.has(b.dataset.col));
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-smode]');
  if (!b) return;
  setSearchMode(b.dataset.smode);
  document.querySelectorAll('[data-smode]').forEach((x) => x.classList.toggle('on', x === b));
  const q = $('#q');
  if (q) {
    q.placeholder = t('searchPlaceholder_' + b.dataset.smode);
    runSearch(q.value).catch(() => {});
  }
});
function spArtist(a) {
  const id = 'spartist:' + a.id;
  if (a.picture) extCovers.set(id, a.picture);
  return { name: a.name, cover: id, href: `#/spartist?id=${a.id}`, sub: t('artist') };
}
function spAlbum(a) {
  const id = 'spalbum:' + a.id;
  if (a.cover) extCovers.set(id, a.cover);
  return { title: a.title, artist: a.year ? `${a.year} · ${a.artist}` : a.artist, cover: id, href: `#/spalbum?id=${a.id}` };
}
function spPlaylist(p) {
  const id = 'sppl:' + p.id;
  if (p.cover) extCovers.set(id, p.cover);
  return { title: p.title, artist: p.owner, cover: id, href: `#/spplaylist?id=${p.id}` };
}
/** Catalog entries (artists, albums) get string ids so their pictures go through extCovers. */
function catArtist(a) {
  const id = 'dzartist:' + a.id;
  if (a.picture) extCovers.set(id, a.picture);
  return { name: a.name, cover: id, href: `#/cartist?id=${a.id}`, sub: t('artist') };
}
function catPlaylist(p) {
  const id = 'dzpl:' + p.id;
  if (p.cover) extCovers.set(id, p.cover);
  return { title: p.title, artist: [p.owner, p.count ? songCount(p.count) : ''].filter(Boolean).join(' · '), cover: id, href: `#/cplaylist?id=${p.id}` };
}
function catAlbum(a) {
  const id = 'dzalbum:' + a.id;
  if (a.cover) extCovers.set(id, a.cover);
  return { title: a.title, artist: a.artist, cover: id, href: `#/calbum?id=${a.id}` };
}
// ---------- followed artists ----------
let follows = null;
async function loadFollows(force = false) {
  if (!follows || force) follows = await get('/api/follows').catch(() => follows || []);
  return follows;
}
const isFollowed = (kind, ref) => !!follows?.some((f) => f.kind === kind && f.ref === String(ref));
function followBtn(kind, ref, name, cover = '') {
  const on = isFollowed(kind, ref);
  return `<button class="btn follow${on ? ' on' : ''}" data-follow="${esc(kind)}" data-fref="${esc(String(ref))}" data-fname="${esc(name)}" data-fcover="${esc(String(cover || ''))}">${icon(on ? 'check' : 'plus')}<span>${t(on ? 'following' : 'follow')}</span></button>`;
}
function followCard(f) {
  if (f.kind === 'local') return { name: f.name, cover: Number(f.cover) || null, href: `#/artist?name=${encodeURIComponent(f.ref)}`, sub: t('artist') };
  const id = `fol:${f.kind}:${f.ref}`;
  if (f.cover) extCovers.set(id, f.cover);
  return { name: f.name, cover: id, href: `#/${f.kind === 'spotify' ? 'spartist' : 'cartist'}?id=${encodeURIComponent(f.ref)}`, sub: t('artist') };
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-follow]');
  if (!b) return;
  const { follow: kind, fref: ref, fname: name, fcover: cover } = b.dataset;
  const on = !b.classList.contains('on');
  b.classList.toggle('on', on);
  b.innerHTML = `${icon(on ? 'check' : 'plus')}<span>${t(on ? 'following' : 'follow')}</span>`;
  try {
    if (on) await put('/api/follows', { kind, ref, name, cover });
    else await del(`/api/follows?kind=${encodeURIComponent(kind)}&ref=${encodeURIComponent(ref)}`);
    await loadFollows(true);
    dropHome();
    toast(t(on ? 'followed' : 'unfollowed', { name }));
  } catch {
    b.classList.toggle('on', !on);
    b.innerHTML = `${icon(!on ? 'check' : 'plus')}<span>${t(!on ? 'following' : 'follow')}</span>`;
    toast(t('error'));
  }
});
function artistCards(list, row = false) {
  return `<div class="cards${row ? ' srow' : ''}">${list.map((a) => `<a class="card" href="${a.href}">${coverImg(a.cover, 'lg round')}<div class="c-title">${esc(a.name)}</div><div class="c-sub">${esc(a.sub || t('artist'))}</div></a>`).join('')}</div>`;
}
function plainAlbumCards(list, row = false) {
  return `<div class="cards${row ? ' srow' : ''}">${list.map((a) => `<a class="card" href="${a.href}">${coverImg(a.cover, 'lg')}<div class="c-title">${esc(a.title)}</div><div class="c-sub">${esc(a.artist || '')}</div></a>`).join('')}</div>`;
}
let searchSeq = 0;
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\(.*?\)|\[.*?\]|feat\..*$/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
async function runSearch(q) {
  const box = $('#results');
  if (!box) return;
  const seq = ++searchSeq;
  if (!q.trim()) return browseView(box);
  const mode = searchMode();
  const lq = q.trim().toLowerCase();
  const data = { q, mode, tracks: [], artists: [], albums: [], playlists: [], cat: null, ytm: [], note: '' };
  if (mode === 'all') {
    const [tr, albums, artists, pls] = await Promise.all([
      get('/api/tracks?limit=50&q=' + encodeURIComponent(q)).catch(() => ({ items: [] })),
      cached('albums', () => get('/api/albums')).catch(() => []),
      cached('artists', () => get('/api/artists')).catch(() => []),
      get('/api/playlists').catch(() => [])
    ]);
    if (seq !== searchSeq) return;
    data.tracks = tr.items || [];
    data.artists = artists.filter((a) => a.name.toLowerCase().includes(lq)).slice(0, 12).map((a) => ({ name: a.name, cover: a.cover_id, href: `#/artist?name=${encodeURIComponent(a.name)}`, sub: songCount(a.tracks) }));
    data.albums = albums.filter((a) => a.album.toLowerCase().includes(lq) || (a.artist || '').toLowerCase().includes(lq)).slice(0, 12).map((a) => ({ title: a.album, artist: a.artist, cover: a.cover_id, href: albumHref(a.album, a.artist) }));
    data.playlists = pls.filter((p) => p.name.toLowerCase().includes(lq)).map((p) => ({ title: p.name, artist: songCount(p.tracks), cover: p.cover_id, href: `#/playlist/${p.id}` }));
  }
  state.search = data;
  drawSearch(box, true);
  // the platforms follow as they arrive
  const later = [];
  const useSpotify = (mode === 'all' || mode === 'spotify') && spotify.connected();
  const deezer = () =>
    get('/api/catalog/search?q=' + encodeURIComponent(q)).then((c) => {
      data.cat = { tracks: (c.tracks || []).map(extTrack), artists: (c.artists || []).map(catArtist), albums: (c.albums || []).map(catAlbum), playlists: [], src: 'deezer' };
    });
  // like the Msik bot: names, covers and everything else from Spotify, the sound later from YouTube Music
  if (useSpotify)
    later.push(
      searchSpotifyAll(q)
        .then((r) => {
          if (!r) throw new Error('none');
          data.cat = { tracks: r.tracks.map(extTrack), artists: r.artists.map(spArtist), albums: r.albums.map(spAlbum), playlists: r.playlists.map(spPlaylist), src: 'spotify' };
        })
        .catch(() => (mode === 'all' ? deezer() : null))
        .catch(() => {})
    );
  else if (mode === 'spotify') data.note = 'spotifyConnectFirst';
  // without Spotify the public Deezer catalog fills in names and covers
  if (mode === 'all' && !useSpotify) later.push(deezer().catch(() => {}));
  // YouTube Music: only songs (the audio tracks), never videos
  if (mode === 'all' || mode === 'ytmusic') later.push(searchYouTubeMusic(q).then((l) => { data.ytm = l; }).catch(() => {}));
  for (const p of later) p.then(() => seq === searchSeq && state.search === data && drawSearch(box, false));
  await Promise.all(later);
  if (seq === searchSeq) drawSearch(box, false, true);
}
function drawSearch(box, loading, done = false) {
  const d = state.search;
  if (!d || !$('#results')) return;
  const cat = d.cat || { tracks: [], artists: [], albums: [], playlists: [] };
  // Spotify / catalog songs first (names and covers like on Spotify), YouTube Music songs after (same song only once)
  const key = (x) => norm(`${artistName(x).split(',')[0]} ${x.title}`);
  const seenSongs = new Set([...d.tracks, ...cat.tracks].map(key));
  const ytm = (d.ytm || []).filter((x) => !seenSongs.has(key(x)) && seenSongs.add(key(x)));
  const songs = [...d.tracks, ...cat.tracks, ...ytm];
  const artists = [...d.artists, ...cat.artists.filter((a) => !d.artists.some((x) => x.name.toLowerCase() === a.name.toLowerCase()))];
  const albums = [...d.albums, ...cat.albums];
  const playlists = [...d.playlists, ...(cat.playlists || [])];
  const has = { songs: songs.length, artists: artists.length, albums: albums.length, playlists: playlists.length };
  const f = has[state.sfilter] ? state.sfilter : 'all';
  const chips = `<div class="sfilters">${SFILTERS.filter((k) => k === 'all' || has[k]).map((k) => `<button class="sf ${f === k ? 'on' : ''}" data-sfilter="${k}">${t('sf_' + k)}</button>`).join('')}</div>`;
  if (!songs.length && !artists.length && !albums.length && !playlists.length) {
    box.innerHTML = d.note
      ? `<div class="noresult"><h3>${t(d.note)}</h3><div class="stack"><a class="btn primary" href="#/sources">${t('spotifyConnect')}</a></div></div>`
      : loading || !done
        ? `<p class="muted small">${t('searching')}</p>`
        : `<div class="noresult"><h3>${t('noResultsFor', { q: d.q })}</h3><p class="muted">${t('noResultsHint')}</p><div class="stack"><a class="btn" href="#/add">${icon('download')}${t('importAdd')}</a><a class="btn" href="#/sources">${t('manageSources')}</a></div></div>`;
    return;
  }
  let html = chips;
  const lq = d.q.trim().toLowerCase();
  if (f === 'all') {
    // top result: an artist that matches the words exactly, else the first song
    const topArtist = artists.find((a) => a.name.toLowerCase() === lq) || (!songs.length ? artists[0] : null);
    const topSong = !topArtist ? songs[0] : null;
    const top = topArtist
      ? `<a class="topres" href="${topArtist.href}">${coverImg(topArtist.cover, 'round')}<div class="tr-text"><div class="tr-title">${esc(topArtist.name)}</div><div class="tr-sub"><span class="pill">${t('artist')}</span></div></div><span class="tr-play">${icon('play')}</span></a>`
      : `<button class="topres" data-topsong>${coverImg(topSong.id)}<div class="tr-text"><div class="tr-title">${esc(topSong.title)}</div><div class="tr-sub">${esc(artistName(topSong))} <span class="pill">${topSong.ext ? srcBadge(topSong.ext.source) : t('song')}</span></div></div><span class="tr-play">${icon('play')}</span></button>`;
    state.topSong = topSong;
    const first = [...d.tracks, ...cat.tracks].length ? [...d.tracks, ...cat.tracks] : songs;
    html += `<div class="sgrid"><section class="sec"><div class="sec-head"><h2>${t('topResult')}</h2></div>${top}</section>${first.length ? `<section class="sec"><div class="sec-head"><h2>${t('tracks')}</h2>${songs.length > 4 ? `<button class="link" data-sfilter="songs">${t('showAll')}</button>` : ''}</div>${trackList(first.slice(0, 4), { album: false })}</section>` : ''}</div>`;
    if (artists.length) html += section(t('artists'), artistCards(artists.slice(0, 10), true), artists.length > 10 ? `<button class="link" data-sfilter="artists">${t('showAll')}</button>` : '');
    if (albums.length) html += section(t('albums'), plainAlbumCards(albums.slice(0, 10), true), albums.length > 10 ? `<button class="link" data-sfilter="albums">${t('showAll')}</button>` : '');
    if (playlists.length) html += section(t('playlists'), plainAlbumCards(playlists.slice(0, 10), true));
  } else if (f === 'songs') html += trackList(songs);
  else if (f === 'artists') html += artistCards(artists);
  else if (f === 'albums') html += plainAlbumCards(albums);
  else html += plainAlbumCards(playlists);
  if (!done) html += `<p class="muted small">${t('searchingMore')}</p>`;
  box.innerHTML = html;
}
async function browseView(box) {
  const recent = recentSearches();
  const albums = await cached('albums', () => get('/api/albums')).catch(() => []);
  if ($('#q')?.value.trim()) return;
  const hues = [12, 340, 262, 205, 160, 32, 290, 190];
  const tiles = [
    ['#/likes', t('likes'), 340],
    ['#/home', t('yourMix'), 262],
    ['#/library?tab=albums', t('albums'), 205],
    ['#/library?tab=artists', t('artists'), 160],
    ['#/library?tab=playlists', t('playlists'), 32],
    ['#/add', t('importAdd'), 12]
  ];
  let html = '';
  if (recent.length) html += section(t('recentSearches'), `<div class="chips">${recent.map((r) => `<span class="chip recent"><button data-recent="${esc(r)}">${esc(r)}</button><button class="x" data-unrecent="${esc(r)}" title="${t('remove')}">×</button></span>`).join('')}</div>`);
  html += section(t('browseAll'), `<div class="browse">${tiles.map(([h, l, hue]) => `<a class="bt hue" href="${h}" style="--h:${hue}"><span>${esc(l)}</span></a>`).join('')}${albums
    .slice(0, 18)
    .map((a, i) => `<a class="bt" href="${albumHref(a.album, a.artist)}" data-tint="${a.cover_id ? coverUrl(a.cover_id) : ''}" style="--h:${hues[i % hues.length]}"><span>${esc(a.album)}</span>${coverImg(a.cover_id)}</a>`)
    .join('')}</div>`);
  box.innerHTML = html;
  tintAll(box);
}
// Settings → Updates → playback check: asks the server to find and open one known song
document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-playcheck]')) return;
  const box = $('#playcheck');
  if (!box) return;
  box.innerHTML = `<p class="muted small">${t('searching')}</p>`;
  const line = (ok, text) => `<div class="pc-line ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✕'} ${esc(text)}</div>`;
  try {
    const r = await get('/api/ytcheck');
    const st = r.stream || {};
    box.innerHTML =
      line(r.search && !!r.pick, r.search ? (r.pick ? t('pcFound', { title: r.title || '', ms: r.search_ms }) : t('pcNoPick')) : t('pcNoSearch', { e: r.search_error || '' })) +
      (r.pick ? line(!!st.direct && st.opens !== false, st.direct ? (st.opens === false ? t('pcNoOpen') : t('pcStream', { ms: st.direct_ms })) : t('pcNoStream', { e: st.direct_error || '' })) : '') +
      (r.pick && !(st.direct && st.opens !== false) ? line(!!st.ytdlp, st.ytdlp ? t('pcYtdlp') : t('pcNoYtdlp')) : '') +
      `<div class="muted small">Server ${esc(r.version || '')}</div>`;
  } catch (err) {
    box.innerHTML = line(false, errorText(err));
  }
});
document.addEventListener('click', (e) => {
  const fb = e.target.closest('[data-sfilter]');
  if (fb) {
    state.sfilter = fb.dataset.sfilter;
    drawSearch($('#results'), false, true);
    $('#content').scrollTop = 0;
    return;
  }
  if (e.target.closest('[data-topsong]') && state.topSong) return player.playList([state.topSong], 0);
  const un = e.target.closest('[data-unrecent]');
  if (un) {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentSearches().filter((x) => x !== un.dataset.unrecent)));
    } catch {}
    return browseView($('#results'));
  }
  const rc = e.target.closest('[data-recent]');
  if (rc) {
    const inp = $('#q');
    inp.value = rc.dataset.recent;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  // a click on any result counts as a finished search
  if (state.route === 'search' && e.target.closest('#results .row, #results .card, #results .topres')) rememberSearch($('#q')?.value || '');
});

// catalog artist and album pages
// the same song often comes several times (album, single, deluxe, remaster): keep the first one
const songKey = (x) => {
  const n = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[([{].*?[)\]}]/g, '').replace(/\s+-\s+.*$/, '').replace(/\b(feat|ft|with)\b.*$/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return n(String(x.artist || '').split(/,|&| x /)[0]) + '|' + n(x.title);
};
function uniqSongs(list) {
  const seen = new Set();
  return (list || []).filter((x) => {
    const k = songKey(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
// ---------- artist pages, laid out like Spotify: popular songs, discography with filters, appears on, similar artists ----------
const REL_FILTERS = ['all', 'album', 'single', 'compilation'];
const relMatch = (r, f) => f === 'all' || (f === 'single' ? r.kind === 'single' || r.kind === 'ep' : r.kind === f);
function relList(list, f) {
  const out = list.filter((r) => relMatch(r, f));
  // "popular releases" where the platform says how many fans a record has, else the newest first
  return f === 'all' && out.some((r) => r.fans) ? out.slice().sort((a, b) => (b.fans || 0) - (a.fans || 0)) : out;
}
function releaseCards(list, grid = false) {
  return `<div class="cards ${grid ? 'libgrid relgrid' : 'srow'}">${list
    .map((a) => `<a class="card" href="${a.href}">${coverImg(a.cover, 'lg')}<div class="c-title">${esc(a.title)}</div><div class="c-sub">${esc([a.latest ? t('latestRelease') : a.year, a.kind === 'appears' ? a.artist : t('rel_' + a.kind)].filter(Boolean).join(' · '))}</div></a>`)
    .join('')}</div>`;
}
function relChips(list, f) {
  const pop = list.some((r) => r.fans);
  return `<div class="chips relchips">${REL_FILTERS.filter((k) => k === 'all' || list.some((r) => relMatch(r, k)))
    .map((k) => `<button class="chip ${k === f ? 'on' : ''}" data-relf="${k}">${t(k === 'all' ? (pop ? 'rel_popular' : 'rel_latest') : 'relf_' + k)}</button>`)
    .join('')}</div>`;
}
/** p: { base, name, header, tracks, releases, appears, related, tail } */
function artistPage(p, params) {
  const show = params.get('show');
  const f = REL_FILTERS.includes(params.get('f')) ? params.get('f') : 'all';
  if (p.releases[0]?.date) p.releases[0].latest = true;
  state.artistPage = { ...p, f, grid: show === 'discography' };
  const sub = (title) => `<button class="mback" data-back title="${t('back')}">${icon('back')}</button><div class="subhead"><a class="muted" href="${p.base}">${esc(p.name)}</a><h1>${esc(title)}</h1></div>`;
  if (show === 'discography') return sub(t('discography')) + relChips(p.releases, f) + `<div id="disco-cards">${releaseCards(relList(p.releases, f), true)}</div>`;
  if (show === 'appears') return sub(t('appearsOn')) + releaseCards(p.appears, true);
  if (show === 'related') return sub(t('fansAlsoLike')) + artistCards(p.related).replace('class="cards"', 'class="cards libgrid"');
  let html = p.header;
  // the same song from several records (album, deluxe, remaster) shows once
  const heard = new Set();
  const pop = p.tracks.filter((x) => { const k = sameSong(x.title); return !heard.has(k) && heard.add(k); }).slice(0, 10);
  if (pop.length) html += `<section class="sec"><div class="sec-head"><h2>${t('popular')}</h2></div><div class="pop${pop.length > 5 ? ' short' : ''}">${trackList(pop)}${pop.length > 5 ? `<button class="link morebtn" data-popmore>${t('seeMore')}</button>` : ''}</div></section>`;
  const all = (what, n) => (n > 6 ? `<a class="link" data-showall href="${p.base}&show=${what}">${t('showAll')}</a>` : '');
  if (p.releases.length) html += `<section class="sec"><div class="sec-head"><h2>${t('discography')}</h2>${all('discography', p.releases.length)}</div>${relChips(p.releases, f)}<div id="disco-cards">${releaseCards(relList(p.releases, f).slice(0, 14))}</div></section>`;
  if (p.related?.length) html += section(t('fansAlsoLike'), artistCards(p.related.slice(0, 12), true), all('related', p.related.length));
  if (p.appears?.length) html += section(t('appearsOn'), releaseCards(p.appears.slice(0, 14)), all('appears', p.appears.length));
  return html + (p.tail || '');
}
document.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-relf]');
  const ap = state.artistPage;
  if (chip && ap) {
    ap.f = chip.dataset.relf;
    chip.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
    const list = relList(ap.releases, ap.f);
    $('#disco-cards').innerHTML = releaseCards(ap.grid ? list : list.slice(0, 14), ap.grid);
    const more = chip.closest('.sec')?.querySelector('[data-showall]');
    if (more) more.href = `${ap.base}&show=discography&f=${ap.f}`;
    if (ap.grid) history.replaceState(history.state, '', `${ap.base}&show=discography&f=${ap.f}`);
    return;
  }
  const more = e.target.closest('[data-popmore]');
  if (more) {
    const short = more.parentElement.classList.toggle('short');
    more.textContent = t(short ? 'seeMore' : 'seeLess');
  }
});
// a name without a page of its own (imported songs, YouTube): find the artist and go there, without a stop at the search
views.findartist = async (params) => {
  const name = (params.get('name') || '').trim();
  const same = (x) => String(x || '').trim().toLowerCase() === name.toLowerCase();
  let to = '';
  if (name) {
    const sp = await spotifyFindArtist(name).catch(() => null);
    if (sp) to = `#/spartist?id=${encodeURIComponent(sp.id)}`;
    if (!to) {
      const mine = await cached('artists', () => get('/api/artists')).catch(() => []);
      const hit = mine.find((a) => same(a.name));
      if (hit) to = `#/artist?name=${encodeURIComponent(hit.name)}`;
    }
    if (!to) {
      const c = await get('/api/catalog/search?q=' + encodeURIComponent(name)).catch(() => null);
      const hit = c?.artists?.find((a) => same(a.name)) || c?.artists?.[0];
      if (hit) to = `#/cartist?id=${encodeURIComponent(hit.id)}`;
    }
  }
  // the lookup takes the place of this stop in the history, so "back" returns to where the name was clicked
  location.replace(to || `#/search?q=${encodeURIComponent(name)}`);
  return '<div class="loading"></div>';
};
const relatedCards = (list) => (list || []).map((a) => {
  const id = 'dzartist:' + a.id;
  if (a.picture) extCovers.set(id, a.picture);
  return { name: a.name, cover: id, sub: t('artist') };
});
/** Monthly listeners like Spotify shows them (read by the server; exact when a source has the full count). */
const listenersCache = new Map(); // id -> { at, p }, kept 10 minutes so an open page always shows a fresh count
function showListeners(spId, name) {
  const run = async () => {
    try {
      let id = spId;
      if (!id && name) id = (await spotifyFindArtist(name))?.id;
      if (!id) return;
      const hit = listenersCache.get(id);
      if (!hit || Date.now() - hit.at > 600000) listenersCache.set(id, { at: Date.now(), p: get('/api/catalog/sp-listeners/' + id).catch(() => null) });
      const r = await listenersCache.get(id).p;
      const n = r?.listeners;
      if (!n) listenersCache.delete(id); // ask again next time instead of keeping a miss
      const el = document.querySelector('[data-listeners]');
      if (!n || !el) return;
      const loc = getLang() === 'de' ? 'de-DE' : 'en-US';
      // exact: the full number ("94,117,336 monthly listeners"); rounded source: short like Spotify's header ("4 Mio.")
      const fmt = r.exact === false
        ? new Intl.NumberFormat(loc, { notation: 'compact', compactDisplay: 'short', maximumFractionDigits: 1 }).format(n)
        : new Intl.NumberFormat(loc).format(n);
      el.textContent = t('monthlyListeners', { n: fmt });
    } catch {}
  };
  setTimeout(run, 30);
}
views.cartist = async (params) => {
  const id = params.get('id') || '';
  const r = await cached('cartist:' + id, () => get('/api/catalog/artist/' + encodeURIComponent(id)));
  const a = catArtist(r.artist);
  await loadFollows();
  const tracks = uniqSongs((r.tracks || []).map(extTrack));
  state.detail = { cartist: tracks };
  const rel = (r.albums || []).map((x) => ({ ...catAlbum(x), year: x.year || '', date: x.date || '', fans: x.fans || 0, kind: x.kind || 'album' }));
  showListeners('', a.name);
  return artistPage({
    base: `#/cartist?id=${encodeURIComponent(id)}`,
    name: a.name,
    header: detailHeader({ coverId: a.cover, round: true, kind: t('artist'), title: a.name, sub: `<span data-listeners>${r.artist.fans ? t('fans', { n: r.artist.fans.toLocaleString() }) : ''}</span>`, actions: (tracks.length ? listActions('cartist') : '') + followBtn('deezer', id, a.name, r.artist.picture) }),
    tracks,
    releases: rel.filter((x) => x.kind !== 'appears'),
    appears: rel.filter((x) => x.kind === 'appears'),
    related: relatedCards(r.related).map((c, i) => ({ ...c, href: `#/cartist?id=${encodeURIComponent(r.related[i].id)}` }))
  }, params);
};
/** Save an album of an artist into the library, like on Spotify; once saved it leads to the saved copy. */
async function albumSaveBtn(url) {
  const imps = await get('/api/imports').catch(() => []);
  const have = imps.find((im) => im.url === url);
  return have
    ? `<a class="btn saved" href="#/imported/${have.id}" title="${t('inLibrary')}">${icon('check')}${t('albumInLibrary')}</a>`
    : `<button class="btn" data-spsave>${icon('plusCircle')}${t('saveAlbum')}</button>`;
}
views.calbum = async (params) => {
  const r = await get('/api/fetch/deezer?type=album&id=' + encodeURIComponent(params.get('id') || ''));
  const tracks = (r.items || []).map(extTrack);
  const cid = 'dzalbum:' + params.get('id');
  if (r.cover) extCovers.set(cid, r.cover);
  state.detail = { calbum: tracks };
  const url = 'https://www.deezer.com/album/' + params.get('id');
  state.spPending = { source: 'deezer', name: r.name, cover: r.cover || '', items: r.items || [], url, album: true, meta: { kind: 'album', artist: tracks[0]?.artist || '' } };
  let html = detailHeader({ coverId: cid, kind: t('album'), title: r.name, sub: `${esc(tracks[0]?.artist || '')} · ${songCount(tracks.length)}`, actions: tracks.length ? listActions('calbum') + (await albumSaveBtn(url)) : '' });
  html += section(t('tracks'), trackList(tracks));
  return html;
};
views.cplaylist = async (params) => {
  const r = await get('/api/fetch/deezer?type=playlist&id=' + encodeURIComponent(params.get('id') || ''));
  const tracks = (r.items || []).map(extTrack);
  const cid = 'dzpl:' + params.get('id');
  if (r.cover) extCovers.set(cid, r.cover);
  state.detail = { cplaylist: tracks };
  state.spPending = { source: 'deezer', name: r.name, cover: r.cover || '', items: r.items || [], url: 'https://www.deezer.com/playlist/' + params.get('id') };
  const total = tracks.reduce((n, x) => n + (x.duration || 0), 0);
  return detailHeader({ coverId: cid, kind: t('playlist'), title: r.name, sub: `${songCount(tracks.length)}${total ? ', ' + fmtLong(total) : ''}`, actions: tracks.length ? listActions('cplaylist') + `<button class="icon-btn lg" data-preload="cplaylist" title="${t('preload')}">${icon('bolt')}</button>` + offBtn('cp' + String(params.get('id') || '').replace(/\W/g, ''), 'cplaylist', r.name || '') + `<button class="btn" data-spsave>${icon('plus')}${t('saveToLibrary')}</button>` : '' }) + trackList(tracks);
};
views.spartist = async (params) => {
  const id = params.get('id') || '';
  const r = await spotifyArtist(id);
  const a = spArtist(r.artist);
  await loadFollows();
  const tracks = uniqSongs(r.tracks.map(extTrack));
  state.detail = { spartist: tracks };
  const count = r.artist.followers ? t('followersN', { n: r.artist.followers.toLocaleString() }) : r.artist.fans ? t('fans', { n: r.artist.fans.toLocaleString() }) : '';
  const sub = [count, r.artist.genres.slice(0, 3).join(', ')].filter(Boolean).join(' · ');
  showListeners(id, '');
  const rel = (x) => ({ ...spAlbum(x), artist: x.artist, year: x.year, date: x.date, kind: x.kind });
  return artistPage({
    base: `#/spartist?id=${encodeURIComponent(id)}`,
    name: a.name,
    header: detailHeader({ coverId: a.cover, round: true, kind: t('artist'), title: a.name, badge: srcBadge('spotify'), sub: `<span data-listeners>${esc(sub)}</span>`, actions: (tracks.length ? listActions('spartist') : '') + followBtn('spotify', id, a.name, r.artist.picture) }),
    tracks,
    releases: r.releases.map(rel),
    appears: r.appears.map(rel),
    related: relatedCards(r.related).map((c) => ({ ...c, href: findArtistHref(c.name, 'spotify') }))
  }, params);
};
views.spalbum = async (params) => {
  const id = params.get('id') || '';
  const r = await spotifyAlbum(id);
  const tracks = r.items.map(extTrack);
  const cid = 'spalbum:' + id;
  if (r.cover) extCovers.set(cid, r.cover);
  state.detail = { spalbum: tracks };
  const url = 'https://open.spotify.com/album/' + id;
  state.spPending = { source: 'spotify', name: r.name, cover: r.cover || '', items: r.items || [], url, album: true, meta: { kind: 'album', artist: r.artist || '' } };
  const total = tracks.reduce((n, x) => n + (x.duration || 0), 0);
  const who = r.artistId ? `<a href="#/spartist?id=${r.artistId}"><b>${esc(r.artist)}</b></a>` : `<b>${esc(r.artist)}</b>`;
  let html = detailHeader({ coverId: cid, kind: t('album'), title: r.name, sub: `${srcBadge('spotify')} ${who}${r.year ? ' · ' + r.year : ''} · ${songCount(tracks.length)}, ${fmtLong(total)}`, actions: tracks.length ? listActions('spalbum') + offBtn('spa_' + id, 'spalbum', r.name || '') + (await albumSaveBtn(url)) : '' });
  html += trackList(tracks);
  if (r.label) html += `<p class="muted small credits">${esc(r.label)}</p>`;
  return html;
};
views.spplaylist = async (params) => {
  const id = params.get('id') || '';
  const r = await spotifyPlaylist(id, 'https://open.spotify.com/playlist/' + id, (n, tot) => importStatus(t('importLoading', { n, total: tot }), (n / tot) * 100)).finally(() => importStatus(null));
  const tracks = r.items.map(extTrack);
  const cid = 'sppl:' + id;
  if (r.cover) extCovers.set(cid, r.cover);
  state.detail = { sppl: tracks };
  state.spPending = { ...r, url: 'https://open.spotify.com/playlist/' + id };
  const m = r.meta || {};
  const total = tracks.reduce((n, x) => n + (x.duration || 0), 0);
  return detailHeader({
    coverId: cid,
    kind: t('playlist'),
    title: r.name,
    sub: `${m.description ? `<span class="dh-desc">${esc(m.description)}</span>` : ''}${srcBadge('spotify')} ${m.owner ? `<b>${esc(m.owner)}</b> · ` : ''}${m.followers ? t('likesN', { n: m.followers.toLocaleString() }) + ' · ' : ''}${songCount(tracks.length)}, ${fmtLong(total)}`,
    actions: listActions('sppl') + `<button class="icon-btn lg" data-preload="sppl" title="${t('preload')}">${icon('bolt')}</button>` + offBtn('sp_' + id, 'sppl', r.name || '') + `<button class="btn" data-spsave>${icon('plus')}${t('saveToLibrary')}</button>`
  }) + trackList(tracks);
};
document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-spsave]') || !state.spPending) return;
  const r = state.spPending;
  try {
    importStatus(t('importMatching', { n: r.items.length }));
    const res = await saveImport({ source: r.source || 'spotify', name: r.name, url: r.url, cover: r.cover || '', meta: r.meta || {}, items: r.items });
    importStatus(null);
    renderSidebarPlaylists();
    // a saved album stays open, its button turns into "Saved"
    if (r.album) {
      toast(t('albumSaved', { name: r.name }));
      return render();
    }
    toast(t('importDone', { name: r.name }));
    go('#/imported/' + res.id);
  } catch (err) {
    importStatus(null);
    toast(errorText(err));
  }
});

let searchTimer;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  clearTimeout(searchTimer);
  const q = e.target.value;
  history.replaceState(null, '', '#/search' + (q ? '?q=' + encodeURIComponent(q) : ''));
  searchTimer = setTimeout(() => runSearch(q).catch(() => {}), 180);
});
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'q' && e.key === 'Enter') {
    rememberSearch(e.target.value);
    e.target.blur();
  }
});

async function cached(key, fn) {
  if (!state.cache[key]) state.cache[key] = await fn();
  return state.cache[key];
}

const LIB_TABS = ['tracks', 'albums', 'artists', 'playlists', 'imported'];
views.library = async (params) => {
  const tab = LIB_TABS.includes(params.get('tab')) ? params.get('tab') : 'tracks';
  let body = '';
  if (tab === 'tracks') {
    const sort = params.get('sort') || 'artist';
    const r = await get(`/api/tracks?limit=1000&sort=${sort}`);
    state.libTracks = r.items;
    const SORTS = { artist: t('artist'), title: t('sortTitle'), album: t('album'), added: t('added') };
    // one quiet row like Spotify: sort on the left, count, shuffle and a round play button on the right
    body = `<div class="libbar"><button class="sortbtn" data-libsort="${sort}">${icon('sort')}<span>${SORTS[sort] || SORTS.artist}</span></button><span class="muted small">${songCount(r.total)}</span><span class="grow"></span><button class="icon-btn lg" data-shufflelib title="${t('shuffle')}">${icon('shuffle')}</button><button class="playround" data-playlib title="${t('playAll')}">${icon('play')}</button></div>
      ${trackList(r.items)}`;
  } else if (tab === 'albums') {
    state.cache.albums = await get('/api/albums');
    body = albumCards(state.cache.albums).replace('class="cards"', 'class="cards libgrid"');
  } else if (tab === 'artists') {
    state.cache.artists = await get('/api/artists');
    const fol = await loadFollows(true);
    body = `${fol.length ? section(t('following'), artistCards(fol.map(followCard)).replace('class="cards"', 'class="cards libgrid"')) + (state.cache.artists.length ? `<div class="sec-head"><h2>${t('inLibrary')}</h2></div>` : '') : state.cache.artists.length ? '' : `<p class="muted empty">${t('followNone')}</p>`}<div class="cards libgrid">${state.cache.artists
      .map(
        (a) => `<a class="card artist" href="#/artist?name=${encodeURIComponent(a.name)}">${coverImg(a.cover_id, 'lg round')}<div class="c-title">${esc(a.name)}</div><div class="c-sub">${songCount(a.tracks)}</div></a>`
      )
      .join('')}</div>`;
  } else if (tab === 'imported') {
    const list = (await get('/api/imports')).filter((im) => !im.kept);
    body = `<div class="libbar"><a class="sortbtn" href="#/add">${icon('download')}<span>${t('importAdd')}</span></a></div>
      ${list.length ? `<div class="cards libgrid"> ${list.map((im) => `<a class="card" data-ref="import:${im.id}" href="#/imported/${im.id}">${im.art ? coverImg(artKey('import', im.id, im.art), 'lg') : im.cover ? `<div class="cover lg"><img loading="lazy" alt="" src="${esc(im.cover)}"></div>` : coverImg(im.cover_id, 'lg')}<div class="c-title">${esc(im.name)}</div><div class="c-sub">${srcBadge(im.source)} ${t('importedOf', { local: im.matched, total: im.total })}</div></a>`).join('')}</div>` : `<p class="muted empty">${t('importNone')}</p>`}`;
  } else {
    const [lists, imps] = await Promise.all([get('/api/playlists'), get('/api/imports').catch(() => [])]);
    const kept = imps.filter((im) => im.kept);
    for (const im of kept) if (im.cover && !im.art) extCovers.set('impc:' + im.id, im.cover);
    body = `<div class="cards libgrid" data-sortpl><a class="card" href="#/likes"><div class="cover lg liked">${icon('heartFill')}</div><div class="c-title">${t('likes')}</div></a>${(await loadTopSongs()).map(topCard).join('')}
      ${byPlOrder([
        ...lists.map((p) => ['playlist:' + p.id, `<a class="card" data-ref="playlist:${p.id}" href="#/playlist/${p.id}">${coverImg(artKey('playlist', p.id, p.art) || p.cover_id, 'lg')}<div class="c-title">${esc(p.name)}</div><div class="c-sub">${songCount(p.tracks)}</div></a>`]),
        ...kept.map((im) => ['import:' + im.id, `<a class="card" data-ref="import:${im.id}" href="#/imported/${im.id}">${coverImg(artKey('import', im.id, im.art) || (im.cover ? 'impc:' + im.id : im.cover_id), 'lg')}<div class="c-title">${esc(im.name)}</div><div class="c-sub">${songCount(im.total)}</div></a>`])
      ], (x) => x[0]).map((x) => x[1]).join('')}</div>
      ${lists.length + kept.length > 1 ? `<p class="muted small sorthint">${t('dragToSort')}</p>` : ''}`;
  }
  return `${pageHead(t('yourLibrary'), `<button class="icon-btn" data-newpl title="${t('newPlaylist')}">${icon('plus')}</button>`)}<div class="tabs">${LIB_TABS.map((x) => `<a class="tab ${x === tab ? 'on' : ''}" href="#/library?tab=${x}">${t(x)}</a>`).join('')}</div>${body}`;
};
document.addEventListener('change', (e) => {
  if (e.target.id === 'sort') go(`#/library?tab=tracks&sort=${e.target.value}`);
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-libsort]');
  if (!b) return;
  const SORTS = { artist: t('artist'), title: t('sortTitle'), album: t('album'), added: t('added') };
  menu(b, Object.entries(SORTS).map(([k, label]) => ({ label: (k === b.dataset.libsort ? '✓ ' : '') + label, icon: 'sort', run: () => go(`#/library?tab=tracks&sort=${k}`) })));
});
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-playlib]') && state.libTracks) player.playList(state.libTracks, 0);
  if (e.target.closest('[data-shufflelib]') && state.libTracks) player.playList(state.libTracks, 0, { shuffle: true });
  if (e.target.closest('[data-newpl]')) {
    const p = await playlistDialog();
    if (p) {
      renderSidebarPlaylists();
      go('#/playlist/' + p.id);
    }
  }
});

function detailHeader({ coverId, kind, title, sub, round = false, actions = '', edit = '', badge = '' }) {
  const cover = coverImg(coverId, 'xl' + (round ? ' round' : ''));
  return `<button class="mback" data-back title="${t('back')}">${icon('back')}</button><div class="detail-head" ${coverId ? `data-tint="${coverUrl(coverId)}"` : ''}>${edit ? `<button class="dh-cover" data-edit="${edit}" title="${t('editDetails')}">${cover}<span class="dh-over">${icon('edit')}${t('choosePhoto')}</span></button>` : cover}<div class="dh-text"><div class="muted kind">${esc(kind)}</div><h1${edit ? ` class="editable" data-edit="${edit}" title="${t('editDetails')}"` : ''}>${badge}${esc(title)}</h1><div class="muted">${sub}</div>
    <div class="toolbar">${actions}</div></div></div>`;
}

/** "Make available offline" for any list in the phone and computer apps. */
function offBtn(key, list, name) {
  return offline.ok() && !offlineMode ? `<button class="icon-btn lg offbtn" data-offpl="${esc(key)}" data-offlist="${esc(list)}" data-offname="${esc(name)}" title="${t('offDownload')}">${icon('download')}<span class="sr"></span></button>` : '';
}
function listActions(key) {
  return `<button class="btn primary" data-playkey="${key}">${icon('play')}${t('playAll')}</button><button class="btn" data-shufflekey="${key}">${icon('shuffle')}${t('shuffle')}</button>`;
}
document.addEventListener('click', (e) => {
  const p = e.target.closest('[data-playkey]');
  const s = e.target.closest('[data-shufflekey]');
  const key = p?.dataset.playkey || s?.dataset.shufflekey;
  if (!key) return;
  // the list that is already playing: the big play button pauses and goes on, like Spotify
  if (p && sourcePlaying(location.hash + '|' + key)) return player.toggle();
  const list = state.detail?.[key];
  if (list?.length) {
    player.playList(list, 0, { shuffle: !!s });
    markSource(location.hash + '|' + key);
  }
});
// which list the queue was started from, so its play button can show pause and pause it
let playSrc = { key: '', queue: null };
const markSource = (key) => {
  // the name of the page it was started on, for the head of the panel on the right in Green
  playSrc = { key, queue: player.queue, name: key === 'mix' ? t('mixForYou') : document.querySelector('#view .detail-head h1')?.textContent || '' };
  paintPlayButtons();
};
const sourceActive = (key) => playSrc.key === key && player.queue === playSrc.queue && !!player.current;
const sourcePlaying = (key) => sourceActive(key);
function paintPlayButtons() {
  document.querySelectorAll('[data-playkey]').forEach((b) => {
    const on = sourceActive(location.hash + '|' + b.dataset.playkey) && player.playing;
    if (b.dataset.on === String(on)) return;
    b.dataset.on = String(on);
    b.innerHTML = `${icon(on ? 'pause' : 'play')}${t(on ? 'pause' : 'playAll')}`;
  });
  document.querySelectorAll('[data-playmix]').forEach((b) => {
    const big = b.classList.contains('btn');
    if (!b.classList.contains('playcircle') && !big) return;
    const on = sourceActive('mix') && player.playing;
    if (b.dataset.on === String(on)) return;
    b.dataset.on = String(on);
    b.innerHTML = icon(on ? 'pause' : 'play') + (big ? t(on ? 'pause' : 'playAll') : '');
    b.title = t(on ? 'pause' : 'playAll');
  });
}

views.album = async (params) => {
  const r = await get(`/api/album?album=${encodeURIComponent(params.get('album') || '')}&artist=${encodeURIComponent(params.get('artist') || '')}`);
  state.detail = { album: r.tracks };
  const total = r.tracks.reduce((s, x) => s + x.duration, 0);
  const year = r.tracks.find((x) => x.year)?.year;
  return (
    detailHeader({
      coverId: r.tracks[0]?.id,
      kind: t('album'),
      title: r.album || t('unknownAlbum'),
      sub: `<a href="#/artist?name=${encodeURIComponent(r.artist)}">${esc(r.artist)}</a>${year ? ' · ' + year : ''} · ${songCount(r.tracks.length)} · ${fmtTime(total)}`,
      actions: listActions('album') + shareBtn('album', { album: r.album, artist: r.artist }, r.album)
    }) + trackList(r.tracks, { album: false })
  );
};

views.artist = async (params) => {
  const name = params.get('name') || '';
  const r = await get(`/api/artist?name=${encodeURIComponent(name)}`);
  r.top = uniqSongs(r.top);
  r.tracks = uniqSongs(r.tracks);
  await loadFollows();
  state.detail = { artist: r.tracks };
  if (enabled('spotify')) showListeners('', name);
  const albums = [];
  const seen = new Set();
  for (const x of r.tracks) {
    if (!x.album || seen.has(x.album.toLowerCase())) continue;
    seen.add(x.album.toLowerCase());
    albums.push({ title: x.album, year: x.year || '', date: '', kind: 'album', cover: x.id, href: albumHref(x.album, x.album_artist || x.artist) });
  }
  albums.sort((a, b) => (b.year || 0) - (a.year || 0));
  return artistPage({
    base: `#/artist?name=${encodeURIComponent(name)}`,
    name: r.name,
    header: detailHeader({
      coverId: r.tracks[0]?.id,
      round: true,
      kind: t('artist'),
      title: r.name,
      sub: `${songCount(r.tracks.length)}<span class="dh-lst"> · <span data-listeners></span></span>`,
      actions: listActions('artist') + `<button class="btn" data-radioartist>${icon('radio')}${t('startRadio')}</button>` + followBtn('local', r.name, r.name, r.tracks[0]?.id || '')
    }),
    tracks: r.top,
    releases: albums,
    tail: section(t('tracks'), trackList(r.tracks))
  }, params);
};
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-radioartist]') && state.detail?.artist?.length) {
    const list = state.detail.artist;
    startRadio(list[Math.floor(Math.random() * list.length)]);
  }
});

views.likes = async () => {
  const [local] = await Promise.all([get('/api/likes'), loadExtLikes()]);
  const tracks = [...[...extLikes.values()].map(histTrack), ...local];
  state.detail = { likes: tracks };
  return (
    detailHeader({ coverId: likesArtKey(), kind: t('playlist'), title: settings.likesName || t('likes'), edit: `likes:${conn.user?.id || 0}`, sub: (settings.likesDesc ? `<span class="dh-desc">${esc(settings.likesDesc)}</span>` : '') + songCount(tracks.length), actions: listActions('likes') + `<button class="icon-btn lg" data-preload="likes" title="${t('preload')}">${icon('bolt')}</button>` + offBtn('likes', 'likes', t('likes')) }).replace(
      `<div class="cover xl ph">${icon('note')}</div>`,
      `<div class="cover xl liked">${icon('heartFill')}</div>`
    ) + trackList(tracks)
  );
};

views.playlist = async (params, id) => {
  const pl = await get(`/api/playlists/${id}`);
  state.detail = { pl: pl.tracks };
  const who = pl.mine === false ? `${esc(t('sharedBy', { name: pl.owner }))} · ` : '';
  const edit = pl.canEdit !== false;
  // people in the playlist: contributors can change it, listeners only listen. The owner switches roles on a tap.
  const members = pl.members?.length
    ? `<div class="pl-members">${icon('user')}<span>${esc(t('members'))}:</span>${pl.members.map((m) => `<span class="pill ${m.role === 'listen' ? 'listen' : ''}">${pl.mine !== false ? `<button class="role" data-memberrole="${pl.id}:${m.id}:${m.role || 'edit'}" title="${t('changeRole')}">` : '<span class="role">'}${icon(m.role === 'listen' ? 'headphones' : 'edit')}${esc(m.name)}<span class="rl">${t(m.role === 'listen' ? 'roleListen' : 'roleEdit')}</span>${pl.mine !== false ? '</button>' : '</span>'}${pl.mine !== false ? `<button class="x" data-rmmember="${pl.id}:${m.id}" title="${t('remove')}">×</button>` : ''}</span>`).join('')}</div>`
    : '';
  const readOnly = edit ? '' : `<p class="muted small pl-ro">${icon('headphones')}${esc(t('listenOnlyHint', { name: pl.owner }))}</p>`;
  return (
    detailHeader({
      coverId: artKey('playlist', pl.id, pl.art) || pl.tracks[0]?.id,
      kind: t('playlist'),
      title: pl.name,
      sub: `${pl.description ? `<span class="pl-desc">${esc(pl.description)}</span>` : ''}${who}${songCount(pl.tracks.length)} · ${fmtTime(pl.tracks.reduce((s, x) => s + x.duration, 0))}`,
      edit: pl.mine !== false ? `playlist:${pl.id}` : '',
      // like Spotify: one big play button, the rest as quiet icons
      actions: `<button class="btn primary" data-playkey="pl">${icon('play')}${t('playAll')}</button>` +
        `<button class="icon-btn lg" data-shufflekey="pl" title="${t('shuffle')}">${icon('shuffle')}</button>` +
        (edit ? `<button class="icon-btn lg" data-pladd="${pl.id}" title="${t('addSongs')}">${icon('plus')}</button>` : '') +
        `<button class="icon-btn lg" data-preload="pl" title="${t('preload')}">${icon('bolt')}</button>` +
        offBtn('pl' + pl.id, 'pl', pl.name) +
        `<button class="icon-btn lg" data-plshare="${pl.id}" title="${t('share')}">${icon('share')}</button>` +
        (pl.mine !== false ? `<button class="icon-btn lg" data-edit="playlist:${pl.id}" title="${t('editDetails')}">${icon('edit')}</button>` : '') +
        (pl.mine !== false && pl.tracks.length ? `<button class="icon-btn lg m-only" data-pledit="playlist:${pl.id}" title="${t('editMode')}">${icon('drag')}</button>` : '') +
        `<button class="icon-btn lg" data-cmenu="playlist:${pl.id}" title="…">${icon('more')}</button>`
    }) + members + readOnly + trackList(pl.tracks, { playlistId: edit ? pl.id : null, reorder: pl.mine !== false })
  );
};
// songs preloaded before: the button then only fetches what was added since
const preloadedIds = (() => {
  try { return new Set(JSON.parse(localStorage.getItem('musik.preloaded') || '[]')); } catch { return new Set(); }
})();
function savePreloaded() {
  try { localStorage.setItem('musik.preloaded', JSON.stringify([...preloadedIds].slice(-6000))); } catch {}
}
/** Marks the preload button as done while every song of the list is preloaded already. */
function paintPreload() {
  const b = $('[data-preload]');
  if (!b) return;
  const list = state.detail?.[b.dataset.preload] || [];
  const done = !prefs.preloadAll && list.length > 0 && list.every((tr) => preloadedIds.has(String(tr.id)));
  b.classList.toggle('on', done);
  b.title = done ? t('preloadDone') : t('preload');
}
// ---------- playlist tools: preload, add songs, drag to reorder (PC) and an edit mode (phone) ----------
document.addEventListener('click', async (e) => {
  const pre = e.target.closest('[data-preload]');
  if (pre) {
    if (pre.classList.contains('busy')) return;
    const all = state.detail?.[pre.dataset.preload] || [];
    // only the songs that are new since the last time, unless the setting says to load everything again
    const list = prefs.preloadAll ? all : all.filter((tr) => !preloadedIds.has(String(tr.id)));
    if (!list.length) return toast(t('preloadDone'));
    pre.classList.add('busy');
    const n = await preloadSongs(list, (d, total) => {
      pre.style.setProperty('--p', total ? (d / total) * 100 + '%' : '0%');
      pre.title = t('preloading', { n: d, total });
    });
    pre.classList.remove('busy');
    list.forEach((tr) => preloadedIds.add(String(tr.id)));
    savePreloaded();
    pre.classList.add('on');
    pre.title = t('preload');
    toast(n ? t('preloaded', { n }) : t('preloadNothing'));
    return;
  }
  const add = e.target.closest('[data-pladd]');
  if (add) return addSongsDialog(Number(add.dataset.pladd));
  const ed = e.target.closest('[data-pledit]');
  if (ed) return reorderDialog(ed.dataset.pledit);
});
/** Search and add songs right inside the playlist, like Spotify's "Let's find something for your playlist". */
function addSongsDialog(id) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal addsongs"><div class="modal-head"><h2>${t('addSongs')}</h2><button class="icon-btn" data-x>${icon('close')}</button></div>
    <div class="searchbar">${icon('search')}<input type="search" placeholder="${t('addSongsPh')}" autocomplete="off"></div><div class="as-list"><p class="muted small">${t('addSongsHint')}</p></div></div>`;
  document.body.appendChild(wrap);
  const input = wrap.querySelector('input');
  const box = wrap.querySelector('.as-list');
  let found = [];
  let seq = 0;
  let timer = 0;
  const close = () => (wrap.remove(), render());
  wrap.addEventListener('click', async (e) => {
    if (e.target === wrap || e.target.closest('[data-x]')) return close();
    const b = e.target.closest('[data-asadd]');
    if (!b || b.disabled) return;
    const tr = found[Number(b.dataset.asadd)];
    b.disabled = true;
    try {
      await post(`/api/playlists/${id}/tracks`, { trackIds: [tr.id] });
      b.innerHTML = icon('check');
      b.classList.add('on');
    } catch (err) {
      b.disabled = false;
      toast(errorText(err));
    }
  });
  const search = async (q) => {
    const my = ++seq;
    if (!q.trim()) return (box.innerHTML = `<p class="muted small">${t('addSongsHint')}</p>`);
    box.innerHTML = `<p class="muted small">${t('searching')}</p>`;
    const [mine, cat] = await Promise.all([
      get('/api/tracks?limit=20&q=' + encodeURIComponent(q)).then((r) => r.items || []).catch(() => []),
      (spotify.connected() ? searchSpotifyAll(q).then((r) => (r?.tracks || []).map(extTrack)) : Promise.reject())
        .catch(() => get('/api/catalog/search?q=' + encodeURIComponent(q)).then((c) => (c.tracks || []).map(extTrack)))
        .catch(() => [])
    ]);
    if (my !== seq) return;
    const seen = new Set();
    found = [...mine, ...cat].filter((x) => {
      const k = norm(`${artistName(x)} ${x.title}`);
      return !seen.has(k) && seen.add(k);
    }).slice(0, 30);
    box.innerHTML = found.length
      ? found.map((x, i) => `<div class="as-row">${coverImg(x.id, 'sm')}<div class="main"><div class="title">${esc(x.title)}</div><div class="sub">${esc(artistName(x))}</div></div><button class="btn sm" data-asadd="${i}">${t('add')}</button></div>`).join('')
      : `<p class="muted small">${t('noResults')}</p>`;
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => search(input.value), 300);
  });
  setTimeout(() => input.focus(), 50);
}
/** Phone: an edit list with handles to drag songs into a new order, like Spotify's "Edit playlist". */
async function reorderDialog(ref) {
  // own playlists and imported playlists (songs from Spotify & co.) both have an edit mode
  const [kind, sid] = String(ref).includes(':') ? String(ref).split(':') : ['playlist', ref];
  const id = Number(sid);
  let order, save, title = '';
  if (kind === 'import') {
    const r = await get('/api/imports/' + id);
    title = r.name;
    order = r.items.map((it) => {
      const cid = it.local ? it.local.id : 'ro:' + it.pos;
      if (!it.local && it.cover) extCovers.set(cid, it.cover);
      return { cid, title: it.local?.title || it.title, artist: it.local ? artistName(it.local) : it.artist, item: it };
    });
    save = () => put('/api/imports/' + id, { items: order.map(({ item: it }) => ({ source: it.source, ext_id: it.ext_id, title: it.title, artist: it.artist, album: it.album, duration: it.duration, cover: it.cover, url: it.url })) });
  } else {
    const pl = await get(`/api/playlists/${id}`);
    title = pl.name;
    order = pl.tracks.map((x) => ({ cid: x.id, title: x.title, artist: artistName(x), id: x.id }));
    save = () => put(`/api/playlists/${id}`, { trackIds: order.map((x) => x.id) });
  }
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  const rows = () => order.map((x, i) => `<div class="ro-row" data-ri="${i}"><button class="icon-btn sm ro-rm" data-rorm="${i}" title="${t('remove')}">${icon('minusCircle')}</button>${coverImg(x.cid, 'sm')}<div class="main"><div class="title">${esc(x.title)}</div><div class="sub">${esc(x.artist || '')}</div></div><span class="ro-grip" data-grip="${i}">${icon('drag')}</span></div>`).join('');
  // like Spotify: cover and name on top (tap to change them), the songs below with minus and handle
  const cover = $('.detail-head .cover')?.cloneNode(true);
  wrap.innerHTML = `<div class="modal reorder"><div class="modal-head"><button class="icon-btn" data-x>${icon('close')}</button><h2>${t('editPlaylist')}</h2><button class="btn primary sm" data-ok>${t('save')}</button></div><div class="ro-list"><button class="ro-head" data-edit="${kind}:${id}"><span class="ro-cover"></span><span class="ro-change">${t('changeImage')}</span><b class="ro-name">${esc(title)}</b></button>${rows()}</div></div>`;
  if (cover) wrap.querySelector('.ro-cover').appendChild(cover);
  document.body.appendChild(wrap);
  const list = wrap.querySelector('.ro-list');
  const redraw = () => {
    list.querySelectorAll('.ro-row').forEach((r) => r.remove());
    list.insertAdjacentHTML('beforeend', rows());
  };
  wrap.addEventListener('click', async (e) => {
    if (e.target.closest('[data-x]')) return wrap.remove();
    if (e.target.closest('[data-edit]')) return wrap.remove();
    const rm = e.target.closest('[data-rorm]');
    if (rm) {
      // the row folds away, the ones below slide up
      const row = rm.closest('.ro-row');
      row.classList.add('gone');
      setTimeout(() => {
        order.splice(Number(rm.dataset.rorm), 1);
        redraw();
      }, 200);
      return;
    }
    if (e.target.closest('[data-ok]')) {
      await save().catch((err) => toast(errorText(err)));
      wrap.remove();
      render();
    }
  });
  // drag by the handle: the row follows the finger, the others make room
  list.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('[data-grip]');
    if (!g) return;
    e.preventDefault();
    const row = g.closest('.ro-row');
    const from = Number(row.dataset.ri);
    const h = row.offsetHeight + 4;
    const y0 = e.clientY;
    const s0 = list.scrollTop;
    let to = from, lastY = e.clientY, raf = 0;
    row.classList.add('lifted');
    list.classList.add('sorting');
    g.setPointerCapture(e.pointerId);
    navigator.vibrate?.(8);
    const place = () => {
      const dy = lastY - y0 + (list.scrollTop - s0);
      row.style.transform = `translateY(${dy}px) scale(1.02)`;
      const nt = Math.max(0, Math.min(order.length - 1, from + Math.round(dy / h)));
      if (nt !== to) navigator.vibrate?.(4);
      to = nt;
      list.querySelectorAll('.ro-row').forEach((r) => {
        const i = Number(r.dataset.ri);
        if (r === row) return;
        const shift = from < to && i > from && i <= to ? -h : from > to && i < from && i >= to ? h : 0;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    // near the top or bottom edge the list scrolls along by itself
    const edge = () => {
      const r = list.getBoundingClientRect();
      const v = lastY < r.top + 60 ? -(r.top + 60 - lastY) / 4 : lastY > r.bottom - 60 ? (lastY - (r.bottom - 60)) / 4 : 0;
      if (v) {
        list.scrollTop += v;
        place();
      }
      raf = requestAnimationFrame(edge);
    };
    raf = requestAnimationFrame(edge);
    const move = (ev) => {
      lastY = ev.clientY;
      place();
    };
    const up = () => {
      cancelAnimationFrame(raf);
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.removeEventListener('pointercancel', up);
      // the row glides into its new place, then the list is drawn in the new order
      row.classList.remove('lifted');
      row.classList.add('settle');
      row.style.transform = `translateY(${(to - from) * h}px)`;
      setTimeout(() => {
        const [x] = order.splice(from, 1);
        order.splice(to, 0, x);
        list.classList.remove('sorting');
        redraw();
      }, 190);
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
  });
}
// PC: drag a song in a playlist to a new place
let plDrag = null;
document.addEventListener('dragstart', (e) => {
  const row = e.target.closest?.('.tracks[data-reorder] .row');
  if (!row) return;
  plDrag = { list: row.parentElement, from: Number(row.dataset.i) };
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', row.dataset.id);
});
document.addEventListener('dragover', (e) => {
  if (!plDrag) return;
  const row = e.target.closest?.('.row');
  if (!row || row.parentElement !== plDrag.list) return;
  e.preventDefault();
  const r = row.getBoundingClientRect();
  plDrag.list.querySelectorAll('.row').forEach((x) => x.classList.remove('drop-above', 'drop-below'));
  const below = e.clientY > r.top + r.height / 2;
  row.classList.add(below ? 'drop-below' : 'drop-above');
  plDrag.to = Number(row.dataset.i) + (below ? 1 : 0);
});
document.addEventListener('dragend', async () => {
  if (!plDrag) return;
  const { list, from, to } = plDrag;
  plDrag = null;
  list.querySelectorAll('.row').forEach((x) => x.classList.remove('drop-above', 'drop-below', 'dragging'));
  if (to == null || to === from || to === from + 1) return;
  const id = Number(list.dataset.playlist);
  const tracks = state.lists?.[list.dataset.list] || [];
  const ids = tracks.map((x) => x.id);
  const [x] = ids.splice(from, 1);
  ids.splice(to > from ? to - 1 : to, 0, x);
  await put(`/api/playlists/${id}`, { trackIds: ids }).catch((err) => toast(errorText(err)));
  render();
});
// download switch on a playlist: on = copy kept on this device, off = copy removed
let offTimer = 0;
async function paintOffline() {
  const b = $('[data-offpl]');
  if (!b) return;
  const sets = await offline.status();
  const set = sets.find((x) => x.key === b.dataset.offpl);
  const loading = set?.state === 'loading';
  b.classList.toggle('on', !!set && !loading && set.state === 'ready');
  b.classList.toggle('busy', loading);
  b.dataset.key = set?.key || '';
  b.dataset.state = set?.state || '';
  const label = loading ? t('offLoading', { n: set.done, total: set.total || '…' }) : set?.state === 'ready' ? t('offOn') : set ? t('offRetry') : t('offDownload');
  b.querySelector('span').textContent = label;
  b.title = label;
  // songs done plus how far the song coming in right now is, so the bar grows steadily from 0 to the end
  b.style.setProperty('--p', loading && set.total ? Math.min(100, ((set.done + (set.part || 0)) / set.total) * 100).toFixed(2) + '%' : '0%');
  clearTimeout(offTimer);
  // a kept playlist follows changes on the server: copied again quietly when it is older than ten minutes
  if (set?.state === 'ready' && Date.now() - set.updated > 600000 && state.detail?.[b.dataset.offlist]?.length) {
    offline.add(set.key, b.dataset.offname, state.detail[b.dataset.offlist]);
    offTimer = setTimeout(paintOffline, 1200);
    return;
  }
  if (loading) offTimer = setTimeout(paintOffline, 700);
  else if (set && set.state !== 'ready' && b.dataset.was === 'loading') toast(t('offError'));
  b.dataset.was = set?.state || '';
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-offpl]');
  if (b) {
    if (b.dataset.state === 'loading') return;
    if (b.dataset.state === 'ready') {
      const ok = await dialog({ title: t('offRemoveQ'), text: t('offRemoveText'), ok: t('offRemove'), danger: true });
      if (!ok) return;
      await offline.remove(b.dataset.key);
    } else {
      const r = await offline.add(b.dataset.offpl, b.dataset.offname, state.detail?.[b.dataset.offlist] || []);
      if (!r) return toast(t('offError'));
    }
    return paintOffline();
  }
  if (e.target.closest('[data-goonline]')) return goOnline();
  const rm = e.target.closest('[data-offrm]');
  if (rm) {
    await offline.remove(rm.dataset.offrm);
    return redrawOffline();
  }
});
// ---------- download to the server: the songs that only stream are stored on the server, then they count as local ----------
const srvDl = new Map();
async function serverDownload(id, total) {
  if (srvDl.has(id)) return;
  try {
    await post(`/api/imports/${id}/store`);
  } catch (err) {
    return toast(errorText(err));
  }
  watchServerDl(id, total);
}
async function watchServerDl(id, total, quiet) {
  if (srvDl.has(id)) return;
  let last = -1;
  srvDl.set(id, true);
  const stop = () => (srvDl.delete(id), importStatus(null));
  for (;;) {
    let s;
    try {
      s = await get(`/api/imports/${id}/store`);
    } catch {
      return stop();
    }
    if (s.state !== 'loading') {
      stop();
      if (!quiet || last >= 0) {
        if (s.state === 'ready' || s.state === 'error') {
          const got = (s.done || 0) - (s.failed || 0);
          toast(s.failed ? t('srvDlSome', { n: got, failed: s.failed }) : t('srvDlDone', { n: got }));
          if (location.hash.includes('/imported/' + id)) render();
        }
      }
      return;
    }
    const n = s.done || 0;
    const pct = s.total ? ((n + (s.part || 0)) / s.total) * 100 : 0;
    importStatus(t('srvDlLoading', { n, total: s.total || '…' }), pct);
    // the "X of Y local" line counts along
    if (n !== last) {
      last = n;
      const el = $(`[data-implocal="${id}"]`);
      if (el) {
        const r = await get('/api/imports/' + id).catch(() => null);
        if (r) el.textContent = t('importedOf', { local: r.items.filter((x) => x.local).length, total: r.items.length || total });
      }
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}
async function offlineHtml() {
  const sets = await offline.status();
  const size = (n) => (n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB');
  const rows = sets.map((x) => `<div class="offrow">${icon(x.state === 'loading' ? 'refresh' : 'download')}<span><b>${esc(x.name || '…')}</b><small>${x.state === 'loading' ? t('offLoading', { n: x.done, total: x.total }) : x.state === 'ready' ? `${songCount(x.total)} · ${size(x.bytes)}` : t('offError')}</small></span><button class="btn sm" data-offrm="${esc(x.key)}">${t('offRemove')}</button></div>`).join('');
  return (
    setRow(t('offTitle'), offlineMode ? `<button class="btn primary" data-goonline>${t('goOnline')}</button>` : '', { hint: t('offHint'), keys: 'offline download herunterladen ohne internet' }) +
    setRow(t('offSaved'), '', { wide: true, hint: rows ? `<div class="offlist">${rows}</div>` : t('offNone'), keys: 'offline download' })
  );
}
async function redrawOffline() {
  const c = $('#set-offline');
  if (c) c.outerHTML = setCard('offline', 'download', t('offTitle'), await offlineHtml());
}
// an invitation link lands here once the user is signed in
views.join = async (params, token) => {
  state.joined = true; // the invitation wins over the first-start assistant
  const j = await post(`/api/public/${encodeURIComponent(token)}/join`, {});
  toast(t(j.role === 'listen' ? 'joinedListen' : 'joinedPlaylist', { name: j.name }));
  renderSidebarPlaylists();
  setTimeout(() => go(`#/playlist/${j.id}`), 0);
  return '';
};
// share a playlist: a link to listen without signing in, or an invitation to add songs
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-plshare]');
  if (b) {
    const id = Number(b.dataset.plshare);
    const pl = await get(`/api/playlists/${id}`).catch(() => null);
    if (!pl) return;
    const items = [{ label: t('shareListen'), icon: 'share', run: () => shareThing('playlist', id, pl.name) }];
    if (pl.mine !== false) items.push('-', { label: t('shareCollab'), icon: 'edit', run: () => shareThing('collab', id, pl.name) }, { label: t('shareListener'), icon: 'headphones', run: () => shareThing('listener', id, pl.name) });
    return menu(b, items);
  }
  const rb = e.target.closest('[data-memberrole]');
  if (rb) {
    const [pid, uid, role] = rb.dataset.memberrole.split(':');
    const set = (r) => async () => {
      await put(`/api/playlists/${pid}/members/${uid}`, { role: r }).catch((err) => toast(errorText(err)));
      render();
    };
    return menu(rb, [
      { label: t('makeContributor') + (role !== 'listen' ? ' ✓' : ''), icon: 'edit', run: set('edit') },
      { label: t('makeListener') + (role === 'listen' ? ' ✓' : ''), icon: 'headphones', run: set('listen') }
    ]);
  }
  const rm = e.target.closest('[data-rmmember]');
  if (rm) {
    const [pid, uid] = rm.dataset.rmmember.split(':');
    await del(`/api/playlists/${pid}/members/${uid}`).catch(() => {});
    render();
  }
});
// ---------- sources (first start + settings) ----------
function sourcesBody() {
  const on = settings.sources || {};
  const cards = SOURCES.map(
    (s) => `<label class="srccard ${s === 'local' || on[s] ? 'on' : ''}"><input type="checkbox" data-src="${s}" ${s === 'local' || on[s] ? 'checked' : ''} ${s === 'local' ? 'disabled' : ''}>
      ${srcBadge(s)}<span class="srctext"><b>${t('src_' + s)}</b><span class="muted small">${t('srcd_' + s)}</span></span></label>`
  ).join('');
  const spOn = on.spotify, ytOn = on.youtube || on.ytmusic;
  const access = `
    <div class="access ${spOn ? '' : 'hide'}" data-for="spotify"><h3>Spotify</h3>
      <label class="field"><span>${t('spotifyClient')}</span><span class="secret"><input id="spclient" type="password" value="${esc(settings.spotifyClientId || '')}" autocomplete="off" spellcheck="false"><button type="button" class="icon-btn" data-eye title="${t('showHide')}">${icon('eye')}</button></span></label>
      <p class="muted small">${esc(t('spotifyClientHelp', { uri: spotify.redirectUri() }))}</p>
      <div class="stack">${spotify.connected() ? `<span class="pill ok">${icon('check')}${t('spotifyConnected')}</span><button type="button" class="btn" data-splogout>${t('spotifyDisconnect')}</button>` : `<button type="button" class="btn primary" data-splogin>${t('spotifyConnect')}</button>`}<button type="button" class="btn ghost" data-sptoken>${t('spotifyToken')}</button></div></div>
    <div class="access ${ytOn ? '' : 'hide'}" data-for="youtube"><h3>YouTube</h3>
      <label class="field"><span>${t('youtubeKey')}</span><span class="secret"><input id="ytkey" type="password" value="${esc(settings.youtubeKey || '')}" autocomplete="off" spellcheck="false"><button type="button" class="icon-btn" data-eye title="${t('showHide')}">${icon('eye')}</button></span></label>
      <p class="muted small">${t('youtubeKeyHelp')}</p></div>`;
  return `<div class="srcgrid">${cards}</div><div class="accesses">${access}</div>`;
}
function sourcesForm() {
  return `${pageHead(t('sources'))}
    <p class="muted lead">${t('sourcesHint')}</p>
    ${sourcesBody()}
    <div class="stack wizard-actions"><a class="btn primary" href="#/add">${icon('download')}${t('importAdd')}</a></div>`;
}
// ---------- first start: a setup assistant that asks one thing after another ----------
const WIZ = ['hello', 'look', 'genres', 'artists', 'how', 'done'];
// genres of the public catalog, so the picked ones give real artists right away
const GENRES = { pop: 132, rap: 116, rock: 152, alt: 85, dance: 113, electro: 106, rnb: 165, soul: 169, metal: 464, jazz: 129, classic: 98, latin: 197, reggae: 144, folk: 466, country: 84, blues: 153, film: 173, asia: 16, africa: 2, kids: 95 };
const ACCENTS = ['cover', 'blue', 'green', 'purple', 'orange', 'pink', 'red', 'teal'];
const wiz = { list: null, listFor: '', found: null };
function wizIndex(params) {
  return Math.max(0, Math.min(WIZ.length - 1, Number(params?.get('s')) || 0));
}
function wizFrame(i, body, { next = true, skip = false } = {}) {
  const dots = WIZ.map((_, n) => `<i class="${n < i ? 'done' : n === i ? 'on' : ''}"></i>`).join('');
  return `<div class="wiz" data-wiz="${WIZ[i]}">
    <div class="wiz-top"><div class="wiz-dots">${dots}</div><span class="muted small">${t('wizStep', { n: i + 1, total: WIZ.length })}</span></div>
    <div class="wiz-body">${body}</div>
    <div class="wiz-nav">${i > 0 ? `<button class="btn ghost" data-wizgo="${i - 1}">${icon('back')}${t('wizBack')}</button>` : '<span></span>'}
      <div class="stack">${skip ? `<button class="btn ghost" data-wizgo="${i + 1}">${t('wizSkipStep')}</button>` : ''}${next ? `<button class="btn primary" data-wizgo="${i + 1}">${t('wizNext')}</button>` : ''}</div></div>
  </div>`;
}
const wizQ = (title, body, hint = '') => `<div class="wiz-q"><h2>${title}</h2>${hint ? `<p class="muted small">${hint}</p>` : ''}${body}</div>`;
function wizArtistCards(list) {
  if (!list?.length) return `<p class="muted small">${t('wizArtistNone')}</p>`;
  return list
    .map((a) => {
      const id = 'dzartist:' + a.id;
      if (a.picture) extCovers.set(id, a.picture);
      const on = isFollowed('deezer', a.id);
      return `<button type="button" class="wiz-artist ${on ? 'on' : ''}" data-wart="${esc(String(a.id))}" data-wname="${esc(a.name)}" data-wpic="${esc(a.picture || '')}">${coverImg(id, 'lg round')}<span class="wa-check">${icon('check')}</span><span class="c-title">${esc(a.name)}</span></button>`;
    })
    .join('');
}
async function wizArtists() {
  const picked = (settings.genres || []).filter((g) => GENRES[g]);
  const key = picked.join(',');
  if (!wiz.list || wiz.listFor !== key) {
    wiz.list = await get('/api/catalog/genre-artists?ids=' + picked.map((g) => GENRES[g]).join(',')).catch(() => []);
    wiz.listFor = key;
  }
  return wiz.list;
}
views.welcome = async (params) => {
  const i = wizIndex(params);
  const step = WIZ[i];
  if (step === 'hello') {
    return wizFrame(i, `<div class="wiz-hero"><span class="brandmark big" aria-hidden="true"></span><h1>${t('wizHello')}</h1><p class="muted lead">${t('wizHelloText')}</p></div>
      ${wizQ(t('wizLangAsk'), `<div class="seg">${['en', 'de'].map((l) => `<button data-wlang="${l}" class="${getLang() === l ? 'on' : ''}">${l === 'de' ? 'Deutsch' : 'English'}</button>`).join('')}</div>`)}
      ${wizQ(t('wizNameAsk'), `<input id="wizname" class="textin" maxlength="40" value="${esc(conn.user?.name || '')}" autocomplete="nickname">`)}`);
  }
  if (step === 'look') {
    return wizFrame(i, `<h1>${t('wizLookTitle')}</h1><p class="muted lead">${t('wizLookText')}</p>
      ${wizQ(t('themeAsk'), themePicker(), t('themeHint'))}
      ${wizQ(t('mode'), `<div class="seg">${['dark', 'light'].map((m) => `<button data-mode-pick="${m}" class="${(prefs.mode === 'light' ? 'light' : 'dark') === m ? 'on' : ''}">${icon(m === 'light' ? 'sun' : 'moon')}${t('mode_' + m)}</button>`).join('')}</div>`)}
      <div class="oledrow">${wizQ(t('oled'), `<label class="wiz-sw">${sw('oledsw', !!prefs.oled)}<span>${t('oledHint')}</span></label>`)}</div>
      ${wizQ(t('wizAccentAsk'), accentPicker(ACCENTS), t('accentHint'))}
      ${wizQ(t('dynColor'), `<label class="wiz-sw">${sw('dyncolor', prefs.dynamic)}<span>${t('wizDynAsk')}</span></label>`)}`);
  }
  if (step === 'genres') {
    const on = new Set(settings.genres || []);
    return wizFrame(i, `<h1>${t('wizGenreTitle')}</h1><p class="muted lead">${t('wizGenreText')}</p>
      <div class="wiz-genres">${Object.keys(GENRES).map((g) => `<button type="button" class="chip ${on.has(g) ? 'on' : ''}" data-wgenre="${g}">${t('g_' + g)}</button>`).join('')}</div>`, { skip: !on.size });
  }
  if (step === 'artists') {
    await loadFollows(true);
    const list = await wizArtists();
    const n = (follows || []).filter((f) => f.kind === 'deezer').length;
    return wizFrame(i, `<h1>${t('wizArtistTitle')}</h1><p class="muted lead">${t('wizArtistText')}</p>
      <div class="searchbar wiz-search">${icon('search')}<input id="wizq" type="search" placeholder="${t('wizArtistSearch')}" autocomplete="off"></div>
      <p class="muted small wiz-count">${t('wizArtistPicked', { n })}</p>
      <div class="wiz-artists" id="wizartists">${wizArtistCards(list)}</div>`, { skip: !n });
  }
  if (step === 'sources') return wizFrame(i, `<h1>${t('wizSrcTitle')}</h1><p class="muted lead">${t('welcomeText')}</p>${sourcesBody()}`);
  if (step === 'how') {
    const eq = prefs.eq?.on ? prefs.eq.preset : 'flat';
    return wizFrame(i, `<h1>${t('wizHowTitle')}</h1><p class="muted lead">${t('wizHowText')}</p>
      ${wizQ(t('autoplayShort'), `<label class="wiz-sw">${sw('autoplay', prefs.autoplay)}<span>${t('wizAutoplayAsk')}</span></label>`)}
      ${wizQ(t('wizSearchAsk'), `<div class="seg wiz-wrap">${SMODES.map((m) => `<button data-smode="${m}" class="${searchMode() === m ? 'on' : ''}">${t('smode_' + m)}</button>`).join('')}</div>`, t('searchInHint'))}
      ${wizQ(t('wizVizAsk'), `<div class="seg wiz-wrap">${VIZ_MODES.map((m) => `<button data-wviz="${m}" class="${(prefs.viz || 'off') === m ? 'on' : ''}">${t('viz_' + m)}</button>`).join('')}</div>`)}
      ${wizQ(t('wizMiniVizAsk'), `<div class="seg wiz-wrap">${MINI_MODES.map((m) => `<button data-wminiviz="${m}" class="${(prefs.miniViz || 'off') === m ? 'on' : ''}">${t('mviz_' + m)}</button>`).join('')}</div>`, t('miniVizHint'))}
      ${wizQ(t('wizEqAsk'), `<div class="seg wiz-wrap">${['flat', 'bass', 'treble', 'vocal', 'night'].map((k) => `<button data-weq="${k}" class="${eq === k ? 'on' : ''}">${t('eq_' + k)}</button>`).join('')}</div>`, t('eqHint'))}`);
  }
  const any = Object.entries(settings.sources || {}).some(([k, v]) => v && k !== 'local');
  return wizFrame(i, `<div class="wiz-hero">${icon('check', 'big')}<h1>${t('wizDoneTitle')}</h1><p class="muted lead">${t('wizDoneText')}</p></div>
    <div class="wiz-ends">
      <button class="wiz-end primary" data-wizend="home">${icon('play')}<span>${t('wizStartListen')}</span></button>
      ${any ? `<button class="wiz-end" data-wizend="add">${icon('download')}<span>${t('wizStartImport')}</span></button>` : ''}
      <button class="wiz-end" data-wizend="search">${icon('search')}<span>${t('wizStartSearch')}</span></button>
      <button class="wiz-end" data-wizend="upload">${icon('upload')}<span>${t('wizStartUpload')}</span></button>
    </div>`, { next: false });
};
async function wizLeave(from) {
  // what was typed on a step is kept when it is left
  if (WIZ[from] === 'hello') {
    const name = $('#wizname')?.value.trim();
    if (name && conn.user && name !== conn.user.name) {
      await put('/api/me', { name }).catch(() => {});
      conn.user = await get('/api/me').catch(() => conn.user);
      saveConn();
      paintAvatars();
    }
  }
}
document.addEventListener('click', async (e) => {
  const go_ = e.target.closest('[data-wizgo]');
  if (go_) {
    const from = wizIndex(new URLSearchParams(location.hash.split('?')[1] || ''));
    await wizLeave(from);
    return go('#/welcome?s=' + go_.dataset.wizgo);
  }
  const wl = e.target.closest('[data-wlang]');
  if (wl) {
    const name = $('#wizname')?.value;
    rememberLang(wl.dataset.wlang);
    applyPrefs();
    buildShell();
    await render();
    if (name != null && $('#wizname')) $('#wizname').value = name;
    return;
  }
  const g = e.target.closest('[data-wgenre]');
  if (g) {
    const set = new Set(settings.genres || []);
    set.has(g.dataset.wgenre) ? set.delete(g.dataset.wgenre) : set.add(g.dataset.wgenre);
    g.classList.toggle('on', set.has(g.dataset.wgenre));
    saveSettings({ genres: [...set] }).catch(() => {});
    document.querySelectorAll('.wiz-nav .stack [data-wizgo]').forEach((b) => b.classList.contains('primary') || b.toggleAttribute('hidden', set.size > 0));
    return;
  }
  const a = e.target.closest('[data-wart]');
  if (a) {
    const on = !a.classList.contains('on');
    a.classList.toggle('on', on);
    navigator.vibrate?.(6);
    const body = { kind: 'deezer', ref: a.dataset.wart, name: a.dataset.wname, cover: a.dataset.wpic };
    try {
      if (on) await put('/api/follows', body);
      else await del(`/api/follows?kind=deezer&ref=${encodeURIComponent(body.ref)}`);
      await loadFollows(true);
      dropHome();
    } catch {
      a.classList.toggle('on', !on);
    }
    const n = (follows || []).filter((f) => f.kind === 'deezer').length;
    const c = $('.wiz-count');
    if (c) c.textContent = t('wizArtistPicked', { n });
    document.querySelectorAll('.wiz-nav .stack [data-wizgo]').forEach((b) => b.classList.contains('primary') || b.toggleAttribute('hidden', n > 0));
    return;
  }
  const mv = e.target.closest('[data-wminiviz]');
  if (mv) {
    prefs.miniViz = mv.dataset.wminiviz;
    savePrefs();
    miniVizSync();
    mv.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === mv));
    return;
  }
  const v = e.target.closest('[data-wviz]');
  if (v) {
    if (v.dataset.wviz !== 'off') prefs.vizLast = v.dataset.wviz;
    setViz(v.dataset.wviz);
    v.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === v));
    return;
  }
  const q = e.target.closest('[data-weq]');
  if (q) {
    const k = q.dataset.weq;
    eqChanged({ on: k !== 'flat', preset: k, gains: EQ_PRESETS[k].slice() });
    q.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === q));
    return;
  }
  const end = e.target.closest('[data-wizend]');
  if (end) {
    await saveSettings({ setupDone: true }).catch(() => {});
    dropHome();
    const where = end.dataset.wizend;
    if (where === 'upload') {
      go('#/home');
      return pickUpload();
    }
    go('#/' + where);
  }
});
// artist search on the "which artists" step
{
  let timer = 0, seq = 0;
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'wizq') return;
    clearTimeout(timer);
    const q = e.target.value.trim();
    timer = setTimeout(async () => {
      const my = ++seq;
      const list = q ? (await get('/api/catalog/search?q=' + encodeURIComponent(q)).catch(() => ({ artists: [] }))).artists : await wizArtists();
      if (my !== seq) return;
      const box = $('#wizartists');
      if (box) {
        box.innerHTML = wizArtistCards(list);
        tintAll(box);
      }
    }, 280);
  });
}
views.sources = async () => sourcesForm();
document.addEventListener('change', async (e) => {
  const c = e.target.closest('[data-src]');
  if (c) {
    const sources = { ...settings.sources, [c.dataset.src]: c.checked };
    c.closest('.srccard').classList.toggle('on', c.checked);
    await saveSettings({ sources }).catch(() => toast(t('error')));
    document.querySelector('.access[data-for="spotify"]')?.classList.toggle('hide', !sources.spotify);
    document.querySelector('.access[data-for="youtube"]')?.classList.toggle('hide', !(sources.youtube || sources.ytmusic));
  }
  if (e.target.id === 'spclient') saveSettings({ spotifyClientId: e.target.value.trim() }).catch(() => {});
  if (e.target.id === 'ytkey') saveSettings({ youtubeKey: e.target.value.trim() }).catch(() => {});
});
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-splogin]')) {
    const id = $('#spclient')?.value.trim();
    if (id && id !== settings.spotifyClientId) await saveSettings({ spotifyClientId: id }).catch(() => {});
    const btn = e.target.closest('[data-splogin]');
    btn.disabled = true;
    btn.textContent = t('spotifyWaiting');
    spotify
      .login()
      .then((ok) => {
        toast(ok ? t('spotifyConnected') : t('spotify_login'));
        render();
      })
      .catch((err) => {
        btn.disabled = false;
        btn.textContent = t('spotifyConnect');
        toast(errorText(err));
      });
  }
  if (e.target.closest('[data-splogout]')) {
    await spotify.logout();
    render();
  }
  if (e.target.closest('[data-sptoken]')) {
    const r = await dialog({ title: t('spotifyToken'), text: t('spotifyTokenHint'), fields: [{ name: 'token', label: 'Token' }], ok: t('save') });
    if (r?.token?.trim()) {
      spotify.setToken(r.token);
      render();
    }
  }
});

// ---------- import ----------
views.add = async (params) => {
  let mine = '';
  if (enabled('spotify') && spotify.connected()) {
    try {
      const pls = await spotify.myPlaylists();
      mine = section(
        t('importMine'),
        `<div class="cards libgrid"><button class="card" data-spimport="liked"><div class="cover lg ph accent">${icon('heartFill')}</div><div class="c-title">${t('importLiked')}</div><div class="c-sub">Spotify</div></button>${pls
          .map((p) => `<button class="card" data-spimport="${esc(p.id)}">${p.cover ? `<div class="cover lg"><img loading="lazy" alt="" src="${esc(p.cover)}"></div>` : coverImg(null, 'lg')}<div class="c-title">${esc(p.name)}</div><div class="c-sub">${songCount(p.total)}</div></button>`)
          .join('')}</div>`
      );
    } catch (err) {
      mine = `<p class="muted small">${esc(errorText(err))}</p>`;
    }
  }
  return `${pageHead(t('importTitle'))}
    <form class="importform" id="importform" autocomplete="off">
      <label class="field"><span>${t('importLink')}</span><input name="link" placeholder="${esc(t('importLinkPh'))}" value="${esc(params.get('link') || '')}" inputmode="url" autocapitalize="off" spellcheck="false"></label>
      <div class="stack"><button class="btn primary">${icon('download')}${t('importLoad')}</button>
      <label class="btn">${icon('upload')}${t('importFile')}<input type="file" id="importfile" accept=".csv,.tsv,.m3u,.m3u8,.txt" hidden></label></div>
    </form>
    <div id="importprev"></div>
    ${mine}
    <p class="muted small srcnote">${t('sourcesHint')} <a href="#/sources">${t('manageSources')}</a></p>`;
};
/** A small status pill that stays on screen while an import runs, also when you go elsewhere. */
function importStatus(text, pct) {
  let el = $('#impstatus');
  if (text == null) {
    el?.classList.remove('show');
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'impstatus';
    el.className = 'impstatus';
    el.innerHTML = '<span class="spin"></span><span class="txt"></span><span class="bar"><i></i></span>';
    document.body.appendChild(el);
  }
  el.querySelector('.txt').textContent = text;
  el.querySelector('.bar').hidden = pct == null;
  el.querySelector('.bar i').style.width = Math.max(3, Math.min(100, pct || 0)) + '%';
  el.classList.add('show');
}
async function previewImport(job) {
  const box = $('#importprev');
  if (!box) return;
  const progress = (n, total) => {
    const pct = total ? (n / total) * 100 : null;
    importStatus(t('importLoading', { n, total: total || '…' }), pct);
    const b = $('#importprev');
    if (b) b.innerHTML = `<div class="impprog"><b>${t('importLoading', { n, total: total || '…' })}</b><span class="bar"><i style="width:${Math.max(3, pct || 3)}%"></i></span></div>`;
  };
  box.innerHTML = `<div class="impprog"><b>${t('importing')}</b><span class="bar indet"><i></i></span></div>`;
  importStatus(t('importing'));
  try {
    const data = await job(progress);
    if (!data.items?.length) throw new Error('empty_import');
    importStatus(null);
    state.pendingImport = data;
    const m = data.meta || {};
    const box2 = $('#importprev') || box;
    box2.innerHTML = `<div class="impprev">
      <div class="imphead">${data.cover ? `<div class="cover lg"><img alt="" src="${esc(data.cover)}"></div>` : ''}<div>
        <label class="field"><span>${t('playlistName')}</span><input id="impname" value="${esc(data.name || '')}"></label>
        ${m.description ? `<p class="muted small impdesc">${esc(m.description)}</p>` : ''}
        <p class="muted">${srcBadge(data.source)} ${m.owner ? esc(m.owner) + ' · ' : ''}${t('importFound', { n: data.items.length })}${m.duration ? ' · ' + fmtLong(m.duration) : ''}</p></div></div>
      <div class="stack"><button class="btn primary" data-impsave>${icon('check')}${t('importSave')}</button></div>
      <ol class="implist">${data.items.slice(0, 30).map((x) => `<li><b>${esc(x.title)}</b> <span class="muted">${esc(x.artist || '')}</span></li>`).join('')}${data.items.length > 30 ? '<li class="muted">…</li>' : ''}</ol></div>`;
  } catch (err) {
    importStatus(null);
    const b = $('#importprev') || box;
    b.innerHTML = `<p class="err">${esc(errorText(err))}</p>`;
  }
}
function fmtLong(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? t('hoursMin', { h, m }) : t('minutes', { m });
}
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'importform') return;
  e.preventDefault();
  const link = e.target.elements.link.value.trim();
  if (link) previewImport((p) => fetchLink(link, p));
});
document.addEventListener('change', (e) => {
  if (e.target.id !== 'importfile' || !e.target.files[0]) return;
  const f = e.target.files[0];
  previewImport(async () => parseFile(f.name, await f.text()));
});
document.addEventListener('click', async (e) => {
  const sp = e.target.closest('[data-spimport]');
  if (sp) previewImport((p) => (sp.dataset.spimport === 'liked' ? spotifyLiked(p) : spotifyPlaylist(sp.dataset.spimport, undefined, p)));
  if (e.target.closest('[data-impsave]') && state.pendingImport) {
    const d = state.pendingImport;
    const name = $('#impname')?.value.trim() || d.name || t('imported');
    const btn = e.target.closest('[data-impsave]');
    btn.disabled = true;
    importStatus(t('importMatching', { n: d.items.length }));
    try {
      const r = await saveImport({ source: d.source, name, url: d.url || '', cover: d.cover || '', meta: d.meta || {}, items: d.items });
      state.pendingImport = null;
      importStatus(null);
      toast(t('importDone', { name }));
      go('#/imported/' + r.id);
    } catch (err) {
      btn.disabled = false;
      importStatus(null);
      toast(errorText(err));
    }
  }
});

views.imported = async (params, id) => {
  const r = await get('/api/imports/' + id);
  const list = playableItems(r.items);
  const tracks = r.items.map((it, i) => list[i] || { id: 'off:' + it.pos, title: it.title, artist: it.artist, album: it.album, duration: it.duration, _off: true, _src: it.source });
  for (const it of r.items) if (!it.local && it.cover) extCovers.set('off:' + it.pos, it.cover);
  state.detail = { imp: tracks.filter((x) => !x._off) };
  state.importInfo = r;
  setTimeout(() => watchServerDl(r.id, r.items.length, true), 0);
  const local = r.items.filter((x) => x.local).length;
  let coverId = r.items.find((x) => x.local)?.local.id || null;
  if (r.cover) {
    extCovers.set('imp:' + id, r.cover);
    coverId = 'imp:' + id;
  }
  coverId = artKey('import', r.id, r.art) || coverId;
  const m = r.meta || {};
  const dur = r.items.reduce((n, x) => n + (x.duration || 0), 0);
  return (
    detailHeader({
      coverId,
      kind: t('playlist'),
      title: r.name,
      sub: `${m.description ? `<span class="dh-desc">${esc(m.description)}</span>` : ''}${srcBadge(r.source)} ${m.owner ? `<b>${esc(m.owner)}</b> · ` : ''}${m.followers ? t('likesN', { n: m.followers.toLocaleString() }) + ' · ' : ''}${songCount(r.items.length)}${dur ? ', ' + fmtLong(dur) : ''} · <span data-implocal="${r.id}">${t('importedOf', { local, total: r.items.length })}</span>`,
      edit: `import:${r.id}`,
      actions: listActions('imp') + `<button class="icon-btn lg" data-preload="imp" title="${t('preload')}">${icon('bolt')}</button>` + offBtn('imp' + r.id, 'imp', r.name) + (r.kept ? '' : `<button class="btn" data-saveimp="${r.id}" title="${t('saveAsPlaylist')}">${icon('plus')}${t('saveAsPlaylist')}</button>`) + shareBtn('import', r.id, r.name) + `<button class="icon-btn lg" data-edit="import:${r.id}" title="${t('editDetails')}">${icon('edit')}</button>` + (r.items.length ? `<button class="icon-btn lg m-only" data-pledit="import:${r.id}" title="${t('editMode')}">${icon('drag')}</button>` : '') + `<button class="icon-btn" data-cmenu="import:${r.id}" title="…">${icon('more')}</button>`
    }) + trackList(tracks)
  );
};
// ---------- lyrics ----------
const lyr = { id: null, lines: [], synced: false, at: -1 };
async function loadLyrics(tr) {
  if (!tr) return { lines: [], synced: false, source: '' };
  const r = tr.ext || tr._off
    ? await get(`/api/lyrics?title=${encodeURIComponent(tr.title)}&artist=${encodeURIComponent(tr.artist || '')}&duration=${Math.round(tr.duration || 0)}`)
    : await get(`/api/lyrics/${tr.id}`);
  if (r.synced) {
    const lines = [];
    for (const l of r.synced.split(/\r?\n/)) {
      const ts = [...l.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
      const text = l.replace(/\[[^\]]*\]/g, '').trim();
      for (const m of ts) lines.push({ t: Number(m[1]) * 60 + Number(m[2].replace(':', '.')), text });
    }
    lines.sort((a, b) => a.t - b.t);
    if (lines.length) return { lines, synced: true, source: r.source };
  }
  return { lines: (r.plain || '').split(/\r?\n/).map((text) => ({ t: -1, text: text.trim() })), synced: false, source: r.source };
}
async function renderLyrics(box) {
  const tr = player.current;
  if (!box) return;
  if (!tr) return (box.innerHTML = `<p class="muted empty">${t('nothingPlaying')}</p>`);
  if (lyr.id === tr.id && box.dataset.id === String(tr.id)) return;
  box.dataset.id = String(tr.id);
  lyr.id = tr.id;
  lyr.at = -1;
  box.innerHTML = `<p class="muted">${t('lyricsLoading')}</p>`;
  try {
    const r = await loadLyrics(tr);
    if (lyr.id !== tr.id) return;
    lyr.lines = r.lines;
    lyr.synced = r.synced;
    if (!r.lines.some((l) => l.text)) throw new Error('none');
    box.innerHTML = `<div class="lyrics ${r.synced ? 'synced' : ''}">${r.lines.map((l, i) => `<p data-li="${i}">${esc(l.text) || '♪'}</p>`).join('')}</div><p class="muted small lyrsrc">${t('lyricsFrom', { src: r.source === 'file' ? t('src_files') : 'LRCLIB' })}</p>`;
    syncLyrics();
  } catch {
    box.innerHTML = `<p class="muted empty">${t('noLyrics')}</p>`;
  }
}
function lyricsBox() {
  return document.querySelector('#fs-lyrics.open .lyrbody') || (state.route === 'lyrics' ? $('#view .lyrbody') : null);
}
function syncLyrics() {
  if (!lyr.synced) return;
  const box = lyricsBox();
  if (!box) return;
  const pos = player.position + 0.25;
  let i = -1;
  for (let k = 0; k < lyr.lines.length; k++) if (lyr.lines[k].t <= pos) i = k;
  if (i === lyr.at) return;
  lyr.at = i;
  box.querySelectorAll('.lyrics p.on').forEach((p) => p.classList.remove('on'));
  const p = box.querySelector(`[data-li="${i}"]`);
  if (p) {
    p.classList.add('on');
    p.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
document.addEventListener('click', (e) => {
  const p = e.target.closest('.lyrics.synced [data-li]');
  if (!p) return;
  const l = lyr.lines[Number(p.dataset.li)];
  if (l && l.t >= 0) player.seek(l.t);
});
views.lyrics = async () => {
  setTimeout(() => renderLyrics($('#view .lyrbody')), 0);
  return `<h1>${t('lyrics')}</h1><div class="lyrbody big"></div>`;
};
function toggleFsLyrics() {
  const l = $('#fs-lyrics');
  $('#fs-queue').classList.remove('open', 'full');
  l.classList.toggle('open');
  if (!l.classList.contains('open')) l.classList.remove('full');
  if (l.classList.contains('open')) renderLyrics(l.querySelector('.lyrbody'));
  fsButtons();
}
// the three buttons under the big player show what is open
function fsButtons() {
  if (!$('#fs')) return;
  const on = (act, yes) => document.querySelector(`.fs-bottom [data-act="${act}"]`)?.classList.toggle('on', yes);
  on('viz', (prefs.viz || 'off') !== 'off');
  on('lyrics', $('#fs-lyrics')?.classList.contains('open'));
  on('queue', $('#fs-queue')?.classList.contains('open'));
  // the bar along the bottom too: what is open lights up in the accent colour, like Spotify
  const fsOpen = $('#fs')?.classList.contains('open');
  const bar = (act, yes) => document.querySelectorAll(`#player [data-act="${act}"]`).forEach((b) => b.classList.toggle('on', yes));
  bar('queue', state.route === 'queue' || (fsOpen && $('#fs-queue')?.classList.contains('open')));
  bar('lyrics', state.route === 'lyrics' || (fsOpen && $('#fs-lyrics')?.classList.contains('open')));
  bar('viz', fsOpen && (prefs.viz || 'off') !== 'off');
}
// swipe left for the next song, right for the previous one (big cover and small player)
function bindSwipe(sel, moving) {
  let el = null, x0 = 0, y0 = 0, dx = 0, active = false, locked = false, id = null;
  const target = () => el.querySelector(moving) || el;
  const settle = (m, cls) => setTimeout(() => m.classList.remove(cls), 240);
  const reset = (dir) => {
    const box = el;
    const m = target();
    m.classList.remove('swiping');
    m.classList.add('swipe-back');
    if (!dir) {
      m.style.transform = '';
      m.style.opacity = '';
      return settle(m, 'swipe-back');
    }
    m.style.transform = `translateX(${dir * -110}%)`;
    m.style.opacity = '0';
    setTimeout(() => {
      // the cover may have been replaced by the new song in the meantime
      m.classList.remove('swipe-back');
      m.style.transform = '';
      m.style.opacity = '';
      const n = box.querySelector(moving) || box;
      n.classList.add('swiping');
      n.style.transform = `translateX(${dir * 60}%)`;
      n.style.opacity = '0';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        n.classList.remove('swiping');
        n.classList.add('swipe-back');
        n.style.transform = '';
        n.style.opacity = '';
        settle(n, 'swipe-back');
      }));
    }, 170);
  };
  document.addEventListener('pointerdown', (e) => {
    const hit = e.target.closest?.(sel);
    if (!hit || e.pointerType === 'mouse' || !player?.current || e.target.closest('button, input')) return;
    el = hit; x0 = e.clientX; y0 = e.clientY; dx = 0; active = true; locked = false; id = e.pointerId;
  });
  document.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== id) return;
    dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (!locked) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dy) > Math.abs(dx)) return void (active = false);
      locked = true;
      target().classList.add('swiping');
    }
    const m = target();
    m.style.transform = `translateX(${dx}px)`;
    m.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / (el.clientWidth * 0.9)));
  });
  const end = (e) => {
    if (!active || e.pointerId !== id) return;
    active = false;
    if (!locked) return;
    const box = el;
    box.dataset.swiped = '1';
    setTimeout(() => delete box.dataset.swiped, 350);
    const far = Math.abs(dx) > Math.min(90, el.clientWidth * 0.22);
    if (far && e.type === 'pointerup') {
      const dir = dx < 0 ? 1 : -1;
      reset(dir);
      dir > 0 ? player.next() : player.prev(true);
    } else reset(0);
  };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
}

// ---------- equalizer ----------
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  treble: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  vocal: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
  acoustic: [3, 3, 2, 1, 1, 1, 2, 2, 2, 1],
  electronic: [5, 4, 1, 0, -2, 1, 1, 2, 4, 5],
  night: [-4, -3, -1, 0, 1, 2, 2, 1, -1, -3]
};
function eqHtml() {
  const eq = prefs.eq || { on: false, preset: 'flat', pre: 0, gains: EQ_PRESETS.flat.slice() };
  const fl = (f) => (f >= 1000 ? f / 1000 + 'k' : f);
  return `<label class="check"><input type="checkbox" id="eqon" ${eq.on ? 'checked' : ''}><span>${t('eqOn')}</span></label>
    <div class="eq ${eq.on ? '' : 'dim'}">
      <select class="select" id="eqpreset">${[...Object.keys(EQ_PRESETS), 'custom'].map((k) => `<option value="${k}" ${eq.preset === k ? 'selected' : ''}>${t('eq_' + k)}</option>`).join('')}</select>
      <div class="eqbands">${EQ_FREQS.map((f, i) => `<label class="band"><input type="range" min="-12" max="12" step="1" value="${eq.gains[i] || 0}" data-band="${i}" orient="vertical"><span>${fl(f)}</span></label>`).join('')}</div>
      <label class="field eqpre"><span>${t('eqPre')} <b id="eqprev">${eq.pre || 0} dB</b></span><input type="range" min="-12" max="6" step="1" value="${eq.pre || 0}" id="eqpre"></label>
      <p class="muted small">${t('eqHint')}</p>
    </div>`;
}
function eqChanged(patch) {
  prefs.eq = { on: false, preset: 'flat', pre: 0, gains: EQ_PRESETS.flat.slice(), ...(prefs.eq || {}), ...patch };
  savePrefs();
  player.setEq(prefs.eq);
}
document.addEventListener('input', (e) => {
  const b = e.target.closest('[data-band]');
  if (b) {
    const gains = (prefs.eq?.gains || EQ_PRESETS.flat).slice();
    gains[Number(b.dataset.band)] = Number(b.value);
    eqChanged({ gains, preset: 'custom' });
    const sel = $('#eqpreset');
    if (sel) sel.value = 'custom';
  }
  if (e.target.id === 'eqpre') {
    eqChanged({ pre: Number(e.target.value) });
    $('#eqprev').textContent = e.target.value + ' dB';
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'eqon') {
    eqChanged({ on: e.target.checked });
    document.querySelector('.eq')?.classList.toggle('dim', !e.target.checked);
  }
  if (e.target.id === 'eqpreset' && EQ_PRESETS[e.target.value]) {
    eqChanged({ preset: e.target.value, gains: EQ_PRESETS[e.target.value].slice() });
    document.querySelectorAll('[data-band]').forEach((r) => (r.value = prefs.eq.gains[Number(r.dataset.band)]));
  }
});

views.queue = async () => {
  const q = player.queue;
  if (!q.length) return `<h1>${t('queue')}</h1><p class="muted empty">${t('empty')}</p>`;
  return `<h1>${t('queue')}</h1>${queueHtml()}`;
};
function queueHtml() {
  const q = player.queue;
  const cur = player.index;
  const now = q[cur] ? [q[cur]] : [];
  const up = q.slice(cur + 1);
  const id = 'queue';
  state.lists = state.lists || {};
  state.lists.qnow = now;
  state.lists.qup = up;
  const rows = (list, key, offset) =>
    `<div class="tracks" data-list="${key}" data-queue="1">${list
      .map(
        (tr, i) => `<div class="row ${offset + i === cur ? 'current' : ''}" data-i="${i}" data-q="${offset + i}" data-id="${tr.id}" draggable="${offset + i > cur}">
        <div class="lead">${coverImg(tr.id, 'sm')}<span class="eqi" aria-hidden="true"><i></i><i></i><i></i><i></i></span><button class="playbtn">${icon('play')}</button></div>
        <div class="main"><div class="title">${esc(tr.title)}</div><div class="sub">${esc(artistName(tr))}</div></div>
        <button class="icon-btn like ${tr.liked ? 'on' : ''}" data-like="${tr.id}">${icon(tr.liked ? 'heartFill' : 'heart')}</button>
        <div class="dur">${fmtTime(tr.duration)}</div><button class="icon-btn more">${icon('more')}</button></div>`
      )
      .join('')}</div>`;
  return `<div class="queue-view" id="${id}">
    ${now.length ? section(t('nowPlaying'), rows(now, 'qnow', cur)) : ''}
    ${section(t('upNext'), up.length ? rows(up, 'qup', cur + 1) : `<p class="muted empty">${t('empty')}</p>`, up.length ? `<button class="btn ghost sm" data-clearq>${t('clearQueue')}</button>` : '')}
  </div>`;
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-clearq]')) player.clearUpcoming();
});
// drag & drop in queue
let dragFrom = null;
document.addEventListener('dragstart', (e) => {
  const row = e.target.closest?.('.queue-view .row');
  if (!row) return;
  dragFrom = Number(row.dataset.q);
  e.dataTransfer.effectAllowed = 'move';
});
document.addEventListener('dragover', (e) => {
  if (dragFrom != null && e.target.closest?.('.queue-view .row')) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  const row = e.target.closest?.('.queue-view .row');
  if (dragFrom == null || !row) return;
  e.preventDefault();
  const to = Number(row.dataset.q);
  if (to > player.index) player.move(dragFrom, to);
  dragFrom = null;
});

// ---------- router ----------
function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}
const TABS = ['home', 'search', 'library'];
let renderSeq = 0;
async function render() {
  closeMenu();
  const hash = location.hash || '#/home';
  const [pathPart, query = ''] = hash.slice(2).split('?');
  const [name, id] = pathPart.split('/');
  const params = new URLSearchParams(query);
  const view = views[name] || views.home;
  const seq = ++renderSeq;
  state.route = name || 'home';
  // pages without their own tab (album, artist, playlist …) keep the tab they were opened from, so the blob never vanishes
  if (TABS.includes(state.route)) state.tab = state.route;
  else if (state.route === 'likes' || state.route === 'imported' || state.route === 'playlist' || state.route === 'topsongs') state.tab = 'library';
  const tab = state.tab || 'home';
  document.querySelectorAll('.side-nav [data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === state.route));
  fsButtons();
  document.querySelectorAll('.bottomnav [data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === tab));
  navBlob.place();
  glassPanes.scan();
  const main = $('#view');
  if (state.route !== state.prevRoute) main.innerHTML = '<div class="loading"></div>';
  state.prevRoute = state.route;
  try {
    const html = await view(params, id);
    if (seq !== renderSeq) return;
    main.innerHTML = html;
    main.classList.toggle('detail', !!main.querySelector('.detail-head'));
    tintAll(main);
    warmSoon(200);
    if (main.querySelector('[data-offpl]')) paintOffline();
    if (main.querySelector('[data-preload]')) paintPreload();
    paintPlayButtons();
    main.scrollTop = 0;
    $('#content').scrollTop = 0;
    paintBars();
    if (state.route === 'search') {
      const q = $('#q');
      if (q) {
        if (!matchMedia('(hover: none)').matches && document.activeElement?.id !== 'tbq') q.focus();
        runSearch(q.value).catch(() => {});
      }
    }
  } catch (e) {
    if (seq !== renderSeq) return;
    main.innerHTML = `<p class="muted empty">${esc(errorText(e))}</p>`;
  }
}
// songs that come from YouTube are looked up as soon as they are on screen, and again the moment a finger or the mouse reaches one
function warmVisible() {
  const main = $('#view');
  if (!main) return;
  for (const el of main.querySelectorAll('[data-list], [data-cards]')) {
    const list = state.lists?.[el.dataset.list || el.dataset.cards];
    if (!list) continue;
    const vh = innerHeight;
    const idx = [...el.children].filter((c) => { const r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < innerWidth; }).map((c) => Number(c.dataset.i)).filter((i) => i >= 0);
    warmSongs(idx.map((i) => list[i]).filter(Boolean));
  }
}
let warmTimer = 0;
const warmSoon = (ms = 350) => { clearTimeout(warmTimer); warmTimer = setTimeout(warmVisible, ms); };
document.addEventListener('scroll', () => warmSoon(450), true);
const warmUnder = (e) => {
  const row = e.target.closest?.('[data-list] > .row, [data-cards] > .card');
  if (!row) return;
  const box = row.parentElement;
  const tr = state.lists?.[box.dataset.list || box.dataset.cards]?.[Number(row.dataset.i)];
  if (tr) warmSongs([tr]);
};
document.addEventListener('pointerdown', warmUnder, true);
document.addEventListener('pointerover', (e) => e.pointerType === 'mouse' && warmUnder(e), true);
addEventListener('hashchange', () => {
  if ($('#settings')?.classList.contains('open')) closeSettings();
  closeProfile();
  render();
});
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-back]')) history.length > 1 ? history.back() : go('#/home');
});

// ---------- player UI ----------
function renderPlayer() {
  const tr = player.current;
  const bar = $('#player');
  bar.classList.toggle('idle', !tr);
  const coverBox = $('#np-cover');
  const big = $('#fs-cover');
  if (tr) {
    if (coverBox.dataset.id !== String(tr.id)) {
      coverBox.dataset.id = tr.id;
      coverBox.innerHTML = coverImg(tr.id, 'md');
      big.innerHTML = coverImg(tr.id, 'huge');
      // Liquid Glass: the big player lies on the blurred artwork, like Apple Music
      const art = coverUrl(tr.id);
      $('#fs').style.setProperty('--art', art ? `url("${art.replace(/"/g, '%22')}")` : 'none');
      viz?.attach(big);
    }
    // like Spotify: once the sound plays on another device the artist moves up next to the song, after a dot
    $('#np-title').innerHTML = `<span class="np-t">${esc(tr.title)}</span><span class="np-inl"> • ${artistText(tr)}</span>`;
    $('#np-artist').innerHTML = artistLinks(tr);
    $('#fs-title').textContent = tr.title;
    $('#fs-artist').innerHTML = artistLinks(tr);
    playerMarquees();
    requestAnimationFrame(paintBand);
    document.title = `${tr.title} · ${artistName(tr)}`;
    applyDyn(tr);
  } else {
    coverBox.dataset.id = '';
    coverBox.innerHTML = coverImg(null, 'md');
    big.innerHTML = coverImg(null, 'huge');
    viz?.attach(big);
    $('#np-title').textContent = t('nothingPlaying');
    $('#np-artist').textContent = '';
    $('#fs-title').textContent = t('nothingPlaying');
    $('#fs-artist').textContent = '';
    playerMarquees();
    requestAnimationFrame(paintBand);
    document.title = 'Streyn';
    applyDyn(null);
  }
  const liked = isLiked(tr);
  document.querySelectorAll('[data-act="like"]').forEach((b) => {
    b.dataset.like = tr?.id ?? '';
    b.classList.toggle('on', liked);
    b.innerHTML = icon(liked ? 'heartFill' : 'heart');
    b.title = liked ? t('unlike') : t('like');
  });
  document.querySelectorAll('[data-act="shuffle"]').forEach((b) => b.classList.toggle('on', player.shuffled));
  document.querySelectorAll('[data-act="repeat"]').forEach((b) => {
    b.classList.toggle('on', player.repeat !== 'off');
    b.innerHTML = icon(player.repeat === 'one' ? 'repeatOne' : 'repeat');
  });
  renderState();
  renderTime();
  document.querySelectorAll('.tracks .row').forEach((r) => {
    if (!r.closest('[data-queue]')) r.classList.toggle('current', r.dataset.id === String(tr?.id));
  });
  document.body.classList.toggle('ext-playing', !!tr?.ext);
  placeStage();
  const lb = lyricsBox();
  if (lb) renderLyrics(lb);
  if (state.route === 'queue') {
    const v = $('#view');
    v.innerHTML = `<h1>${t('queue')}</h1>${player.queue.length ? queueHtml() : `<p class="muted empty">${t('empty')}</p>`}`;
  }
  if ($('#fs').classList.contains('open') && $('#fs-queue').classList.contains('open')) $('#fs-queue').innerHTML = queueHtml();
  gOnChange();
}
function renderState() {
  document.documentElement.classList.toggle('is-playing', !!player.playing);
  document.querySelectorAll('[data-act="toggle"]').forEach((b) => {
    b.innerHTML = icon(player.playing ? 'pause' : 'play');
    b.title = player.playing ? t('pause') : t('play');
    b.classList.toggle('busy', player.buffering && player.playing);
  });
  document.querySelectorAll('input.vol').forEach((v) => {
    if (document.activeElement !== v) v.value = player.volume;
    v.style.setProperty('--p', Number(v.value) * 100 + '%');
  });
  document.querySelectorAll('[data-act="mute"]').forEach((b) => (b.innerHTML = icon(player.volume === 0 ? 'mute' : 'volume')));
}
let seeking = false;
function renderTime() {
  const d = player.duration || player.current?.duration || 0;
  const p = Math.min(player.position, d || player.position);
  document.querySelectorAll('.seek').forEach((s) => {
    if (seeking && document.activeElement === s) return;
    s.max = d || 1;
    s.value = p;
    s.style.setProperty('--p', d ? (p / d) * 100 + '%' : '0%');
  });
  document.querySelectorAll('.t-pos').forEach((e) => (e.textContent = fmtTime(p)));
  document.querySelectorAll('.t-dur').forEach((e) => (e.textContent = fmtTime(d)));
  const mp = $('#mini-progress i');
  if (mp) mp.style.transform = `scaleX(${d ? Math.min(1, p / d) : 0})`;
}

function bindPlayer() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'toggle') player.toggle();
    else if (a === 'next') player.next();
    else if (a === 'prev') player.prev();
    else if (a === 'shuffle') player.toggleShuffle();
    else if (a === 'repeat') player.cycleRepeat();
    else if (a === 'like' && player.current) toggleLike(player.current);
    else if (a === 'queue') {
      if (innerWidth < 900) {
        $('#fs').classList.contains('open') ? toggleFsQueue() : go('#/queue');
      } else go(state.route === 'queue' ? '#/home' : '#/queue');
    } else if (a === 'mute') {
      if (player.volume > 0) {
        prefs.prevVolume = player.volume;
        player.setVolume(0);
      } else player.setVolume(prefs.prevVolume || 1);
      prefs.volume = player.volume;
      savePrefs();
    } else if (a === 'lyrics') {
      if ($('#fs').classList.contains('open')) toggleFsLyrics();
      else go(state.route === 'lyrics' ? '#/home' : '#/lyrics');
    } else if (a === 'viz') {
      const fsOpen = $('#fs').classList.contains('open');
      const cur = prefs.viz || 'off';
      if (!fsOpen) {
        if (cur === 'off') prefs.viz = prefs.vizLast || 'bars';
        openFs(true);
        setViz(prefs.viz);
      } else {
        const next = VIZ_MODES[(VIZ_MODES.indexOf(cur) + 1) % VIZ_MODES.length];
        if (next !== 'off') prefs.vizLast = next;
        setViz(next);
        toast(t('viz_' + next) + (next !== 'off' && player.current?.ext ? ' · ' + t('vizPlatform') : ''));
      }
    } else if (a === 'open-fs') openFs(true);
    else if (a === 'close-fs') openFs(false);
    else if (a === 'chill') openChill();
    else if (a === 'menu' && player.current) trackMenu(b, player.current, {});
    e.stopPropagation();
  });
  document.addEventListener('input', (e) => {
    if (e.target.classList.contains('seek')) {
      seeking = true;
      const s = e.target;
      s.style.setProperty('--p', (s.value / s.max) * 100 + '%');
      document.querySelectorAll('.t-pos').forEach((x) => (x.textContent = fmtTime(Number(s.value))));
    }
    if (e.target.classList.contains('vol')) {
      e.target.style.setProperty('--p', Number(e.target.value) * 100 + '%');
      player.setVolume(Number(e.target.value));
      prefs.volume = player.volume;
      savePrefs();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.classList.contains('seek')) {
      player.seek(Number(e.target.value));
      seeking = false;
    }
  });
  bindSwipe('#fs-cover', '.cover');
  bindSwipe('#mini', '.np-text');
  // an artist name in the big player: put the player away and open the artist
  document.addEventListener('click', (e) => {
    const l = e.target.closest('#fs a.alink');
    if (!l) return;
    e.preventDefault();
    openFs(false);
    setTimeout(() => (location.hash = l.getAttribute('href')), 0);
  });
  document.addEventListener('click', (e) => {
    const mini = e.target.closest('#mini');
    if (!mini || !player.current || e.target.closest('button, [data-devsheet]') || mini.dataset.swiped) return;
    // phone: a tap anywhere on the small player opens the big one (the artist too, it is tiny there)
    if (innerWidth < 900) return void (e.preventDefault(), openFs(true));
    // desktop: the cover or the song name open the big player, the artist name opens the artist
    if (e.target.closest('a.alink')) return;
    if (e.target.closest('#np-cover, #np-title, .np-text')) openFs(true);
  });
  player.addEventListener('change', renderPlayer);
  player.addEventListener('change', () => rememberPlay(player.current));
  player.addEventListener('state', renderState);
  player.addEventListener('state', paintPlayButtons);
  player.addEventListener('change', paintPlayButtons);
  player.addEventListener('state', miniVizSync);
  player.addEventListener('change', () => chill && chillMeta());
  player.addEventListener('change', () => setTimeout(presenceTick, 800));
  player.addEventListener('change', discordSync);
  player.addEventListener('state', discordSync);
  player.addEventListener('state', () => { clearTimeout(window.__presT); window.__presT = setTimeout(presenceTick, 600); });
  player.addEventListener('state', () => {
    if (!chill) return;
    // the new song waits silently until its record is down: an engine that starts on its own is stopped again
    if (chill.hold != null && player.playing) player.pause();
    chillMeta();
  });
  player.addEventListener('change', miniVizSync);
  document.addEventListener('visibilitychange', miniVizSync);
  player.addEventListener('time', renderTime);
  player.addEventListener('time', syncLyrics);
  player.addEventListener('error', () => toast(player.lastError && t(player.lastError) !== player.lastError ? t(player.lastError) : t('error')));
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      player.toggle();
    } else if (e.code === 'ArrowRight' && e.altKey) player.next();
    else if (e.code === 'ArrowLeft' && e.altKey) player.prev();
    else if (e.key === 'Escape') {
      closeMenu();
      openFs(false);
      closeSettings();
    }
  });
}
/** The small visualizer in the mini player: runs while a song plays and the big player is closed. */
function miniVizSync() {
  if (!player) return;
  if (!viz) viz = new Visualizer(player);
  if (!miniViz) miniViz = new MiniViz(player, viz);
  const box = $('#player');
  if (!box) return;
  miniViz.attach(box);
  const mode = prefs.miniViz || 'off'; // off until chosen (setup or settings); then a thin strip along the bottom edge of the bar
  miniViz.setMode(mode);
  const run = mode !== 'off' && player.playing && !document.hidden && !$('#fs').classList.contains('open');
  if (run) {
    // Android asks once for the audio permission its visualizer needs: only after the big visualizer was used
    if (!miniViz.running && !viz.running && prefs.vizAsked) player.startViz();
    miniViz.start();
  } else {
    miniViz.stop();
    if (!viz.running) player.stopViz();
    // let the bars fall instead of freezing
    if (mode !== 'off' && miniViz.canvas) miniViz.canvas.getContext('2d').clearRect(0, 0, miniViz.canvas.width, miniViz.canvas.height);
  }
}
function vizSync() {
  if (!player) return;
  if (!viz) viz = new Visualizer(player);
  viz.attach($('#fs-cover'));
  const on = $('#fs').classList.contains('open') && (prefs.viz || 'off') !== 'off';
  viz.setMode(on ? prefs.viz : 'off');
  if (on) {
    if (!prefs.vizAsked) (prefs.vizAsked = true), savePrefs();
    if (!viz.running) player.startViz();
    viz.start();
  } else {
    viz.stop();
    // the small one takes over first, so the sound reading is not switched off and on again in between
    miniVizSync();
    if (!miniViz?.running) player.stopViz();
  }
  miniVizSync();
}
function setViz(mode) {
  prefs.viz = mode;
  savePrefs();
  vizSync();
  fsButtons();
  const sel = $('#vizmode');
  if (sel) sel.value = mode;
}
document.addEventListener('change', (e) => {
  if (e.target.id !== 'vizmode') return;
  if (e.target.value !== 'off') prefs.vizLast = e.target.value;
  setViz(e.target.value);
});
// Big player: the cover takes the free space between the top bar and the title, never more, and on wide
// screens the title, line and buttons are exactly as wide as the cover, so everything lines up in every theme.
let fsFit = null;
function fitFsCover() {
  const box = $('#fs-cover');
  const fs = $('#fs');
  if (!box || !fs) return;
  const r = box.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const cap = innerWidth >= 900 ? innerHeight * 0.52 : Infinity;
  fs.style.setProperty('--cov', Math.max(140, Math.floor(Math.min(r.width, r.height, cap))) + 'px');
}
function watchFsCover() {
  fsFit?.disconnect();
  const box = $('#fs-cover');
  if (!box || !window.ResizeObserver) return;
  fsFit = new ResizeObserver(() => fitFsCover());
  fsFit.observe(box);
}
function openFs(open) {
  $('#fs').classList.toggle('open', open);
  if (open) fitFsCover();
  if (open) playerMarquees();
  vizSync();
  if (!open) $('#fs-queue').classList.remove('open', 'full');
  if (!open) $('#fs-lyrics').classList.remove('open', 'full');
  fsButtons();
  paintBars();
  placeStage();
  setTimeout(placeStage, 350);
  if (open) history.pushState({ fs: 1 }, '');
}
// ---------- chillscreen: the room from the website, with its camera moves, around the song that plays ----------
let chill = null;
function chillSync() {
  const b = $('#fs-chill');
  if (b) b.hidden = !prefs.chill;
  if (!prefs.chill && chill) closeChill();
}
const chillCover = () => $('#fs-cover img')?.src || $('#np-cover img')?.src || '';
function chillShow(m) {
  if (!chill || !m) return;
  chill.last = m;
  const ti = chill.el.querySelector('.ch-title'), ar = chill.el.querySelector('.ch-artist');
  ti.textContent = m.title;
  // phone like Spotify: every artist on its own link, long lines run in a loop; desktop stays as it is
  if (matchMedia('(max-width: 899px)').matches && m.links) ar.innerHTML = m.links; else ar.textContent = m.artist;
  chill.el.querySelector('.ch-cover').innerHTML = m.src ? `<img src="${esc(m.src)}" alt="">` : '';
  requestAnimationFrame(() => { spotMarquee(ti); spotMarquee(ar); });
}
addEventListener('resize', () => chill?.last && chillShow(chill.last));
// the room is decorated with what plays next: crate, CDs, shelf and the wall show the upcoming covers
function chillDecor() {
  const q = player.queue || [], i = player.index;
  const up = [...q.slice(i + 1), ...q.slice(0, Math.max(0, i))].filter((x) => x && x.id != null && x.has_cover !== false).slice(0, 16);
  // covers for the room, and the artist + title of each for the CD spines (same order)
  const seen = new Set(), urls = [], names = [];
  for (const x of up) { const u = sharpCover(coverUrl(x.id)); if (seen.has(u)) continue; seen.add(u); urls.push(u); names.push({ artist: artistName(x), title: x.title || '' }); }
  const cur = player.current;
  chill?.room?.setDecor(urls.length ? urls : [chillCover()], urls.length ? names : cur ? [{ artist: artistName(cur), title: cur.title || '' }] : null);
}
function chillMeta() {
  if (!chill) return;
  const tr = player.current;
  chill.el.querySelector('[data-chill="toggle"]').innerHTML = icon(player.playing || chill.hold != null ? 'pause' : 'play');
  if (!tr) return;
  const m = { id: tr.id, title: tr.title || '', artist: artistName(tr), links: artistLinks(tr), src: chillCover() };
  if (!chill.room) { chill.first = m; chill.id = m.id; chillShow(m); return; }
  chillDecor();
  // a new song: the record change runs completely, the title switches once the new record spins
  if (m.id !== chill.id && m.src) {
    chill.id = m.id; chill.meta[chill.room.next(m.src)] = m;
    // and the song itself only starts when the needle is down
    chill.hold = m.id; if (player.playing) player.pause();
  }
}
// the record of the held song is down: now it plays, from the start
function chillRelease(m) {
  if (!chill || chill.hold == null || (m && m.id !== chill.hold)) return;
  chill.hold = null;
  if (player.position > 1) player.seek(0);
  player.play();
}
async function openChill() {
  if (chill || !player.current) return;
  const el = document.createElement('div');
  el.className = 'chill';
  el.innerHTML = `<canvas></canvas><div class="ch-ui"><button class="icon-btn ch-close" data-chill="close" title="${t('close')}">${icon('close')}</button><button class="icon-btn ch-pin" data-chill="pin" title="${t('chillPin')}" aria-label="${t('chillPin')}"></button>
    <div class="ch-np"><div class="ch-cover"></div><div class="ch-meta"><b class="ch-title"></b><span class="ch-artist"></span></div>
    <div class="ch-ctl"><button class="icon-btn" data-chill="prev">${icon('prev')}</button><button class="icon-btn ch-play" data-chill="toggle"></button><button class="icon-btn" data-chill="next">${icon('next')}</button></div></div></div>`;
  document.body.appendChild(el);
  chill = { el, room: null, hide: 0, lock: null, meta: [], id: player.current.id };
  const pinSync = () => { const on = !!prefs.chillPin; el.classList.toggle('pinned', on); const b = el.querySelector('.ch-pin'); b.innerHTML = icon('pin'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); };
  pinSync();
  chillMeta();
  const wake = () => { el.classList.remove('calm'); clearTimeout(chill?.hide); if (chill) chill.hide = setTimeout(() => el.classList.add('calm'), 3500); };
  el.addEventListener('pointermove', wake);
  el.addEventListener('pointerdown', wake);
  el.addEventListener('click', (e) => {
    // an artist link: leave the room, then open the artist
    const al = e.target.closest('a.alink');
    if (al) { e.preventDefault(); const href = al.getAttribute('href'); closeChill(); setTimeout(() => { location.hash = href.replace(/^#/, ''); }, 150); return; }
    const b = e.target.closest('[data-chill]');
    if (!b) return;
    const k = b.dataset.chill;
    if (k === 'close') closeChill();
    else if (k === 'pin') { prefs.chillPin = !prefs.chillPin; savePrefs(); pinSync(); }
    else if (k === 'toggle') { if (chill.hold != null) { chill.hold = null; chillMeta(); } else player.toggle(); }
    else if (k === 'next') player.next();
    else if (k === 'prev') player.prev();
  });
  wake();
  requestAnimationFrame(() => el.classList.add('open'));
  history.pushState({ chill: 1 }, '');
  try { await el.requestFullscreen?.({ navigationUI: 'hide' }); } catch {}
  try { chill.lock = await navigator.wakeLock?.request('screen'); } catch {}
  try {
    const { createTurntable } = await import('./room.js');
    if (!chill || chill.el !== el) return;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4c8dff';
    chill.meta = [chill.first];
    chill.room = createTurntable(el.querySelector('canvas'), { accent, tracks: [{ cover: chill.first?.src || chillCover() }], center: true, follow: false, manual: true, beatSync: prefs.chillSync || 'beat', bands: (o) => player.spectrum(o), onTrack: (i) => { chillShow(chill?.meta[i]); chillRelease(chill?.meta[i]); }, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches });
    chillMeta();
    el.classList.add('ready');
    // Android: its visualizer delivers the sound for the dots and the beat (only if the permission was given before)
    if (prefs.vizAsked) player.startViz();
    chill.tick = setInterval(() => {
      const r = chill?.room;
      if (!r) return;
      r.setAccent(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || accent);
      // the speakers move with the music: real bands when the visualizer runs, otherwise a calm beat
      const live = [viz, miniViz].find((v) => v?.running);
      const e = live ? Array.from(live.smooth.slice(0, 10)).reduce((s, v) => s + v, 0) / 10 : player.playing ? 0.32 + Math.max(0, Math.sin(performance.now() / 260)) * 0.18 : 0;
      r.setEnergy(player.playing ? Math.min(1, e) : 0);
      r.setPlaying?.(player.playing || player.buffering || chill.hold != null);
    }, 100);
  } catch (err) {
    console.warn('chill', err);
    toast(t('error'));
    closeChill();
  }
}
function closeChill(fromHistory) {
  const c = chill;
  if (!c) return;
  chillRelease();
  if (!viz?.running && !miniViz?.running) player.stopViz();
  chill = null;
  clearInterval(c.tick); clearTimeout(c.hide);
  try { c.lock?.release(); } catch {}
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  c.el.classList.remove('open');
  setTimeout(() => { c.room?.dispose(); c.el.remove(); }, 380);
  if (!fromHistory && history.state?.chill) history.back();
}
addEventListener('popstate', () => chill && closeChill(true));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && chill) closeChill(); });
// phone: drag the big player down to put it away, drag the small player up to open it. The player follows the finger.
(() => {
  let d = null;
  const fs = () => $('#fs');
  document.addEventListener('pointerdown', (e) => {
    d = null;
    if (e.pointerType === 'mouse' || innerWidth >= 900 || !player?.current) return;
    const f = fs();
    if (!f) return;
    const open = f.classList.contains('open');
    if (open ? !e.target.closest('#fs') || e.target.closest('input, .fs-queue, .fs-lyrics, .menu') : !e.target.closest('#player') || e.target.closest('input')) return;
    d = { id: e.pointerId, y0: e.clientY, x0: e.clientX, open, on: false, y: 0, t: performance.now(), ly: e.clientY, v: 0 };
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!d || e.pointerId !== d.id) return;
    const dy = e.clientY - d.y0, dx = e.clientX - d.x0;
    if (!d.on) {
      if (Math.abs(dy) < 12 && Math.abs(dx) < 12) return;
      if (Math.abs(dx) > Math.abs(dy) || (d.open ? dy < 0 : dy > 0)) return void (d = null);
      d.on = true;
      const f = fs();
      f.classList.add('dragging');
      if (!d.open) placeStage();
    }
    const now = performance.now();
    d.v = (e.clientY - d.ly) / Math.max(1, now - d.t);
    d.ly = e.clientY; d.t = now;
    d.y = d.open ? Math.max(0, dy) : Math.max(0, innerHeight + dy);
    fs().style.transform = `translateY(${d.y}px)`;
  }, true);
  const up = (e) => {
    if (!d || e.pointerId !== d.id) return;
    const g = d;
    d = null;
    if (!g.on) return;
    const f = fs();
    const moved = g.open ? g.y : innerHeight - g.y;
    const go = g.open ? (moved > 130 || g.v > 0.5) && g.v > -0.3 : (moved > 90 || g.v < -0.5) && g.v < 0.3;
    const want = g.open ? !go : go; // open afterwards?
    f.classList.remove('dragging');
    f.classList.add('settling');
    f.style.transform = want ? 'translateY(0)' : 'translateY(100%)';
    // the tap that ends the drag must not press what is under the finger
    const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    document.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', stop, true), 350);
    setTimeout(() => {
      f.classList.remove('settling');
      f.style.transform = '';
      if (want !== f.classList.contains('open')) openFs(want);
    }, 260);
  };
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
})();
function toggleFsQueue() {
  const q = $('#fs-queue');
  $('#fs-lyrics').classList.remove('open', 'full');
  q.classList.toggle('open');
  if (!q.classList.contains('open')) q.classList.remove('full');
  if (q.classList.contains('open')) q.innerHTML = queueHtml();
  fsButtons();
}
/* Queue and lyrics are a sheet like on Spotify: a grip on top, pulled up it fills the screen, pulled down it gets small again.
   Small, the sheet does not scroll; trying to scroll it makes it big, and big it scrolls. */
(() => {
  const sheet = (el) => el?.closest?.('#fs-queue, #fs-lyrics');
  const setFull = (el, on) => {
    if (el.classList.contains('full') === on) return;
    el.classList.toggle('full', on);
    if (!on) el.scrollTop = 0;
    setTimeout(paintBars, 320);
    navigator.vibrate?.(8);
  };
  const close = (el) => {
    el.classList.remove('open', 'full');
    fsButtons();
  };
  // the sheet follows the finger: top edge while growing or shrinking, a slide down while closing; on release it springs to its place
  let t = null;
  const drag = (el, top, slide) => {
    el.style.transition = 'none';
    el.style.top = top == null ? '' : top + 'px';
    el.style.transform = slide ? `translateY(${slide}px)` : '';
  };
  const release = (el) => {
    el.style.transition = el.style.top = el.style.transform = '';
  };
  document.addEventListener('touchstart', (e) => {
    const el = sheet(e.target);
    if (!el || !el.classList.contains('open')) return (t = null);
    const r = el.getBoundingClientRect();
    const host = el.offsetParent?.getBoundingClientRect().top || 0;
    t = { el, y: e.touches[0].clientY, top0: r.top - host, grip: e.touches[0].clientY - r.top < 34, top: el.scrollTop <= 0, full: el.classList.contains('full'), moved: false, dy: 0 };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!t) return;
    const dy = e.touches[0].clientY - t.y;
    const minTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-t')) || 0;
    if (!t.full) {
      // small: never scrolls, the finger moves the sheet (up = bigger, down = away)
      if (e.cancelable) e.preventDefault();
      t.moved = true; t.dy = dy;
      if (dy < 0) drag(t.el, Math.max(minTop, t.top0 + dy * 1.15), 0);
      else drag(t.el, null, dy);
    } else if ((t.grip || t.top) && (t.moved || dy > 6)) {
      // big and at the top: pulling down brings it back down with the finger
      if (e.cancelable) e.preventDefault();
      t.moved = true; t.dy = dy;
      t.el.style.transition = 'none';
      t.el.style.setProperty('top', Math.max(minTop, t.top0 + Math.max(0, dy)) + 'px', 'important');
    }
  }, { passive: false });
  const end = () => {
    if (!t) return;
    const { el, dy, moved, full } = t;
    t = null;
    if (!moved) return;
    // one frame with the release transition set, then the class change animates from where the finger left the sheet
    if (!full) {
      if (dy < -40) { release(el); setFull(el, true); }
      else if (dy > 90) { release(el); close(el); }
      else release(el);
    } else if (dy > 90) { release(el); setFull(el, false); }
    else release(el);
  };
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
  // mouse: the wheel on a small sheet makes it big, the grip switches between small and big
  document.addEventListener('wheel', (e) => {
    const el = sheet(e.target);
    if (!el || !el.classList.contains('open')) return;
    if (!el.classList.contains('full')) {
      e.preventDefault();
      if (e.deltaY > 0) setFull(el, true);
    } else if (e.deltaY < -30 && el.scrollTop <= 0) setFull(el, false);
  }, { passive: false });
  document.addEventListener('click', (e) => {
    const el = sheet(e.target);
    if (!el || !el.classList.contains('open') || e.target.closest('button, a, input, .row, .lyrics p')) return;
    if (e.clientY - el.getBoundingClientRect().top < 34) setFull(el, !el.classList.contains('full'));
  });
})();
addEventListener('popstate', () => {
  if ($('#fs').classList.contains('open')) openFs(false);
});

// Android back button
window.musikBack = () => {
  if ($('.modal-wrap')) return $('.modal-wrap').remove(), true;
  if ($('.menu:not(.lg-ghost)')) return closeMenu(), true;
  if ($('#settings').classList.contains('open')) return closeSettings(), true;
  if ($('#fs').classList.contains('open')) return openFs(false), true;
  if (location.hash && location.hash !== '#/home') return history.back(), true;
  return false;
};

// ---------- sidebar ----------
async function renderSidebarPlaylists() {
  const box = $('#side-playlists');
  if (!box) return;
  try {
    // playlists and imported playlists, pinned unless taken off the sidebar
    const [lists, imps] = await Promise.all([get('/api/playlists'), get('/api/imports').catch(() => [])]);
    const hidden = new Set(settings.unpinned || []);
    const item = (ref, href, cov, name, sub) =>
      hidden.has(ref) ? '' : `<a href="${href}" class="side-pl" data-ref="${ref}">${coverImg(cov, 'xs')}<span class="spl-t"><b>${esc(name)}</b><small>${sub}</small></span></a>`;
    for (const im of imps) if (im.cover && !im.art) extCovers.set('impc:' + im.id, im.cover);
    const all = [
      ...lists.map((p) => ['playlist:' + p.id, () => item('playlist:' + p.id, '#/playlist/' + p.id, artKey('playlist', p.id, p.art) || p.cover_id, p.name, `${t('playlist')} · ${songCount(p.tracks)}`)]),
      ...imps.map((im) => ['import:' + im.id, () => item('import:' + im.id, '#/imported/' + im.id, artKey('import', im.id, im.art) || (im.cover ? 'impc:' + im.id : im.cover_id), im.name, `${im.kept || t('src_' + im.source) === 'src_' + im.source ? t('playlist') : t('src_' + im.source)} · ${songCount(im.total)}`)])
    ];
    // the yearly top songs below, like Spotify keeps them in the library (no drag, no menu: they are made, not owned)
    const tops = (await loadTopSongs()).map((y) => `<a href="#/topsongs/${y.year}" class="side-pl gen">${coverImg(y.cover, 'xs')}<span class="spl-t"><b>${esc(y.title)}</b><small>${t('playlist')} · ${esc(t('forUser', { name: userName() }))}</small></span></a>`);
    box.innerHTML = byPlOrder(all, (x) => x[0]).map((x) => x[1]()).join('') + tops.join('');
    box.dataset.sortpl = '';
  } catch {
    box.innerHTML = '';
  }
}

// ---------- own order of playlists: drag them in the sidebar or in the library ----------
// The order is kept in the account settings, so it is the same on every device.
// Playlists without a place yet (new ones) come first, like a new playlist at the top.
function byPlOrder(items, refOf) {
  const pos = new Map((settings.plOrder || []).map((r, i) => [r, i]));
  return items
    .map((x, i) => [x, i])
    .sort((a, b) => {
      const pa = pos.has(refOf(a[0])) ? pos.get(refOf(a[0])) : -1;
      const pb = pos.has(refOf(b[0])) ? pos.get(refOf(b[0])) : -1;
      return pa === pb ? a[1] - b[1] : pa - pb;
    })
    .map((x) => x[0]);
}
function savePlOrder(box) {
  const now = [...box.children].map((c) => c.dataset.ref).filter(Boolean);
  const seen = new Set(now);
  // playlists that are not in this list (hidden ones, imports) keep their places,
  // the slots of the ones in this list are filled in the new order
  const prev = (settings.plOrder || []).filter((r) => r);
  const order = [];
  let k = 0;
  for (const r of prev) order.push(seen.has(r) ? now[k++] : r);
  while (k < now.length) order.push(now[k++]);
  saveSettings({ plOrder: order.filter((r, i) => r && order.indexOf(r) === i) }).catch(() => {});
  if (box.id !== 'side-playlists') renderSidebarPlaylists();
  else if (state.route === 'library' && /tab=playlists/.test(location.hash)) render();
}
{
  let d = null; // { box, el, id, x0, y0, on, touch, armed, timer }
  const items = (box) => [...box.children].filter((c) => c.dataset.ref);
  const flip = (box, move) => {
    const els = items(box);
    const before = new Map(els.map((e) => [e, e.getBoundingClientRect()]));
    move();
    for (const e of els) {
      if (e === d?.el) continue;
      const a = before.get(e), b = e.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (!dx && !dy) continue;
      e.style.transition = 'none';
      e.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        e.style.transition = 'transform 0.18s ease';
        e.style.transform = '';
      });
    }
  };
  const start = () => {
    d.on = true;
    d.el.classList.add('pl-dragging');
    d.box.classList.add('pl-sorting');
    document.body.classList.add('pl-sorting-body');
    navigator.vibrate?.(10);
  };
  const moveTo = (x, y) => {
    const el = d.el;
    el.style.pointerEvents = 'none';
    const under = document.elementFromPoint(x, y)?.closest('[data-ref]');
    el.style.pointerEvents = '';
    // keep the list scrolling when the finger is at its edge
    const sc = d.box.closest('.side, #content, .side-pls') || d.box;
    const r = sc.getBoundingClientRect();
    if (y < r.top + 40) sc.scrollTop -= 10;
    else if (y > r.bottom - 40) sc.scrollTop += 10;
    if (!under || under === el || under.parentElement !== d.box) return;
    const ur = under.getBoundingClientRect();
    const grid = d.box.classList.contains('libgrid') && getComputedStyle(d.box).display === 'grid';
    const after = grid && ur.height < r.height / 2 && Math.abs(ur.top - el.getBoundingClientRect().top) < 4 ? x > ur.left + ur.width / 2 : y > ur.top + ur.height / 2;
    // already right there
    if ((after && under.nextSibling === el) || (!after && under.previousSibling === el)) return;
    flip(d.box, () => d.box.insertBefore(el, after ? under.nextSibling : under));
  };
  const end = (drop) => {
    if (!d) return;
    clearTimeout(d.timer);
    const x = d;
    d = null;
    if (!x.on) return;
    x.el.classList.remove('pl-dragging');
    x.box.classList.remove('pl-sorting');
    document.body.classList.remove('pl-sorting-body');
    // the click that ends a drag does not open the playlist
    const stop = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    document.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', stop, { capture: true }), 400);
    if (drop) savePlOrder(x.box);
  };
  document.addEventListener('pointerdown', (e) => {
    if (d || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const el = e.target.closest('[data-sortpl] > [data-ref]');
    if (!el) return;
    const touch = e.pointerType !== 'mouse';
    d = { box: el.parentElement, el, id: e.pointerId, x0: e.clientX, y0: e.clientY, on: false, touch, armed: !touch, timer: 0 };
    // finger: hold a moment, then drag. Mouse: just drag.
    if (touch) d.timer = setTimeout(() => d && !d.on && ((d.armed = true), d.el.classList.add('pl-armed')), 380);
  });
  document.addEventListener('pointermove', (e) => {
    if (!d || e.pointerId !== d.id) return;
    const far = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
    if (!d.on) {
      if (!d.armed) {
        if (far > 10) end(false); // a scroll, not a drag
        return;
      }
      // past the 10 px at which a held finger no longer counts as a long press for the menu
      if (far < 12) return;
      d.el.classList.remove('pl-armed');
      start();
    }
    if (document.querySelector('.menu:not(.lg-ghost)')) closeMenu();
    e.preventDefault();
    moveTo(e.clientX, e.clientY);
  });
  // while a finger drags, the page must not scroll
  document.addEventListener('touchmove', (e) => {
    if (d && (d.on || d.armed)) e.preventDefault();
  }, { passive: false });
  document.addEventListener('pointerup', (e) => {
    if (!d || e.pointerId !== d.id) return;
    d.el.classList.remove('pl-armed');
    end(true);
  });
  document.addEventListener('pointercancel', () => {
    if (!d) return;
    d.el.classList.remove('pl-armed');
    end(true);
  });
  // no browser drag image for links and pictures while sorting
  document.addEventListener('dragstart', (e) => {
    if (e.target.closest?.('[data-sortpl]')) e.preventDefault();
  });
}

async function saveImportAsPlaylist(id) {
  const r = await post(`/api/imports/${id}/playlist`);
  renderSidebarPlaylists();
  toast(t('savedAsPlaylist', { name: r.name, n: r.tracks }));
  if (state.route === 'imported' || state.route === 'library') render();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-saveimp]');
  if (b) saveImportAsPlaylist(Number(b.dataset.saveimp)).catch((err) => toast(errorText(err)));
});
// ---------- own covers (zoom and crop in the app, stored on the server) ----------
function artKey(kind, id, v) {
  if (!v) return null;
  const k = `art:${kind}:${id}`;
  extCovers.set(k, `${conn.server}/api/art/${kind}/${id}?t=${conn.token}&v=${v}`);
  return k;
}
function pickImage() {
  return new Promise((res) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => res(inp.files[0] || null);
    inp.click();
  });
}
/** Crop dialog: drag to move, wheel / slider / pinch to zoom. Resolves with a 640×640 JPEG blob or null. */
function cropImage(file) {
  return new Promise((res) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => (URL.revokeObjectURL(url), toast(t('badImage')), res(null));
    img.onload = () => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-wrap';
      wrap.innerHTML = `<div class="modal crop"><div class="modal-head"><h2>${t('changeCover')}</h2><button class="icon-btn" data-x>${icon('close')}</button></div>
        <div class="crop-box"><canvas width="640" height="640"></canvas><div class="crop-grid"></div></div>
        <label class="crop-zoom">${icon('minus')}<input type="range" min="1" max="4" step="0.01" value="1">${icon('plus')}</label>
        <p class="muted small">${t('cropHint')}</p>
        <div class="modal-actions"><button class="btn" data-x>${t('cancel')}</button><button class="btn primary" data-ok>${t('save')}</button></div></div>`;
      document.body.appendChild(wrap);
      const cv = wrap.querySelector('canvas');
      const g = cv.getContext('2d');
      const zoomEl = wrap.querySelector('input');
      const S = 640;
      const base = S / Math.min(img.width, img.height); // fill the square at zoom 1
      let z = 1, cx = img.width / 2, cy = img.height / 2; // centre of the view in image pixels
      const clamp = () => {
        const half = S / (base * z) / 2;
        cx = Math.min(Math.max(cx, half), img.width - half);
        cy = Math.min(Math.max(cy, half), img.height - half);
      };
      const draw = () => {
        clamp();
        const sc = base * z;
        g.fillStyle = '#000';
        g.fillRect(0, 0, S, S);
        g.drawImage(img, S / 2 - cx * sc, S / 2 - cy * sc, img.width * sc, img.height * sc);
      };
      const setZoom = (nz) => {
        z = Math.min(4, Math.max(1, nz));
        zoomEl.value = z;
        draw();
      };
      zoomEl.oninput = () => setZoom(Number(zoomEl.value));
      cv.addEventListener('wheel', (e) => (e.preventDefault(), setZoom(z * (e.deltaY < 0 ? 1.08 : 1 / 1.08))), { passive: false });
      const pts = new Map();
      let pinch = 0;
      cv.addEventListener('pointerdown', (e) => (cv.setPointerCapture(e.pointerId), pts.set(e.pointerId, [e.clientX, e.clientY])));
      cv.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId)) return;
        const [px, py] = pts.get(e.pointerId);
        pts.set(e.pointerId, [e.clientX, e.clientY]);
        if (pts.size === 2) {
          const [a, b] = [...pts.values()];
          const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
          if (pinch) setZoom((z * d) / pinch);
          pinch = d;
          return;
        }
        const k = (S / cv.clientWidth) / (base * z);
        cx -= (e.clientX - px) * k;
        cy -= (e.clientY - py) * k;
        draw();
      });
      const up = (e) => (pts.delete(e.pointerId), (pinch = 0));
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      const close = (v) => (wrap.remove(), URL.revokeObjectURL(url), res(v));
      wrap.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => close(null)));
      wrap.addEventListener('mousedown', (e) => e.target === wrap && close(null));
      wrap.querySelector('[data-ok]').onclick = () => cv.toBlob((b) => close(b), 'image/jpeg', 0.88);
      draw();
    };
    img.src = url;
  });
}
/** Second way to a cover: make one from a colour and a symbol or a few letters. Resolves with a JPEG blob or null. */
/** "Create cover" like Spotify: a square preview, below it tabs for background, image, text and effects.
 *  A photo can be moved with the finger or mouse and zoomed; the text is the playlist name in one of several styles. */
function makeCover(name = '', covers = []) {
  return new Promise((res) => {
    const S = 640;
    const SOLIDS = ['#1db954', '#e91429', '#ff6437', '#f59b23', '#ffc862', '#27856a', '#1e3264', '#8d67ab', '#e8115b', '#509bf5', '#477d95', '#f4f4f4', '#121212'];
    const GRADS = [['#7a5cff', '#2ec5c0'], ['#ff6fb1', '#ff9a3d'], ['#4c8dff', '#9b7bff'], ['#1ed760', '#0b6b3a'], ['#ff5d5d', '#7a1f4f'], ['#f5d547', '#ff7a3d'], ['#20232b', '#5b6072'], ['#0fa3b1', '#1b2a6b'], ['#e0c3fc', '#8ec5fc'], ['#f093fb', '#f5576c']];
    const FONTS = [
      ['bold', '900', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', 1],
      ['serif', '700', 'Georgia, "Times New Roman", serif', 1],
      ['mono', '700', 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', 0.82],
      ['narrow', '800', '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif', 1.1],
      ['script', '700', '"Brush Script MT", "Segoe Script", "Snell Roundhand", cursive', 1.15],
      ['light', '300', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', 1]
    ];
    const FX = ['none', 'duotone', 'bw', 'grain', 'vignette', 'blur', 'glow'];
    const st = { bg: { kind: 'grad', i: 0 }, img: null, imgSrc: '', zoom: 1, ox: 0, oy: 0, text: name.trim(), font: 0, size: 1, color: '#ffffff', pos: 'bottom', align: 'left', fx: 'none', shadow: true };
    let tab = 'bg';
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal ce"><div class="ce-top"><button class="btn ghost" data-x>${t('cancel')}</button><h2>${t('makeCover')}</h2><button class="btn primary" data-ok>${t('done')}</button></div>
      <div class="ce-stage"><canvas width="${S}" height="${S}"></canvas></div>
      <div class="ce-tabs" role="tablist">${['bg', 'img', 'text', 'fx'].map((k) => `<button type="button" data-tab="${k}" class="${k === tab ? 'on' : ''}">${icon({ bg: 'palette', img: 'image', text: 'abc', fx: 'sparkle' }[k])}<span>${t('ce_' + k)}</span></button>`).join('')}</div>
      <div class="ce-panel"></div></div>`;
    document.body.appendChild(wrap);
    const cv = wrap.querySelector('canvas');
    const ctx = cv.getContext('2d');
    const panel = wrap.querySelector('.ce-panel');
    const loadImg = (src) => new Promise((ok) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = () => ok(null); im.src = src; });
    const background = () => {
      if (st.bg.kind === 'solid') { ctx.fillStyle = SOLIDS[st.bg.i]; ctx.fillRect(0, 0, S, S); return; }
      const g = ctx.createLinearGradient(0, 0, S, S);
      g.addColorStop(0, GRADS[st.bg.i][0]);
      g.addColorStop(1, GRADS[st.bg.i][1]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
    };
    const photo = () => {
      const im = st.img;
      if (!im) return;
      const base = Math.max(S / im.width, S / im.height) * st.zoom;
      const w = im.width * base, h = im.height * base;
      // never a gap at the edge: the picture is kept covering the whole square
      st.ox = Math.min(0, Math.max(S - w, st.ox));
      st.oy = Math.min(0, Math.max(S - h, st.oy));
      ctx.save();
      if (st.fx === 'blur') ctx.filter = 'blur(10px)';
      ctx.drawImage(im, st.ox, st.oy, w, h);
      ctx.restore();
    };
    const effects = () => {
      if (st.fx === 'bw' || st.fx === 'duotone') {
        const d = ctx.getImageData(0, 0, S, S), p = d.data;
        const a = st.bg.kind === 'solid' ? SOLIDS[st.bg.i] : GRADS[st.bg.i][0];
        const b = st.bg.kind === 'solid' ? '#121212' : GRADS[st.bg.i][1];
        const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
        const [A, B] = [rgb(a), rgb(b)];
        for (let i = 0; i < p.length; i += 4) {
          const l = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) / 255;
          if (st.fx === 'bw') p[i] = p[i + 1] = p[i + 2] = l * 255;
          else for (let c = 0; c < 3; c++) p[i + c] = B[c] + (A[c] - B[c]) * l;
        }
        ctx.putImageData(d, 0, 0);
      }
      if (st.fx === 'grain') {
        const d = ctx.getImageData(0, 0, S, S), p = d.data;
        for (let i = 0; i < p.length; i += 4) { const n = (Math.random() - 0.5) * 46; p[i] += n; p[i + 1] += n; p[i + 2] += n; }
        ctx.putImageData(d, 0, 0);
      }
      if (st.fx === 'vignette') {
        const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.25, S / 2, S / 2, S * 0.75);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,.7)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, S, S);
      }
      if (st.fx === 'glow') {
        const g = ctx.createRadialGradient(S * 0.3, S * 0.25, 0, S * 0.3, S * 0.25, S * 0.8);
        g.addColorStop(0, 'rgba(255,255,255,.35)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, S, S);
      }
    };
    const text = () => {
      const txt = st.text.trim();
      if (!txt) return;
      const [, weight, family, k] = FONTS[st.font];
      let px = Math.round(96 * st.size * k);
      const pad = 44;
      ctx.font = `${weight} ${px}px ${family}`;
      // wrap into lines that fit, shrink when even one word is too wide
      const words = txt.split(/\s+/);
      let lines;
      for (;;) {
        lines = [];
        let cur = '';
        for (const w of words) {
          const tryL = cur ? cur + ' ' + w : w;
          if (ctx.measureText(tryL).width > S - pad * 2 && cur) { lines.push(cur); cur = w; } else cur = tryL;
        }
        lines.push(cur);
        const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
        if ((widest <= S - pad * 2 && lines.length * px * 1.05 <= S - pad * 2) || px < 24) break;
        px = Math.round(px * 0.9);
        ctx.font = `${weight} ${px}px ${family}`;
      }
      const lh = px * 1.05, block = lines.length * lh;
      let y = st.pos === 'top' ? pad + px * 0.85 : st.pos === 'center' ? (S - block) / 2 + px * 0.85 : S - pad - block + px * 0.85;
      ctx.textAlign = st.align;
      const x = st.align === 'left' ? pad : st.align === 'center' ? S / 2 : S - pad;
      ctx.fillStyle = st.color;
      ctx.shadowColor = st.shadow ? 'rgba(0,0,0,.45)' : 'transparent';
      ctx.shadowBlur = st.shadow ? 18 : 0;
      ctx.shadowOffsetY = st.shadow ? 3 : 0;
      for (const l of lines) { ctx.fillText(l, x, y); y += lh; }
      ctx.shadowColor = 'transparent';
    };
    const draw = () => {
      ctx.clearRect(0, 0, S, S);
      background();
      photo();
      effects();
      text();
    };
    const sw = (on) => (on ? 'on' : '');
    const panels = {
      bg: () => `<div class="ce-sec"><small>${t('ce_colors')}</small><div class="ce-sw">${SOLIDS.map((c, i) => `<button type="button" class="ce-dot ${sw(st.bg.kind === 'solid' && st.bg.i === i)}" data-solid="${i}" style="background:${c}"></button>`).join('')}</div></div>
        <div class="ce-sec"><small>${t('ce_gradients')}</small><div class="ce-sw">${GRADS.map((c, i) => `<button type="button" class="ce-dot ${sw(st.bg.kind === 'grad' && st.bg.i === i)}" data-grad="${i}" style="background:linear-gradient(135deg,${c[0]},${c[1]})"></button>`).join('')}</div></div>`,
      img: () => `<div class="ce-sec"><div class="ce-thumbs"><button type="button" class="ce-up" data-upload-ce>${icon('upload')}<span>${t('uploadPicture')}</span></button>${covers.slice(0, 12).map((u, i) => `<button type="button" class="ce-th ${sw(st.imgSrc === u)}" data-pick="${i}"><img alt="" src="${esc(u)}"></button>`).join('')}</div></div>
        ${st.img ? `<div class="ce-sec ce-zoom"><small>${t('zoom')}</small><input type="range" min="1" max="3" step="0.01" value="${st.zoom}" data-zoom><button type="button" class="btn ghost" data-noimg>${icon('close')}${t('removePicture')}</button></div><p class="muted small">${t('ce_move')}</p>` : ''}`,
      text: () => `<div class="ce-sec"><input class="textin" data-ctext maxlength="60" value="${esc(st.text)}" placeholder="${t('playlistName')}"></div>
        <div class="ce-sec"><div class="ce-fonts">${FONTS.map((f, i) => `<button type="button" class="ce-font ${sw(st.font === i)}" data-font="${i}" style="font-family:${esc(f[2])};font-weight:${f[1]}">Aa</button>`).join('')}</div></div>
        <div class="ce-sec ce-row"><div class="seg">${['top', 'center', 'bottom'].map((k) => `<button type="button" class="${sw(st.pos === k)}" data-pos="${k}">${t('ce_' + k)}</button>`).join('')}</div><div class="seg">${['left', 'center', 'right'].map((k) => `<button type="button" class="${sw(st.align === k)}" data-align="${k}">${icon('align_' + k)}</button>`).join('')}</div></div>
        <div class="ce-sec ce-zoom"><small>${t('ce_size')}</small><input type="range" min="0.5" max="1.8" step="0.01" value="${st.size}" data-size></div>
        <div class="ce-sec"><div class="ce-sw">${['#ffffff', '#121212', '#1db954', '#ffc862', '#ff6437', '#e91429', '#509bf5', '#8d67ab', '#f4f4f4'].map((c) => `<button type="button" class="ce-dot ${sw(st.color === c)}" data-tcolor="${c}" style="background:${c}"></button>`).join('')}<button type="button" class="ce-chip ${sw(st.shadow)}" data-shadow>${t('ce_shadow')}</button></div></div>`,
      fx: () => `<div class="ce-sec"><div class="ce-fx">${FX.map((k) => `<button type="button" class="ce-chip ${sw(st.fx === k)}" data-fx="${k}">${t('ce_fx_' + k)}</button>`).join('')}</div></div>`
    };
    const paint = () => {
      panel.innerHTML = panels[tab]();
      wrap.querySelectorAll('.ce-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    };
    const setImg = async (src) => {
      const im = await loadImg(src);
      if (!im) return toast(t('error'));
      Object.assign(st, { img: im, imgSrc: src, zoom: 1, ox: 0, oy: 0 });
      // centre the picture
      const base = Math.max(S / im.width, S / im.height);
      st.ox = (S - im.width * base) / 2;
      st.oy = (S - im.height * base) / 2;
      draw();
      paint();
    };
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const d = b.dataset;
      if (d.tab) { tab = d.tab; return paint(); }
      if (d.solid) st.bg = { kind: 'solid', i: +d.solid };
      else if (d.grad) st.bg = { kind: 'grad', i: +d.grad };
      else if (d.pick) return setImg(covers[+d.pick]);
      else if ('uploadCe' in d) {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'image/*';
        inp.onchange = () => inp.files[0] && setImg(URL.createObjectURL(inp.files[0]));
        return inp.click();
      } else if ('noimg' in d) Object.assign(st, { img: null, imgSrc: '' });
      else if (d.font) st.font = +d.font;
      else if (d.pos) st.pos = d.pos;
      else if (d.align) st.align = d.align;
      else if (d.tcolor) st.color = d.tcolor;
      else if ('shadow' in d) st.shadow = !st.shadow;
      else if (d.fx) st.fx = d.fx;
      else return;
      draw();
      paint();
    });
    wrap.addEventListener('input', (e) => {
      const el = e.target;
      if ('zoom' in el.dataset) {
        // zoom around the middle of the square
        const old = st.zoom;
        st.zoom = +el.value;
        st.ox = S / 2 - (S / 2 - st.ox) * (st.zoom / old);
        st.oy = S / 2 - (S / 2 - st.oy) * (st.zoom / old);
      } else if ('size' in el.dataset) st.size = +el.value;
      else if ('ctext' in el.dataset) st.text = el.value;
      else return;
      draw();
    });
    // move the picture with the finger or mouse, pinch or wheel to zoom
    const pts = new Map();
    let last = null, pinch = 0;
    cv.addEventListener('pointerdown', (e) => { if (!st.img) return; cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); last = [e.clientX, e.clientY]; });
    cv.addEventListener('pointermove', (e) => {
      if (!st.img || !pts.has(e.pointerId)) return;
      const k = S / cv.getBoundingClientRect().width;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) { const z = Math.min(3, Math.max(1, st.zoom * (dist / pinch))); const old = st.zoom; st.zoom = z; st.ox = S / 2 - (S / 2 - st.ox) * (z / old); st.oy = S / 2 - (S / 2 - st.oy) * (z / old); }
        pinch = dist;
      } else if (last) {
        st.ox += (e.clientX - last[0]) * k;
        st.oy += (e.clientY - last[1]) * k;
        last = [e.clientX, e.clientY];
      }
      draw();
    });
    const up = (e) => { pts.delete(e.pointerId); pinch = 0; last = pts.size ? [...pts.values()][0] : null; const z = panel.querySelector('[data-zoom]'); if (z) z.value = st.zoom; };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => { if (!st.img) return; e.preventDefault(); const old = st.zoom; st.zoom = Math.min(3, Math.max(1, st.zoom * (e.deltaY < 0 ? 1.06 : 0.94))); st.ox = S / 2 - (S / 2 - st.ox) * (st.zoom / old); st.oy = S / 2 - (S / 2 - st.oy) * (st.zoom / old); draw(); }, { passive: false });
    const close = (v) => (wrap.remove(), res(v));
    wrap.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => close(null)));
    wrap.addEventListener('mousedown', (e) => e.target === wrap && close(null));
    wrap.querySelector('[data-ok]').onclick = () => {
      try { cv.toBlob((b) => close(b), 'image/jpeg', 0.92); } catch { toast(t('error')); }
    };
    paint();
    draw();
    // a playlist with songs starts like Spotify's editor: its first cover as the picture
    if (covers[0]) setImg(covers[0]);
  });
}
/** Covers of the songs in a playlist, offered as pictures in the cover editor (each album once). */
function coverChoices(pl, kind) {
  if (!pl) return [];
  const urls = kind === 'import'
    ? (pl.items || []).map((x) => (x.local ? coverUrl(x.local.id) : x.cover)).filter(Boolean)
    : (pl.tracks || []).map((x) => coverUrl(x.id)).filter(Boolean);
  return [...new Set(urls)].slice(0, 12);
}
/** Playlist details like on Spotify: picture on the left (upload and place it, or make one), name and description on the right. */
function playlistDialog(pl = null, kind = 'playlist') {
  return new Promise((res) => {
    let blob = null, removeArt = false, preview = '';
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    const imp = kind === 'import';
    // without an own picture: what the page shows (first song, or the platform's cover)
    const std = !pl || pl.likes ? '' : imp ? pl.cover || coverUrl(pl.items?.find((x) => x.local)?.local.id || '') || pl.items?.find((x) => x.cover)?.cover || '' : coverUrl(pl.tracks?.[0]?.id || pl.cover_id || '');
    const cur = pl?.art ? coverUrl(artKey(kind, pl.id, pl.art)) : std;
    let own = !!pl?.art;
    const desc = imp ? pl?.meta?.description || '' : pl?.description || '';
    wrap.innerHTML = `<form class="modal pld" novalidate><div class="modal-head"><h2>${t(pl ? 'editDetails' : 'newPlaylist')}</h2><button type="button" class="icon-btn" data-x>${icon('close')}</button></div>
      <div class="pld-grid">
        <div class="pld-cover" data-photo tabindex="0" role="button" title="${t('choosePhoto')}">${cur ? `<img alt="" src="${esc(cur)}">` : icon('note')}<span class="pld-over">${icon('edit')}${t('choosePhoto')}</span></div>
        <div class="pld-fields">
          <label class="field"><span>${t('playlistName')}</span><input name="name" maxlength="80" value="${esc(pl?.name || '')}" autocomplete="off"></label>
          <label class="field"><span>${t('description')}</span><textarea name="description" maxlength="300" rows="4" placeholder="${t('descriptionHint')}">${esc(desc)}</textarea></label>
        </div>
      </div>
      <div class="modal-actions pld-foot"><button class="btn primary">${t(pl ? 'save' : 'create')}</button></div></form>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form');
    const cover = wrap.querySelector('.pld-cover');
    const show = (b) => {
      blob = b;
      removeArt = false;
      if (preview) URL.revokeObjectURL(preview);
      preview = URL.createObjectURL(b);
      cover.querySelector(':scope > img, :scope > svg')?.remove();
      cover.insertAdjacentHTML('afterbegin', `<img alt="" src="${preview}">`);
      own = true;
    };
    // the picture is the one place to change it, like on Spotify: choose a photo, make a cover, remove it
    const photoMenu = (anchor) =>
      menu(anchor, [
        { label: t(own ? 'changePhoto' : 'choosePhoto'), icon: 'image', run: async () => { const f = await pickImage(); const b = f && (await cropImage(f)); if (b) show(b); } },
        { label: t('makeCover'), icon: 'edit', run: async () => { const b = await makeCover(form.elements.name.value, coverChoices(pl, kind)); if (b) show(b); } },
        own && {
          label: t('removePhoto'),
          icon: 'trash',
          run: () => {
            blob = null;
            removeArt = true;
            own = false;
            cover.querySelector(':scope > img, :scope > svg')?.remove();
            cover.insertAdjacentHTML('afterbegin', std ? `<img alt="" src="${esc(std)}">` : icon('note'));
          }
        }
      ]);
    cover.addEventListener('click', (e) => (e.stopPropagation(), photoMenu(e.target.closest('.pld-more') || cover)));
    cover.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && e.target === cover && (e.preventDefault(), photoMenu(cover)));
    const close = (v) => (closeMenu(), wrap.remove(), preview && URL.revokeObjectURL(preview), res(v));
    wrap.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => close(null)));
    wrap.addEventListener('mousedown', (e) => e.target === wrap && close(null));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      const description = form.elements.description.value.trim();
      if (!name) return form.elements.name.focus();
      const btn = form.querySelector('.btn.primary');
      btn.disabled = true;
      try {
        let id = pl?.id;
        if (kind === 'likes') {
          await saveSettings({ likesName: name === t('likes') ? '' : name, likesDesc: description, ...(blob ? { likesArt: Date.now() } : removeArt ? { likesArt: 0 } : {}) });
        } else if (imp) await put(`/api/imports/${id}`, { name, meta: { ...(pl.meta || {}), description } });
        else if (id) await put(`/api/playlists/${id}`, { name, description });
        else id = (await post('/api/playlists', { name, description })).id;
        if (blob) {
          const r = await fetch(`${conn.server}/api/art/${kind}/${id}`, { method: 'PUT', headers: { Authorization: 'Bearer ' + conn.token, 'Content-Type': 'image/jpeg' }, body: blob });
          if (!r.ok) throw new Error('error');
        } else if (removeArt) await del(`/api/art/${kind}/${id}`).catch(() => {});
        close({ id, name });
      } catch (err) {
        btn.disabled = false;
        toast(errorText(err));
      }
    };
    setTimeout(() => !pl && form.elements.name.focus(), 30);
  });
}
/** Own picture of Liked songs (set in "Edit details"), otherwise the heart. */
function likesArtKey() {
  return artKey('likes', conn.user?.id || 0, settings.likesArt || 0);
}
/** Picture, name and description of a playlist (own or imported) are changed in one dialog. */
async function editDetails(kind, id, info) {
  if (kind === 'likes') {
    const r = await playlistDialog({ id: Number(id), name: settings.likesName || t('likes'), description: settings.likesDesc || '', art: settings.likesArt || 0, likes: true }, 'likes');
    if (r) render();
    return;
  }
  info = info || (await get(kind === 'playlist' ? `/api/playlists/${id}` : `/api/imports/${id}`).catch(() => null));
  if (!info || info.mine === false) return;
  if (await playlistDialog(info, kind)) {
    renderSidebarPlaylists();
    render();
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-edit]');
  if (!b) return;
  const [kind, id] = b.dataset.edit.split(':');
  editDetails(kind, id);
});
// ---------- one menu for playlists, imports, albums and artists: "…" button, right click, long press ----------
async function togglePin(ref) {
  const set = new Set(settings.unpinned || []);
  set.has(ref) ? set.delete(ref) : set.add(ref);
  await saveSettings({ unpinned: [...set] }).catch(() => {});
  renderSidebarPlaylists();
  toast(t(set.has(ref) ? 'unpinned' : 'pinned'));
}
async function refTracks(kind, id) {
  if (kind === 'playlist') return (await get(`/api/playlists/${id}`)).tracks;
  if (kind === 'import') return playableItems((await get('/api/imports/' + id)).items).filter(Boolean);
  if (kind === 'album') {
    const [album, artist] = id.split('\u0001');
    return (await get(`/api/album?album=${encodeURIComponent(album)}&artist=${encodeURIComponent(artist)}`)).tracks;
  }
  if (kind === 'artist') return (await get(`/api/artist?name=${encodeURIComponent(id)}`)).tracks || [];
  return [];
}
async function collectionMenu(anchor, ref) {
  const i = ref.indexOf(':');
  const kind = ref.slice(0, i);
  const id = ref.slice(i + 1);
  const playWith = (fn) => async () => {
    try {
      const list = await refTracks(kind, id);
      if (!list.length) return toast(t('nothingToPlay'));
      fn(list);
    } catch (e) {
      toast(errorText(e));
    }
  };
  const common = [
    { label: t('playAll'), icon: 'play', run: playWith((l) => player.playList(l, 0)) },
    { label: t('shuffle'), icon: 'shuffle', run: playWith((l) => player.playList(l, 0, { shuffle: true })) },
    { label: t('playNext'), icon: 'next', run: playWith((l) => (player.playNext(l), toast(t('playsNext')))) },
    { label: t('addQueue'), icon: 'queue', run: playWith((l) => (player.add(l), toast(t('addedQueue')))) }
  ];
  let items = [];
  if (kind === 'playlist' || kind === 'import') {
    const info = kind === 'playlist' ? await get(`/api/playlists/${id}`).catch(() => ({})) : await get('/api/imports/' + id).catch(() => ({}));
    const name = info.name || '';
    const pinned = !(settings.unpinned || []).includes(ref);
    items = [
      ...common,
      '-',
      info.mine !== false && {
        label: t('editDetails'),
        icon: 'edit',
        run: () => editDetails(kind, id, info)
      },
      // the phone has no sidebar to pin to
      innerWidth >= 900 && { label: t(pinned ? 'unpin' : 'pin'), icon: 'pin', run: () => togglePin(ref) },
      { label: t((settings.homePins || []).includes(ref) ? 'unpinHome' : 'pinHome'), icon: 'home', run: () => toggleHomePin(ref) },
      { label: t(kind === 'playlist' ? 'shareListen' : 'share'), icon: 'share', run: () => shareThing(kind, Number(id), name) },
      kind === 'playlist' && info.mine !== false && { label: t('shareCollab'), icon: 'edit', run: () => shareThing('collab', Number(id), name) },
      kind === 'playlist' && info.mine !== false && { label: t('shareListener'), icon: 'headphones', run: () => shareThing('listener', Number(id), name) },
      kind === 'playlist' && info.mine === false && {
        label: t('leavePlaylist'),
        icon: 'close',
        run: async () => {
          await del(`/api/playlists/${id}/members/${conn.user.id}`);
          renderSidebarPlaylists();
          go('#/library?tab=playlists');
        }
      }
    ];
    if (kind === 'import') {
      items.push(
        !info.kept && {
          label: t('saveAsPlaylist'),
          icon: 'plus',
          run: () => saveImportAsPlaylist(id)
        },
        (info.items || []).some((x) => !x.local) && {
          label: t(srvDl.has(Number(id)) ? 'srvDlBusy' : 'srvDl'),
          icon: 'server',
          run: () => serverDownload(Number(id), (info.items || []).length)
        },
        {
          label: t('rematch'),
          icon: 'refresh',
          run: async () => {
            const r = await post(`/api/imports/${id}/rematch`);
            toast(t('matchedN', { n: r.matched }));
            render();
          }
        },
        info.url && {
          label: t('refreshImport'),
          icon: 'download',
          run: async () => {
            try {
              const prog = (n, tot) => importStatus(t('importLoading', { n, total: tot }), (n / tot) * 100);
              const d = info.url === 'spotify:liked' ? await spotifyLiked(prog) : await fetchLink(info.url, prog);
              importStatus(t('importMatching', { n: d.items.length }));
              await put(`/api/imports/${id}`, { items: d.items, meta: d.meta || undefined, cover: d.cover || '' });
              importStatus(null);
              render();
            } catch (err) {
              importStatus(null);
              toast(errorText(err));
            }
          }
        }
      );
    }
    if (!(kind === 'playlist' && info.mine === false)) items.push('-', {
      label: t('delete'),
      icon: 'trash',
      danger: true,
      run: async () => {
        if (!(await dialog({ title: t(kind === 'playlist' ? 'deletePlaylistQ' : 'deleteImportQ', { name }), ok: t('delete'), danger: true }))) return;
        await del(kind === 'playlist' ? `/api/playlists/${id}` : `/api/imports/${id}`);
        renderSidebarPlaylists();
        if (location.hash.includes(kind === 'playlist' ? '/playlist/' + id : '/imported/' + id)) go('#/library?tab=' + (kind === 'playlist' ? 'playlists' : 'imported'));
        else render();
      }
    });
  } else if (kind === 'album') {
    const [album, artist] = id.split('\u0001');
    items = [
      ...common,
      '-',
      { label: t('goAlbum'), icon: 'album', run: () => go(`#/album?album=${encodeURIComponent(album)}&artist=${encodeURIComponent(artist)}`) },
      artist && { label: t('goArtist'), icon: 'user', run: () => go(`#/artist?name=${encodeURIComponent(artist)}`) },
      { label: t('addPlaylist'), icon: 'plus', run: async () => menu(anchor, await pickPlaylist(await refTracks(kind, id))) }
    ];
  } else if (kind === 'artist') {
    items = [
      ...common,
      '-',
      { label: t('goArtist'), icon: 'user', run: () => go(`#/artist?name=${encodeURIComponent(id)}`) },
      { label: t('artistRadio'), icon: 'radio', run: playWith((l) => startRadio(l[Math.floor(Math.random() * l.length)])) }
    ];
  } else if (kind === 'likes') items = common;
  menu(anchor, items);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmenu]');
  if (b) collectionMenu(b, b.dataset.cmenu);
});

/** Right click (and long press on phones) opens the same menu as the "…" button. */
function contextTarget(el) {
  const row = el.closest('.tracks .row');
  if (row) return () => {
    const listEl = row.closest('.tracks');
    const tracks = state.lists?.[listEl.dataset.list];
    const i = Number(row.dataset.i);
    const tr = tracks?.[i];
    if (!tr || tr._off) return null;
    return (pt) => trackMenu(pt, tr, { queueIndex: listEl.dataset.queue ? Number(row.dataset.q) : null, playlistId: listEl.dataset.playlist ? Number(listEl.dataset.playlist) : null, position: i });
  };
  const tcard = el.closest('[data-cards] > .card');
  if (tcard) return () => {
    const tr = state.lists?.[tcard.parentElement.dataset.cards]?.[Number(tcard.dataset.i)];
    return tr ? (pt) => trackMenu(pt, tr, {}) : null;
  };
  if (el.closest('#mini, #fs-cover, .fs-meta') && player?.current) return () => (pt) => trackMenu(pt, player.current, {});
  const ref = el.closest('[data-ref]');
  if (ref) return () => (pt) => collectionMenu(pt, ref.dataset.ref);
  const qt = el.closest('a.qt[href^="#/album"]');
  if (qt) {
    const q = new URLSearchParams(qt.getAttribute('href').split('?')[1] || '');
    return () => (pt) => collectionMenu(pt, 'album:' + (q.get('album') || '') + '\u0001' + (q.get('artist') || ''));
  }
  const card = el.closest('a.card[href]');
  if (card) {
    const h = card.getAttribute('href');
    const q = new URLSearchParams(h.split('?')[1] || '');
    if (h.startsWith('#/album')) return () => (pt) => collectionMenu(pt, 'album:' + (q.get('album') || '') + '\u0001' + (q.get('artist') || ''));
    if (h.startsWith('#/artist')) return () => (pt) => collectionMenu(pt, 'artist:' + (q.get('name') || ''));
    if (h === '#/likes') return () => (pt) => collectionMenu(pt, 'likes:0');
  }
  const head = el.closest('.detail-head');
  const more = head?.querySelector('[data-cmenu]');
  if (more) return () => (pt) => collectionMenu(pt, more.dataset.cmenu);
  return null;
}
function openContext(el, x, y) {
  const mk = contextTarget(el)?.();
  if (!mk) return false;
  mk({ clientX: x, clientY: y, getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }) });
  return true;
}
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (openContext(e.target, e.clientX, e.clientY)) e.preventDefault();
});
{
  // long press: 500 ms without moving
  let timer = 0, sx = 0, sy = 0, fired = false;
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const tch = e.touches[0];
    sx = tch.clientX;
    sy = tch.clientY;
    fired = false;
    clearTimeout(timer);
    const target = e.target;
    timer = setTimeout(() => {
      if (contextTarget(target)) {
        fired = true;
        navigator.vibrate?.(12);
        openContext(target, sx, sy);
      }
    }, 500);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    const tch = e.touches[0];
    if (Math.hypot(tch.clientX - sx, tch.clientY - sy) > 10) clearTimeout(timer);
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    clearTimeout(timer);
    if (fired) e.preventDefault();
  });
  // the click that follows a long press must not open or play what was pressed
  document.addEventListener('click', (e) => {
    if (fired) {
      fired = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
}

// ---------- settings panel ----------
function filterSettings(q) {
  q = q.trim().toLowerCase();
  const box = $('#settings-body');
  if (!box) return;
  let any = false;
  box.querySelectorAll('.set-card').forEach((c) => {
    const whole = !q || c.dataset.k.includes(q);
    let n = 0;
    c.querySelectorAll('.set-row').forEach((r) => {
      const hit = whole || r.dataset.k.includes(q) || r.textContent.toLowerCase().includes(q);
      r.hidden = !hit;
      if (hit) n++;
    });
    c.hidden = !n;
    if (n) any = true;
  });
  const none = box.querySelector('.set-none');
  if (none) none.hidden = any;
  $('#setnav')?.classList.toggle('dim', !!q);
}
document.addEventListener('input', (e) => {
  if (e.target.id === 'setq') filterSettings(e.target.value);
});
document.addEventListener('click', (e) => {
  const j = e.target.closest('[data-setjump]');
  if (!j) return;
  const c = document.getElementById(j.dataset.setjump);
  c?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelectorAll('[data-setjump]').forEach((b) => b.classList.toggle('on', b === j));
});
function openSettings(section = '') {
  const q = $('#setq');
  if (q) q.value = '';
  const done = renderSettings();
  $('#settings').classList.add('open');
  $('#scrim').classList.add('show');
  if (section) Promise.resolve(done).then(() => setTimeout(() => $('#set-' + section)?.scrollIntoView({ block: 'start' }), 50));
}
const openSettingsPage = openSettings;
function closeSettings() {
  $('#settings').classList.remove('open');
  $('#scrim').classList.remove('show');
  clearInterval(state.scanTimer);
}
// ---------- settings: a full page with search, categories as cards, one row per setting ----------
/** One setting: label and hint on the left, the control on the right (or below when wide). */
function setRow(label, control, { hint = '', keys = '', wide = false, cls = '' } = {}) {
  return `<div class="set-row ${wide ? 'wide' : ''} ${cls}" data-k="${esc((label + ' ' + hint + ' ' + keys).toLowerCase())}"><div class="sr-text"><div class="sr-label">${label}</div>${hint ? `<div class="sr-hint">${hint}</div>` : ''}</div><div class="sr-ctl">${control}</div></div>`;
}
// ---------- devices: where the sound goes, headphones and Bluetooth ----------
const DEV_ICON = { bluetooth: 'bluetooth', wired: 'headphones', usb: 'headphones', hdmi: 'speaker', phone: 'phone', out: 'speaker' };
let outDevices = null; // desktop and browser: the audio outputs the system offers
async function loadOutputs(ask) {
  if (!navigator.mediaDevices?.enumerateDevices || !('setSinkId' in HTMLMediaElement.prototype)) return (outDevices = []);
  let list = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'audiooutput');
  // browsers only name the outputs after the microphone question was answered once
  if (ask && list.length && !list.some((d) => d.label)) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    s?.getTracks().forEach((x) => x.stop());
    list = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'audiooutput');
  }
  return (outDevices = list);
}
/** This device can get its own name: other devices of the account and the device picker show it. */
function devicesHtml() {
  return setRow(t('devNameRow'), `<div class="remoteedit"><input id="devname" class="textin" maxlength="40" value="${esc(prefs.devName || '')}" placeholder="${esc(autoDeviceName())}" autocomplete="off" spellcheck="false"><button class="btn primary" data-savedevname>${t('save')}</button></div>`, { hint: t('devNameHint'), keys: 'name umbenennen rename gerät device', wide: true }) + devicesHtmlInner();
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-savedevname]')) return;
  prefs.devName = ($('#devname')?.value || '').trim().slice(0, 40);
  savePrefs();
  toast(t('devNameSaved', { name: myDeviceName() }));
  presenceTick?.().catch?.(() => {});
  redrawDevices();
});
document.addEventListener('keydown', (e) => { if (e.target.id === 'devname' && e.key === 'Enter') $('[data-savedevname]')?.click(); });
function devicesHtmlInner() {
  const A = window.MusikAndroid;
  const line = (ic, name, on, attr = '') => `<${attr ? 'button' : 'div'} class="dev ${on ? 'on' : ''}" ${attr}>${icon(ic)}<span>${esc(name)}</span>${on ? `<small>${t('devPlaying')}</small>` : ''}</${attr ? 'button' : 'div'}>`;
  if (A?.audioDevices) {
    let list = [];
    try { list = JSON.parse(A.audioDevices()); } catch {}
    return (
      setRow(t('devOutput'), `<div class="devlist">${list.map((d) => line(DEV_ICON[d.kind] || 'speaker', d.name || t('dev_' + d.kind), d.active, A.setOutput ? `data-pickdev="${esc(String(d.id ?? ''))}"` : '')).join('') || line('phone', t('dev_phone'), true)}</div>`, { hint: t('devOutputHint'), wide: true, keys: 'bluetooth kopfhörer headphones lautsprecher speaker ausgabe output gerät device' }) +
      setRow(t('devSwitch'), `<div class="stack"><button class="btn" data-devout>${icon('speaker')}${t('devSwitchBtn')}</button><button class="btn" data-devbt>${icon('bluetooth')}${t('devBtSettings')}</button></div>`, { hint: t('devSwitchHint'), keys: 'bluetooth verbinden connect koppeln pair' }) +
      setRow(t('devPause'), sw('devpause', A.getPlayPref('pauseOnDisconnect')), { hint: t('devPauseHint'), keys: 'bluetooth pause trennen disconnect' }) +
      setRow(t('devResume'), sw('devresume', A.getPlayPref('resumeOnConnect')), { hint: t('devResumeHint'), keys: 'bluetooth weiter resume verbinden auto' }) +
      (A.resetAsks ? setRow(t('askAgain'), `<button class="btn" data-resetasks>${t('askAgainBtn')}</button>`, { hint: t('askAgainHint'), keys: 'erlaubnis permission fragen ask nein no mikrofon benachrichtigung notification' }) : '')
    );
  }
  if (outDevices === null) {
    loadOutputs(false).then(() => $('#set-devices') && ($('#set-devices').outerHTML = setCard('devices', 'bluetooth', t('devices'), devicesHtml())));
    return setRow(t('devOutput'), `<span class="muted small">…</span>`, { hint: t('devOutputHint') });
  }
  if (!outDevices.length) return setRow(t('devOutput'), `<span class="muted small">${t('devSystem')}</span>`, { hint: t('devNoPick'), keys: 'bluetooth ausgabe output' });
  const named = outDevices.some((d) => d.label);
  const cur = prefs.sink && outDevices.some((d) => d.deviceId === prefs.sink) ? prefs.sink : 'default';
  const kind = (l) => (/bluetooth|airpods|buds|wh-|wf-/i.test(l) ? 'bluetooth' : /head|kopf/i.test(l) ? 'wired' : 'out');
  return (
    setRow(t('devOutput'), named ? `<div class="devlist">${outDevices.map((d, i) => line(DEV_ICON[kind(d.label)], d.deviceId === 'default' ? t('devSystem') : d.label || t('devOutput') + ' ' + (i + 1), d.deviceId === cur || (cur === 'default' && i === 0 && !outDevices.some((x) => x.deviceId === 'default')), `data-sink="${esc(d.deviceId)}"`)).join('')}</div>` : `<button class="btn" data-devask>${icon('speaker')}${t('devShow')}</button>`, { hint: named ? t('devPickHint') : t('devAskHint'), wide: named, keys: 'bluetooth kopfhörer headphones lautsprecher speaker ausgabe output gerät device' })
  );
}
const redrawDevices = () => {
  if ($('#set-devices')) $('#set-devices').outerHTML = setCard('devices', 'bluetooth', t('devices'), devicesHtml());
  paintDevice();
  if ($('.devsheet')) fillDevSheet();
};
window.musikDevices = () => setTimeout(redrawDevices, 250);

// ---------- device picker like Spotify's: current device on top, the others below ----------
function deviceList() {
  const A = window.MusikAndroid;
  if (A?.audioDevices) {
    let l = [];
    try { l = JSON.parse(A.audioDevices()); } catch {}
    if (!l.length) l = [{ id: 0, kind: 'phone', name: '', active: true }];
    return l.map((d) => ({ id: String(d.id ?? ''), kind: d.kind, name: (d.kind === 'phone' && prefs.devName) || d.name || t('dev_' + d.kind), active: !!d.active, android: true }));
  }
  if (!outDevices?.length) return [{ id: 'default', kind: 'out', name: prefs.devName || (window.musikDesktop ? t('devThisComputer') : t('devThisBrowser')), active: true }];
  const kind = (l) => (/bluetooth|airpods|buds|wh-|wf-|jbl|bose|sony/i.test(l) ? 'bluetooth' : /head|kopf|hörer|phone/i.test(l) ? 'wired' : 'out');
  const cur = prefs.sink && outDevices.some((d) => d.deviceId === prefs.sink) ? prefs.sink : 'default';
  const l = outDevices.filter((d) => d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId, kind: kind(d.label), name: d.deviceId === 'default' ? prefs.devName || (window.musikDesktop ? t('devThisComputer') : t('devSystem')) : d.label || t('devOutput') + ' ' + (i + 1), active: d.deviceId === cur }));
  if (!l.some((d) => d.active) && l[0]) l[0].active = true;
  return l;
}
/** Spotify shows the device in accent colour under the song once the sound leaves the phone. */
function paintDevice() {
  const cur = deviceList().find((d) => d.active);
  const away = cur && !['phone', 'out'].includes(cur.kind) && !(cur.id === 'default');
  const line = $('.np-dev');
  if ($('#mini') && $('#mini').classList.contains('devaway') !== !!away) { $('#mini').classList.toggle('devaway', !!away); playerMarquees(); }
  if (line) {
    line.hidden = !away;
    line.innerHTML = away ? `${icon(DEV_ICON[cur.kind] || 'speaker')}<span><em>${esc(cur.name)}</em></span>` : '';
    requestAnimationFrame(() => marquee(line.querySelector('span')));
  }
  const fd = $('.fs-dev');
  if (fd) {
    fd.classList.toggle('away', !!away);
    fd.querySelector('span').textContent = cur ? cur.name : '';
    fd.querySelector('svg')?.replaceWith(document.createRange().createContextualFragment(icon(away ? DEV_ICON[cur.kind] || 'speaker' : 'devices')));
  }
  document.querySelectorAll('.devbtn').forEach((b) => b.classList.toggle('away', !!away));
  const gc = $('.gconnect');
  if (gc) {
    gc.hidden = !away;
    gc.querySelector('span').textContent = away ? t('gPlayingOn', { name: cur.name }) : '';
    document.documentElement.classList.toggle('gaway', !!away);
  }
}
/** A name that does not fit glides slowly to its end and back, so it can be read in full. */
function marquee(box) {
  if (!box) return;
  box.classList.remove('mq');
  const over = box.scrollWidth - box.clientWidth;
  if (over > 3) {
    box.style.setProperty('--mq', `${-over - 6}px`);
    box.style.setProperty('--mqt', `${Math.max(5, over / 14 + 3)}s`);
    box.classList.add('mq');
  }
}
addEventListener('resize', () => marquee($('.np-dev span')));
/** Phone, like Spotify: a song name or artist line that does not fit waits a moment, then runs to the left in a loop
   (the text follows itself after a gap) and rests again at the start. Desktop keeps the cut-off with dots. */
function spotMarquee(el) {
  if (!el) return;
  const old = el.querySelector(':scope > .smq');
  if (old) el.innerHTML = old.firstElementChild.innerHTML;
  el.classList.remove('smq-on');
  if (!matchMedia('(max-width: 899px)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (el.scrollWidth - el.clientWidth <= 2) return;
  const html = el.innerHTML;
  el.innerHTML = `<span class="smq"><span>${html}</span><span aria-hidden="true" inert>${html}</span></span>`;
  const w = el.querySelector('.smq > span').offsetWidth + 40;
  el.style.setProperty('--smq-w', `-${w}px`);
  // about 30 px a second plus the rest at the start, like Spotify
  el.style.setProperty('--smq-t', `${(w / 30 + 2.5).toFixed(1)}s`);
  el.classList.add('smq-on');
}
function playerMarquees() {
  // after layout, so the widths are real (the big player may only just be opening)
  requestAnimationFrame(() => ['#np-title', '#np-artist', '#fs-title', '#fs-artist'].forEach((s) => spotMarquee($(s))));
}
addEventListener('resize', () => playerMarquees());
matchMedia('(max-width: 899px)').addEventListener?.('change', () => playerMarquees());
function fillDevSheet() {
  const box = $('.devsheet .ds-body');
  if (!box) return;
  const l = deviceList();
  const cur = l.find((d) => d.active) || l[0];
  const others = l.filter((d) => d !== cur);
  const A = window.MusikAndroid;
  const row = (d) => `<button class="ds-row" data-pickdev="${esc(d.id)}">${icon(DEV_ICON[d.kind] || 'speaker')}<span><b>${esc(d.name)}</b><small>${t('dev_' + d.kind) !== 'dev_' + d.kind && d.name !== t('dev_' + d.kind) ? t('dev_' + d.kind) : ''}</small></span></button>`;
  const named = !outDevices || outDevices.some((d) => d.label) || A;
  box.innerHTML = `
    <div class="ds-cur">${icon(DEV_ICON[cur.kind] || 'speaker')}<div><small>${t('devCurrent')}</small><b>${esc(cur.name)}</b></div><i class="ds-eq"><i></i><i></i><i></i></i></div>
    <h4>${t('devSelect')}</h4>
    ${others.length ? others.map(row).join('') : `<p class="muted small ds-none">${t(A ? 'devNoneAndroid' : named ? 'devNone' : 'devAskHint')}</p>`}
    ${!A && !named ? `<button class="btn" data-devask>${icon('speaker')}${t('devShow')}</button>` : ''}
    <div class="ds-more">
      ${A?.openBluetooth ? `<button class="btn" data-devbt>${icon('bluetooth')}${t('devPair')}</button>` : ''}
      ${A?.openOutput ? `<button class="btn" data-devout>${icon('speaker')}${t('devSystemPicker')}</button>` : ''}
    </div>
    ${A ? '' : `<p class="muted small">${t('devPickHint')}</p>`}
    ${accountDevicesHtml()}`;
}
// ---------- other devices of the same account (like Spotify Connect): see what plays there, take it over ----------
const DEV_ID = (() => {
  try {
    let id = localStorage.getItem('musik.devid');
    if (!id) localStorage.setItem('musik.devid', (id = Math.random().toString(36).slice(2, 12)));
    return id;
  } catch {
    return 'x' + Math.random().toString(36).slice(2, 10);
  }
})();
function myDeviceName() {
  return (prefs.devName || '').trim() || autoDeviceName();
}
function autoDeviceName() {
  const ua = navigator.userAgent;
  if (window.MusikAndroid) {
    const m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/);
    return m && !/^K$/.test(m[1]) ? m[1].trim() : 'Android';
  }
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : 'Linux';
  if (window.musikDesktop) return t('devPc', { os });
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} (${os})`;
}
const myKind = () => (window.MusikAndroid || /Android|iPhone/.test(navigator.userAgent) ? 'phone' : window.musikDesktop ? 'computer' : 'web');
let remoteDevs = [];
let elsewhereHidden = '';
const packTrack = (x) => (x ? (x.ext ? { ...x, cover: extCovers.get(x.id) || x.cover || '' } : { id: x.id, title: x.title, artist: x.artist, album: x.album, duration: x.duration, has_cover: x.has_cover }) : null);
async function presenceTick() {
  if (!conn.token || offlineMode || !player) return;
  const tr = player?.current;
  const body = { device: DEV_ID, name: myDeviceName(), kind: myKind(), playing: !!player?.playing, position: player?.position || 0, duration: player?.duration || tr?.duration || 0 };
  if (tr) body.track = { ...packTrack(tr), next: player.queue.slice(player.index + 1, player.index + 31).map(packTrack) };
  try {
    const r = await post('/api/presence', body);
    remoteDevs = (r.devices || []).filter((d) => d.track);
    for (const c of r.commands || []) {
      if (c.cmd === 'pause') player?.pause();
      else if (c.cmd === 'play') player?.play();
      else if (c.cmd === 'next') player?.next();
      else if (c.cmd === 'prev') player?.prev();
    }
  } catch {
    remoteDevs = [];
  }
  paintElsewhere();
  if ($('.devsheet .ds-acc')) $('.devsheet .ds-acc').outerHTML = accountDevicesHtml();
}
function presenceLoop() {
  const busy = player?.playing || remoteDevs.some((d) => d.playing) || $('.devsheet');
  if (!document.hidden || player?.playing) presenceTick();
  setTimeout(presenceLoop, busy ? 8000 : 20000);
}
setTimeout(presenceLoop, 2500);
function accountDevicesHtml() {
  if (!remoteDevs.length) return '<div class="ds-acc"></div>';
  const kindIcon = { phone: 'phone', computer: 'computer', web: 'devices' };
  return `<div class="ds-acc"><h4>${t('devAccount')}</h4>${remoteDevs
    .map((d) => `<div class="ds-row acc">${icon(kindIcon[d.kind] || 'devices')}<span><b>${esc(d.name)}</b><small>${d.playing ? `${icon('play')} ` : ''}${esc(d.track.title)} · ${esc(d.track.artist || '')}</small></span>
      <button class="icon-btn" data-remcmd="${esc(d.device)}:${d.playing ? 'pause' : 'play'}" title="${t(d.playing ? 'pause' : 'play')}">${icon(d.playing ? 'pause' : 'play')}</button>
      <button class="btn small primary" data-takeover="${esc(d.device)}">${t('devPlayHere')}</button></div>`)
    .join('')}</div>`;
}
/** Phone: how far the floating bars (banner, mini player, tab bar) reach up from the bottom; the plain strip behind them follows it. */
function paintBand() {
  if (!matchMedia('(max-width: 899px) and (pointer: coarse)').matches) return;
  let top = innerHeight;
  ['#elsewhere', '#mini', '.bottomnav'].forEach((sel) => {
    const e = document.querySelector(sel);
    if (!e) return;
    const r = e.getBoundingClientRect();
    if (r.height > 0 && r.top > innerHeight * 0.5) top = Math.min(top, r.top);
  });
  const h = Math.ceil(innerHeight - top + 8);
  if (h > 8) document.documentElement.style.setProperty('--band-h', h + 'px');
}
addEventListener('resize', () => requestAnimationFrame(paintBand));
/** A small bar like Spotify's "Listening on …" while another device of the account plays and this one does not. */
function paintElsewhere() {
  const d = remoteDevs.find((x) => x.playing);
  let el = $('#elsewhere');
  const show = d && !player?.playing && elsewhereHidden !== d.device + d.track.title;
  requestAnimationFrame(paintBand);
  if (!show) return el?.remove();
  if (!el) {
    el = document.createElement('div');
    el.id = 'elsewhere';
    document.body.appendChild(el);
  }
  el.classList.toggle('above-player', !!player?.current);
  el.innerHTML = `${icon(d.kind === 'phone' ? 'phone' : d.kind === 'computer' ? 'computer' : 'devices')}<span><small>${t('devPlayingOn', { name: esc(d.name) })}</small><b>${esc(d.track.title)} · ${esc(d.track.artist || '')}</b></span>
    <button class="btn small primary" data-takeover="${esc(d.device)}">${t('devPlayHere')}</button><button class="icon-btn" data-elsewhereoff="${esc(d.device + d.track.title)}" title="${t('close')}">${icon('close')}</button>`;
}
async function takeOver(id) {
  const d = remoteDevs.find((x) => x.device === id);
  if (!d?.track) return;
  const items = [d.track, ...(d.track.next || [])].filter(Boolean);
  const localIds = items.filter((x) => !x.ext).map((x) => x.id);
  let byId = new Map();
  if (localIds.length) byId = new Map((await post('/api/tracks/batch', { ids: localIds }).catch(() => [])).map((x) => [x.id, x]));
  const list = items
    .map((x) => {
      if (!x.ext) return byId.get(x.id);
      if (x.cover) extCovers.set(x.id, x.cover);
      const { next, ...rest } = x;
      return rest;
    })
    .filter(Boolean);
  if (!list.length) return toast(t('error'));
  const pos = d.position + (d.playing ? (Date.now() - d.at) / 1000 : 0);
  post(`/api/presence/${encodeURIComponent(id)}/cmd`, { cmd: 'pause' }).catch(() => {});
  player.playList(list, 0);
  const seekOnce = () => {
    player.removeEventListener('state', seekOnce);
    if (pos > 2 && (!d.duration || pos < d.duration - 2)) setTimeout(() => player.seek(pos), 300);
  };
  player.addEventListener('state', seekOnce);
  remoteDevs = remoteDevs.map((x) => (x.device === id ? { ...x, playing: false } : x));
  paintElsewhere();
  $('.devsheet') && fillDevSheet();
  toast(t('devTookOver', { name: d.name }));
}
document.addEventListener('click', (e) => {
  const tk = e.target.closest('[data-takeover]');
  if (tk) return void takeOver(tk.dataset.takeover);
  const rc = e.target.closest('[data-remcmd]');
  if (rc) {
    const [id, cmd] = rc.dataset.remcmd.split(':');
    post(`/api/presence/${encodeURIComponent(id)}/cmd`, { cmd }).catch(() => {});
    remoteDevs = remoteDevs.map((x) => (x.device === id ? { ...x, playing: cmd === 'play' } : x));
    $('.devsheet .ds-acc') && ($('.devsheet .ds-acc').outerHTML = accountDevicesHtml());
    paintElsewhere();
    setTimeout(presenceTick, 2500);
    return;
  }
  const off = e.target.closest('[data-elsewhereoff]');
  if (off) {
    elsewhereHidden = off.dataset.elsewhereoff;
    paintElsewhere();
  }
});
async function devSheet() {
  if ($('.devsheet')) return;
  if (!window.MusikAndroid && outDevices === null) await loadOutputs(false);
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap devsheet-wrap';
  wrap.innerHTML = `<div class="modal devsheet" role="dialog"><i class="ds-grip"></i><div class="modal-head"><h2>${t('devConnect')}</h2><button class="icon-btn" data-x title="${t('close')}">${icon('close')}</button></div><div class="ds-body"></div></div>`;
  document.body.appendChild(wrap);
  const close = () => {
    wrap.classList.add('closing');
    setTimeout(() => wrap.remove(), 220);
  };
  wrap.addEventListener('mousedown', (e) => e.target === wrap && close());
  wrap.addEventListener('touchstart', (e) => e.target === wrap && close(), { passive: true });
  wrap.querySelector('[data-x]').onclick = close;
  wrap._close = close;
  fillDevSheet();
}
async function pickDevice(id) {
  const A = window.MusikAndroid;
  if (A?.setOutput) A.setOutput(Number(id) || 0);
  else {
    prefs.sink = id === 'default' ? '' : id;
    savePrefs();
    await audioOut.set(prefs.sink);
  }
  redrawDevices();
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => loadOutputs(false).then(redrawDevices));
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-devout]')) return window.MusikAndroid?.openOutput?.();
  if (e.target.closest('[data-devbt]')) return window.MusikAndroid?.openBluetooth?.();
  if (e.target.closest('[data-resetasks]')) { window.MusikAndroid?.resetAsks?.(); return toast(t('askAgainDone')); }
  if (e.target.closest('[data-devask]')) return loadOutputs(true).then(redrawDevices);
  if (e.target.closest('[data-devsheet]')) {
    e.stopPropagation();
    return devSheet();
  }
  const pk = e.target.closest('[data-pickdev]');
  if (pk) return pickDevice(pk.dataset.pickdev);
  const s = e.target.closest('[data-sink]');
  if (s) {
    prefs.sink = s.dataset.sink === 'default' ? '' : s.dataset.sink;
    savePrefs();
    await audioOut.set(prefs.sink);
    redrawDevices();
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'devpause') window.MusikAndroid?.setPlayPref?.('pauseOnDisconnect', e.target.checked);
  if (e.target.id === 'devresume') window.MusikAndroid?.setPlayPref?.('resumeOnConnect', e.target.checked);
});
function setCard(id, ic, title, rows) {
  return `<section class="set-card" id="set-${id}" data-k="${esc(title.toLowerCase())}"><h3>${icon(ic)}<span>${title}</span></h3>${rows}</section>`;
}
const sw = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></label>`;
// settings kept in prefs: a switch, a slider with its value, a row of choices
const pct = (v) => Math.round(Number(v) * 100) + ' %';
const pv = (k, d) => (prefs[k] ?? d);
const psw = (k, d) => `<label class="switch"><input type="checkbox" data-pref="${k}" ${pv(k, d) ? 'checked' : ''}><span></span></label>`;
const rngP = (v, min, max) => `${(((Number(v) - min) / (max - min)) * 100).toFixed(1)}%`;
const prng = (k, min, max, step, d, fmt = (v) => v) => `<div class="prng"><input type="range" data-pref="${k}" min="${min}" max="${max}" step="${step}" value="${pv(k, d)}" style="--p:${rngP(pv(k, d), min, max)}"><b data-prefval="${k}">${fmt(pv(k, d))}</b></div>`;
const PREF_FMT = { crossfade: (v) => (Number(v) ? v + ' s' : t('off')), vizSpeed: (v) => Number(v).toFixed(1) + '×', vizSens: pct, vizBass: pct, vizMid: pct, vizHigh: pct, mixStream: (v) => `${Math.round((1 - v) * 100)} : ${Math.round(v * 100)}` };
const pseg = (k, opts, d, label) => `<div class="seg wrap">${opts.map((o) => `<button data-prefseg="${k}" data-v="${o}" class="${pv(k, d) === o ? 'on' : ''}">${label(o)}</button>`).join('')}</div>`;
/** What has to follow a changed setting. */
function prefChanged(k) {
  if (k.startsWith('viz') || k === 'miniViz') {
    applyVizTune();
    miniVizSync();
    const r = $('.rainbow-only');
    if (r) r.hidden = !['rainbow', 'flow'].includes(prefs.vizColor);
  }
  if (['crossfade', 'normalize', 'streamQ'].includes(k)) player?.setOptions?.(playOptions());
  if (k === 'logos') applyLogos();
  if (k === 'chill') chillSync();
  if (k === 'chillSync') chill?.room?.setBeatSync?.(prefs.chillSync || 'beat');
  if (k === 'mixStream') saveTaste();
  if (k === 'discord') discordSync();
}
const playOptions = () => ({ crossfade: Number(prefs.crossfade || 0), normalize: !!prefs.normalize, streamQ: prefs.streamQ || 'auto' });
document.addEventListener('input', (e) => {
  const k = e.target.dataset?.pref;
  if (!k || e.target.type !== 'range') return;
  prefs[k] = Number(e.target.value);
  e.target.style.setProperty('--p', rngP(e.target.value, Number(e.target.min), Number(e.target.max)));
  const b = $(`[data-prefval="${k}"]`);
  if (b) b.textContent = (PREF_FMT[k] || ((v) => v))(prefs[k]);
  savePrefs();
  prefChanged(k);
});
document.addEventListener('change', (e) => {
  const k = e.target.dataset?.pref;
  if (!k || e.target.type !== 'checkbox') return;
  prefs[k] = e.target.checked;
  savePrefs();
  prefChanged(k);
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-prefseg]');
  if (!b) return;
  const k = b.dataset.prefseg;
  prefs[k] = b.dataset.v;
  savePrefs();
  b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  prefChanged(k);
});
async function renderSettings() {
  const s = $('#settings-body');
  const user = conn.user || {};
  let lib = null, info = null;
  try {
    [lib, info] = await Promise.all([get('/api/library'), api('GET', '/api/info', undefined, { token: null, timeout: 6000 }).catch(() => null)]);
  } catch {}
  const accents = ['cover', 'blue', 'green', 'purple', 'orange', 'pink', 'red', 'teal'];
  const cards = [
    setCard('general', 'gear', t('set_general'),
      setRow(t('language'), `<div class="seg">${['de', 'en'].map((l) => `<button data-lang="${l}" class="${getLang() === l ? 'on' : ''}">${l === 'de' ? 'Deutsch' : 'English'}</button>`).join('')}</div>`, { keys: 'deutsch english sprache language' }) +
      setRow(t('theme'), themePicker(), { hint: t('themeHint'), keys: 'theme design liquid glass glas aussehen look', wide: true }) +
      setRow(t('mode'), `<div class="seg">${['dark', 'light'].map((m) => `<button data-mode-pick="${m}" class="${(prefs.mode === 'light' ? 'light' : 'dark') === m ? 'on' : ''}">${icon(m === 'light' ? 'sun' : 'moon')}${t('mode_' + m)}</button>`).join('')}</div>`, { hint: t('modeHint'), keys: 'hell dunkel light dark mode darkmode lightmode' }) +
      setRow(t('oled'), sw('oledsw', !!prefs.oled), { hint: t('oledHint'), keys: 'oled amoled schwarz black pure dark dunkel akku battery', cls: 'oledrow' }) +
      setRow(t('accent'), accentPicker(accents), { hint: t('accentHint'), keys: 'farbe color theme cover akzent accent hex eigene custom farbwähler picker', wide: true }) +
      setRow(t('dynColor'), sw('dyncolor', prefs.dynamic), { hint: t('dynColorHint'), keys: t('look') }) +
      setRow(t('logosShow'), psw('logos', true), { hint: t('logosShowHint'), keys: 'logo logos plattform platform spotify youtube quelle source' }) +
      setRow(t('searchIn'), `<div class="seg">${SMODES.map((m) => `<button data-smode="${m}" class="${searchMode() === m ? 'on' : ''}">${t('smode_' + m)}</button>`).join('')}</div>`, { hint: t('searchInHint'), keys: 'search suche spotify youtube everything' }) +
      setRow(t('columns'), `<div class="colpick">${COLS.map((k) => `<button data-col="${k}" class="chip ${cols().has(k) ? 'on' : ''}">${t('col_' + k)}</button>`).join('')}</div>`, { hint: t('columnsHint'), keys: 'spalten columns artist album länge duration quelle source jahr genre', wide: true })),
    setCard('playback', 'play', t('playback'),
      setRow(t('autoplayShort'), sw('autoplay', prefs.autoplay), { hint: t('autoplay'), keys: 'autoplay radio' }) +
      setRow(t('crossfade'), prng('crossfade', 0, 12, 1, 0, (v) => (Number(v) ? v + ' s' : t('off'))), { hint: t('crossfadeHint'), keys: 'crossfade überblendung übergang fade gapless' }) +
      setRow(t('normalize'), psw('normalize', false), { hint: t('normalizeHint'), keys: 'lautstärke normalisieren normalize volume loudness gleiche' }) +
      setRow(t('streamQ'), pseg('streamQ', ['auto', 'low', 'normal', 'high', 'veryhigh'], 'auto', (v) => t('q_' + v)), { hint: t('streamQHint'), keys: 'qualität quality streaming bitrate', wide: true }) +
      setRow(t('preloadAll'), psw('preloadAll', false), { hint: t('preloadAllHint'), keys: 'vorladen preload laden neu alles' }) +
      setRow(t('chill'), psw('chill', false), { hint: t('chillHint'), keys: 'chillscreen raum room zimmer vollbild fullscreen kamera camera plattenspieler' }) +
      setRow(t('chillBeat'), pseg('chillSync', ['off', 'beat', 'bar'], 'beat', (o) => t('chillSync_' + o)), { hint: t('chillBeatHint'), keys: 'chillscreen beat takt bar übergänge transitions rhythmus' })),
    setCard('viz', 'viz', t('viz'),
      setRow(t('viz'), `<select class="select" id="vizmode">${VIZ_MODES.map((m) => `<option value="${m}" ${(prefs.viz || 'off') === m ? 'selected' : ''}>${t('viz_' + m)}</option>`).join('')}</select>`, { hint: t('vizHint'), keys: 'visualizer bars ring wave' }) +
      setRow(t('miniViz'), pseg('miniViz', MINI_MODES, 'off', (v) => t('mviz_' + v)), { hint: t('miniVizHint'), keys: 'mini player visualizer klein', wide: true }) +
      setRow(t('vizColor'), pseg('vizColor', ['accent', 'flow', 'rainbow'], 'accent', (v) => t('vcol_' + v)), { keys: 'farbe color regenbogen rainbow akzent' }) +
      `<div class="rainbow-only" ${['rainbow', 'flow'].includes(prefs.vizColor) ? '' : 'hidden'}>${setRow(t('vizSpeed'), prng('vizSpeed', 0.2, 3, 0.1, 1, (v) => Number(v).toFixed(1) + '×'), { keys: 'regenbogen rainbow speed tempo' })}</div>` +
      setRow(t('vizDelay'), prng('vizDelay', 0, 500, 10, 0, (v) => (Number(v) ? v + ' ms' : t('q_auto'))), { hint: t('vizDelayHint'), keys: 'verzögerung delay sync synchron bluetooth latenz latency' }) +
      setRow(t('vizSens'), prng('vizSens', 0.3, 2.5, 0.05, 1, pct), { hint: t('vizSensHint'), keys: 'empfindlichkeit sensitivity' }) +
      setRow(t('vizBass'), prng('vizBass', 0, 2, 0.05, 1, pct), { keys: 'bass tiefen lows' }) +
      setRow(t('vizMid'), prng('vizMid', 0, 2, 0.05, 1, pct), { keys: 'mitten mids' }) +
      setRow(t('vizHigh'), prng('vizHigh', 0, 2, 0.05, 1, pct), { keys: 'höhen highs treble' })),
    (window.musikDesktop?.discord ? setCard('discord', 'radio', 'Discord',
      setRow(t('discordShow'), psw('discord', false), { hint: t('discordHint'), keys: 'discord rich presence status aktivität activity' }) +
      setRow(t('discordId'), `<input class="textin" id="discordid" value="${esc(prefs.discordId || '')}" placeholder="123456789012345678" inputmode="numeric" autocomplete="off" spellcheck="false">`, { hint: t('discordIdHint'), keys: 'discord application id client' })) : '') +
    setCard('taste', 'mix', t('taste'),
      setRow(t('streynMixes'), asw('streynMixes', true), { hint: t('streynMixesHint'), keys: 'streyn mix mixes daily genre künstler artist cover generieren generate' }) +
      setRow(t('topSongsSet'), asw('topSongs', true), { hint: t('topSongsSetHint'), keys: 'top songs jahr year wrapped rückblick playlist generieren generate' }) +
      setRow(t('mixStream'), `<div class="mixlbl"><small>${t('mixOwn')}</small>${prng('mixStream', 0, 1, 0.05, 0.3, PREF_FMT.mixStream)}<small>${t('mixStreaming')}</small></div>`, { hint: t('mixStreamHint'), keys: 'mix geschmack taste lokal local streaming spotify anteil', wide: true }) +
      setRow(t('tasteExcludedList'), '', { hint: t('tasteExcludedHint'), keys: 'geschmack taste ausschließen exclude profil profile', wide: true }) +
      `<div id="tastelist" class="tastelist">${tasteListHtml()}</div>`) +
    (offline.ok() ? setCard('offline', 'download', t('offTitle'), `<span class="muted small">…</span>`) : '') +
    setCard('devices', 'bluetooth', t('devices'), devicesHtml()) +
    setCard('sound', 'eq', t('equalizer'), setRow(t('equalizer'), eqHtml(), { wide: true, keys: 'eq bass treble klang sound preset' })),
    setCard('sources', 'link', t('sources'),
      setRow(t('sourcesOn'), `<a class="btn" href="#/sources" data-closesettings>${t('manageSources')}</a>`, { hint: SOURCES.filter((x) => enabled(x)).map((x) => t('src_' + x)).join(', '), keys: 'youtube spotify soundcloud deezer quellen' }) +
      setRow(t('importAdd'), `<a class="btn" href="#/add" data-closesettings>${icon('download')}${t('importAdd')}</a>`, { hint: t('importHint'), keys: 'import playlist csv m3u' })),
    setCard('library', 'library', t('library'),
      setRow(t('libraryNow'), user.admin ? `<button class="btn" data-scan>${icon('refresh')}${t('scan')}</button>` : '', { hint: (lib ? t('stats', { tracks: lib.tracks, artists: lib.artists, albums: lib.albums }) : '') + '<span id="scaninfo"></span>', keys: 'scan einlesen' }) +
      setRow(t('upload'), `<button class="btn" data-upload>${icon('upload')}${t('upload')}</button>`, { hint: '<span id="upload-progress"></span>', keys: 'hochladen dateien files' }) +
      (user.admin && lib ? setRow(t('folders'), '', { hint: lib.dirs.map(esc).join(', '), keys: 'ordner folder' }) : '')),
    setCard('account', 'user', t('account'),
      setRow(esc(user.name || ''), `<button class="btn" data-logout>${t('logout')}</button>`, { hint: user.admin ? t('admin') : t('account'), keys: 'name abmelden logout' }) +
      setRow(t('editProfile'), `<button class="btn" data-editprofile>${t('change')}</button>`, { hint: t('profileNameHint'), keys: 'profil profile name bild picture avatar' }) +
      setRow(t('changePassword'), `<button class="btn" data-chpw>${t('change')}</button>`, { keys: 'passwort password' }) +
      setRow(t('server'), sameOrigin && !window.musikDesktop && !window.MusikAndroid ? '' : `<button class="btn" data-chserver>${t('changeServer')}</button>`, { hint: esc(conn.server), keys: 'adresse address' })),
    setCard('remote', 'radio', t('onTheGo'),
      (conn.user?.admin
        ? setRow(t('remoteAddr'), `<div class="remoteedit"><input id="remoteurl" class="textin" value="${esc(info?.remote || '')}" placeholder="http://100.x.x.x:8484" autocomplete="off" spellcheck="false" inputmode="url"><button class="btn primary" data-saveremote>${t('save')}</button>${info?.remote ? `<button class="btn" data-copyremote="${esc(info.remote)}">${t('copy')}</button>` : ''}</div>`, { hint: `${info?.remote ? t('remoteOn') : t('remoteOff')} <a href="${GUIDE}" target="_blank" rel="noopener">${t('guide')}</a>`, keys: 'tailscale unterwegs remote', wide: true })
        : info?.remote
          ? setRow(t('remoteAddr'), `<button class="btn" data-copyremote="${esc(info.remote)}">${t('copy')}</button>`, { hint: `<code class="addr">${esc(info.remote)}</code><br>${t('remoteOn')}`, keys: 'tailscale unterwegs remote' })
          : setRow(t('remoteAddr'), `<a class="btn" href="${GUIDE}" target="_blank" rel="noopener">${t('guide')}</a>`, { hint: t('remoteOff'), keys: 'tailscale unterwegs remote' })) +
      (conn.user?.admin
        ? setRow(t('publicLinks'), `<div class="remoteedit"><input id="publicurl" class="textin" value="${esc(info?.public || '')}" placeholder="https://streyn.tail1234.ts.net:8443" autocomplete="off" spellcheck="false" inputmode="url"><button class="btn primary" data-savepublic>${t('save')}</button></div>`, { hint: `${info?.public ? t('publicOn') : t('publicOff')} <a href="${GUIDE}#public" target="_blank" rel="noopener">${t('guide')}</a>`, keys: 'öffentlich public teilen share funnel link', wide: true })
        : '')),
    user.admin ? setCard('users', 'user', t('users'), setRow(t('users'), `<button class="btn" data-invite>${icon('share')}${t('inviteLink')}</button><button class="btn" data-adduser>${icon('plus')}${t('addUser')}</button>`, { hint: '<span id="userlist">…</span>', keys: 'nutzer users admin konto' })) : '',
    setCard('updates', 'download', t('updates'),
      setRow(t('updates'), `<button class="btn" data-updcheck>${icon('refresh')}${t('checkUpdates')}</button>`, { wide: true, hint: '<div id="updinfo" class="upd"></div>', keys: 'update version neu' }) +
      setRow(t('playCheck'), `<button class="btn" data-playcheck>${icon('play')}${t('playCheckRun')}</button>`, { wide: true, hint: `${t('playCheckHint')}<div id="playcheck" class="upd"></div>`, keys: 'test check youtube stream wiedergabe playback prüfen' }) +
      setRow(t('allDownloads'), `<a class="btn" href="${RELEASES}" target="_blank" rel="noopener">${icon('download')}${t('allDownloads')}</a>`, { hint: 'LabtosoStudios', keys: 'apk exe appimage download' }))
  ].join('');
  const q = $('#setq')?.value || '';
  s.innerHTML = `<div class="set-cards">${cards}<p class="muted empty set-none" hidden>${t('noSettings')}</p></div>`;
  if (offline.ok()) redrawOffline();
  $('#setnav').innerHTML = [...s.querySelectorAll('.set-card')].map((c) => `<button data-setjump="${c.id}">${esc(c.querySelector('h3 span').textContent)}</button>`).join('');
  filterSettings(q);
  renderUpdates(false);
  if (lib) showScan(lib);
  if (user.admin) renderUsers();
}
// ---------- updates: server, Android app and desktop app ----------
/** Version of the app this page runs in (Android or desktop), empty in a plain browser. */
function appVersion() {
  try {
    if (window.MusikAndroid?.appVersion) return { kind: 'android', v: window.MusikAndroid.appVersion() };
  } catch {}
  if (window.musikDesktop?.version) return { kind: 'desktop', v: window.musikDesktop.version };
  return null;
}
/** Newest version for this app: the desktop app has its own number, the phone app follows the release. */
const appLatestOf = (u, app) => (app?.kind === 'desktop' && u?.desktop ? u.desktop : u?.latest);
const vNewer = (a, b) => {
  const p = (x) => String(x || '0').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const A = p(a), B = p(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) > (B[i] || 0);
  return false;
};
async function updateStatus(force) {
  try {
    return await api('GET', '/api/update' + (force ? '?force=1' : ''), undefined, { timeout: 20000 });
  } catch (e) {
    // older servers: ask GitHub directly
    const info = await api('GET', '/api/info', undefined, { token: null, timeout: 6000 }).catch(() => ({}));
    const r = await fetch('https://api.github.com/repos/Labtoso/Musik/releases/latest').then((x) => x.json()).catch(() => null);
    const latest = r?.tag_name?.replace(/^v/, '') || null;
    return { current: info.version, latest, available: !!latest && vNewer(latest, info.version), how: 'readonly', admin: !!conn.user?.admin };
  }
}
async function renderUpdates(force) {
  const box = $('#updinfo');
  if (!box) return;
  box.innerHTML = `<p class="muted small">${t('updChecking')}</p>`;
  const u = await updateStatus(force);
  if (!$('#updinfo')) return;
  const app = appVersion();
  const latest = u.latest;
  const row = (label, cur, avail, action, to = latest) => `<div class="upd-row"><div><b>${label}</b><span class="muted small">${cur ? 'v' + esc(cur) : '–'}${to ? avail ? ` → <span class="upd-new">v${esc(to)}</span>` : ` · ${t('upToDate')}` : ''}</span></div>${action || ''}</div>`;
  let srvAction = '';
  if (u.available) {
    if (!u.admin) srvAction = `<span class="muted small">${t('updAdminOnly')}</span>`;
    else if (u.how === 'self') srvAction = `<button class="btn primary" data-updserver>${t('updNow')}</button>`;
    else srvAction = `<span class="muted small">${t('upd_' + u.how)}</span>`;
  }
  // the desktop app has its own version (its file only changes when the app itself changes)
  const appLatest = appLatestOf(u, app);
  const appAvail = app && appLatest && vNewer(appLatest, app.v);
  // the app first, then the server: a new server can expect things an old app does not have yet
  if (appAvail && u.available && srvAction.includes('data-updserver')) srvAction = `<span class="muted small">${t('updAfterApp')}</span>`;
  const both = appAvail && u.available && u.admin && u.how === 'self';
  box.innerHTML =
    (both ? `<div class="upd-row upd-all"><div><b>${t('updAll')}</b><span class="muted small">${t('updAllHint')}</span></div><button class="btn primary" data-updall>${t('updAllBtn')}</button></div>` : '') +
    (app ? row(t(app.kind === 'android' ? 'updAndroid' : 'updDesktop'), app.v, appAvail, appAvail ? `<button class="btn ${both ? '' : 'primary'}" data-updapp>${t('updNow')}</button>` : '', appLatest) : '') +
    row(t('updServer'), u.current, u.available, srvAction) +
    (!latest ? `<p class="muted small">${t('updOffline')}</p>` : '') + '<div id="updprog" class="muted small"></div>';
}
/** Server update with the server's own output mirrored in a small terminal. */
async function updateServer() {
  const prog = $('#updprog');
  const before = (await api('GET', '/api/info', undefined, { token: null }).catch(() => ({}))).version;
  document.querySelectorAll('[data-updserver],[data-updall]').forEach((b) => (b.disabled = true));
  if (prog) prog.innerHTML = `<span>${t('updServerRunning')}</span><pre class="updlog" aria-live="polite"></pre>`;
  const term = () => $('#updprog .updlog');
  let lines = [];
  const show = (extra = []) => {
    const el = term();
    if (!el) return;
    el.textContent = [...lines, ...extra].join('\n');
    el.scrollTop = el.scrollHeight;
  };
  let polling = true;
  (async () => {
    while (polling) {
      const r = await api('GET', '/api/update/log', undefined, { timeout: 3000 }).catch(() => null);
      if (r?.lines?.length) { lines = r.lines; show(); }
      await new Promise((res) => setTimeout(res, 600));
    }
  })();
  let r;
  try {
    r = await post('/api/update');
  } finally {
    polling = false;
  }
  const r2 = await api('GET', '/api/update/log', undefined, { timeout: 3000 }).catch(() => null);
  if (r2?.lines?.length) lines = r2.lines;
  show([t('updWaitStart')]);
  // the server restarts; wait until it answers with the new version
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    const v = (await api('GET', '/api/info', undefined, { token: null, timeout: 3000 }).catch(() => ({}))).version;
    if (v && v !== before) {
      show([t('updWaitStart'), t('updRunning', { v })]);
      toast(t('updDone', { v }));
      setTimeout(() => location.reload(), 1800);
      return;
    }
    show([t('updWaitStart') + ' ' + '.'.repeat((i % 20) + 1)]);
  }
  if (prog) prog.insertAdjacentHTML('beforeend', `<span>${t('updSlow', { v: r?.to || '' })}</span>`);
}
function updateApp(thenServer = false) {
  const app = appVersion();
  if (!app) return;
  try {
    if (thenServer) localStorage.setItem('musik.updnext', 'server');
  } catch {}
  const prog = $('#updprog');
  if (prog) prog.textContent = t('updDownloading', { p: 0 });
  if (app.kind === 'android') window.MusikAndroid.updateApp();
  else window.musikDesktop.update();
}
// progress from the Android app while it downloads and installs
window.musikAppUpdate = (stateName, pct) => {
  const prog = $('#updprog');
  const msg = stateName === 'download' ? t('updDownloading', { p: pct || 0 }) : t('updApp_' + stateName);
  if (prog) prog.textContent = msg;
  else if (stateName !== 'download') toast(msg);
};
/** Once a day after start: a short hint when something is out of date. */
/** After the app updated itself as step one, the server follows on its own. An app older than its server is pointed to the update. */
async function updateFlow() {
  const app = appVersion();
  if (!app) return;
  let next = '';
  try { next = localStorage.getItem('musik.updnext') || ''; } catch {}
  const info = await api('GET', '/api/info', undefined, { token: null, timeout: 6000 }).catch(() => null);
  if (!info?.version || info.offline) return;
  if (next === 'server') {
    const u = await updateStatus(true).catch(() => null);
    // still the old app (the install was cancelled): ask again later
    if (appLatestOf(u, app) && vNewer(appLatestOf(u, app), app.v)) return;
    try { localStorage.removeItem('musik.updnext'); } catch {}
    if (u?.available && u.admin && u.how === 'self') {
      toast(t('updServerNext'));
      openSettings('updates');
      return updateServer().catch(() => toast(t('error')));
    }
    return;
  }
  // the desktop app has its own version number, the update bar below covers it
  if (app.kind !== 'desktop' && vNewer(info.version, app.v)) {
    const bar = document.createElement('div');
    bar.className = 'updbar';
    bar.innerHTML = `${icon('download')}<span><b>${t('updAppOld')}</b> ${t('updAppOldHint', { app: app.v, server: info.version })}</span><button class="btn sm primary" data-updapp>${t('updNow')}</button><button class="icon-btn sm" data-x title="${t('close')}">${icon('close')}</button>`;
    bar.querySelector('[data-x]').onclick = () => bar.remove();
    bar.querySelector('[data-updapp]').onclick = () => { bar.remove(); openSettings('updates'); updateApp(); };
    $('#content')?.prepend(bar);
  }
}
/** A bar at the top when the app or the server is behind the latest release. Closing it hides it until the next release. */
async function autoUpdateCheck() {
  if (offlineMode || $('.updbar')) return;
  const u = await updateStatus(false).catch(() => null);
  if (!u?.latest) return;
  const app = appVersion();
  const appOld = !!app && !!appLatestOf(u, app) && vNewer(appLatestOf(u, app), app.v);
  if (!u.available && !appOld) return;
  let gone = '';
  try { gone = localStorage.getItem('musik.upddismiss') || ''; } catch {}
  if (gone === u.latest || $('.updbar')) return;
  const parts = [];
  if (appOld) parts.push(t(app.kind === 'android' ? 'updAndroid' : 'updDesktop') + ' v' + esc(app.v));
  if (u.available) parts.push(t('updServer') + ' v' + esc(u.current));
  const srvBtn = u.available && u.admin && u.how === 'self';
  const btn = appOld
    ? `<button class="btn sm primary" data-barapp>${t('updNow')}</button>`
    : srvBtn ? `<button class="btn sm primary" data-barsrv>${t('updNow')}</button>` : '';
  const bar = document.createElement('div');
  bar.className = 'updbar';
  bar.innerHTML = `${icon('download')}<span><b>${t('updBar', { v: esc(u.latest) })}</b> ${parts.join(' · ')}${u.available && !u.admin ? ' · ' + t('updAdminOnly') : ''}</span>${btn}<button class="icon-btn sm" data-x title="${t('close')}">${icon('close')}</button>`;
  bar.querySelector('[data-x]').onclick = () => {
    try { localStorage.setItem('musik.upddismiss', u.latest); } catch {}
    bar.remove();
  };
  bar.querySelector('[data-barapp]')?.addEventListener('click', () => { bar.remove(); openSettings('updates'); updateApp(u.available && u.admin && u.how === 'self'); });
  bar.querySelector('[data-barsrv]')?.addEventListener('click', () => { bar.remove(); openSettings('updates'); setTimeout(() => updateServer().catch((e) => toast(errorText(e))), 300); });
  $('#content')?.prepend(bar);
}

function showScan(lib) {
  const el = $('#scaninfo');
  if (!el) return;
  if (lib.scanning) {
    el.textContent = t('scanning', { n: lib.progress.found });
    clearInterval(state.scanTimer);
    state.scanTimer = setInterval(async () => {
      try {
        const l = await get('/api/library');
        if (!l.scanning) {
          clearInterval(state.scanTimer);
          state.cache = {};
          renderSettings();
        } else showScan(l);
      } catch {}
    }, 1500);
  } else if (lib.lastScan) el.textContent = t('lastScan', { date: new Date(lib.lastScan.at).toLocaleString(getLang()) });
}
async function renderUsers() {
  try {
    const users = await get('/api/users');
    $('#userlist').innerHTML = users
      .map(
        (u) => `<div class="userrow"><span>${esc(u.name)}${u.admin ? ` <span class="muted">· ${t('admin')}</span>` : ''}</span>${
          u.id !== conn.user.id ? `<button class="icon-btn" data-deluser="${u.id}" data-name="${esc(u.name)}" title="${t('delete')}">${icon('trash')}</button>` : ''
        }</div>`
      )
      .join('');
  } catch {}
}
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-updcheck],[data-updserver],[data-updapp],[data-updall],[data-lang],.swatch[data-accent],[data-scan],[data-logout],[data-chserver],[data-chpw],[data-adduser],[data-invite],[data-deluser],[data-settings],#scrim,[data-closesettings],[data-copyremote]');
  if (!el) return;
  if (el.dataset.copyremote) {
    copyText(el.dataset.copyremote).then((ok) => (ok ? toast(t('copied')) : dialog({ title: t('onTheGo'), fields: [{ name: 'url', label: t('remoteAddr'), value: el.dataset.copyremote }], ok: 'OK' })));
    return;
  }
  if (el.matches('[data-settings]')) return openSettings();
  if (el.matches('#scrim,[data-closesettings]')) return closeSettings();
  if (el.dataset.lang) {
    rememberLang(el.dataset.lang);
    applyPrefs();
    buildShell();
    $('#settings').classList.add('open');
    $('#scrim').classList.add('show');
    renderSettings();
    render();
    return;
  }
  if (el.dataset.accent) {
    setAccentPref(el.dataset.accent);
    document.querySelectorAll('.cpick.open').forEach((p) => cpickOpen(p, false));
    return;
  }
  try {
    if (el.matches('[data-updcheck]')) return renderUpdates(true);
    if (el.matches('[data-updapp]')) return updateApp();
    if (el.matches('[data-updall]')) {
      el.disabled = true;
      return updateApp(true);
    }
    if (el.matches('[data-updserver]')) {
      el.disabled = true;
      return await updateServer().catch((err) => {
        el.disabled = false;
        const p = $('#updprog');
        if (p) p.textContent = errorText(err);
      });
    }
    if (el.matches('[data-scan]')) {
      await post('/api/library/scan');
      showScan({ scanning: true, progress: { found: 0 } });
    } else if (el.matches('[data-logout]')) {
      await post('/api/logout').catch(() => {});
      logout();
    } else if (el.matches('[data-chserver]')) {
      if (window.musikDesktop) return window.musikDesktop.changeServer();
      if (window.MusikAndroid) return window.MusikAndroid.changeServer();
      conn.server = '';
      logout();
    } else if (el.matches('[data-chpw]')) {
      const r = await dialog({
        title: t('changePassword'),
        fields: [
          { name: 'old', label: t('oldPassword'), type: 'password' },
          { name: 'password', label: t('newPassword'), type: 'password' }
        ]
      });
      if (r) {
        const res = await put('/api/me/password', { old: r.old, password: r.password, client: clientName() });
        conn.token = res.token;
        saveConn();
        toast(t('saved'));
      }
    } else if (el.matches('[data-invite]')) {
      const r = await post('/api/invites');
      const base = (sameOrigin || conn.server || location.origin).replace(/\/$/, '');
      const link = `${base}/#/invite/${r.token}`;
      const ok = await copyText(link);
      if (ok) toast(t('inviteCopied'));
      await dialog({ title: t('inviteLink'), text: t('inviteHint'), fields: [{ name: 'url', label: t('link'), value: link }], ok: 'OK' });
    } else if (el.matches('[data-adduser]')) {
      const r = await dialog({
        title: t('addUser'),
        fields: [
          { name: 'name', label: t('name') },
          { name: 'password', label: t('password'), type: 'password' },
          { name: 'admin', label: t('isAdmin'), type: 'checkbox' }
        ],
        ok: t('create')
      });
      if (r) {
        await post('/api/users', r);
        renderUsers();
      }
    } else if (el.dataset.deluser) {
      const r = await dialog({ title: t('deleteUserQ', { name: el.dataset.name }), ok: t('delete'), danger: true });
      if (r) {
        await del('/api/users/' + el.dataset.deluser);
        renderUsers();
      }
    }
  } catch (err) {
    toast(errorText(err));
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'oledsw') {
    prefs.oled = e.target.checked;
    savePrefs();
    applyPrefs();
    document.querySelectorAll('#oledsw').forEach((x) => (x.checked = prefs.oled));
  }
  if (e.target.id === 'dyncolor') {
    prefs.dynamic = e.target.checked;
    savePrefs();
    applyDyn(player.current);
  }
  if (e.target.id === 'autoplay') {
    prefs.autoplay = e.target.checked;
    player.autoplay = prefs.autoplay;
    savePrefs();
  }
});

function pickUpload() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.multiple = true;
  inp.accept = 'audio/*,.mp3,.flac,.m4a,.aac,.ogg,.opus,.wav,.webm';
  inp.onchange = async () => {
    const files = [...inp.files];
    if (!files.length) return;
    let ok = 0;
    const box = () => $('#upload-progress');
    for (const f of files) {
      const show = (p) => {
        const msg = `${t('uploading', { name: f.name })} ${Math.round(p * 100)} %`;
        if (box()) box().textContent = msg;
        else toast(msg);
      };
      try {
        await upload(f, show);
        ok++;
      } catch {
        toast(t('uploadFailed', { name: f.name }));
      }
    }
    if (box()) box().textContent = '';
    toast(t('uploaded', { n: ok }));
    state.cache = {};
    if ($('#settings').classList.contains('open')) renderSettings();
    render();
  };
  inp.click();
}

// ---------- login / connect ----------
function clientName() {
  if (window.MusikAndroid) return 'Android';
  if (window.musikDesktop) return 'Desktop';
  return 'Browser';
}

function logout() {
  conn.token = null;
  conn.user = null;
  saveConn();
  if (player) player.pause();
  showLogin();
}

async function showLogin(errorMsg = '') {
  document.body.classList.add('auth');
  const app = $('#app');
  if (!conn.server && sameOrigin) conn.server = sameOrigin;
  let info = null;
  let err = errorMsg;
  if (conn.server) {
    try {
      info = await api('GET', '/api/info', undefined, { token: null, timeout: 6000 });
      if (info?.app !== 'musik') {
        info = null;
        err = t('notMusik');
      }
    } catch {
      err = err || t('serverUnreachable');
    }
  }
  const serverField = !sameOrigin
    ? `<label class="field"><span>${t('serverAddress')}</span><input name="server" value="${esc(conn.server || '')}" placeholder="http://192.168.1.50:8484" inputmode="url" autocapitalize="off" autocorrect="off"></label>
       <p class="muted small">${t('serverHelp')}</p>`
    : '';
  const invite = (location.hash.match(/^#\/invite\/([0-9a-f]{16,64})/) || [])[1] || '';
  let inviteErr = '';
  if (info && invite && !info.setup) {
    await api('GET', '/api/invite/' + invite, undefined, { token: null, timeout: 6000 }).catch((e) => (inviteErr = errorText(e)));
  }
  const mode = !info ? 'server' : info.setup ? 'setup' : invite && !inviteErr ? 'invite' : 'login';
  if (inviteErr && !err) err = inviteErr;
  app.innerHTML = `<div class="auth-wrap"><form class="auth-card" novalidate>
    <div class="brand"><span class="brandmark" aria-hidden="true"></span><span class="wordmark" role="img" aria-label="Streyn"></span></div>
    <h2>${mode === 'setup' ? t('firstAccount') : mode === 'invite' ? t('inviteTitle') : mode === 'login' ? t('login') : t('connect')}</h2>
    ${mode === 'setup' ? `<p class="muted small">${t('firstAccountHelp')}</p>` : mode === 'invite' ? `<p class="muted small">${t('inviteHelp', { name: esc(info.name || 'Streyn') })}</p>` : ''}
    ${mode === 'server' ? serverField : `${sameOrigin ? '' : `<p class="muted small srv">${esc(conn.server)} · <a href="#" data-editserver>${t('changeServer')}</a></p>`}
      <label class="field"><span>${t('name')}</span><input name="name" autocomplete="username" autocapitalize="off"></label>
      <label class="field"><span>${t('password')}</span><input name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>`}
    <p class="err">${esc(err)}</p>
    <button class="btn primary wide">${mode === 'setup' || mode === 'invite' ? t('create') : mode === 'login' ? t('login') : t('connect')}</button>
    <div class="auth-foot"><button type="button" class="linkbtn" data-authlang>${getLang() === 'de' ? 'English' : 'Deutsch'}</button></div>
  </form></div>`;
  const form = $('.auth-card');
  form.querySelector('input')?.focus();
  form.querySelector('[data-editserver]')?.addEventListener('click', (e) => {
    e.preventDefault();
    conn.server = '';
    saveConn();
    showLogin();
  });
  form.querySelector('[data-authlang]').onclick = () => {
    rememberLang(getLang() === 'de' ? 'en' : 'de');
    applyPrefs();
    showLogin(err);
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('.btn.primary');
    btn.disabled = true;
    try {
      if (mode === 'server') {
        const s = normalizeServer(form.elements.server.value);
        if (!s) throw new ApiError(0, 'offline');
        conn.server = s;
        saveConn();
        return showLogin();
      }
      const body = { name: form.elements.name.value, password: form.elements.password.value, client: clientName() };
      const r = await api('POST', mode === 'setup' ? '/api/setup' : mode === 'invite' ? `/api/invite/${invite}/signup` : '/api/login', body, { token: null });
      if (mode === 'invite') history.replaceState(null, '', location.pathname + '#/home');
      conn.token = r.token;
      conn.user = r.user;
      saveConn();
      startApp();
    } catch (e2) {
      form.querySelector('.err').textContent = errorText(e2);
      btn.disabled = false;
    }
  };
}

// ---------- shell ----------
// ---------- Green theme on the desktop: Spotify's layout ----------
// Library on the left (folds to a strip of covers), the page in the middle, a panel on the right
// (now playing, queue, devices, other devices), the player row below. Only while Green is on and
// the window is wide; phones keep their own layout.
var gCtx = { queue: null, name: '' }; // the page a song list was started from
function gOn() {
  return curTheme() === 'green' && innerWidth >= 900;
}
function gPanelMode() {
  if (!gOn()) return null;
  const m = prefs.gPanel === undefined ? 'np' : prefs.gPanel;
  return ['np', 'queue', 'devices', 'friends'].includes(m) ? m : null;
}
function gSync() {
  const root = document.documentElement;
  const on = gOn();
  const was = root.classList.contains('gdesk');
  root.classList.toggle('gdesk', on);
  gApplyZoom();
  root.classList.toggle('glib-min', on && !!prefs.gLibMin);
  const box = document.getElementById('gpanel');
  if (!box) return;
  gBind();
  gStickyBind();
  const mode = gPanelMode();
  root.classList.toggle('gpanel-open', !!mode);
  if (!mode) {
    box.innerHTML = '';
    box.dataset.mode = '';
  } else if (box.dataset.mode !== mode) gRenderPanel();
  document.querySelectorAll('[data-gpanel]').forEach((b) => b.classList.toggle('on', b.dataset.gpanel === mode));
  $('#player [data-act="queue"]')?.classList.toggle('on', mode === 'queue');
  $('#player .extra .devbtn')?.classList.toggle('on', mode === 'devices');
  const tog = $('[data-glibmin]');
  if (tog) tog.title = t(prefs.gLibMin ? 'gShowLib' : 'gHideLib');
  gChipFilter();
  // song lists get (or lose) the table head with the number column
  if (was !== on && $('#view')?.children.length) render();
}
addEventListener('resize', () => {
  if (gOn() !== document.documentElement.classList.contains('gdesk')) gSync();
});
function gSetPanel(mode) {
  prefs.gPanel = gPanelMode() === mode ? 'off' : mode;
  savePrefs();
  gSync();
}
// the track changed: the panel follows
function gOnChange() {
  const box = document.getElementById('gpanel');
  const mode = gPanelMode();
  if (box && mode === 'np' && box.dataset.id !== String(player.current?.id ?? '')) gRenderPanel();
  else if (box && mode === 'queue') gRenderPanel();
  else if (box && mode === 'np') gPaintNext();
  gMiniPaint();
}

function gRenderPanel() {
  const box = document.getElementById('gpanel');
  const mode = gPanelMode();
  if (!box || !mode) return;
  box.dataset.mode = mode;
  if (mode === 'np') return gRenderNp(box);
  if (mode === 'queue') return gRenderQueue(box);
  if (mode === 'devices') {
    box.dataset.id = '';
    box.innerHTML = `${gHead(t('devConnect'))}<div class="gp-scroll"><div class="devsheet gdev"><div class="ds-body"></div></div></div>`;
    if (!window.MusikAndroid && outDevices === null) loadOutputs(false).then(() => fillDevSheet());
    return fillDevSheet();
  }
  box.dataset.id = '';
  box.innerHTML = `${gHead(t('gFriends'))}<div class="gp-scroll"><p class="gp-intro">${t('gFriendsText')}</p><div class="gp-friends">${accountDevicesHtml() || `<p class="muted small">${t('devNone')}</p>`}</div></div>`;
}
const gHead = (title, extra = '', big = false) =>
  `<div class="gp-head"><div class="gp-ht">${title}</div>${extra}${big ? `<button class="icon-btn" data-act="open-fs" title="${t('gFull')}">${icon('expand')}</button>` : `<button class="icon-btn" data-gclose title="${t('close')}">${icon('close')}</button>`}</div>`;

// what is playing: the list or album the song came from, else the artist
function gContext(tr) {
  if (playSrc.name && player.queue === playSrc.queue) return playSrc.name;
  if (gCtx.name && player.queue === gCtx.queue) return gCtx.name;
  return tr.album || artistName(tr);
}

const gArtistInfo = new Map(); // name -> Promise<{ picture, fans, id }>
function gArtistLookup(name) {
  if (!gArtistInfo.has(name)) {
    gArtistInfo.set(
      name,
      get('/api/catalog/search?q=' + encodeURIComponent(name))
        .then((c) => {
          const same = (a) => a.name.toLowerCase() === name.toLowerCase();
          return c?.artists?.find(same) || null;
        })
        .catch(() => null)
    );
  }
  return gArtistInfo.get(name);
}

async function gRenderNp(box) {
  const tr = player.current;
  box.dataset.id = String(tr?.id ?? '');
  const more = `<button class="icon-btn" data-gpmore title="…">${icon('more')}</button>`;
  if (!tr) {
    box.innerHTML = `${gHead(t('gNowPl'), more)}<div class="gp-scroll"><p class="gp-intro">${t('nothingPlaying')}</p></div>`;
    return;
  }
  await loadFollows().catch(() => null);
  if (box.dataset.id !== String(tr.id)) return;
  const refs = artistRefs(tr);
  const main = refs[0] || { name: artistName(tr), href: findArtistHref(artistName(tr), tr.ext?.source) };
  const spId = tr.ext?.source === 'spotify' ? tr.artists?.[0]?.id : null;
  const fol = (a, i) => {
    if (!tr.ext) return followBtn('local', a.name, a.name, tr.id);
    const id = tr.ext.source === 'spotify' ? tr.artists?.[i]?.id : null;
    return id ? followBtn('spotify', id, a.name, '') : '';
  };
  box.innerHTML = `${gHead(`<a href="#/queue" class="gp-ctx" data-gpanel="queue">${esc(gContext(tr))}</a>`, more, true)}
    <div class="gp-scroll">
      <div class="gp-cover" data-act="open-fs">${coverImg(tr.id, 'xl')}</div>
      <div class="gp-meta"><div class="gp-mt"><div class="gp-title">${esc(tr.title)}</div><div class="gp-artists">${artistLinks(tr)}</div></div>
        <button class="icon-btn" data-gpshare title="${t('share')}">${icon('share2')}</button>
        <button class="icon-btn like ${tr.liked || extLikes.has(tr.id) ? 'on' : ''}" data-act="like" title="${t('like')}">${icon('heart')}</button></div>
      <div class="gp-card gp-lyr" data-glyr hidden><div class="gp-ch"><b>${t('gLyricsPreview')}</b></div><div class="gp-lines"></div></div>
      <div class="gp-card gp-about"><a class="gp-apic" href="${main.href}"><div class="gp-ch gp-onpic"><b>${t('gAboutArtist')}</b></div></a>
        <div class="gp-ab"><a class="gp-an" href="${main.href}">${esc(main.name)}</a>
        <div class="gp-arow"><span class="gp-al" data-glisteners></span>${fol(main, 0)}</div></div></div>
      <div class="gp-card gp-credits"><div class="gp-ch"><b>${t('gCredits')}</b></div>
        ${refs.map((a, i) => `<div class="gp-cr"><div><a href="${a.href}">${esc(a.name)}</a><small>${t(i ? 'gArtistRole' : 'gMainArtist')}</small></div>${fol(a, i)}</div>`).join('')}
        ${tr.album ? `<div class="gp-cr"><div>${albumLink(tr)}<small>${t('gAlbumRole')}</small></div></div>` : ''}</div>
      <div class="gp-card gp-next" hidden></div>
    </div>`;
  gPaintNext();
  // the artist's picture and how many listen to them
  gArtistLookup(main.name).then((a) => {
    if (box.dataset.id !== String(tr.id)) return;
    const pic = box.querySelector('.gp-apic');
    if (a?.picture && pic) {
      pic.style.backgroundImage = `url("${String(a.picture).replace('/250x250-', '/1000x1000-')}")`;
      pic.classList.add('has');
    }
    const el = box.querySelector('[data-glisteners]');
    if (el && a?.fans) el.textContent = t('gFollowers', { n: a.fans.toLocaleString(getLang() === 'de' ? 'de-DE' : 'en-US') });
  });
  (async () => {
    let id = spId;
    if (!id) id = (await spotifyFindArtist(main.name).catch(() => null))?.id;
    if (!id) return;
    const r = await get('/api/catalog/sp-listeners/' + id).catch(() => null);
    const el = box.querySelector('[data-glisteners]');
    if (!r?.listeners || !el || box.dataset.id !== String(tr.id)) return;
    const loc = getLang() === 'de' ? 'de-DE' : 'en-US';
    const n = r.exact === false ? new Intl.NumberFormat(loc, { notation: 'compact', maximumFractionDigits: 1 }).format(r.listeners) : new Intl.NumberFormat(loc).format(r.listeners);
    el.textContent = t('monthlyListeners', { n });
  })();
  // a few lines of the lyrics on the colour of the cover, they move with the song
  loadLyrics(tr)
    .then((r) => {
      if (box.dataset.id !== String(tr.id) || !r.lines.some((l) => l.text)) return;
      const card = box.querySelector('[data-glyr]');
      card.hidden = false;
      card._lines = r.lines;
      card._synced = r.synced;
      card._at = -2;
      card.querySelector('.gp-lines').innerHTML = r.lines.filter((l) => l.text || r.synced).map((l, i) => `<p data-gl="${i}">${esc(l.text) || '♪'}</p>`).join('');
      gLyrSync();
    })
    .catch(() => {});
}
function gPaintNext() {
  const card = $('#gpanel .gp-next');
  if (!card) return;
  const i = player.index + 1;
  const up = player.queue[i];
  card.hidden = !up;
  if (!up) return;
  card.innerHTML = `<div class="gp-ch"><b>${t('gNextQ')}</b><button class="gp-link" data-gpanel="queue">${t('gOpenQ')}</button></div>
    <button class="gp-nrow" data-gjump="${i}">${coverImg(up.id, 'sm')}<span class="gp-play">${icon('play')}</span><span><b>${esc(up.title)}</b><small>${esc(artistName(up))}</small></span></button>`;
}
function gLyrSync() {
  const card = $('#gpanel [data-glyr]');
  if (!card || card.hidden || !card._lines) return;
  const lines = card._lines;
  let i = -1;
  if (card._synced) {
    const pos = player.position + 0.25;
    for (let k = 0; k < lines.length; k++) if (lines[k].t <= pos) i = k;
  }
  if (i === card._at) return;
  card._at = i;
  card.querySelectorAll('p').forEach((p) => {
    const k = Number(p.dataset.gl);
    p.classList.toggle('past', card._synced && k < i);
    p.classList.toggle('on', k === i);
  });
  const p = card.querySelector(`[data-gl="${i}"]`);
  const box = card.querySelector('.gp-lines');
  if (p) box.scrollTo({ top: Math.max(0, p.offsetTop - box.offsetTop - 34), behavior: 'smooth' });
}

function gRenderQueue(box) {
  box.dataset.id = '';
  const tab = box._tab || 'queue';
  const q = player.queue;
  const cur = player.index;
  const row = (tr, i, isNow = false) => `<div class="row gq ${isNow ? 'current' : ''}" data-i="${i}" data-q="${i}" data-id="${esc(String(tr.id))}">
      <div class="lead">${coverImg(tr.id, 'sm')}<span class="eqi" aria-hidden="true"><i></i><i></i><i></i><i></i></span><button class="playbtn">${icon('play')}</button></div>
      <div class="main"><div class="title">${esc(tr.title)}</div><div class="sub">${esc(artistName(tr))}</div></div>
      <button class="icon-btn more" title="…">${icon('more')}</button></div>`;
  let body = '';
  if (tab === 'queue') {
    state.lists = state.lists || {};
    state.lists.gq = q;
    const now = q[cur];
    const up = q.slice(cur + 1, cur + 81);
    body = now
      ? `<h4 class="gp-sh">${t('gNowPl')}</h4><div class="tracks" data-list="gq" data-queue="1">${row(now, cur, true)}</div>
        ${up.length ? `<div class="gp-sh2"><h4 class="gp-sh">${t('gNextFrom', { name: esc(gContext(now)) })}</h4><button class="gp-link" data-clearq>${t('gClearQ')}</button></div><div class="tracks" data-list="gq" data-queue="1">${up.map((tr, k) => row(tr, cur + 1 + k)).join('')}</div>` : ''}`
      : `<div class="gp-empty">${icon('queue', 'big')}<b>${t('queue')}</b><p>${t('gQueueEmpty')}</p><a class="btn" href="#/search">${t('search')}</a></div>`;
  } else {
    const list = extHistory().slice(0, 50).map(histTrack);
    state.lists = state.lists || {};
    state.lists.grecent = list;
    body = list.length ? `<div class="tracks" data-list="grecent">${list.map((tr, i) => row(tr, i).replace(' data-q="' + i + '"', '')).join('')}</div>` : `<p class="gp-intro">${t('empty')}</p>`;
  }
  const scroll = box.querySelector('.gp-scroll')?.scrollTop || 0;
  box.innerHTML = `${gHead(`<span class="gp-tabs"><button class="${tab === 'queue' ? 'on' : ''}" data-gqtab="queue">${t('queue')}</button><button class="${tab === 'recent' ? 'on' : ''}" data-gqtab="recent">${t('gRecent')}</button></span>`)}<div class="gp-scroll">${body}</div>`;
  box.querySelector('.gp-scroll').scrollTop = scroll;
}

// ---------- clicks ----------
document.addEventListener(
  'click',
  (e) => {
    if (!gOn()) return;
    const el = e.target;
    // the player's queue and device buttons open the panel instead of a page or a sheet
    const qb = el.closest('#player [data-act="queue"]');
    if (qb) {
      e.stopPropagation();
      return gSetPanel('queue');
    }
    if (el.closest('#player .extra [data-devsheet], .gconnect')) {
      e.stopPropagation();
      return gSetPanel('devices');
    }
    if (el.closest('#player [data-act="lyrics"]') && gPanelMode() === 'np' && state.route === 'lyrics') {
      e.stopPropagation();
      return history.back();
    }
  },
  true
);
document.addEventListener('click', (e) => {
  const el = e.target;
  const gp = el.closest('[data-gpanel]');
  if (gp) {
    e.preventDefault();
    return gSetPanel(gp.dataset.gpanel);
  }
  if (el.closest('[data-gclose]')) {
    prefs.gPanel = 'off';
    savePrefs();
    return gSync();
  }
  const qt = el.closest('[data-gqtab]');
  if (qt) {
    const box = $('#gpanel');
    box._tab = qt.dataset.gqtab;
    return gRenderQueue(box);
  }
  const j = el.closest('[data-gjump]');
  if (j) return player.jump(Number(j.dataset.gjump));
  if (el.closest('[data-glyr]')) return go('#/lyrics');
  if (el.closest('[data-gpshare]') && player.current) {
    const tr = player.current;
    const txt = `${tr.title} · ${artistName(tr)}`;
    return navigator.clipboard?.writeText(txt).then(() => toast(t('copied')), () => toast(txt));
  }
  const pm = el.closest('[data-gpmore]');
  if (pm && player.current) return trackMenu(pm, player.current, {});
  if (el.closest('[data-gfull]')) {
    if (document.fullscreenElement) return document.exitFullscreen?.();
    return document.documentElement.requestFullscreen?.().catch(() => openFs(true));
  }
  if (el.closest('[data-gmini]')) return gMiniOpen();
  const tog = el.closest('[data-glibmin]');
  if (tog) {
    prefs.gLibMin = !prefs.gLibMin;
    savePrefs();
    const side = $('.side');
    side?.classList.add('gmoving');
    setTimeout(() => side?.classList.remove('gmoving'), 320);
    return gSync();
  }
  const chip = el.closest('[data-glibchip]');
  if (chip) {
    prefs.gLibChip = prefs.gLibChip === chip.dataset.glibchip ? '' : chip.dataset.glibchip;
    savePrefs();
    return gChipFilter();
  }
  const cr = el.closest('[data-gcreate]');
  if (cr) return gCreateMenu(cr);
  const am = el.closest('[data-appmenu]');
  if (am) return gAppMenu(am);
});
addEventListener('fullscreenchange', () => $('[data-gfull]')?.classList.toggle('on', !!document.fullscreenElement));

// the lyrics card and the mini player move with the song
let gTick = 0;
function gTime() {
  const now = performance.now();
  if (now - gTick < 200) return;
  gTick = now;
  if (gPanelMode() === 'np') gLyrSync();
  gMiniTime();
}

// ---------- library on the left: filter chips, artists you follow, fold to covers ----------
function gChipFilter() {
  const box = $('#side-playlists');
  if (!box) return;
  const want = gOn() ? prefs.gLibChip || '' : '';
  box.querySelectorAll('.side-pl').forEach((a) => (a.hidden = !!want && a.dataset.kind !== want));
  document.querySelectorAll('[data-glibchip]').forEach((c) => c.classList.toggle('on', c.dataset.glibchip === want));
  $('.glib-chips')?.classList.toggle('picked', !!want);
}
async function gSideExtras() {
  const box = $('#side-playlists');
  if (!box) return;
  box.querySelectorAll('.side-pl').forEach((a) => {
    if (!a.dataset.kind) a.dataset.kind = /^import:/.test(a.dataset.ref || '') && /album/i.test(a.querySelector('small')?.textContent || '') ? 'album' : 'playlist';
    if (!a.querySelector('.gside-play')) a.querySelector('.cover')?.insertAdjacentHTML('afterend', `<span class="gside-play" aria-hidden="true">${icon('play')}</span>`);
  });
  if (!gOn()) return gChipFilter();
  if (!box.querySelector('.gliked')) {
    const n = await get('/api/likes').then((l) => (Array.isArray(l) ? l.length : 0) + (extLikes?.size || 0)).catch(() => 0);
    box.insertAdjacentHTML('afterbegin', `<a href="#/likes" class="side-pl gliked" data-kind="playlist" data-ref=""><div class="cover xs liked">${icon('heartFill')}</div><span class="gside-play" aria-hidden="true">${icon('play')}</span><span class="spl-t"><b>${esc(settings.likesName || t('likes'))}</b><small>${t('playlist')} · ${songCount(n)}</small></span></a>`);
  }
  const fol = await loadFollows().catch(() => []);
  if (box.querySelector('.side-pl[data-kind="artist"]')) box.querySelectorAll('.side-pl[data-kind="artist"]').forEach((x) => x.remove());
  box.insertAdjacentHTML(
    'beforeend',
    (fol || [])
      .map((f) => {
        const c = followCard(f);
        return `<a href="${c.href}" class="side-pl gart" data-kind="artist">${coverImg(c.cover, 'xs round')}<span class="gside-play" aria-hidden="true">${icon('play')}</span><span class="spl-t"><b>${esc(c.name)}</b><small>${t('artist')}</small></span></a>`;
      })
      .join('')
  );
  // titles for the folded strip, where only the covers show
  box.querySelectorAll('.side-pl').forEach((a) => (a.title = a.querySelector('.spl-t b')?.textContent || ''));
  gChipFilter();
}
{
  // run after the sidebar list was (re)built
  const orig = renderSidebarPlaylists;
  // eslint-disable-next-line no-func-assign
  renderSidebarPlaylists = async function () {
    await orig();
    await gSideExtras();
  };
}

// ---------- the "Create" button and the "…" menu at the top left ----------
function gCreateMenu(btn) {
  if (document.querySelector('.gcreate-pop')) return closeGPop();
  const items = [
    ['noteplus', 'gCreatePl', 'gCreatePlHint', async () => {
      const p = await playlistDialog();
      if (p) {
        renderSidebarPlaylists();
        go('#/playlist/' + p.id);
      }
    }],
    ['download', 'gCreateImp', 'gCreateImpHint', () => go('#/add')],
    ['upload', 'gCreateUp', 'gCreateUpHint', () => pickUpload()],
    ['mix', 'gCreateMix', 'gCreateMixHint', () => gFire('playmix')]
  ];
  const pop = document.createElement('div');
  pop.className = 'gcreate-pop';
  pop.innerHTML = items.map(([ic, l, h], i) => `<button data-i="${i}"><span class="gc-ic">${icon(ic)}</span><span><b>${t(l)}</b><small>${t(h)}</small></span></button>`).join('');
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 8) + 'px';
  pop.style.top = r.bottom + 8 + 'px';
  btn.classList.add('open');
  pop._btn = btn;
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    closeGPop();
    Promise.resolve(items[Number(b.dataset.i)][3]()).catch((err) => toast(errorText(err)));
  });
  setTimeout(() => addEventListener('mousedown', gPopOutside), 0);
}
function gPopOutside(e) {
  const pop = document.querySelector('.gcreate-pop, .gmenu');
  if (!pop || pop.contains(e.target) || pop._btn?.contains(e.target)) return;
  closeGPop();
}
function closeGPop() {
  document.querySelectorAll('.gcreate-pop, .gmenu').forEach((p) => {
    p._btn?.classList.remove('open');
    p.remove();
  });
  removeEventListener('mousedown', gPopOutside);
}
addEventListener('keydown', (e) => e.key === 'Escape' && closeGPop());
// press a button that lives somewhere else in the app (one place for each action)
function gFire(attr) {
  const b = document.createElement('button');
  b.setAttribute('data-' + attr, '');
  b.hidden = true;
  document.body.appendChild(b);
  b.click();
  b.remove();
}
function gZoom(step) {
  prefs.gZoom = step === 0 ? 1 : Math.min(2, Math.max(0.5, Math.round(((prefs.gZoom || 1) + step) * 10) / 10));
  savePrefs();
  gApplyZoom();
}
function gApplyZoom() {
  const z = curTheme() === 'green' && prefs.gZoom && prefs.gZoom !== 1 ? prefs.gZoom : '';
  document.body.style.zoom = z;
}
addEventListener('keydown', (e) => {
  if (!gOn() || !(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.key === '+' || e.key === '=') gZoom(0.1);
  else if (e.key === '-') gZoom(-0.1);
  else if (e.key === '0') gZoom(0);
  else return;
  e.preventDefault();
});
function gAppMenu(btn) {
  if (document.querySelector('.gmenu')) return closeGPop();
  const vol = (d) => {
    player.setVolume(Math.min(1, Math.max(0, player.volume + d)));
    prefs.volume = player.volume;
    savePrefs();
  };
  const groups = [
    ['gFile', [
      [t('gNewPlaylist'), () => gFire('newpl')],
      [t('gCreateImp'), () => go('#/add')],
      [t('gCreateUp'), () => pickUpload()],
      '-',
      [t('gPrefs'), () => openSettings()],
      [t('logout'), () => logout()]
    ]],
    ['gEdit', [
      [t('gFind'), () => ($('#tbq') ? $('#tbq').focus() : go('#/search')), 'Ctrl+K'],
      [t('gPrefs'), () => openSettings(), 'Ctrl+,']
    ]],
    ['gView', [
      [t('gZoomIn'), () => gZoom(0.1), 'Ctrl++'],
      [t('gZoomOut'), () => gZoom(-0.1), 'Ctrl+−'],
      [t('gZoomReset'), () => gZoom(0), 'Ctrl+0'],
      '-',
      [t(prefs.gLibMin ? 'gShowLib' : 'gHideLib'), () => gFire('glibmin')],
      [t('gNpv'), () => gSetPanel('np')],
      [t('queue'), () => gSetPanel('queue')],
      [t('gFull'), () => gFire('gfull'), 'F11']
    ]],
    ['gPlayback', [
      [t(player.playing ? 'pause' : 'play'), () => player.toggle(), 'Space'],
      [t('next'), () => player.next(), 'Ctrl+→'],
      [t('prev'), () => player.prev(), 'Ctrl+←'],
      [t('shuffle'), () => player.toggleShuffle(), 'Ctrl+S'],
      [t('repeat'), () => player.cycleRepeat(), 'Ctrl+R'],
      '-',
      [t('gVolUp'), () => vol(0.1), 'Ctrl+↑'],
      [t('gVolDown'), () => vol(-0.1), 'Ctrl+↓']
    ]],
    ['gHelp', [
      [t('gDocs'), () => openExt('https://musik.labtoso.de/docs/')],
      ['Discord', () => openExt(DISCORD_URL)],
      [t('gAbout'), () => openSettings('updates')]
    ]]
  ];
  const m = document.createElement('div');
  m.className = 'gmenu';
  const acts = [];
  m.innerHTML = groups
    .map(([g, list]) => `<div class="gam-item"><button class="gam-top">${t(g)}${icon('back', 'gam-arrow')}</button><div class="gam-sub">${list
      .map((it) => {
        if (it === '-') return '<hr>';
        acts.push(it[1]);
        return `<button data-a="${acts.length - 1}"><span>${esc(it[0])}</span>${it[2] ? `<kbd>${it[2]}</kbd>` : ''}</button>`;
      })
      .join('')}</div></div>`)
    .join('');
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect();
  m.style.left = r.left + 'px';
  m.style.top = r.bottom + 4 + 'px';
  m._btn = btn;
  btn.classList.add('open');
  m.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    closeGPop();
    Promise.resolve(acts[Number(b.dataset.a)]()).catch((err) => toast(errorText(err)));
  });
  setTimeout(() => addEventListener('mousedown', gPopOutside), 0);
}

// ---------- the bar that sticks to the top of a page with its play button ----------
function gStickyBind() {
  const c = $('#content');
  if (!c || c._gsticky) return;
  c._gsticky = true;
  c.addEventListener('scroll', gSticky, { passive: true });
  // a new page: the bar starts hidden again
  new MutationObserver(() => setTimeout(() => (gSticky(), gFitTitle()), 30)).observe($('#view'), { childList: true });
}
// the big title of a page gets the largest of Spotify's sizes that fits on one line
function gFitTitle() {
  const h = gOn() ? $('#view .detail-head .dh-text > h1') : null;
  if (!h || !h.clientWidth) return;
  h.classList.add('gfit');
  h.classList.remove('wrap');
  for (const px of [96, 72, 48, 32]) {
    h.style.fontSize = px + 'px';
    if (h.scrollWidth <= h.clientWidth + 1) return;
  }
  h.classList.add('wrap');
}
addEventListener('resize', () => gFitTitle());
function gSticky() {
  const c = $('#content');
  if (!c) return;
  let bar = $('#gsticky');
  const head = gOn() ? $('#view .detail-head') : null;
  if (!head) return bar?.classList.remove('on');
  if (!bar) {
    c.insertAdjacentHTML('afterbegin', `<div id="gsticky" class="gsticky"><button class="gs-play" data-gsplay>${icon('play')}</button><span class="gs-t"></span></div>`);
    bar = $('#gsticky');
  }
  const h1 = head.querySelector('h1');
  const edge = head.offsetTop + head.offsetHeight - 104 - 64 - 64;
  const show = c.scrollTop > edge;
  const tint = getComputedStyle(head).getPropertyValue('--tint').trim();
  bar.style.setProperty('--gs', tint || 'var(--dyn-bg, #404040)');
  bar.querySelector('.gs-t').textContent = h1?.textContent || '';
  bar.classList.toggle('on', show);
  // a little later it fades in, like the bar in Spotify that rises with the scroll
  bar.style.setProperty('--gso', Math.min(1, Math.max(0, (c.scrollTop - edge) / 64)));
  const pb = head.querySelector('.toolbar [data-playkey]');
  const on = pb && player.playing && sourceActive(location.hash + '|' + pb.dataset.playkey);
  bar.querySelector('.gs-play').innerHTML = icon(on ? 'pause' : 'play');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-gsplay]')) return;
  $('#view .detail-head .toolbar .btn.primary, #view .detail-head .toolbar .playcircle')?.click();
});

// ---------- tooltips like Spotify's: a small dark box under or over the control ----------
{
  let tip = null;
  let timer = 0;
  const hide = () => {
    clearTimeout(timer);
    tip?.remove();
    tip = null;
  };
  document.addEventListener('mouseover', (e) => {
    if (!gOn() || matchMedia('(hover: none)').matches) return;
    const el = e.target.closest?.('.titlebar [title], .player [title], .gpanel [title], .glib-head [title], .side-pl[title], .detail-head .toolbar [title]');
    if (!el) return;
    if (el._gt === undefined) {
      el._gt = el.getAttribute('title');
      el.removeAttribute('title');
      el.setAttribute('aria-label', el._gt);
    }
    hide();
    if (!el._gt) return;
    timer = setTimeout(() => {
      tip = document.createElement('div');
      tip.className = 'gtip';
      tip.textContent = el._gt;
      document.body.appendChild(tip);
      const r = el.getBoundingClientRect();
      const side = el.closest('.side-pl') && document.documentElement.classList.contains('glib-min');
      let x = side ? r.right + 8 : r.left + r.width / 2 - tip.offsetWidth / 2;
      let y = side ? r.top + r.height / 2 - tip.offsetHeight / 2 : el.closest('.player') ? r.top - tip.offsetHeight - 8 : r.bottom + 8;
      tip.style.left = Math.max(8, Math.min(x, innerWidth - tip.offsetWidth - 8)) + 'px';
      tip.style.top = Math.max(8, y) + 'px';
    }, 450);
    el.addEventListener('mouseleave', hide, { once: true });
  });
  document.addEventListener('mousedown', hide, true);
}

// ---------- "What's New": the bell at the top ----------
views.gnew = async () => {
  const [lib, fol] = await Promise.all([get('/api/library').catch(() => ({})), loadFollows().catch(() => [])]);
  const albums = (lib.albums || []).slice().sort((a, b) => (b.added || 0) - (a.added || 0)).slice(0, 24);
  let html = `<h1 class="gnew-h">${t('gWhatsNew')}</h1><p class="muted gnew-p">${t('gWhatsNewHint')}</p>`;
  const recent = extHistory().slice(0, 12).map(histTrack);
  if (albums.length) html += section(t('newAlbums') !== 'newAlbums' ? t('newAlbums') : t('albums'), `<div class="cards">${albums.map((a) => `<a class="card" href="${albumHref(a.album || a.name, a.artist)}">${coverImg(a.cover_id, 'lg')}<div class="c-title">${esc(a.album || a.name || '')}</div><div class="c-sub">${esc(a.artist || '')}</div></a>`).join('')}</div>`);
  if (fol?.length) html += section(t('followedArtists'), artistCards(fol.map(followCard), true));
  if (recent.length) html += section(t('recent'), trackCards(recent, 'gnewrecent'));
  if (!albums.length && !fol?.length && !recent.length) html += `<div class="emptystate">${icon('bell', 'big')}<p>${t('empty')}</p></div>`;
  return html;
};

// ---------- Miniplayer: a small window with the cover, it stays on top ----------
let gMini = null; // { win, el }
async function gMiniOpen() {
  if (gMini) return gMiniClose();
  const el = document.createElement('div');
  el.className = 'gmini';
  el.innerHTML = `<div class="gm-bg"></div><div class="gm-cover"></div>
    <div class="gam-top"><button class="gm-b" data-gm="set" title="${t('gMiniSettings')}">${icon('more')}</button><button class="gm-b" data-gm="close" title="${t('gMiniClose')}">${icon('close')}</button></div>
    <div class="gm-ctl"><button class="gm-b" data-gm="prev">${icon('prev')}</button><button class="gm-b gm-pp" data-gm="toggle">${icon('play')}</button><button class="gm-b" data-gm="next">${icon('next')}</button></div>
    <div class="gm-foot"><div class="gm-txt"><b></b><small></small></div><button class="gm-b gm-like like" data-gm="like">${icon('heart')}</button></div>
    <div class="gm-q"></div>
    <div class="gm-bar"><i></i></div>`;
  let win = null;
  if (window.documentPictureInPicture?.requestWindow) {
    try {
      win = await documentPictureInPicture.requestWindow({ width: 320, height: 320 });
      for (const s of document.querySelectorAll('link[rel="stylesheet"], style')) win.document.head.appendChild(s.cloneNode(true));
      win.document.documentElement.dataset.theme = 'green';
      win.document.body.className = 'gmini-win';
      win.document.body.appendChild(el);
      win.addEventListener('pagehide', () => {
        gMini = null;
        $('[data-gmini]')?.classList.remove('on');
      });
    } catch {
      win = null;
    }
  }
  if (!win) {
    el.classList.add('float');
    document.body.appendChild(el);
    // drag it anywhere in the window
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, .gm-bar, .gm-set')) return;
      const r = el.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const mv = (ev) => {
        el.style.left = Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx)) + 'px';
        el.style.top = Math.max(0, Math.min(innerHeight - r.height, ev.clientY - dy)) + 'px';
        el.style.right = el.style.bottom = 'auto';
      };
      const up = () => removeEventListener('pointermove', mv);
      addEventListener('pointermove', mv);
      addEventListener('pointerup', up, { once: true });
    });
  }
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-gm]');
    if (!b) return;
    const a = b.dataset.gm;
    if (a === 'close') return gMiniClose();
    if (a === 'set') return gMiniSettings(el);
    if (a === 'toggle') player.toggle();
    else if (a === 'next') player.next();
    else if (a === 'prev') player.prev();
    else if (a === 'like' && player.current) toggleLike(player.current);
  });
  el.querySelector('.gm-bar').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const d = player.current?.duration || 0;
    if (d) player.seek(((e.clientX - r.left) / r.width) * d);
  });
  gMini = { win, el };
  $('[data-gmini]')?.classList.add('on');
  gMiniPaint();
}
function gMiniClose() {
  if (!gMini) return;
  if (gMini.win) gMini.win.close();
  else gMini.el.remove();
  gMini = null;
  $('[data-gmini]')?.classList.remove('on');
}
function gMiniSettings(el) {
  if (el.querySelector('.gm-set')) return;
  const sw = (k, on) => `<label class="switch"><input type="checkbox" data-gms="${k}" ${on ? 'checked' : ''}><span></span></label>`;
  el.insertAdjacentHTML('beforeend', `<div class="gm-set"><div class="gm-card"><h3>${t('gMiniSet')}</h3>
    <div class="gm-row"><span>${t('gMiniBg')}</span>${sw('bg', prefs.gMiniBg !== false)}</div>
    <div class="gm-row"><span>${t('gMiniQueue')}</span>${sw('queue', !!prefs.gMiniQueue)}</div>
    <button class="gm-done" data-gmdone>${t('done')}</button></div></div>`);
  const set = el.querySelector('.gm-set');
  set.addEventListener('change', (e) => {
    const k = e.target.dataset.gms;
    if (k === 'bg') prefs.gMiniBg = e.target.checked;
    if (k === 'queue') prefs.gMiniQueue = e.target.checked;
    savePrefs();
    gMiniPaint();
  });
  set.addEventListener('click', (e) => {
    if (e.target.closest('[data-gmdone]') || e.target === set) set.remove();
  });
}
function gMiniPaint() {
  if (!gMini) return;
  const el = gMini.el;
  const tr = player.current;
  el.querySelector('.gm-cover').innerHTML = tr ? coverImg(tr.id, 'xl') : '';
  el.querySelector('.gm-txt b').textContent = tr?.title || t('nothingPlaying');
  el.querySelector('.gm-txt small').textContent = tr ? artistName(tr) : '';
  el.querySelector('.gm-pp').innerHTML = icon(player.playing ? 'pause' : 'play');
  el.querySelector('.gm-like').classList.toggle('on', !!(tr && (tr.liked || extLikes.has(tr.id))));
  el.classList.toggle('nobg', prefs.gMiniBg === false);
  el.style.setProperty('--gm-bg', getComputedStyle(document.documentElement).getPropertyValue('--dyn-bg') || '#333');
  const q = el.querySelector('.gm-q');
  el.classList.toggle('withq', !!prefs.gMiniQueue);
  q.innerHTML = prefs.gMiniQueue
    ? player.queue.slice(player.index + 1, player.index + 6).map((x, i) => `<button class="gm-qr" data-gmj="${player.index + 1 + i}">${coverImg(x.id, 'xs')}<span><b>${esc(x.title)}</b><small>${esc(artistName(x))}</small></span></button>`).join('')
    : '';
  q.onclick = (e) => {
    const b = e.target.closest('[data-gmj]');
    if (b) player.jump(Number(b.dataset.gmj));
  };
  gMiniTime(true);
}
function gMiniTime() {
  if (!gMini) return;
  const d = player.current?.duration || 0;
  gMini.el.querySelector('.gm-bar i').style.width = d ? Math.min(100, (player.position / d) * 100) + '%' : '0';
}

// ---------- wire it up once the player exists ----------
function gBind() {
  if (gBind.done || typeof player === 'undefined') return;
  gBind.done = true;
  player.addEventListener('time', gTime);
  player.addEventListener('playing', () => {
    gMiniPaint();
    gSticky();
  });
}

function buildShell() {
  const nav = (key, ic, label) => `<a href="#/${key}" data-nav="${key}">${icon(ic)}<span>${label}</span></a>`;
  const frameless = !!window.musikDesktop?.frameless;
  document.documentElement.classList.toggle('frameless', frameless);
  $('#app').innerHTML = `
  ${`<div class="titlebar${frameless ? '' : ' tb-web'}" data-drag>
    <div class="tb-left"><button class="tb-more gonly" data-appmenu title="${t('gAppMenu')}">${icon('more')}</button><span class="tb-logo"><span class="brandmark" aria-hidden="true"></span></span><button class="tb-btn" data-hist="-1" title="${t('back')}">${icon('back')}</button><button class="tb-btn fwd" data-hist="1" title="${t('forward')}">${icon('back')}</button></div>
    <div class="tb-mid"><a class="tb-home" href="#/home" title="${t('home')}">${icon('home')}</a><label class="tb-search">${icon('search')}<input id="tbq" type="search" placeholder="${t('tbSearch')}" autocomplete="off" spellcheck="false"><a class="tb-browse gonly" href="#/search" title="${t('gBrowse')}">${icon('browse')}</a></label></div>
    <div class="tb-right">${discordBtn('tb-discord')}<a class="tb-icon gonly" href="#/gnew" title="${t('gWhatsNew')}">${icon('bell')}</a><button class="tb-icon gonly" data-gpanel="friends" title="${t('gFriends')}">${icon('friends')}</button><button class="tb-avatar" data-profile title="${t('profile')}">${avatarInner()}</button>
      ${frameless ? `<button class="tb-win" data-win="min" title="${t('minimize')}"><svg viewBox="0 0 10 10"><path d="M1 5h8"/></svg></button>
      <button class="tb-win" data-win="max" title="${t('maximize')}"><svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7"/></svg></button>
      <button class="tb-win close" data-win="close" title="${t('close')}"><svg viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg></button>` : ''}</div>
  </div>`}
  <div class="shell">
    <aside class="side">
      <div class="side-top"><button class="icon-btn" data-settings title="${t('settings')}">${icon('gear')}</button><span class="logo"><span class="brandmark" aria-hidden="true"></span><span class="wordmark" role="img" aria-label="Streyn"></span></span>${discordBtn('side-discord')}</div>
      <nav class="side-nav">${nav('home', 'home', t('home'))}${nav('search', 'search', t('search'))}${nav('library', 'library', t('library'))}${nav('likes', 'heart', t('likes'))}${nav('queue', 'queue', t('queue'))}</nav>
      <div class="side-head">${t('playlists')}<button class="icon-btn sm" data-newpl title="${t('newPlaylist')}">${icon('plus')}</button></div>
      <div class="glib-head gonly"><button class="glib-tog" data-glibmin title="${t(prefs.gLibMin ? 'gShowLib' : 'gHideLib')}">${icon('libside')}<span>${t('gLibrary')}</span></button><button class="glib-create" data-gcreate title="${t('gCreate')}">${icon('plus')}<span>${t('gCreate')}</span></button><a class="icon-btn glib-open" href="#/library" title="${t('gOpenLib')}">${icon('expand')}</a></div>
      <div class="glib-chips gonly"><button class="chip" data-glibchip="playlist">${t('gChipPl')}</button><button class="chip" data-glibchip="album">${t('gChipAl')}</button><button class="chip" data-glibchip="artist">${t('gChipAr')}</button></div>
      <div id="side-playlists" class="side-pls"></div>
    </aside>
    <header class="topbar"><button class="icon-btn" data-settings title="${t('settings')}">${icon('gear')}</button><span class="logo"><span class="brandmark" aria-hidden="true"></span><span class="wordmark" role="img" aria-label="Streyn"></span></span><a class="icon-btn" href="#/queue" title="${t('queue')}">${icon('queue')}</a></header>
    <main id="content">${offlineMode ? `<div class="offbar">${icon('download')}<span id="offbar-text"><b>${t('offMode')}</b> ${t('offModeHint')}</span><button class="btn sm" data-goonline>${t('goOnline')}</button></div>` : ''}<div id="view"></div></main>
    <aside id="gpanel" class="gpanel" aria-label="${t('gNpv')}"></aside>
    <footer id="player" class="player idle">
      <div id="mini-progress"><i></i></div>
      <div class="np" id="mini">
        <div id="np-cover"></div>
        <div class="np-text"><div id="np-title" class="title"></div><div id="np-artist" class="sub"></div><div class="np-dev" data-devsheet hidden></div></div>
        <button class="icon-btn mobile-only devbtn" data-devsheet title="${t('devConnect')}">${icon('devices')}</button>
        <button class="icon-btn like" data-act="like" title="${t('like')}">${icon('heart')}</button>
        <button class="icon-btn mobile-only" data-act="toggle">${icon('play')}</button>
        <button class="icon-btn mobile-only" data-act="next">${icon('next')}</button>
      </div>
      <div class="controls desktop-only">
        <div class="buttons">
          <button class="icon-btn" data-act="shuffle" title="${t('shuffle')}">${icon('shuffle')}</button>
          <button class="icon-btn" data-act="prev" title="${t('prev')}">${icon('prev')}</button>
          <button class="playpause" data-act="toggle">${icon('play')}</button>
          <button class="icon-btn" data-act="next" title="${t('next')}">${icon('next')}</button>
          <button class="icon-btn" data-act="repeat" title="${t('repeat')}">${icon('repeat')}</button>
        </div>
        <div class="timeline"><span class="t-pos">0:00</span><input class="seek" type="range" min="0" max="1" step="0.1" value="0"><span class="t-dur">0:00</span></div>
      </div>
      <div class="extra desktop-only">
        <button class="icon-btn" data-act="viz" title="${t('viz')}">${icon('viz')}</button>
        <button class="icon-btn gonly" data-gpanel="np" title="${t('gNpv')}">${icon('npv')}</button>
        <button class="icon-btn" data-act="lyrics" title="${t('lyrics')}">${icon('lyrics')}</button>
        <button class="icon-btn" data-act="queue" title="${t('queue')}">${icon('queue')}</button>
        <button class="icon-btn devbtn" data-devsheet title="${t('devConnect')}">${icon('devices')}</button>
        <button class="icon-btn" data-act="mute" title="${t('volume')}">${icon('volume')}</button>
        <input id="vol" class="vol" type="range" min="0" max="1" step="0.01" value="1">
        <button class="icon-btn gonly" data-gmini title="${t('gMini')}">${icon('pip')}</button>
        <button class="icon-btn gonly" data-gfull title="${t('gFull')}">${icon('fullscreen')}</button>
      </div>
    </footer>
    <div class="gconnect gonly" hidden>${icon('speaker')}<span></span></div>
    <nav class="bottomnav"><i class="navblob"></i>${nav('home', 'home', t('home'))}${nav('search', 'search', t('search'))}${nav('library', 'library', t('library'))}</nav>
  </div>
  <div id="fs" class="fs">
    <div class="fs-top"><button class="icon-btn" data-act="close-fs">${icon('down')}</button><span class="muted small">${t('nowPlaying')}</span><span class="fs-topr"><button class="icon-btn" data-act="chill" id="fs-chill" title="${t('chill')}" ${prefs.chill ? '' : 'hidden'}>${icon('expand')}</button><button class="icon-btn" data-act="menu">${icon('more')}</button></span></div>
    <div id="fs-cover" class="fs-cover"></div>
    <div class="fs-meta"><div><div id="fs-title" class="title"></div><div id="fs-artist" class="sub"></div></div><button class="icon-btn like" data-act="like">${icon('heart')}</button></div>
    <div class="timeline"><input class="seek" type="range" min="0" max="1" step="0.1" value="0"><div class="times"><span class="t-pos">0:00</span><span class="t-dur">0:00</span></div></div>
    <div class="fs-buttons">
      <button class="icon-btn" data-act="shuffle">${icon('shuffle')}</button>
      <button class="icon-btn lg" data-act="prev">${icon('prev')}</button>
      <button class="playpause xl" data-act="toggle">${icon('play')}</button>
      <button class="icon-btn lg" data-act="next">${icon('next')}</button>
      <button class="icon-btn" data-act="repeat">${icon('repeat')}</button>
    </div>
    <button class="fs-dev" data-devsheet>${icon('devices')}<span></span></button>
    <div class="fs-bottom"><button class="btn ghost" data-act="viz">${icon('viz')}${t('viz')}</button><button class="btn ghost" data-act="lyrics">${icon('lyrics')}${t('lyrics')}</button><button class="btn ghost" data-act="queue">${icon('queue')}${t('queue')}</button></div>
    <div id="fs-queue" class="fs-queue"></div>
    <div id="fs-lyrics" class="fs-queue fs-lyrics"><div class="lyrbody"></div></div>
  </div>
  <div id="scrim" class="scrim"></div>
  <aside id="settings" class="settings" role="dialog" aria-label="${t('settings')}"><div class="set-top"><div class="set-head"><button class="icon-btn" data-closesettings title="${t('close')}">${icon('back')}</button><h2>${t('settings')}</h2></div><div class="searchbar set-search">${icon('search')}<input id="setq" type="search" placeholder="${t('settingsSearch')}" autocomplete="off"></div><nav id="setnav" class="setnav"></nav></div><div id="settings-body"></div></aside>`;
  if (player) {
    renderPlayer();
    renderState();
  }
  renderSidebarPlaylists();
  paintDevice();
  watchFsCover();
  gSync();
}

// offline with nothing downloaded: keep the normal app, but say so in the bar
async function offlineEmptyNote() {
  const pls = await api('GET', '/api/playlists').catch(() => null);
  const el = document.getElementById('offbar-text');
  if (!el || !Array.isArray(pls) || pls.length) return;
  el.innerHTML = `<b>${t('offMode')}</b> ${t('offEmpty')}`;
  el.closest('.offbar')?.classList.add('empty');
}

function startApp() {
  document.body.classList.remove('auth');
  if (!player) {
    player = new Player();
    player.autoplay = prefs.autoplay;
    player.setVolume(prefs.volume ?? 1);
    if (prefs.eq) player.setEq(prefs.eq);
    player.setOptions(playOptions());
    buildShell();
    bindPlayer();
  } else buildShell();
  renderPlayer();
  if (offlineMode) offlineEmptyNote();
  loadSettings()
    .then(async () => {
      // the playlists in the sidebar in the order kept in the account
      if (settings.plOrder?.length) renderSidebarPlaylists();
      if (SMODES.includes(settings.searchIn)) prefs.searchIn = settings.searchIn;
      if (Array.isArray(settings.cols)) prefs.cols = settings.cols;
      // the account's language wins, so it survives reinstalls and other addresses (home / on the go)
      if (settings.langChosen && (settings.lang === 'de' || settings.lang === 'en') && settings.lang !== prefs.lang && !nativeLang) {
        prefs.lang = settings.lang;
        prefs.langChosen = true;
        savePrefs();
        try {
          window.MusikAndroid?.setLang?.(prefs.lang);
        } catch {}
        applyPrefs();
        buildShell();
      } else if (!settings.langChosen && prefs.langChosen) saveSettings({ lang: prefs.lang, langChosen: true }).catch(() => {});
      await spotify.finishLogin().catch(() => false);
      loadExtLikes().then(() => renderPlayer());
      setTimeout(() => autoUpdateCheck(), 4000);
      setTimeout(() => updateFlow().catch(() => {}), 1500);
      if (!settings.setupDone && !state.joined && !/^#\/(welcome|join)\b/.test(location.hash) && !['welcome', 'join'].includes(state.route)) go('#/welcome');
      else render();
    })
    .catch(() => render());
  get('/api/me')
    .then((u) => {
      conn.user = u;
      saveConn();
      paintAvatars();
    })
    .catch(() => {});
}

setUnauthorizedHandler(() => {
  if (conn.token) logout();
});

async function boot() {
  // an invitation from a public link hands over the new session: #/join/<token>?auth=<session>
  const handoff = location.hash.match(/[?&]auth=([0-9a-f]{64})/);
  if (handoff) {
    conn.token = handoff[1];
    conn.server = location.origin;
    conn.user = null;
    saveConn();
    history.replaceState(null, '', location.pathname + location.hash.replace(/[?&]auth=[0-9a-f]{64}/, ''));
  }
  // fast start: who am I is asked at the same time as the check of the server
  const meEarly = conn.server && conn.token && conn.server === location.origin ? api('GET', '/api/me', undefined, { timeout: 8000 }) : null;
  meEarly?.catch(() => {});
  sameOrigin = await detectSameOrigin();
  if (sameOrigin) conn.server = sameOrigin;
  if (sameOrigin) {
    const info = sameInfo || (await api('GET', '/api/info', undefined, { token: null, timeout: 4000 }).catch(() => null));
    if (info?.offline) {
      offlineMode = true;
      document.documentElement.classList.add('offline-mode');
      if (!conn.token) {
        const s = await api('POST', '/api/offline/session', {}, { token: null }).catch(() => null);
        if (s?.token) Object.assign(conn, { token: s.token, user: s.user });
        saveConn();
      }
    }
  }
  if (conn.server && conn.token) {
    try {
      conn.user = await (meEarly && !offlineMode ? meEarly : api('GET', '/api/me', undefined, { timeout: 8000 }));
      saveConn();
      return startApp();
    } catch (e) {
      if (e.status !== 401) return showLogin(t('serverUnreachable'));
      conn.token = null;
      saveConn();
    }
  }
  showLogin();
}

// the loading animation of index.html fades once the app (or the sign-in) stands
boot().finally(() => {
  const b = document.getElementById('boot');
  if (!b) return;
  b.classList.add('out');
  setTimeout(() => b.remove(), 400);
});
