import { conn, saveConn, normalizeServer, detectSameOrigin, api, get, post, put, del, coverUrl, upload, setUnauthorizedHandler, ApiError, extCovers } from './api.js';
import { LOGOS } from './logos.js';
import { Player, EQ_FREQS } from './player.js';
import { settings, loadSettings, saveSettings, enabled, SOURCES, spotify, fetchLink, parseFile, saveImport, spotifyPlaylist, spotifyLiked, playableItems, searchYouTube, searchSpotify, searchSpotifyAll, searchYouTubeFree, searchYouTubeMusic, spotifyArtist, spotifyAlbum, extTrack } from './sources.js';
import { placeStage } from './engines.js';
import { Visualizer, VIZ_MODES } from './viz.js';
import { t, setLang, getLang } from './i18n.js';
import { icon } from './icons.js';
import { colorFromUrl } from './dyncolor.js';

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
function applyPrefs() {
  setLang(prefs.lang);
  document.documentElement.dataset.accent = prefs.accent;
  document.documentElement.dataset.theme = prefs.theme === 'glass' ? 'glass' : 'default';
  window.MusikAndroid?.setAccent?.(prefs.accent);
}
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
const THEMES = ['default', 'glass'];
function themePicker() {
  const cur = prefs.theme === 'glass' ? 'glass' : 'default';
  return `<div class="themes">${THEMES.map(
    (k) => `<button type="button" class="themeopt ${k === cur ? 'on' : ''}" data-theme-pick="${k}"><span class="themeprev ${k}"><i></i><i></i><i></i><b></b></span><span class="themename">${t('theme_' + k)}</span></button>`
  ).join('')}</div>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-pick]');
  if (!b) return;
  prefs.theme = b.dataset.themePick;
  savePrefs();
  applyPrefs();
  document.querySelectorAll('.themeopt').forEach((x) => x.classList.toggle('on', x.dataset.themePick === prefs.theme));
  requestAnimationFrame(() => {
    navBlob.place(false);
    glassPanes.scan();
  });
});

// ---------- Liquid Glass: light bends at the rim of a pane ----------
// backdrop-filter with an SVG filter exists in Chromium only (Android app, Windows app, Chrome, Edge); elsewhere the glass is frosted without the bend
const LENS_OK = /Chrome\//.test(navigator.userAgent);
/** Builds (or rebuilds) the SVG filter `id` for a pane of w x h with corner radius r: a displacement map that pushes
 *  what lies under the rim towards the middle, the way thick glass does, optionally split by colour. */
function lensFilter(id, w, h, r, bezel, scale, split = false) {
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
        m = tt * tt * tt * (3 - 2 * tt); // steep at the very edge, flat towards the middle
      }
      const i = (py * W + px) * 4;
      d8[i] = 128 - nx * m * 127;
      d8[i + 1] = 128 - ny * m * 127;
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
    ? pass('r', 1.12, '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0') + pass('g', 1, '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0') + pass('b', 0.88, '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0') + '<feBlend in="r" in2="g" mode="screen" result="rg"/><feBlend in="rg" in2="b" mode="screen"/>'
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
  const PANES = [['.bottomnav', 'nav', 9], ['.player', 'player', 9], ['.toast', 'toast', 6], ['.menu', 'menu', 8]];
  const sizes = new Map();
  let ro = null;
  const fit = (el, key, frost) => {
    if (document.documentElement.dataset.theme !== 'glass' || !LENS_OK) return void (el.style.backdropFilter = '');
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) return;
    const sig = `${w}x${h}`;
    if (sizes.get(key) !== sig) {
      sizes.set(key, sig);
      lensFilter('lg-' + key, w, h, parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, 14, 34);
    }
    el.style.backdropFilter = `url(#lg-${key}) blur(${frost}px) saturate(1.7) brightness(1.05)`;
  };
  const scan = () => {
    ro ||= new ResizeObserver(scan);
    for (const [sel, key, frost] of PANES) {
      const el = document.querySelector(sel);
      if (!el) continue;
      ro.observe(el);
      fit(el, key, frost);
    }
  };
  new MutationObserver((list) => {
    if (list.some((m) => [...m.addedNodes].some((n) => n.classList?.contains('menu') || n.classList?.contains('shell')))) scan();
  }).observe(document.body, { childList: true, subtree: true });
  return { scan };
})();
// ---------- tab bar with a glass blob that can be dragged from tab to tab ----------
const navBlob = (() => {
  let nav = null, blob = null, x = 0, v = 0, target = 0, w = 0, raf = 0, last = 0, drag = null, hover = -1;
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
    lensFilter('lg-lens', w, h, h / 2, Math.min(11, h * 0.22), 15, true);
    document.documentElement.classList.add('lg-refract');
  };
  const place = (animate = true) => {
    nav = document.querySelector('.bottomnav');
    blob = nav?.querySelector('.navblob');
    if (!blob || !nav.offsetWidth) return;
    const list = items();
    const nw = Math.min(list[0].offsetWidth - 10, 132);
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
  return { place };
})();
// Colours from the current cover: the accent when "From cover" is picked, the background tint when dynamic colours are on
let dynFor = null;
const ACCENT_VARS = ['--accent', '--accent-ink', '--accent2'];
function applyDyn(tr, force = false) {
  const root = document.documentElement;
  const wantAccent = prefs.accent === 'cover';
  const clear = () => {
    root.classList.remove('dyn');
    [...ACCENT_VARS, '--dyn-bg'].forEach((k) => root.style.removeProperty(k));
  };
  const id = (prefs.dynamic || wantAccent) && tr ? tr.id : null;
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
    } else ACCENT_VARS.forEach((k) => root.style.removeProperty(k));
    if (prefs.dynamic) {
      root.style.setProperty('--dyn-bg', p.bg);
      root.classList.add('dyn');
    } else {
      root.style.removeProperty('--dyn-bg');
      root.classList.remove('dyn');
    }
  });
}
applyPrefs();

let player = null;
let viz = null;
let sameOrigin = null;
let state = { route: '', cache: {} };

