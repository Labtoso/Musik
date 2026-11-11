import { conn, saveConn, normalizeServer, detectSameOrigin, api, get, post, put, del, coverUrl, upload, setUnauthorizedHandler, ApiError } from './api.js';
import { Player } from './player.js';
import { t, setLang, getLang } from './i18n.js';
import { icon } from './icons.js';

const RELEASES = 'https://github.com/Labtoso/Musik/releases/latest';
const VERSION = '1.0.0';
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- settings ----------
const PREFS_KEY = 'musik.prefs';
const prefs = Object.assign({ lang: (navigator.language || 'de').startsWith('de') ? 'de' : 'en', accent: 'blue', volume: 1, autoplay: true }, (() => {
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
applyPrefs();

let player = null;
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
  return t('error');
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
    { label: t('startRadio'), icon: 'radio', run: () => startRadio(tr) },
    '-',
    tr.artist && { label: t('goArtist'), icon: 'user', run: () => go(`#/artist?name=${encodeURIComponent(tr.artist)}`) },
    tr.album && {
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
      return `<div class="row ${tr.id === cur ? 'current' : ''}" data-i="${i}" data-id="${tr.id}">
        <div class="lead">${numbers ? `<span class="num">${tr.track_no || i + 1}</span>` : coverImg(tr.has_cover ? tr.id : tr.id, 'sm')}<button class="playbtn" title="${t('play')}">${icon('play')}</button></div>
        <div class="main"><div class="title">${esc(tr.title)}</div><div class="sub">${esc(artistName(tr))}${reason ? ' · ' + reason : ''}</div></div>
        ${album ? `<div class="alb">${esc(tr.album || '')}</div>` : ''}
        <button class="icon-btn like ${tr.liked ? 'on' : ''}" data-like="${tr.id}" title="${tr.liked ? t('unlike') : t('like')}">${icon(tr.liked ? 'heartFill' : 'heart')}</button>
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
  if (e.target.closest('.playbtn') || isTouch || e.detail >= 2) player.playList(tracks, i);
});

// ---------- views ----------
const views = {};

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
  let html = `<div class="hero">
    <div class="hero-text"><h1>${t('mixForYou')}</h1><p class="muted">${h.cold ? t('coldHint') : esc(h.mix.slice(0, 4).map(artistName).filter((v, i, a) => a.indexOf(v) === i).join(', '))}</p></div>
    <button class="btn primary" data-playmix>${icon('play')}${t('playAll')}</button></div>`;
  html += `<section class="sec">${trackList(h.mix, { reasons: true })}</section>`;
  if (h.recent.length) html += section(t('recent'), trackCards(h.recent, 'recent'));
  if (h.rediscover.length) html += section(t('rediscover'), trackCards(h.rediscover, 'rediscover'));
  if (h.newAlbums.length) html += section(t('newAlbums'), albumCards(h.newAlbums));
  if (h.topArtists.length)
    html += section(
      t('yourArtists'),
      `<div class="chips">${h.topArtists.map((a) => `<a class="chip" href="#/artist?name=${encodeURIComponent(a)}">${esc(a)}</a>`).join('')}</div>`
    );
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
  return `<div class="searchbar">${icon('search')}<input id="q" type="search" placeholder="${t('searchPlaceholder')}" value="${esc(q)}" autocomplete="off"></div><div id="results"></div>`;
};
async function runSearch(q) {
  const box = $('#results');
  if (!box) return;
  if (!q.trim()) {
    box.innerHTML = '';
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

const LIB_TABS = ['tracks', 'albums', 'artists', 'playlists'];
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
    body = albumCards(state.cache.albums);
  } else if (tab === 'artists') {
    state.cache.artists = await get('/api/artists');
    body = `<div class="cards">${state.cache.artists
      .map(
        (a) => `<a class="card artist" href="#/artist?name=${encodeURIComponent(a.name)}">${coverImg(a.cover_id, 'lg round')}<div class="c-title">${esc(a.name)}</div><div class="c-sub">${songCount(a.tracks)}</div></a>`
      )
      .join('')}</div>`;
  } else {
    const lists = await get('/api/playlists');
    body = `<div class="toolbar"><button class="btn" data-newpl>${icon('plus')}${t('newPlaylist')}</button></div>
      <div class="cards"><a class="card" href="#/likes"><div class="cover lg ph accent">${icon('heartFill')}</div><div class="c-title">${t('likes')}</div></a>
      ${lists.map((p) => `<a class="card" href="#/playlist/${p.id}">${coverImg(p.cover_id, 'lg')}<div class="c-title">${esc(p.name)}</div><div class="c-sub">${songCount(p.tracks)}</div></a>`).join('')}</div>`;
  }
  return `<h1>${t('library')}</h1><div class="tabs">${LIB_TABS.map((x) => `<a class="tab ${x === tab ? 'on' : ''}" href="#/library?tab=${x}">${t(x)}</a>`).join('')}</div>${body}`;
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
  return `<div class="detail-head">${coverImg(coverId, 'xl' + (round ? ' round' : ''))}<div class="dh-text"><div class="muted kind">${esc(kind)}</div><h1>${esc(title)}</h1><div class="muted">${sub}</div>
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
      actions: listActions('album')
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
      actions: listActions('pl') + `<button class="icon-btn" data-plmenu="${pl.id}" title="…">${icon('more')}</button>`
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
    main.scrollTop = 0;
    $('#content').scrollTop = 0;
    if (state.route === 'search') {
      const q = $('#q');
      if (q) {
        if (!matchMedia('(hover: none)').matches) q.focus();
        if (q.value) runSearch(q.value);
      }
    }
  } catch (e) {
    if (seq !== renderSeq) return;
    main.innerHTML = `<p class="muted empty">${esc(errorText(e))}</p>`;
  }
}
addEventListener('hashchange', render);

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
    }
    $('#np-title').textContent = tr.title;
    $('#np-artist').textContent = artistName(tr);
    $('#fs-title').textContent = tr.title;
    $('#fs-artist').textContent = artistName(tr);
    document.title = `${tr.title} · ${artistName(tr)}`;
  } else {
    coverBox.dataset.id = '';
    coverBox.innerHTML = coverImg(null, 'md');
    big.innerHTML = coverImg(null, 'huge');
    $('#np-title').textContent = t('nothingPlaying');
    $('#np-artist').textContent = '';
    $('#fs-title').textContent = t('nothingPlaying');
    $('#fs-artist').textContent = '';
    document.title = 'Musik';
  }
  document.querySelectorAll('[data-act="like"]').forEach((b) => {
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
    if (!r.closest('[data-queue]')) r.classList.toggle('current', Number(r.dataset.id) === tr?.id);
  });
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
  player.addEventListener('error', () => toast(t('error')));
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
function openFs(open) {
  $('#fs').classList.toggle('open', open);
  if (!open) $('#fs-queue').classList.remove('open');
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
  let lib = null;
  try {
    lib = await get('/api/library');
  } catch {}
  const accents = ['blue', 'green', 'purple'];
  s.innerHTML = `
    <div class="set-group"><h3>${t('language')}</h3>
      <div class="seg">${['de', 'en'].map((l) => `<button data-lang="${l}" class="${getLang() === l ? 'on' : ''}">${l === 'de' ? 'Deutsch' : 'English'}</button>`).join('')}</div></div>
    <div class="set-group"><h3>${t('accent')}</h3>
      <div class="swatches">${accents.map((a) => `<button class="swatch ${a} ${prefs.accent === a ? 'on' : ''}" data-accent="${a}" title="${t(a)}" aria-label="${t(a)}"></button>`).join('')}</div></div>
    <div class="set-group"><h3>${t('playback')}</h3>
      <label class="check"><input type="checkbox" id="autoplay" ${prefs.autoplay ? 'checked' : ''}><span>${t('autoplay')}</span></label></div>
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
  const el = e.target.closest('[data-lang],[data-accent],[data-scan],[data-logout],[data-chserver],[data-chpw],[data-adduser],[data-deluser],[data-settings],#scrim,[data-closesettings]');
  if (!el) return;
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
    <div class="fs-bottom"><button class="btn ghost" data-act="queue">${icon('queue')}${t('queue')}</button></div>
    <div id="fs-queue" class="fs-queue"></div>
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
    buildShell();
    bindPlayer();
  } else buildShell();
  renderPlayer();
  render();
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
