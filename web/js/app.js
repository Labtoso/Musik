import { conn, saveConn, normalizeServer, detectSameOrigin, api, get, post, put, del, coverUrl, upload, setUnauthorizedHandler, ApiError, extCovers } from './api.js';
import { Player, EQ_FREQS } from './player.js';
import { settings, loadSettings, saveSettings, enabled, SOURCES, spotify, fetchLink, parseFile, saveImport, spotifyPlaylist, spotifyLiked, playableItems, searchYouTube, searchSpotify } from './sources.js';
import { placeStage } from './engines.js';
import { Visualizer, VIZ_MODES } from './viz.js';
import { t, setLang, getLang } from './i18n.js';
import { icon } from './icons.js';
import { colorFromUrl } from './dyncolor.js';

const RELEASES = 'https://github.com/Labtoso/Musik/releases/latest';
const GUIDE = 'https://github.com/Labtoso/Musik/blob/main/docs/tailscale.md';
const VERSION = '1.0.0';
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- settings ----------
const PREFS_KEY = 'musik.prefs';
const prefs = Object.assign({ lang: (navigator.language || 'de').startsWith('de') ? 'de' : 'en', accent: 'blue', volume: 1, autoplay: true, dynamic: true }, (() => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
})());
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}
function applyPrefs() {
  setLang(prefs.lang);
  document.documentElement.dataset.accent = prefs.accent;
  window.MusikAndroid?.setAccent?.(prefs.accent);
}
// Colours from the current cover ("dynamic colours")
let dynFor = null;
function applyDyn(tr) {
  const root = document.documentElement;
  const clear = () => {
    root.classList.remove('dyn');
    ['--accent', '--accent-ink', '--accent2', '--dyn-bg'].forEach((k) => root.style.removeProperty(k));
  };
  const id = prefs.dynamic && tr ? tr.id : null;
  if (id === dynFor) return;
  dynFor = id;
  if (!id) return clear();
  colorFromUrl(coverUrl(id)).then((p) => {
    if (dynFor !== id) return;
    if (!p) return clear();
    root.style.setProperty('--accent', p.accent);
    root.style.setProperty('--accent2', p.accent2);
    root.style.setProperty('--accent-ink', p.ink);
    root.style.setProperty('--dyn-bg', p.bg);
    root.classList.add('dyn');
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
  m.innerHTML = items
    .filter(Boolean)
    .map((it, i) => (it === '-' ? '<hr>' : `<button data-i="${i}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span></button>`))
    .join('');
  document.body.appendChild(m);
  const list = items.filter(Boolean);
  m.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    closeMenu();
    list[Number(b.dataset.i)]?.run();
  });
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  let x = Math.min(r.right - mw, innerWidth - mw - 8);
  let y = r.bottom + 4;
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 4);
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
function trackList(tracks, { numbers = false, album = true, reasons = false, playlistId = null } = {}) {
  if (!tracks.length) return `<p class="muted empty">${t('empty')}</p>`;
  const id = 'tl' + Math.random().toString(36).slice(2, 8);
  state.lists = state.lists || {};
  state.lists[id] = tracks;
  const cur = player.current?.id;
  return `<div class="tracks" data-list="${id}" ${playlistId ? `data-playlist="${playlistId}"` : ''}>${tracks
    .map((tr, i) => {
      const reason = reasons && tr.reason ? `<span class="reason">${esc(t('reason_' + tr.reason, { artist: artistName(tr) }))}</span>` : '';
      const side = tr.ext || tr._off
        ? `<span class="like-slot">${srcBadge(tr.ext?.source || tr._src)}</span>`
        : `<button class="icon-btn like ${tr.liked ? 'on' : ''}" data-like="${tr.id}" title="${tr.liked ? t('unlike') : t('like')}">${icon(tr.liked ? 'heartFill' : 'heart')}</button>`;
      return `<div class="row ${tr.id === cur ? 'current' : ''} ${tr._off ? 'off' : ''}" data-i="${i}" data-id="${esc(String(tr.id))}">
        <div class="lead">${numbers ? `<span class="num">${tr.track_no || i + 1}</span>` : coverImg(tr.has_cover ? tr.id : tr.id, 'sm')}<button class="playbtn" title="${t('play')}">${icon('play')}</button></div>
        <div class="main"><div class="title">${esc(tr.title)}</div><div class="sub">${esc(artistName(tr))}${reason ? ' · ' + reason : ''}</div></div>
        ${album ? `<div class="alb">${esc(tr.album || '')}</div>` : ''}
        ${side}
        <div class="dur">${fmtTime(tr.duration)}</div>
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
  return `<span class="src src-${esc(src || '')}" title="${esc(t('src_' + src))}">${SRC_SHORT[src] ?? ''}</span>`;
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
    try {
      await navigator.clipboard.writeText(url);
      toast(t('linkCopied'));
    } catch {
      dialog({ title: t('share'), fields: [{ name: 'url', label: 'Link', value: url }], ok: 'OK' });
    }
  } catch (e) {
    toast(errorText(e));
  }
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