// ---------- helpers ----------
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
function artistName(tr) {
  return tr.artist || tr.album_artist || t('unknownArtist');
}
function coverImg(id, cls = '') {
  if (!id) return `<div class="cover ${cls} ph">${icon('note')}</div>`;
  return `<div class="cover ${cls}"><img loading="lazy" alt="" src="${coverUrl(id)}" onerror="this.parentNode.classList.add('ph');this.parentNode.innerHTML='${icon('note').replace(/"/g, '&quot;')}'"></div>`;
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
function menu(anchor, items) {
  closeMenu();
  const m = document.createElement('div');
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
  setTimeout(() => addEventListener('mousedown', outside), 0);
  function outside(e) {
    if (!m.contains(e.target)) closeMenu();
  }
  m._outside = outside;
}
function closeMenu() {
  const m = $('.menu');
  if (m) {
    removeEventListener('mousedown', m._outside);
    m.remove();
  }
}

async function pickPlaylist(tracks) {
  const lists = await get('/api/playlists');
  const items = lists.map((p) => ({
    label: p.name,
    icon: 'queue',
    run: async () => {
      await post(`/api/playlists/${p.id}/tracks`, { trackIds: tracks.map((x) => x.id) });
      toast(t('addedTo', { name: p.name }));
    }
  }));
  items.push('-', {
    label: t('newPlaylist'),
    icon: 'plus',
    run: async () => {
      const r = await dialog({ title: t('newPlaylist'), fields: [{ name: 'name', label: t('playlistName') }], ok: t('create') });
      if (!r?.name?.trim()) return;
      await post('/api/playlists', { name: r.name.trim(), trackIds: tracks.map((x) => x.id) });
      toast(t('addedTo', { name: r.name.trim() }));
      state.cache.playlists = null;
      renderSidebarPlaylists();
    }
  });
  return items;
}

function trackMenu(anchor, tr, ctx = {}) {
  const items = [
    { label: t('playNext'), icon: 'next', run: () => (player.playNext([tr]), toast(t('playsNext'))) },
    { label: t('addQueue'), icon: 'queue', run: () => (player.add([tr]), toast(t('addedQueue'))) },
    {
      label: t('addPlaylist'),
      icon: 'plus',
      run: async () => menu(anchor, await pickPlaylist([tr]))
    },
    !tr.ext && { label: t('startRadio'), icon: 'radio', run: () => startRadio(tr) },
    !tr.ext && { label: t('share'), icon: 'share', run: () => shareThing('track', tr.id, tr.title) },
    tr.ext?.url && { label: t('openOn', { src: t('src_' + tr.ext.source) }), icon: 'link', run: () => window.open(tr.ext.url, '_blank', 'noopener') },
    '-',
    tr.artist && !tr.ext && { label: t('goArtist'), icon: 'user', run: () => go(`#/artist?name=${encodeURIComponent(tr.artist)}`) },
    tr.artist && tr.ext && { label: t('goArtist'), icon: 'user', run: () => go(`#/search?q=${encodeURIComponent(tr.artist.split(',')[0].trim())}`) },
    tr.album && !tr.ext && {
      label: t('goAlbum'),
      icon: 'album',
      run: () => go(`#/album?album=${encodeURIComponent(tr.album)}&artist=${encodeURIComponent(tr.album_artist || tr.artist)}`)
    },
    ctx.queueIndex != null && { label: t('removeQueue'), icon: 'close', run: () => player.removeAt(ctx.queueIndex) },
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

async function startRadio(tr) {
  try {
    const list = await get(`/api/recommend/radio/${tr.id}?limit=40`);
    player.playList([tr, ...list], 0);
    toast(t('radioStarted'));
  } catch (e) {
    toast(errorText(e));
  }
}

async function toggleLike(tr) {
  if (tr.ext || tr._off) return;
  const liked = !tr.liked;
  try {
    if (liked) await put(`/api/likes/${tr.id}`);
    else await del(`/api/likes/${tr.id}`);
    tr.liked = liked;
    player.patch(tr.id, { liked });
    document.querySelectorAll(`[data-like="${tr.id}"]`).forEach((b) => {
      b.classList.toggle('on', liked);
      b.innerHTML = icon(liked ? 'heartFill' : 'heart');
      b.title = liked ? t('unlike') : t('like');
    });
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
function trackList(tracks, { numbers = false, album = true, reasons = false, playlistId = null } = {}) {
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
  const full = ['40px', 'minmax(0, 3fr)', showAlb && 'minmax(0, 2fr)', ...extra.map((k) => w[k]), '36px', c.has('duration') && '52px', '36px'].filter(Boolean).join(' ');
  const mid = ['40px', 'minmax(0, 1fr)', '36px', c.has('duration') && '52px', '36px'].filter(Boolean).join(' ');
  return `<div class="tracks ${c.has('cover') ? '' : 'nocover'}" style="--cols:${full};--cols-mid:${mid}" data-list="${id}" ${playlistId ? `data-playlist="${playlistId}"` : ''}>${tracks
    .map((tr, i) => {
      const reason = reasons && tr.reason ? `<span class="reason">${esc(t('reason_' + tr.reason, { artist: artistName(tr) }))}</span>` : '';
      const src = tr.ext?.source || tr._src;
      const side = tr.ext || tr._off
        ? `<span class="like-slot">${c.has('source') ? srcBadge(src) : ''}</span>`
        : `<button class="icon-btn like ${tr.liked ? 'on' : ''}" data-like="${tr.id}" title="${tr.liked ? t('unlike') : t('like')}">${icon(tr.liked ? 'heartFill' : 'heart')}</button>`;
      const lead = numbers || !c.has('cover') ? `<span class="num">${(numbers && tr.track_no) || i + 1}</span>` : coverImg(tr.id, 'sm');
      const sub = [c.has('artist') ? esc(artistName(tr)) : '', reason].filter(Boolean).join(' · ');
      const xc = { year: tr.year || '', genre: esc(tr.genre || ''), added: tr.added ? fmtDate(tr.added) : '' };
      return `<div class="row ${tr.id === cur ? 'current' : ''} ${tr._off ? 'off' : ''}" data-i="${i}" data-id="${esc(String(tr.id))}">
        <div class="lead">${lead}<button class="playbtn" title="${t('play')}">${icon('play')}</button></div>
        <div class="main"><div class="title">${esc(tr.title)}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
        ${showAlb ? `<div class="alb">${esc(tr.album || '')}</div>` : ''}
        ${extra.map((k) => `<div class="alb xcol">${xc[k]}</div>`).join('')}
        ${side}
        ${c.has('duration') ? `<div class="dur">${fmtTime(tr.duration)}</div>` : ''}
        <button class="icon-btn more" title="…">${icon('more')}</button>
      </div>`;
    })
    .join('')}</div>`;
}

document.addEventListener('click', (e) => {
  const row = e.target.closest('.tracks .row');
  if (!row) return;
  const listEl = row.closest('.tracks');
  const tracks = state.lists?.[listEl.dataset.list];
  if (!tracks) return;
  const i = Number(row.dataset.i);
  const tr = tracks[i];
  if (tr._off) return toast(t('notAvailable', { src: t('src_' + tr._src) }));
  if (e.target.closest('.like')) return toggleLike(tr);
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
    const url = (conn.server || location.origin) + r.path;
    if (window.MusikAndroid?.share) return window.MusikAndroid.share(title, url);
    if (navigator.share) {
      try {
        return await navigator.share({ title, text: t('shareText', { title }), url });
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    if (await copyText(url)) toast(t('linkCopied'));
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
  if (e.target.closest('[data-tbsearch]')) {
    go('#/search');
    setTimeout(() => $('#q')?.focus(), 60);
  }
});

// ---------- profile panel (tap the picture, like Spotify on the phone) ----------
function openProfile() {
  closeProfile();
  const name = (conn.user && conn.user.name) || '';
  const initial = esc(name.trim().charAt(0).toUpperCase() || '?');
  const wrap = document.createElement('div');
  wrap.className = 'profile-wrap';
  const item = (attr, ic, label) => `<button ${attr}>${icon(ic)}<span>${label}</span></button>`;
  wrap.innerHTML = `<aside class="profile" role="dialog" aria-label="${t('profile')}">
    <div class="pf-head"><span class="avatar big">${initial}</span><div><b>${esc(name)}</b><a class="muted small" href="#/library">${t('library')}</a></div></div>
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
  });
}
function closeProfile() {
  const w = $('.profile-wrap');
  if (!w) return;
  w.classList.remove('open');
  setTimeout(() => w.remove(), 200);
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-profile]')) openProfile();
});

function pageHead(title, extra = '') {
  const initial = esc(((conn.user && conn.user.name) || '?').trim().charAt(0).toUpperCase() || '?');
  return `<div class="mhead"><button class="avatar" data-profile title="${t('profile')}">${initial}</button><h1>${title}</h1>${extra}</div>`;
}
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
    colorFromUrl(url).then((c) => { if (c) { el.style.setProperty('--tint', c.bg); el.style.setProperty('--tint2', c.accent); el.classList.add('tinted'); } });
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
  extHistory().forEach((x, i) => add(x.artist, Math.max(1, 6 - i / 10)));
  if (score.size < 3) {
    const imps = await get('/api/imports').catch(() => []);
    for (const im of imps.slice(0, 3)) {
      const r = await get('/api/imports/' + im.id).catch(() => null);
      r?.items?.slice(0, 40).forEach((x) => add(x.artist, 1));
    }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]).slice(0, 4);
}
async function forYouSections(h) {
  const names = await favouriteArtists(h);
  if (!names.length) return '';
  const r = await get('/api/catalog/foryou?artists=' + encodeURIComponent(names.join('|'))).catch(() => null);
  if (!r) return '';
  let html = '';
  for (const row of r.rows || []) {
    const tracks = row.tracks.map(extTrack);
    html += section(t('becauseYouListen', { name: row.because }), trackCards(tracks, 'fy' + Math.random().toString(36).slice(2, 7)));
  }
  if (r.artists?.length) html += section(t('suggestedArtists'), artistCards(r.artists.map(catArtist), true));
  return html;
}

views.home = async () => {
  const [h, lib] = await Promise.all([get('/api/home'), get('/api/library')]);
  const recentExt = extHistory().slice(0, 12).map(histTrack);
  if (!lib.tracks) {
    // no own files yet: suggestions from Spotify / YouTube listening instead of an empty page
    let html = pageHead(greeting());
    if (recentExt.length) html += section(t('recent'), trackCards(recentExt, 'recentext'));
    const fol = await loadFollows(true);
    if (fol.length) html += section(t('followedArtists'), artistCards(fol.map(followCard), true));
    const fy = await forYouSections(null);
    html += fy || `<div class="emptystate">${icon('note', 'big')}<p>${t('emptyStart')}</p><div class="stack"><a class="btn primary" href="#/search">${icon('search')}${t('search')}</a><a class="btn" href="#/add">${icon('download')}${t('importAdd')}</a><button class="btn" data-upload>${icon('upload')}${t('upload')}</button></div></div>`;
    return html;
  }
  state.homeMix = h.mix;
  // quick tiles: the mix plus albums played lately and new ones
  const quick = [];
  const seenAlb = new Set();
  for (const x of [...h.recent.map((tr) => ({ album: tr.album, artist: tr.album_artist || tr.artist, cover_id: tr.id })), ...h.newAlbums]) {
    const k = (x.album || '').toLowerCase();
    if (!x.album || seenAlb.has(k)) continue;
    seenAlb.add(k);
    quick.push(x);
  }
  let html = pageHead(greeting());
  html += `<div class="quick"><button class="qt" data-playmix><div class="cover accent">${icon('mix')}</div><span>${t('mixForYou')}</span></button>${quick
    .slice(0, 7)
    .map((a) => `<a class="qt" href="${albumHref(a.album, a.artist)}">${coverImg(a.cover_id)}<span>${esc(a.album)}</span></a>`)
    .join('')}</div>`;
  html += `<div class="hero">
    <div class="hero-text"><h1>${t('mixForYou')}</h1><p class="muted">${h.cold ? t('coldHint') : esc(h.mix.slice(0, 4).map(artistName).filter((v, i, a) => a.indexOf(v) === i).join(', '))}</p></div>
    <button class="btn primary" data-playmix>${icon('play')}${t('playAll')}</button></div>`;
  html += `<section class="sec home-mix"><div class="sec-head m-only"><h2>${t('mixForYou')}</h2><button class="playcircle" data-playmix title="${t('playAll')}">${icon('play')}</button></div>${trackList(h.mix, { reasons: true })}</section>`;
  const recentAll = [...h.recent, ...recentExt].slice(0, 14);
  if (recentAll.length) html += section(t('recent'), trackCards(recentAll, 'recent'));
  const fol = await loadFollows(true);
  if (fol.length) html += section(t('followedArtists'), artistCards(fol.map(followCard), true));
  html += await forYouSections(h).catch(() => '');
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
};

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-playmix]')) {
    try {
      const mix = await get('/api/recommend/mix?limit=60');
      player.playList(mix, 0);
    } catch (err) {
      toast(errorText(err));
    }
  }
  if (e.target.closest('[data-upload]')) pickUpload();
});

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
views.cartist = async (params) => {
  const r = await get('/api/catalog/artist/' + encodeURIComponent(params.get('id') || ''));
  const a = catArtist(r.artist);
  await loadFollows();
  const tracks = (r.tracks || []).map(extTrack);
  state.detail = { cartist: tracks };
  let html = detailHeader({ coverId: a.cover, round: true, kind: t('artist'), title: a.name, sub: r.artist.fans ? t('fans', { n: r.artist.fans.toLocaleString() }) : '', actions: (tracks.length ? listActions('cartist') : '') + followBtn('deezer', params.get('id') || '', a.name, r.artist.picture) });
  if (tracks.length) html += section(t('top'), trackList(tracks), `<span class="muted small">${t('catalogHint')}</span>`);
  if (r.albums?.length) html += section(t('albums'), plainAlbumCards(r.albums.map(catAlbum)));
  return html;
};
views.calbum = async (params) => {
  const r = await get('/api/fetch/deezer?type=album&id=' + encodeURIComponent(params.get('id') || ''));
  const tracks = (r.items || []).map(extTrack);
  const cid = 'dzalbum:' + params.get('id');
  if (r.cover) extCovers.set(cid, r.cover);
  state.detail = { calbum: tracks };
  let html = detailHeader({ coverId: cid, kind: t('album'), title: r.name, sub: `${esc(tracks[0]?.artist || '')} · ${songCount(tracks.length)}`, actions: tracks.length ? listActions('calbum') : '' });
  html += section(t('tracks'), trackList(tracks, { numbers: true }), `<span class="muted small">${t('catalogHint')}</span>`);
  return html;
};
views.spartist = async (params) => {
  const r = await spotifyArtist(params.get('id') || '');
  const a = spArtist(r.artist);
  await loadFollows();
  const tracks = r.tracks.map(extTrack);
  state.detail = { spartist: tracks };
  const sub = [r.artist.followers ? t('followersN', { n: r.artist.followers.toLocaleString() }) : '', r.artist.genres.slice(0, 3).join(', ')].filter(Boolean).join(' · ');
  let html = detailHeader({ coverId: a.cover, round: true, kind: t('artist'), title: a.name, sub: `${srcBadge('spotify')} ${esc(sub)}`, actions: (tracks.length ? listActions('spartist') : '') + followBtn('spotify', params.get('id') || '', a.name, r.artist.picture) });
  if (tracks.length) html += section(t('top'), trackList(tracks));
  if (r.albums.length) html += section(t('albums'), plainAlbumCards(r.albums.map(spAlbum)));
  return html;
};
views.spalbum = async (params) => {
  const id = params.get('id') || '';
  const r = await spotifyAlbum(id);
  const tracks = r.items.map(extTrack);
  const cid = 'spalbum:' + id;
  if (r.cover) extCovers.set(cid, r.cover);
  state.detail = { spalbum: tracks };
  const total = tracks.reduce((n, x) => n + (x.duration || 0), 0);
  const who = r.artistId ? `<a href="#/spartist?id=${r.artistId}"><b>${esc(r.artist)}</b></a>` : `<b>${esc(r.artist)}</b>`;
  let html = detailHeader({ coverId: cid, kind: t('album'), title: r.name, sub: `${srcBadge('spotify')} ${who}${r.year ? ' · ' + r.year : ''} · ${songCount(tracks.length)}, ${fmtLong(total)}`, actions: tracks.length ? listActions('spalbum') : '' });
  html += trackList(tracks, { numbers: true });
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
    actions: listActions('sppl') + `<button class="btn" data-spsave>${icon('plus')}${t('saveToLibrary')}</button>`
  }) + trackList(tracks);
};
document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-spsave]') || !state.spPending) return;
  const r = state.spPending;
  try {
    importStatus(t('importMatching', { n: r.items.length }));
    const res = await saveImport({ source: 'spotify', name: r.name, url: r.url, cover: r.cover || '', meta: r.meta || {}, items: r.items });
    importStatus(null);
    renderSidebarPlaylists();
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
    body = `<div class="toolbar"><button class="btn primary" data-playlib>${icon('play')}${t('playAll')}</button><button class="btn" data-shufflelib>${icon('shuffle')}${t('shuffle')}</button>
      <span class="muted">${songCount(r.total)}</span>
</div>
      <div class="sortrow"><span class="muted small">${t('sortBy')}</span>${['artist', 'title', 'album', 'added'].map((s) => `<a class="chip ${s === sort ? 'on' : ''}" href="#/library?tab=tracks&sort=${s}">${{ artist: t('artist'), title: t('sortTitle'), album: t('album'), added: t('added') }[s]}</a>`).join('')}</div>
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
    const list = await get('/api/imports');
    body = `<div class="toolbar"><a class="btn primary" href="#/add">${icon('download')}${t('importAdd')}</a><a class="btn" href="#/sources">${t('manageSources')}</a></div>
      ${list.length ? `<div class="cards libgrid"> ${list.map((im) => `<a class="card" data-ref="import:${im.id}" href="#/imported/${im.id}">${im.art ? coverImg(artKey('import', im.id, im.art), 'lg') : im.cover ? `<div class="cover lg"><img loading="lazy" alt="" src="${esc(im.cover)}"></div>` : coverImg(im.cover_id, 'lg')}<div class="c-title">${esc(im.name)}</div><div class="c-sub">${srcBadge(im.source)} ${t('importedOf', { local: im.matched, total: im.total })}</div></a>`).join('')}</div>` : `<p class="muted empty">${t('importNone')}</p>`}`;
  } else {
    const lists = await get('/api/playlists');
    body = `<div class="toolbar"><button class="btn" data-newpl>${icon('plus')}${t('newPlaylist')}</button></div>
      <div class="cards libgrid"><a class="card" href="#/likes"><div class="cover lg ph accent">${icon('heartFill')}</div><div class="c-title">${t('likes')}</div></a>
      ${lists.map((p) => `<a class="card" data-ref="playlist:${p.id}" href="#/playlist/${p.id}">${coverImg(artKey('playlist', p.id, p.art) || p.cover_id, 'lg')}<div class="c-title">${esc(p.name)}</div><div class="c-sub">${songCount(p.tracks)}</div></a>`).join('')}</div>`;
  }
  return `${pageHead(t('yourLibrary'), `<button class="icon-btn" data-newpl title="${t('newPlaylist')}">${icon('plus')}</button>`)}<div class="tabs">${LIB_TABS.map((x) => `<a class="tab ${x === tab ? 'on' : ''}" href="#/library?tab=${x}">${t(x)}</a>`).join('')}</div>${body}`;
};
document.addEventListener('change', (e) => {
  if (e.target.id === 'sort') go(`#/library?tab=tracks&sort=${e.target.value}`);
});
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-playlib]') && state.libTracks) player.playList(state.libTracks, 0);
  if (e.target.closest('[data-shufflelib]') && state.libTracks) player.playList(state.libTracks, 0, { shuffle: true });
  if (e.target.closest('[data-newpl]')) {
    const r = await dialog({ title: t('newPlaylist'), fields: [{ name: 'name', label: t('playlistName') }], ok: t('create') });
    if (r?.name?.trim()) {
      const p = await post('/api/playlists', { name: r.name.trim() });
      renderSidebarPlaylists();
      go('#/playlist/' + p.id);
    }
  }
});

function detailHeader({ coverId, kind, title, sub, round = false, actions = '' }) {
  return `<button class="mback" data-back title="${t('back')}">${icon('back')}</button><div class="detail-head" ${coverId ? `data-tint="${coverUrl(coverId)}"` : ''}>${coverImg(coverId, 'xl' + (round ? ' round' : ''))}<div class="dh-text"><div class="muted kind">${esc(kind)}</div><h1>${esc(title)}</h1><div class="muted">${sub}</div>
    <div class="toolbar">${actions}</div></div></div>`;
}

function listActions(key) {
  return `<button class="btn primary" data-playkey="${key}">${icon('play')}${t('playAll')}</button><button class="btn" data-shufflekey="${key}">${icon('shuffle')}${t('shuffle')}</button>`;
}
document.addEventListener('click', (e) => {
  const p = e.target.closest('[data-playkey]');
  const s = e.target.closest('[data-shufflekey]');
  const key = p?.dataset.playkey || s?.dataset.shufflekey;
  if (!key) return;
  const list = state.detail?.[key];
  if (list?.length) player.playList(list, 0, { shuffle: !!s });
});

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
    }) + trackList(r.tracks, { numbers: true, album: false })
  );
};

views.artist = async (params) => {
  const r = await get(`/api/artist?name=${encodeURIComponent(params.get('name') || '')}`);
  await loadFollows();
  state.detail = { artist: r.tracks };
  const albums = [];
  const seen = new Set();
  for (const x of r.tracks) {
    if (!x.album || seen.has(x.album.toLowerCase())) continue;
    seen.add(x.album.toLowerCase());
    albums.push({ album: x.album, artist: x.album_artist || x.artist, year: x.year, cover_id: x.id });
  }
  let html = detailHeader({
    coverId: r.tracks[0]?.id,
    round: true,
    kind: t('artist'),
    title: r.name,
    sub: songCount(r.tracks.length),
    actions: listActions('artist') + `<button class="btn" data-radioartist>${icon('radio')}${t('startRadio')}</button>` + followBtn('local', r.name, r.name, r.tracks[0]?.id || '')
  });
  html += section(t('top'), trackList(r.top));
  if (albums.length) html += section(t('albums'), albumCards(albums));
  html += section(t('tracks'), trackList(r.tracks));
  return html;
};
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-radioartist]') && state.detail?.artist?.length) {
    const list = state.detail.artist;
    startRadio(list[Math.floor(Math.random() * list.length)]);
  }
});

views.likes = async () => {
  const tracks = await get('/api/likes');
  state.detail = { likes: tracks };
  return (
    detailHeader({ coverId: null, kind: t('playlist'), title: t('likes'), sub: songCount(tracks.length), actions: listActions('likes') }).replace(
      'cover xl ph',
      'cover xl ph accent'
    ) + trackList(tracks)
  );
};