function pageHead(title, extra = '') {
  const initial = esc(((conn.user && conn.user.name) || '?').trim().charAt(0).toUpperCase() || '?');
  return `<div class="mhead"><button class="avatar" data-settings title="${t('settings')}">${initial}</button><h1>${title}</h1>${extra}</div>`;
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

views.home = async () => {
  const [h, lib] = await Promise.all([get('/api/home'), get('/api/library')]);
  if (!lib.tracks) {
    return `<div class="emptystate">${icon('note', 'big')}<p>${t('emptyLibrary')}</p><button class="btn primary" data-upload>${icon('upload')}${t('upload')}</button></div>`;
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
  if (h.recent.length) html += section(t('recent'), trackCards(h.recent, 'recent'));
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

views.search = async (params) => {
  const q = params.get('q') || '';
  return `${pageHead(t('search'))}<div class="searchbar">${icon('search')}<input id="q" type="search" placeholder="${t('searchPlaceholder')}" value="${esc(q)}" autocomplete="off"></div><div id="results"></div>`;
};
async function runSearch(q) {
  const box = $('#results');
  if (!box) return;
  if (!q.trim()) {
    const albums = await cached('albums', () => get('/api/albums')).catch(() => []);
    if ($('#q')?.value.trim()) return;
    box.innerHTML = albums.length
      ? section(t('browseAll'), `<div class="browse">${albums
          .slice(0, 24)
          .map((a) => `<a class="bt" href="${albumHref(a.album, a.artist)}" data-tint="${a.cover_id ? coverUrl(a.cover_id) : ''}"><span>${esc(a.album)}</span>${coverImg(a.cover_id)}</a>`)
          .join('')}</div>`)
      : '';
    tintAll(box);
    return;
  }
  const lq = q.toLowerCase();
  const [tr, albums, artists] = await Promise.all([
    get('/api/tracks?limit=50&q=' + encodeURIComponent(q)),
    cached('albums', () => get('/api/albums')),
    cached('artists', () => get('/api/artists'))
  ]);
  if ($('#q')?.value !== q) return;
  const ar = artists.filter((a) => a.name.toLowerCase().includes(lq)).slice(0, 12);
  const al = albums.filter((a) => a.album.toLowerCase().includes(lq) || (a.artist || '').toLowerCase().includes(lq)).slice(0, 12);
  let html = '';
  if (ar.length) html += section(t('artists'), `<div class="chips">${ar.map((a) => `<a class="chip" href="#/artist?name=${encodeURIComponent(a.name)}">${esc(a.name)}</a>`).join('')}</div>`);
  if (al.length) html += section(t('albums'), albumCards(al));
  if (tr.items.length) html += section(t('tracks'), trackList(tr.items));
  box.innerHTML = html || `<p class="muted empty">${t('noResults')}</p>`;
  // songs from other platforms below the own library
  const extra = [];
  if ((enabled('youtube') || enabled('ytmusic')) && settings.youtubeKey) extra.push(searchYouTube(q, enabled('ytmusic') && !enabled('youtube') ? 'ytmusic' : 'youtube').then((l) => [t('onYouTube'), l]).catch(() => null));
  if (enabled('spotify') && spotify.connected()) extra.push(searchSpotify(q).then((l) => [t('onSpotify'), l]).catch(() => null));
  for (const r of await Promise.all(extra)) {
    if (!r || !r[1].length || $('#q')?.value !== q) continue;
    if (!tr.items.length && !ar.length && !al.length && box.querySelector('.empty')) box.innerHTML = '';
    box.insertAdjacentHTML('beforeend', section(r[0], trackList(r[1])));
  }
}
let searchTimer;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  clearTimeout(searchTimer);
  const q = e.target.value;
  history.replaceState(null, '', '#/search' + (q ? '?q=' + encodeURIComponent(q) : ''));
  searchTimer = setTimeout(() => runSearch(q).catch(() => {}), 180);
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
      <select class="select" id="sort">${['artist', 'title', 'album', 'added'].map((s) => `<option value="${s}" ${s === sort ? 'selected' : ''}>${{ artist: t('artists'), title: t('tracks'), album: t('albums'), added: t('added') }[s]}</option>`).join('')}</select></div>
      ${trackList(r.items)}`;
  } else if (tab === 'albums') {
    state.cache.albums = await get('/api/albums');
    body = albumCards(state.cache.albums).replace('class="cards"', 'class="cards libgrid"');
  } else if (tab === 'artists') {
    state.cache.artists = await get('/api/artists');
    body = `<div class="cards libgrid">${state.cache.artists
      .map(
        (a) => `<a class="card artist" href="#/artist?name=${encodeURIComponent(a.name)}">${coverImg(a.cover_id, 'lg round')}<div class="c-title">${esc(a.name)}</div><div class="c-sub">${songCount(a.tracks)}</div></a>`
      )
      .join('')}</div>`;
  } else if (tab === 'imported') {
    const list = await get('/api/imports');
    body = `<div class="toolbar"><a class="btn primary" href="#/add">${icon('download')}${t('importAdd')}</a><a class="btn" href="#/sources">${t('manageSources')}</a></div>
      ${list.length ? `<div class="cards libgrid">${list.map((im) => `<a class="card" href="#/imported/${im.id}">${im.cover ? `<div class="cover lg"><img loading="lazy" alt="" src="${esc(im.cover)}"></div>` : coverImg(im.cover_id, 'lg')}<div class="c-title">${esc(im.name)}</div><div class="c-sub">${srcBadge(im.source)} ${t('importedOf', { local: im.matched, total: im.total })}</div></a>`).join('')}</div>` : `<p class="muted empty">${t('importNone')}</p>`}`;
  } else {
    const lists = await get('/api/playlists');
    body = `<div class="toolbar"><button class="btn" data-newpl>${icon('plus')}${t('newPlaylist')}</button></div>
      <div class="cards libgrid"><a class="card" href="#/likes"><div class="cover lg ph accent">${icon('heartFill')}</div><div class="c-title">${t('likes')}</div></a>
      ${lists.map((p) => `<a class="card" href="#/playlist/${p.id}">${coverImg(p.cover_id, 'lg')}<div class="c-title">${esc(p.name)}</div><div class="c-sub">${songCount(p.tracks)}</div></a>`).join('')}</div>`;
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
    actions: listActions('artist') + `<button class="btn" data-radioartist>${icon('radio')}${t('startRadio')}</button>`
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
      coverId: pl.tracks[0]?.id,
      kind: t('playlist'),
      title: pl.name,
      sub: `${songCount(pl.tracks.length)} · ${fmtTime(pl.tracks.reduce((s, x) => s + x.duration, 0))}`,
      actions: listActions('pl') + shareBtn('playlist', pl.id, pl.name) + `<button class="icon-btn" data-plmenu="${pl.id}" title="…">${icon('more')}</button>`
    }) + trackList(pl.tracks, { playlistId: pl.id })
  );
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-plmenu]');
  if (!b) return;
  const id = b.dataset.plmenu;
  const name = $('.detail-head h1')?.textContent || '';
  menu(b, [
    {
      label: t('rename'),
      icon: 'refresh',
      run: async () => {
        const r = await dialog({ title: t('rename'), fields: [{ name: 'name', label: t('playlistName'), value: name }] });
        if (r?.name?.trim()) {
          await put(`/api/playlists/${id}`, { name: r.name.trim() });
          renderSidebarPlaylists();
          render();
        }
      }
    },
    {
      label: t('delete'),
      icon: 'trash',
      run: async () => {
        const r = await dialog({ title: t('deletePlaylistQ', { name }), ok: t('delete'), danger: true });
        if (r) {
          await del(`/api/playlists/${id}`);
          renderSidebarPlaylists();
          go('#/library?tab=playlists');
        }
      }
    }
  ]);
});

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
      <label class="field"><span>${t('spotifyClient')}</span><input id="spclient" value="${esc(settings.spotifyClientId || '')}" autocomplete="off" spellcheck="false"></label>
      <p class="muted small">${esc(t('spotifyClientHelp', { uri: spotify.redirectUri() }))}</p>
      <div class="stack">${spotify.connected() ? `<span class="pill ok">${icon('check')}${t('spotifyConnected')}</span><button type="button" class="btn" data-splogout>${t('spotifyDisconnect')}</button>` : `<button type="button" class="btn primary" data-splogin>${t('spotifyConnect')}</button>`}<button type="button" class="btn ghost" data-sptoken>${t('spotifyToken')}</button></div></div>
    <div class="access ${ytOn ? '' : 'hide'}" data-for="youtube"><h3>YouTube</h3>
      <label class="field"><span>${t('youtubeKey')}</span><input id="ytkey" value="${esc(settings.youtubeKey || '')}" autocomplete="off" spellcheck="false"></label>
      <p class="muted small">${t('youtubeKeyHelp')}</p></div>`;
  return `${pageHead(welcome ? t('welcomeTitle') : t('sources'))}
    <p class="muted lead">${welcome ? t('welcomeText') : t('sourcesHint')}</p>
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
    spotify.login().catch((err) => toast(errorText(err)));
  }
  if (e.target.closest('[data-splogout]')) {
    spotify.logout();
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
async function previewImport(job) {
  const box = $('#importprev');
  if (!box) return;
  box.innerHTML = `<div class="loading"></div><p class="muted">${t('importing')}</p>`;
  try {
    const data = await job();
    if (!data.items?.length) throw new Error('empty_import');
    state.pendingImport = data;
    box.innerHTML = `<div class="impprev">
      <label class="field"><span>${t('playlistName')}</span><input id="impname" value="${esc(data.name || '')}"></label>
      <p class="muted">${srcBadge(data.source)} ${t('importFound', { n: data.items.length })}</p>
      <div class="stack"><button class="btn primary" data-impsave>${icon('check')}${t('importSave')}</button></div>
      <ol class="implist">${data.items.slice(0, 30).map((x) => `<li><b>${esc(x.title)}</b> <span class="muted">${esc(x.artist || '')}</span></li>`).join('')}${data.items.length > 30 ? '<li class="muted">…</li>' : ''}</ol></div>`;
  } catch (err) {
    box.innerHTML = `<p class="err">${esc(errorText(err))}</p>`;
  }
}
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'importform') return;
  e.preventDefault();
  const link = e.target.elements.link.value.trim();
  if (link) previewImport(() => fetchLink(link));
});
document.addEventListener('change', (e) => {
  if (e.target.id !== 'importfile' || !e.target.files[0]) return;
  const f = e.target.files[0];
  previewImport(async () => parseFile(f.name, await f.text()));
});
document.addEventListener('click', async (e) => {
  const sp = e.target.closest('[data-spimport]');
  if (sp) previewImport(() => (sp.dataset.spimport === 'liked' ? spotifyLiked() : spotifyPlaylist(sp.dataset.spimport)));
  if (e.target.closest('[data-impsave]') && state.pendingImport) {
    const d = state.pendingImport;
    const name = $('#impname')?.value.trim() || d.name || t('imported');
    try {
      const r = await saveImport({ source: d.source, name, url: d.url || '', cover: d.cover || '', items: d.items });
      state.pendingImport = null;
      go('#/imported/' + r.id);
    } catch (err) {
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
  return (
    detailHeader({
      coverId,
      kind: t('imported'),
      title: r.name,
      sub: `${srcBadge(r.source)} ${t('importedOf', { local, total: r.items.length })}`,
      actions: listActions('imp') + shareBtn('import', r.id, r.name) + `<button class="icon-btn" data-immenu="${r.id}" title="…">${icon('more')}</button>`
    }) + trackList(tracks)
  );
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-immenu]');
  if (!b) return;
  const id = b.dataset.immenu;
  const info = state.importInfo || {};
  menu(b, [
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
    info.url && info.url !== 'spotify:liked' || info.url === 'spotify:liked'
      ? {
          label: t('refreshImport'),
          icon: 'download',
          run: async () => {
            try {
              const d = info.url === 'spotify:liked' ? await spotifyLiked() : await fetchLink(info.url);
              await put(`/api/imports/${id}`, { items: d.items });
              render();
            } catch (err) {
              toast(errorText(err));
            }
          }
        }
      : null,
    '-',
    {
      label: t('delete'),
      icon: 'trash',
      run: async () => {
        if (await dialog({ title: t('deleteImportQ', { name: info.name || '' }), ok: t('delete'), danger: true })) {
          await del(`/api/imports/${id}`);
          go('#/library?tab=imported');
        }
      }
    }
  ]);
});

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
addEventListener('hashchange', render);
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
  if (v && document.activeElement !== v) v.value = player.volume;
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
  $('#mini').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (innerWidth < 900 && player.current) openFs(true);
  });
  player.addEventListener('change', renderPlayer);
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
  placeStage();
  setTimeout(placeStage, 350);
  if (open) history.pushState({ fs: 1 }, '');
}
function toggleFsQueue() {
  const q = $('#fs-queue');
  q.classList.toggle('open');
  if (q.classList.contains('open')) q.innerHTML = queueHtml();
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
    const lists = await get('/api/playlists');
    box.innerHTML = lists.map((p) => `<a href="#/playlist/${p.id}" class="side-pl">${esc(p.name)}</a>`).join('');
  } catch {
    box.innerHTML = '';
  }
}

// ---------- settings panel ----------
function openSettings() {
  renderSettings();
  $('#settings').classList.add('open');
  $('#scrim').classList.add('show');
}
function closeSettings() {
  $('#settings').classList.remove('open');
  $('#scrim').classList.remove('show');
  clearInterval(state.scanTimer);
}
async function renderSettings() {
  const s = $('#settings-body');
  const user = conn.user || {};
  let lib = null, info = null;
  try {
    [lib, info] = await Promise.all([get('/api/library'), api('GET', '/api/info', undefined, { token: null, timeout: 6000 }).catch(() => null)]);
  } catch {}
  const accents = ['blue', 'green', 'purple'];
  s.innerHTML = `
    <div class="set-group"><h3>${t('language')}</h3>
      <div class="seg">${['de', 'en'].map((l) => `<button data-lang="${l}" class="${getLang() === l ? 'on' : ''}">${l === 'de' ? 'Deutsch' : 'English'}</button>`).join('')}</div></div>
    <div class="set-group"><h3>${t('accent')}</h3>
      <div class="swatches">${accents.map((a) => `<button class="swatch ${a} ${prefs.accent === a ? 'on' : ''}" data-accent="${a}" title="${t(a)}" aria-label="${t(a)}"></button>`).join('')}</div></div>
    <div class="set-group"><h3>${t('playback')}</h3>
      <label class="check"><input type="checkbox" id="autoplay" ${prefs.autoplay ? 'checked' : ''}><span>${t('autoplay')}</span></label></div>
    <div class="set-group"><h3>${t('look')}</h3>
      <label class="check"><input type="checkbox" id="dyncolor" ${prefs.dynamic ? 'checked' : ''}><span>${t('dynColor')}</span></label></div>
    <div class="set-group"><h3>${t('sources')}</h3>
      <p class="muted small">${SOURCES.filter((x) => enabled(x)).map((x) => t('src_' + x)).join(', ')}</p>
      <div class="stack"><a class="btn" href="#/sources" data-closesettings>${t('manageSources')}</a><a class="btn" href="#/add" data-closesettings>${icon('download')}${t('importAdd')}</a></div></div>
    <div class="set-group"><h3>${t('equalizer')}</h3>${eqHtml()}</div>
    <div class="set-group"><h3>${t('viz')}</h3>
      <select class="select" id="vizmode">${VIZ_MODES.map((m) => `<option value="${m}" ${(prefs.viz || 'off') === m ? 'selected' : ''}>${t('viz_' + m)}</option>`).join('')}</select>
      <p class="muted small">${t('vizHint')}</p></div>
    <div class="set-group"><h3>${t('library')}</h3>
      ${lib ? `<p class="muted">${t('stats', { tracks: lib.tracks, artists: lib.artists, albums: lib.albums })}</p>` : ''}
      <div id="scaninfo" class="muted small"></div>
      <div class="stack">
        <button class="btn" data-upload>${icon('upload')}${t('upload')}</button>
        ${user.admin ? `<button class="btn" data-scan>${icon('refresh')}${t('scan')}</button>` : ''}
      </div>
      <div id="upload-progress"></div>
      ${user.admin && lib ? `<p class="muted small">${t('folders')}: ${lib.dirs.map(esc).join(', ')}</p>` : ''}</div>
    <div class="set-group"><h3>${t('account')}</h3>
      <p><span class="muted">${t('name')}:</span> ${esc(user.name || '')}${user.admin ? ` <span class="muted">· ${t('admin')}</span>` : ''}</p>
      <p class="muted small">${t('server')}: ${esc(conn.server)}</p>
      <div class="stack">
        <button class="btn" data-chpw>${t('changePassword')}</button>
        ${sameOrigin && !window.musikDesktop && !window.MusikAndroid ? '' : `<button class="btn" data-chserver>${t('changeServer')}</button>`}
        <button class="btn" data-logout>${t('logout')}</button>
      </div></div>
    <div class="set-group"><h3>${t('onTheGo')}</h3>
      ${info?.remote ? `<p class="muted small">${t('remoteOn')}</p><p><code class="addr">${esc(info.remote)}</code></p><div class="stack"><button class="btn" data-copyremote="${esc(info.remote)}">${t('copy')}</button></div>`
        : `<p class="muted small">${t('remoteOff')}</p><div class="stack"><a class="btn" href="${GUIDE}" target="_blank" rel="noopener">${t('guide')}</a></div>`}</div>
    ${user.admin ? `<div class="set-group"><h3>${t('users')}</h3><div id="userlist" class="muted small">…</div><button class="btn" data-adduser>${icon('plus')}${t('addUser')}</button></div>` : ''}
    <div class="set-group"><h3>${t('apps')}</h3>
      <div class="stack"><a class="btn" href="${RELEASES}" target="_blank" rel="noopener">${icon('download')}${t('allDownloads')}</a></div>
      <p class="muted small">${t('version')} ${VERSION} · LabtosoStudios</p></div>`;
  if (lib) showScan(lib);
  if (user.admin) renderUsers();
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
  const el = e.target.closest('[data-lang],[data-accent],[data-scan],[data-logout],[data-chserver],[data-chpw],[data-adduser],[data-deluser],[data-settings],#scrim,[data-closesettings],[data-copyremote]');
  if (!el) return;
  if (el.dataset.copyremote) { navigator.clipboard?.writeText(el.dataset.copyremote).then(() => toast(t('copied'))).catch(() => {}); return; }
  if (el.matches('[data-settings]')) return openSettings();
  if (el.matches('#scrim,[data-closesettings]')) return closeSettings();
  if (el.dataset.lang) {
    prefs.lang = el.dataset.lang;
    savePrefs();
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
    document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.accent === prefs.accent));
    return;
  }
  try {
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
    prefs.lang = getLang() === 'de' ? 'en' : 'de';
    savePrefs();
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
  $('#app').innerHTML = `
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
    <nav class="bottomnav">${nav('home', 'home', t('home'))}${nav('search', 'search', t('search'))}${nav('library', 'library', t('library'))}</nav>
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
  <aside id="settings" class="settings"><div class="set-head"><button class="icon-btn" data-closesettings>${icon('close')}</button><h2>${t('settings')}</h2></div><div id="settings-body"></div></aside>`;
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
      await spotify.finishLogin().catch(() => false);
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