views.playlist = async (params, id) => {
  const pl = await get(`/api/playlists/${id}`);
  state.detail = { pl: pl.tracks };
  return (
    detailHeader({
      coverId: artKey('playlist', pl.id, pl.art) || pl.tracks[0]?.id,
      kind: t('playlist'),
      title: pl.name,
      sub: `${songCount(pl.tracks.length)} · ${fmtTime(pl.tracks.reduce((s, x) => s + x.duration, 0))}`,
      actions: listActions('pl') + shareBtn('playlist', pl.id, pl.name) + `<button class="icon-btn" data-cmenu="playlist:${pl.id}" title="…">${icon('more')}</button>`
    }) + trackList(pl.tracks, { playlistId: pl.id })
  );
};
// ---------- sources (first start + settings) ----------
function sourcesForm(welcome) {
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
  return `${pageHead(welcome ? t('welcomeTitle') : t('sources'))}
    <p class="muted lead">${welcome ? t('welcomeText') : t('sourcesHint')}</p>
    ${welcome ? `<h2 class="wizhead">${t('themeAsk')}</h2><p class="muted small">${t('themeHint')}</p>${themePicker()}<h2 class="wizhead">${t('sources')}</h2>` : ''}
    <div class="srcgrid">${cards}</div>
    <div class="accesses">${access}</div>
    <div class="stack wizard-actions">${welcome ? `<button class="btn primary" data-wizdone>${t('welcomeDone')}</button><button class="btn ghost" data-wizskip>${t('welcomeSkip')}</button>` : `<a class="btn primary" href="#/add">${icon('download')}${t('importAdd')}</a>`}</div>`;
}
views.welcome = async () => sourcesForm(true);
views.sources = async () => sourcesForm(false);
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
  if (e.target.closest('[data-wizdone]')) {
    await saveSettings({ setupDone: true }).catch(() => {});
    const any = Object.entries(settings.sources).some(([k, v]) => v && k !== 'local');
    go(any ? '#/add' : '#/home');
  }
  if (e.target.closest('[data-wizskip]')) {
    await saveSettings({ setupDone: true, sources: { local: true } }).catch(() => {});
    go('#/home');
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
      sub: `${m.description ? `<span class="dh-desc">${esc(m.description)}</span>` : ''}${srcBadge(r.source)} ${m.owner ? `<b>${esc(m.owner)}</b> · ` : ''}${m.followers ? t('likesN', { n: m.followers.toLocaleString() }) + ' · ' : ''}${songCount(r.items.length)}${dur ? ', ' + fmtLong(dur) : ''} · ${t('importedOf', { local, total: r.items.length })}`,
      actions: listActions('imp') + shareBtn('import', r.id, r.name) + `<button class="icon-btn" data-cmenu="import:${r.id}" title="…">${icon('more')}</button>`
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
  $('#fs-queue').classList.remove('open');
  l.classList.toggle('open');
  if (l.classList.contains('open')) renderLyrics(l.querySelector('.lyrbody'));
  fsButtons();
}
// the three buttons under the big player show what is open
function fsButtons() {
  const on = (act, yes) => document.querySelector(`.fs-bottom [data-act="${act}"]`)?.classList.toggle('on', yes);
  on('viz', (prefs.viz || 'off') !== 'off');
  on('lyrics', $('#fs-lyrics').classList.contains('open'));
  on('queue', $('#fs-queue').classList.contains('open'));
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
        <div class="lead">${coverImg(tr.id, 'sm')}<button class="playbtn">${icon('play')}</button></div>
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
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === state.route));
  document.querySelector('.bottomnav')?.classList.toggle('nohome', !document.querySelector('.bottomnav a.on'));
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
    main.scrollTop = 0;
    $('#content').scrollTop = 0;
    if (state.route === 'search') {
      const q = $('#q');
      if (q) {
        if (!matchMedia('(hover: none)').matches) q.focus();
        runSearch(q.value).catch(() => {});
      }
    }
  } catch (e) {
    if (seq !== renderSeq) return;
    main.innerHTML = `<p class="muted empty">${esc(errorText(e))}</p>`;
  }
}
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
      viz?.attach(big);
    }
    $('#np-title').textContent = tr.title;
    $('#np-artist').textContent = artistName(tr);
    $('#fs-title').textContent = tr.title;
    $('#fs-artist').textContent = artistName(tr);
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
    document.title = 'Musik';
    applyDyn(null);
  }
  document.querySelectorAll('[data-act="like"]').forEach((b) => {
    b.style.visibility = tr?.ext ? 'hidden' : '';
    b.dataset.like = tr?.id || '';
    b.classList.toggle('on', !!tr?.liked);
    b.innerHTML = icon(tr?.liked ? 'heartFill' : 'heart');
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
}
function renderState() {
  document.querySelectorAll('[data-act="toggle"]').forEach((b) => {
    b.innerHTML = icon(player.playing ? 'pause' : 'play');
    b.title = player.playing ? t('pause') : t('play');
    b.classList.toggle('busy', player.buffering && player.playing);
  });
  const v = $('#vol');
  if (v) {
    if (document.activeElement !== v) v.value = player.volume;
    v.style.setProperty('--p', Number(v.value) * 100 + '%');
  }
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
  $('#mini-progress').style.width = d ? (p / d) * 100 + '%' : '0';
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
    if (e.target.id === 'vol') {
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
  document.addEventListener('click', (e) => {
    const mini = e.target.closest('#mini');
    if (!mini || e.target.closest('button') || mini.dataset.swiped) return;
    if (innerWidth < 900 && player.current) openFs(true);
  });
  player.addEventListener('change', renderPlayer);
  player.addEventListener('change', () => rememberPlay(player.current));
  player.addEventListener('state', renderState);
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
function vizSync() {
  if (!player) return;
  if (!viz) viz = new Visualizer(player);
  viz.attach($('#fs-cover'));
  const on = $('#fs').classList.contains('open') && (prefs.viz || 'off') !== 'off';
  viz.setMode(on ? prefs.viz : 'off');
  if (on) {
    player.startViz();
    viz.start();
  } else {
    player.stopViz();
    viz.stop();
  }
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
function openFs(open) {
  $('#fs').classList.toggle('open', open);
  vizSync();
  if (!open) $('#fs-queue').classList.remove('open');
  if (!open) $('#fs-lyrics').classList.remove('open');
  fsButtons();
  placeStage();
  setTimeout(placeStage, 350);
  if (open) history.pushState({ fs: 1 }, '');
}
function toggleFsQueue() {
  const q = $('#fs-queue');
  $('#fs-lyrics').classList.remove('open');
  q.classList.toggle('open');
  if (q.classList.contains('open')) q.innerHTML = queueHtml();
  fsButtons();
}
addEventListener('popstate', () => {
  if ($('#fs').classList.contains('open')) openFs(false);
});

// Android back button
window.musikBack = () => {
  if ($('.modal-wrap')) return $('.modal-wrap').remove(), true;
  if ($('.menu')) return closeMenu(), true;
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
    box.innerHTML =
      lists.map((p) => item('playlist:' + p.id, '#/playlist/' + p.id, artKey('playlist', p.id, p.art) || p.cover_id, p.name, `${t('playlist')} · ${songCount(p.tracks)}`)).join('') +
      imps.map((im) => item('import:' + im.id, '#/imported/' + im.id, artKey('import', im.id, im.art) || (im.cover ? 'impc:' + im.id : im.cover_id), im.name, `${t('src_' + im.source) === 'src_' + im.source ? t('playlist') : t('src_' + im.source)} · ${songCount(im.total)}`)).join('');
  } catch {
    box.innerHTML = '';
  }
}

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
async function changeCover(kind, id) {
  const f = await pickImage();
  if (!f) return;
  const blob = await cropImage(f);
  if (!blob) return;
  const r = await fetch(`${conn.server}/api/art/${kind}/${id}`, { method: 'PUT', headers: { Authorization: 'Bearer ' + conn.token, 'Content-Type': 'image/jpeg' }, body: blob });
  if (!r.ok) return toast(t('error'));
  toast(t('coverSaved'));
  renderSidebarPlaylists();
  render();
}

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
      {
        label: t('rename'),
        icon: 'edit',
        run: async () => {
          const r = await dialog({ title: t('rename'), fields: [{ name: 'name', label: t('playlistName'), value: name }] });
          if (!r?.name?.trim()) return;
          await put(kind === 'playlist' ? `/api/playlists/${id}` : `/api/imports/${id}`, { name: r.name.trim() });
          renderSidebarPlaylists();
          render();
        }
      },
      { label: t('changeCover'), icon: 'image', run: () => changeCover(kind, id) },
      info.art && {
        label: t('resetCover'),
        icon: 'refresh',
        run: async () => {
          await del(`/api/art/${kind}/${id}`);
          renderSidebarPlaylists();
          render();
        }
      },
      { label: t(pinned ? 'unpin' : 'pin'), icon: 'pin', run: () => togglePin(ref) },
      { label: t('share'), icon: 'share', run: () => shareThing(kind, Number(id), name) }
    ];
    if (kind === 'import') {
      items.push(
        {
          label: t('saveAsPlaylist'),
          icon: 'plus',
          run: async () => {
            const r = await post(`/api/imports/${id}/playlist`);
            renderSidebarPlaylists();
            toast(t('savedAsPlaylist', { name: r.name, n: r.tracks }));
          }
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
    items.push('-', {
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
  const ref = el.closest('[data-ref]');
  if (ref) return () => (pt) => collectionMenu(pt, ref.dataset.ref);
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
function setRow(label, control, { hint = '', keys = '', wide = false } = {}) {
  return `<div class="set-row ${wide ? 'wide' : ''}" data-k="${esc((label + ' ' + hint + ' ' + keys).toLowerCase())}"><div class="sr-text"><div class="sr-label">${label}</div>${hint ? `<div class="sr-hint">${hint}</div>` : ''}</div><div class="sr-ctl">${control}</div></div>`;
}
function setCard(id, ic, title, rows) {
  return `<section class="set-card" id="set-${id}" data-k="${esc(title.toLowerCase())}"><h3>${icon(ic)}<span>${title}</span></h3>${rows}</section>`;
}
const sw = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></label>`;
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
      setRow(t('accent'), `<div class="swatches">${accents.map((a) => `<button class="swatch ${a} ${prefs.accent === a ? 'on' : ''}" data-accent="${a}" title="${t(a)}" aria-label="${t(a)}"></button>`).join('')}</div>`, { hint: t('accentHint'), keys: 'farbe color theme cover akzent accent' }) +
      setRow(t('dynColor'), sw('dyncolor', prefs.dynamic), { hint: t('dynColorHint'), keys: t('look') }) +
      setRow(t('searchIn'), `<div class="seg">${SMODES.map((m) => `<button data-smode="${m}" class="${searchMode() === m ? 'on' : ''}">${t('smode_' + m)}</button>`).join('')}</div>`, { hint: t('searchInHint'), keys: 'search suche spotify youtube everything' }) +
      setRow(t('columns'), `<div class="colpick">${COLS.map((k) => `<button data-col="${k}" class="chip ${cols().has(k) ? 'on' : ''}">${t('col_' + k)}</button>`).join('')}</div>`, { hint: t('columnsHint'), keys: 'spalten columns artist album länge duration quelle source jahr genre', wide: true })),
    setCard('playback', 'play', t('playback'),
      setRow(t('autoplayShort'), sw('autoplay', prefs.autoplay), { hint: t('autoplay'), keys: 'autoplay radio' }) +
      setRow(t('viz'), `<select class="select" id="vizmode">${VIZ_MODES.map((m) => `<option value="${m}" ${(prefs.viz || 'off') === m ? 'selected' : ''}>${t('viz_' + m)}</option>`).join('')}</select>`, { hint: t('vizHint'), keys: 'visualizer bars ring wave' })),
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
      setRow(t('changePassword'), `<button class="btn" data-chpw>${t('change')}</button>`, { keys: 'passwort password' }) +
      setRow(t('server'), sameOrigin && !window.musikDesktop && !window.MusikAndroid ? '' : `<button class="btn" data-chserver>${t('changeServer')}</button>`, { hint: esc(conn.server), keys: 'adresse address' })),
    setCard('remote', 'radio', t('onTheGo'),
      (conn.user?.admin
        ? setRow(t('remoteAddr'), `<div class="remoteedit"><input id="remoteurl" class="textin" value="${esc(info?.remote || '')}" placeholder="http://100.x.x.x:8484" autocomplete="off" spellcheck="false" inputmode="url"><button class="btn primary" data-saveremote>${t('save')}</button>${info?.remote ? `<button class="btn" data-copyremote="${esc(info.remote)}">${t('copy')}</button>` : ''}</div>`, { hint: `${info?.remote ? t('remoteOn') : t('remoteOff')} <a href="${GUIDE}" target="_blank" rel="noopener">${t('guide')}</a>`, keys: 'tailscale unterwegs remote', wide: true })
        : info?.remote
          ? setRow(t('remoteAddr'), `<button class="btn" data-copyremote="${esc(info.remote)}">${t('copy')}</button>`, { hint: `<code class="addr">${esc(info.remote)}</code><br>${t('remoteOn')}`, keys: 'tailscale unterwegs remote' })
          : setRow(t('remoteAddr'), `<a class="btn" href="${GUIDE}" target="_blank" rel="noopener">${t('guide')}</a>`, { hint: t('remoteOff'), keys: 'tailscale unterwegs remote' }))),
    user.admin ? setCard('users', 'user', t('users'), setRow(t('users'), `<button class="btn" data-adduser>${icon('plus')}${t('addUser')}</button>`, { hint: '<span id="userlist">…</span>', keys: 'nutzer users admin konto' })) : '',
    setCard('updates', 'download', t('updates'),
      setRow(t('updates'), `<button class="btn" data-updcheck>${icon('refresh')}${t('checkUpdates')}</button>`, { wide: true, hint: '<div id="updinfo" class="upd"></div>', keys: 'update version neu' }) +
      setRow(t('playCheck'), `<button class="btn" data-playcheck>${icon('play')}${t('playCheckRun')}</button>`, { wide: true, hint: `${t('playCheckHint')}<div id="playcheck" class="upd"></div>`, keys: 'test check youtube stream wiedergabe playback prüfen' }) +
      setRow(t('allDownloads'), `<a class="btn" href="${RELEASES}" target="_blank" rel="noopener">${icon('download')}${t('allDownloads')}</a>`, { hint: 'LabtosoStudios', keys: 'apk exe appimage download' }))
  ].join('');
  const q = $('#setq')?.value || '';
  s.innerHTML = `<div class="set-cards">${cards}<p class="muted empty set-none" hidden>${t('noSettings')}</p></div>`;
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
  const row = (label, cur, avail, action) => `<div class="upd-row"><div><b>${label}</b><span class="muted small">${cur ? 'v' + esc(cur) : '–'}${latest ? avail ? ` → <span class="upd-new">v${esc(latest)}</span>` : ` · ${t('upToDate')}` : ''}</span></div>${action || ''}</div>`;
  let srvAction = '';
  if (u.available) {
    if (!u.admin) srvAction = `<span class="muted small">${t('updAdminOnly')}</span>`;
    else if (u.how === 'self') srvAction = `<button class="btn primary" data-updserver>${t('updNow')}</button>`;
    else srvAction = `<span class="muted small">${t('upd_' + u.how)}</span>`;
  }
  const appAvail = app && latest && vNewer(latest, app.v);
  box.innerHTML = row(t('updServer'), u.current, u.available, srvAction) + (app ? row(t(app.kind === 'android' ? 'updAndroid' : 'updDesktop'), app.v, appAvail, appAvail ? `<button class="btn primary" data-updapp>${t('updNow')}</button>` : '') : '') + (!latest ? `<p class="muted small">${t('updOffline')}</p>` : '') + '<div id="updprog" class="muted small"></div>';
}
async function updateServer() {
  const prog = $('#updprog');
  const before = (await api('GET', '/api/info', undefined, { token: null }).catch(() => ({}))).version;
  if (prog) prog.textContent = t('updServerRunning');
  const r = await post('/api/update');
  // the server restarts; wait until it answers with the new version
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    const v = (await api('GET', '/api/info', undefined, { token: null, timeout: 3000 }).catch(() => ({}))).version;
    if (v && v !== before) {
      toast(t('updDone', { v }));
      setTimeout(() => location.reload(), 900);
      return;
    }
  }
  if (prog) prog.textContent = t('updSlow', { v: r.to || '' });
}
function updateApp() {
  const app = appVersion();
  if (!app) return;
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
async function autoUpdateCheck() {
  let last = 0;
  try {
    last = +localStorage.getItem('musik.updcheck') || 0;
  } catch {}
  if (Date.now() - last < 20 * 3600 * 1000) return;
  try {
    localStorage.setItem('musik.updcheck', String(Date.now()));
  } catch {}
  const u = await updateStatus(false).catch(() => null);
  if (!u?.latest) return;
  const app = appVersion();
  if (u.available || (app && vNewer(u.latest, app.v))) toast(t('updNotice', { v: u.latest }));
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
  const el = e.target.closest('[data-updcheck],[data-updserver],[data-updapp],[data-lang],[data-accent],[data-scan],[data-logout],[data-chserver],[data-chpw],[data-adduser],[data-deluser],[data-settings],#scrim,[data-closesettings],[data-copyremote]');
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
    prefs.accent = el.dataset.accent;
    savePrefs();
    applyPrefs();
    applyDyn(player?.current, true);
    document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.accent === prefs.accent));
    return;
  }
  try {
    if (el.matches('[data-updcheck]')) return renderUpdates(true);
    if (el.matches('[data-updapp]')) return updateApp();
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
  const mode = !info ? 'server' : info.setup ? 'setup' : 'login';
  app.innerHTML = `<div class="auth-wrap"><form class="auth-card" novalidate>
    <div class="brand">${icon('note')}<span>Musik</span></div>
    <h2>${mode === 'setup' ? t('firstAccount') : mode === 'login' ? t('login') : t('connect')}</h2>
    ${mode === 'setup' ? `<p class="muted small">${t('firstAccountHelp')}</p>` : ''}
    ${mode === 'server' ? serverField : `${sameOrigin ? '' : `<p class="muted small srv">${esc(conn.server)} · <a href="#" data-editserver>${t('changeServer')}</a></p>`}
      <label class="field"><span>${t('name')}</span><input name="name" autocomplete="username" autocapitalize="off"></label>
      <label class="field"><span>${t('password')}</span><input name="password" type="password" autocomplete="${mode === 'setup' ? 'new-password' : 'current-password'}"></label>`}
    <p class="err">${esc(err)}</p>
    <button class="btn primary wide">${mode === 'setup' ? t('create') : mode === 'login' ? t('login') : t('connect')}</button>
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
      const r = await api('POST', mode === 'setup' ? '/api/setup' : '/api/login', body, { token: null });
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
function buildShell() {
  const nav = (key, ic, label) => `<a href="#/${key}" data-nav="${key}">${icon(ic)}<span>${label}</span></a>`;
  const frameless = !!window.musikDesktop?.frameless;
  document.documentElement.classList.toggle('frameless', frameless);
  $('#app').innerHTML = `
  ${frameless ? `<div class="titlebar" data-drag>
    <div class="tb-left"><span class="tb-logo">${icon('note')}</span><button class="tb-btn" data-hist="-1" title="${t('back')}">${icon('back')}</button><button class="tb-btn fwd" data-hist="1" title="${t('forward')}">${icon('back')}</button></div>
    <div class="tb-mid"><a class="tb-home" href="#/home" title="${t('home')}">${icon('home')}</a><button class="tb-search" data-tbsearch>${icon('search')}<span>${t('searchPlaceholder_' + searchMode())}</span></button></div>
    <div class="tb-right"><button class="tb-avatar" data-profile title="${t('profile')}">${esc(((conn.user && conn.user.name) || '?').trim().charAt(0).toUpperCase() || '?')}</button>
      <button class="tb-win" data-win="min" title="${t('minimize')}"><svg viewBox="0 0 10 10"><path d="M1 5h8"/></svg></button>
      <button class="tb-win" data-win="max" title="${t('maximize')}"><svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7"/></svg></button>
      <button class="tb-win close" data-win="close" title="${t('close')}"><svg viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg></button></div>
  </div>` : ''}
  <div class="shell">
    <aside class="side">
      <div class="side-top"><button class="icon-btn" data-settings title="${t('settings')}">${icon('gear')}</button><span class="logo">Musik</span></div>
      <nav class="side-nav">${nav('home', 'home', t('home'))}${nav('search', 'search', t('search'))}${nav('library', 'library', t('library'))}${nav('likes', 'heart', t('likes'))}${nav('queue', 'queue', t('queue'))}</nav>
      <div class="side-head">${t('playlists')}<button class="icon-btn sm" data-newpl title="${t('newPlaylist')}">${icon('plus')}</button></div>
      <div id="side-playlists" class="side-pls"></div>
    </aside>
    <header class="topbar"><button class="icon-btn" data-settings title="${t('settings')}">${icon('gear')}</button><span class="logo">Musik</span><a class="icon-btn" href="#/queue" title="${t('queue')}">${icon('queue')}</a></header>
    <main id="content"><div id="view"></div></main>
    <footer id="player" class="player idle">
      <div id="mini-progress"></div>
      <div class="np" id="mini">
        <div id="np-cover"></div>
        <div class="np-text"><div id="np-title" class="title"></div><div id="np-artist" class="sub"></div></div>
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
        <button class="icon-btn" data-act="lyrics" title="${t('lyrics')}">${icon('lyrics')}</button>
        <button class="icon-btn" data-act="queue" title="${t('queue')}">${icon('queue')}</button>
        <button class="icon-btn" data-act="mute" title="${t('volume')}">${icon('volume')}</button>
        <input id="vol" class="vol" type="range" min="0" max="1" step="0.01" value="1">
      </div>
    </footer>
    <nav class="bottomnav"><i class="navblob"></i>${nav('home', 'home', t('home'))}${nav('search', 'search', t('search'))}${nav('library', 'library', t('library'))}</nav>
  </div>
  <div id="fs" class="fs">
    <div class="fs-top"><button class="icon-btn" data-act="close-fs">${icon('down')}</button><span class="muted small">${t('nowPlaying')}</span><button class="icon-btn" data-act="menu">${icon('more')}</button></div>
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
}

function startApp() {
  document.body.classList.remove('auth');
  if (!player) {
    player = new Player();
    player.autoplay = prefs.autoplay;
    player.setVolume(prefs.volume ?? 1);
    if (prefs.eq) player.setEq(prefs.eq);
    buildShell();
    bindPlayer();
  } else buildShell();
  renderPlayer();
  loadSettings()
    .then(async () => {
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
      setTimeout(() => autoUpdateCheck(), 4000);
      if (!settings.setupDone && state.route !== 'welcome') go('#/welcome');
      else render();
    })
    .catch(() => render());
  get('/api/me')
    .then((u) => {
      conn.user = u;
      saveConn();
    })
    .catch(() => {});
}

setUnauthorizedHandler(() => {
  if (conn.token) logout();
});

async function boot() {
  sameOrigin = await detectSameOrigin();
  if (sameOrigin) conn.server = sameOrigin;
  if (conn.server && conn.token) {
    try {
      conn.user = await api('GET', '/api/me', undefined, { timeout: 8000 });
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

boot();
