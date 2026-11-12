// Other platforms: which ones are on, logins, reading playlists, and turning their songs into queue items.
import { get, put, post, api, conn, extCovers } from './api.js';

export const SOURCES = ['local', 'youtube', 'ytmusic', 'spotify', 'soundcloud', 'deezer', 'files'];
/** Sources whose songs can be played inside the app (the rest only import and match). */
export const PLAYABLE = ['youtube', 'ytmusic', 'spotify', 'soundcloud'];

export const settings = { setupDone: false, sources: { local: true }, spotifyClientId: '', youtubeKey: '' };
export async function loadSettings() {
  try {
    Object.assign(settings, await get('/api/me/settings'));
  } catch {}
  settings.sources = { local: true, ...(settings.sources || {}) };
  return settings;
}
export async function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  await put('/api/me/settings', settings);
}
export const enabled = (src) => src === 'local' || !!settings.sources?.[src];
/** Which player plays a source: YouTube Music songs are YouTube videos. */
// Spotify gives names and covers, the sound comes from YouTube (like the Msik bot)
export const playerOf = (src) => (src === 'ytmusic' ? 'youtube' : src === 'spotify' ? 'ytfind' : src);

// ---------- helpers ----------
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => res();
    s.onerror = () => rej(new Error('script'));
    document.head.appendChild(s);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JUNK = /\s*[([](official|video|audio|lyrics?|lyric video|visuali[sz]er|mv|hd|4k|hq|clip officiel|musikvideo)[^)\]]*[)\]]/gi;

/** "Artist - Title (Official Video)" + channel → { artist, title } */
export function splitYouTube(title, author = '') {
  let t = (title || '').replace(JUNK, '').trim();
  const topic = / - Topic$/i.test(author);
  let artist = topic ? author.replace(/ - Topic$/i, '') : author.replace(/VEVO$/i, '').trim();
  if (!topic) {
    const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) {
      artist = m[1].trim();
      t = m[2].trim();
    }
  }
  return { artist, title: t.replace(/["“”]/g, '').trim() };
}

// ---------- queue items for other platforms ----------
/** An import item (or search result) → track object the player understands. */
export function extTrack(it) {
  const src = it.source;
  const id = `${src}:${it.ext_id}`;
  if (it.cover) extCovers.set(id, it.cover);
  return {
    id,
    ext: { source: src, player: playerOf(src), id: it.ext_id, url: it.url || '' },
    title: it.title,
    artist: it.artist || '',
    album: it.album || '',
    duration: it.duration || 0,
    has_cover: !!it.cover,
    liked: false
  };
}
export const isExt = (t) => !!t?.ext;
/** Open a page in the system browser: Android and the desktop app hand it over, a browser opens a tab. */
export function openExternal(url) {
  try {
    if (window.MusikAndroid?.openExternal) return window.MusikAndroid.openExternal(url);
  } catch {}
  if (window.musikDesktop) {
    // the desktop app catches this navigation and opens the browser instead
    location.href = url;
    return;
  }
  window.open(url, '_blank', 'noopener');
}

/** Turn import items into playable tracks: local first, then the platform if it is on. */
export function playableItems(items) {
  return items.map((it) => {
    if (it.local) return { ...it.local, _pos: it.pos };
    // Spotify songs play through YouTube when a YouTube key is there (name and artist come from Spotify)
    if (it.source === 'spotify' && it.title) {
      const tr = extTrack(it);
      tr.ext = { ...tr.ext, player: 'ytfind' };
      return { ...tr, _pos: it.pos };
    }
    const canPlay = PLAYABLE.includes(it.source) && enabled(it.source) && it.ext_id && !(it.source === 'spotify' && !spotify.connected());
    return canPlay ? { ...extTrack(it), _pos: it.pos } : null;
  });
}

// ---------- Spotify (PKCE login in the browser, or a pasted token) ----------
const SP_KEY = 'musik.spotify';
const SP_SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state';
function spLoad() {
  try {
    return JSON.parse(localStorage.getItem(SP_KEY)) || {};
  } catch {
    return {};
  }
}
function spSave(v) {
  try {
    localStorage.setItem(SP_KEY, JSON.stringify(v));
  } catch {}
}
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// The sign-in runs in the system browser; the server keeps the tokens (also the refresh token),
// so every app on every device stays connected. A pasted token still works as a fallback.
const spState = { server: false, access: '', exp: 0 };
export const spotify = {
  redirectUri: () => 'https://musik.labtoso.de/spotify.html',
  canLogin: () => true,
  connected: () => {
    const s = spLoad();
    return spState.server || !!(s.access && s.exp > Date.now());
  },
  /** Ask the server once on start whether this account is connected. */
  async init() {
    try {
      spState.server = !!(await api('GET', '/api/spotify/status')).connected;
    } catch {
      spState.server = false;
    }
    return spState.server;
  },
  async login() {
    const id = settings.spotifyClientId;
    if (!id) throw new Error('spotify_no_client');
    const r = await api('POST', '/api/spotify/start', { client_id: id, origin: conn.server || location.origin });
    openExternal(r.url);
    // wait for the browser to finish
    for (let i = 0; i < 120; i++) {
      await new Promise((res) => setTimeout(res, 2500));
      if (await this.init()) return true;
    }
    return false;
  },
  async finishLogin() {
    return this.init();
  },
  setToken(token) {
    spSave({ access: token.trim(), refresh: '', exp: Date.now() + 55 * 60 * 1000 });
  },
  async logout() {
    localStorage.removeItem(SP_KEY);
    spState.server = false;
    spState.access = '';
    await api('POST', '/api/spotify/disconnect').catch(() => {});
  },
  async token() {
    if (spState.access && spState.exp > Date.now() + 30000) return spState.access;
    if (spState.server) {
      try {
        const r = await api('GET', '/api/spotify/token');
        spState.access = r.access;
        spState.exp = r.exp;
        return r.access;
      } catch (e) {
        if (e.status === 401 || e.status === 404) spState.server = false;
      }
    }
    const s = spLoad();
    if (s.access && s.exp > Date.now()) return s.access;
    throw new Error('spotify_login');
  },
  async api(path, opts = {}) {
    const r = await fetch('https://api.spotify.com/v1' + path, { ...opts, headers: { Authorization: 'Bearer ' + (await this.token()), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (r.status === 204) return null;
    if (r.status === 401) throw new Error('spotify_login');
    if (r.status === 403) throw new Error('spotify_forbidden');
    if (!r.ok) throw new Error('spotify_' + r.status);
    return r.json();
  },
  async all(path, pick = (j) => j, onProgress) {
    const out = [];
    let next = path;
    for (let n = 0; next && n < 200; n++) {
      const j = pick(await this.api(next.replace('https://api.spotify.com/v1', '')));
      out.push(...(j.items || []));
      onProgress?.(out.length, j.total || out.length);
      next = j.next;
    }
    return out;
  },
  async myPlaylists() {
    return (await this.all('/me/playlists?limit=50')).filter(Boolean).map((p) => ({ id: p.id, name: p.name, cover: p.images?.[0]?.url || '', total: p.items?.total ?? p.tracks?.total ?? 0 }));
  },
  item(t, album) {
    if (!t || t.type === 'episode' || !t.id) return null;
    const al = t.album || album || {};
    return {
      source: 'spotify',
      ext_id: t.id,
      title: t.name,
      artist: (t.artists || []).map((a) => a.name).join(', '),
      album: al.name || '',
      duration: (t.duration_ms || 0) / 1000,
      cover: al.images?.[1]?.url || al.images?.[0]?.url || '',
      url: t.external_urls?.spotify || ''
    };
  }
};

// ---------- YouTube (official IFrame player for lists, oEmbed via our server for titles) ----------
async function ytApi() {
  if (window.YT?.Player) return window.YT;
  const ready = new Promise((res) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      res();
    };
  });
  await loadScript('https://www.youtube.com/iframe_api');
  await Promise.race([ready, sleep(15000)]);
  if (!window.YT?.Player) throw new Error('youtube_unreachable');
  return window.YT;
}
export { ytApi };

async function ytPlaylistIds(list) {
  const YT = await ytApi();
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-400px;top:0;width:200px;height:200px;opacity:0;pointer-events:none';
  const el = document.createElement('div');
  box.appendChild(el);
  document.body.appendChild(box);
  try {
    const ids = await new Promise((res, rej) => {
      let done = false;
      const p = new YT.Player(el, {
        width: 200,
        height: 200,
        playerVars: { listType: 'playlist', list, autoplay: 0 },
        events: {
          onReady: async () => {
            for (let i = 0; i < 40 && !done; i++) {
              const l = p.getPlaylist?.();
              if (l?.length) {
                done = true;
                return res(l);
              }
              await sleep(250);
            }
            rej(new Error('youtube_empty'));
          },
          onError: () => rej(new Error('youtube_private'))
        }
      });
      setTimeout(() => !done && rej(new Error('youtube_unreachable')), 20000);
    });
    return ids;
  } finally {
    box.remove();
  }
}

async function ytWithKey(list, key, source) {
  const base = 'https://www.googleapis.com/youtube/v3/';
  const head = await (await fetch(`${base}playlists?part=snippet&id=${list}&key=${key}`)).json();
  if (head.error) throw new Error('youtube_key');
  const items = [];
  let page = '';
  for (let n = 0; n < 40; n++) {
    const j = await (await fetch(`${base}playlistItems?part=snippet&maxResults=50&playlistId=${list}&key=${key}${page ? '&pageToken=' + page : ''}`)).json();
    if (j.error) throw new Error('youtube_private');
    for (const it of j.items || []) {
      const sn = it.snippet;
      const vid = sn.resourceId?.videoId;
      if (!vid || sn.title === 'Private video' || sn.title === 'Deleted video') continue;
      const { artist, title } = splitYouTube(sn.title, sn.videoOwnerChannelTitle || '');
      items.push({ source, ext_id: vid, title, artist, album: '', duration: 0, cover: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`, url: `https://www.youtube.com/watch?v=${vid}` });
    }
    page = j.nextPageToken;
    if (!page) break;
  }
  const sn = head.items?.[0]?.snippet;
  return { name: sn?.title || 'YouTube', cover: sn?.thumbnails?.high?.url || '', items };
}

async function ytTitles(ids, source) {
  const items = [];
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60);
    const meta = await get('/api/fetch/oembed?ids=' + chunk.join(',')).catch(() => []);
    const by = new Map(meta.map((m) => [m.id, m]));
    for (const vid of chunk) {
      const m = by.get(vid);
      if (!m?.title) continue; // private or removed
      const { artist, title } = splitYouTube(m.title, m.author || '');
      items.push({ source, ext_id: vid, title, artist, album: '', duration: 0, cover: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`, url: `https://www.youtube.com/watch?v=${vid}` });
    }
  }
  return items;
}

// ---------- SoundCloud (official widget) ----------
async function scApi() {
  if (window.SC?.Widget) return window.SC;
  await loadScript('https://w.soundcloud.com/player/api.js');
  return window.SC;
}
export { scApi };
async function soundcloudList(url) {
  const SC = await scApi();
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-500px;top:0;width:300px;height:300px;opacity:0;pointer-events:none';
  const fr = document.createElement('iframe');
  fr.allow = 'autoplay';
  fr.width = '300';
  fr.height = '300';
  fr.src = 'https://w.soundcloud.com/player/?visual=false&auto_play=false&url=' + encodeURIComponent(url);
  box.appendChild(fr);
  document.body.appendChild(box);
  try {
    const w = SC.Widget(fr);
    await new Promise((res, rej) => {
      w.bind(SC.Widget.Events.READY, res);
      w.bind(SC.Widget.Events.ERROR, () => rej(new Error('soundcloud_private')));
      setTimeout(() => rej(new Error('soundcloud_unreachable')), 20000);
    });
    // the widget loads details of long sets bit by bit, give it a moment
    await sleep(1500);
    const sounds = await new Promise((res) => w.getSounds(res));
    const items = (sounds || []).map((s) => ({
      source: 'soundcloud',
      ext_id: String(s.id),
      title: s.title || `SoundCloud ${s.id}`,
      artist: s.user?.username || s.publisher_metadata?.artist || '',
      album: s.publisher_metadata?.album_title || '',
      duration: (s.duration || s.full_duration || 0) / 1000,
      cover: (s.artwork_url || s.user?.avatar_url || '').replace('-large', '-t300x300'),
      url: s.permalink_url || `https://api.soundcloud.com/tracks/${s.id}`
    }));
    return { name: decodeURIComponent(url.split('/').filter(Boolean).pop() || 'SoundCloud').replace(/-/g, ' '), cover: items[0]?.cover || '', items };
  } finally {
    box.remove();
  }
}

// ---------- reading a link ----------
/** Detect what a pasted link is. */
export function parseLink(raw) {
  const s = String(raw || '').trim();
  let m;
  if ((m = s.match(/spotify\.com\/(?:intl-[a-z]+\/)?(playlist|album|track)\/([A-Za-z0-9]+)/) || s.match(/^spotify:(playlist|album|track):([A-Za-z0-9]+)/)))
    return { source: 'spotify', kind: m[1], id: m[2] };
  if ((m = s.match(/deezer\.com\/(?:[a-z]{2}\/)?(playlist|album)\/(\d+)/))) return { source: 'deezer', kind: m[1], id: m[2] };
  if (/soundcloud\.com\//.test(s)) return { source: 'soundcloud', kind: 'list', id: s.split('?')[0] };
  if (/youtube\.com|youtu\.be/.test(s)) {
    const music = /music\.youtube\.com/.test(s);
    const list = (s.match(/[?&]list=([A-Za-z0-9_-]+)/) || s.match(/browse\/VL([A-Za-z0-9_-]+)/) || [])[1];
    if (list) return { source: music ? 'ytmusic' : 'youtube', kind: 'playlist', id: list.replace(/^VL/, '') };
    const v = (s.match(/[?&]v=([A-Za-z0-9_-]{11})/) || s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) || [])[1];
    if (v) return { source: music ? 'ytmusic' : 'youtube', kind: 'video', id: v };
  }
  return null;
}

/** Load a playlist / album from any platform → { source, name, url, cover, items } */
export async function fetchLink(raw, onProgress) {
  const L = parseLink(raw);
  if (!L) throw new Error('bad_link');
  const url = String(raw).trim();
  if (L.source === 'spotify') {
    if (L.kind === 'playlist') return spotifyPlaylist(L.id, url, onProgress);
    if (!spotify.connected()) {
      // without a Spotify login the public page still has names, artists, lengths and the cover
      const e = await get(`/api/spotify/embed?kind=${L.kind}&id=${encodeURIComponent(L.id)}`);
      const items = await spotifyEmbedItems(L.kind, L.id, onProgress, e);
      if (L.kind === 'album') items.forEach((x) => (x.album = x.album || e.name));
      return { source: 'spotify', name: e.name, url, cover: e.cover, items };
    }
    if (L.kind === 'album') {
      const a = await spotify.api(`/albums/${L.id}`);
      const items = (await spotify.all(`/albums/${L.id}/tracks?limit=50`)).map((t) => spotify.item(t, a)).filter(Boolean);
      return { source: 'spotify', name: a.name, url, cover: a.images?.[0]?.url || '', items };
    }
    const t = await spotify.api(`/tracks/${L.id}`);
    return { source: 'spotify', name: t.name, url, cover: t.album?.images?.[0]?.url || '', items: [spotify.item(t)] };
  }
  if (L.source === 'deezer') {
    const r = await get(`/api/fetch/deezer?type=${L.kind}&id=${L.id}`);
    return { source: 'deezer', url, ...r };
  }
  if (L.source === 'soundcloud') return { source: 'soundcloud', url, ...(await soundcloudList(L.id)) };
  // YouTube / YouTube Music
  if (L.kind === 'video') {
    const items = await ytTitles([L.id], L.source);
    return { source: L.source, name: items[0]?.title || 'YouTube', url, cover: items[0]?.cover || '', items };
  }
  if (settings.youtubeKey) return { source: L.source, url, ...(await ytWithKey(L.id, settings.youtubeKey, L.source)) };
  const ids = await ytPlaylistIds(L.id);
  const items = await ytTitles(ids, L.source);
  return { source: L.source, name: L.source === 'ytmusic' ? 'YouTube Music' : 'YouTube', url, cover: items[0]?.cover || '', items };
}

const unhtml = (h) => {
  const d = document.createElement('div');
  d.innerHTML = String(h || '').replace(/<[^>]*>/g, '');
  return d.textContent.trim();
};
/** Songs of a public Spotify page (embed), each with its own cover from the Web API where it answers. */
export async function spotifyEmbedItems(kind, id, onProgress, pre) {
  const e = pre || await get(`/api/spotify/embed?kind=${kind}&id=${encodeURIComponent(id)}`).catch(() => null);
  const list = (e?.tracks || []).filter((t) => t.id);
  const out = list.map((t) => ({ source: 'spotify', ext_id: t.id, title: t.title, artist: t.artist, album: '', duration: t.duration || 0, cover: t.cover || '', url: `https://open.spotify.com/track/${t.id}` }));
  // covers and albums one by one (Spotify dropped the batch call), a few at a time
  let i = 0;
  const work = async () => {
    while (i < out.length) {
      const it = out[i++];
      try {
        const t = await spotify.api(`/tracks/${it.ext_id}`);
        const full = spotify.item(t);
        if (full) Object.assign(it, { album: full.album, cover: full.cover || it.cover, duration: full.duration || it.duration });
      } catch (err) {
        if (err.message === 'spotify_login') i = out.length;
      }
      onProgress?.(i, out.length);
    }
  };
  if (spotify.connected()) await Promise.all([work(), work(), work(), work()]);
  for (const it of out) if (!it.cover) it.cover = e?.cover || '';
  return out;
}
/** A Spotify playlist with everything it shows there: cover, description, owner, followers, songs. */
export async function spotifyPlaylist(id, url = `https://open.spotify.com/playlist/${id}`, onProgress) {
  let p = null;
  let raw = [];
  if (spotify.connected()) {
    p = await spotify.api(`/playlists/${id}?fields=name,description,images,owner(display_name),followers(total),tracks(total),items(total)`).catch((e) => {
      if (e.message === 'spotify_login') throw e;
      return null;
    });
    if (p) raw = await spotify.all(`/playlists/${id}/items?limit=50`, undefined, onProgress).catch((e) => {
      if (e.message === 'spotify_login') throw e;
      return [];
    });
  }
  let items = raw.map((x) => spotify.item(x.item || x.track)).filter(Boolean);
  // playlists of others: Spotify only lists your own ones now, so read the public embed page like the Msik bot
  let em = null;
  if (!items.length) {
    em = await get(`/api/spotify/embed?kind=playlist&id=${encodeURIComponent(id)}`).catch(() => null);
    items = await spotifyEmbedItems('playlist', id, onProgress, em);
  }
  if (!items.length) throw new Error('spotify_not_own');
  const meta = { description: unhtml(p?.description || em?.description || ''), owner: p?.owner?.display_name || em?.owner || '', followers: p?.followers?.total || 0, total: items.length, duration: items.reduce((n, x) => n + (x.duration || 0), 0) };
  return { source: 'spotify', name: p?.name || em?.name || 'Spotify', url, cover: p?.images?.[0]?.url || em?.cover || '', meta, items };
}
export async function spotifyLiked(onProgress) {
  const items = (await spotify.all('/me/tracks?limit=50', undefined, onProgress)).map((x) => spotify.item(x.track)).filter(Boolean);
  const meta = { description: '', owner: '', followers: 0, total: items.length, duration: items.reduce((n, x) => n + (x.duration || 0), 0) };
  return { source: 'spotify', name: 'Spotify Lieblingssongs', url: 'spotify:liked', cover: '', meta, items };
}
/** YouTube video for a song (Spotify name + artist). The server looks it up with the YouTube key
 *  and remembers it for every device; this device keeps its own copy too. */
const YT_MAP = 'musik.ytmap';
export async function findOnYouTube(key, it) {
  let map = {};
  try {
    map = JSON.parse(localStorage.getItem(YT_MAP)) || {};
  } catch {}
  if (map[key]) return map[key];
  const r = await get(`/api/ytfind?title=${encodeURIComponent(it.title || '')}&artist=${encodeURIComponent(it.artist || '')}&duration=${Math.round(it.duration || 0)}`);
  const id = r?.id || '';
  if (id) {
    map[key] = id;
    const keys = Object.keys(map);
    if (keys.length > 3000) delete map[keys[0]];
    try {
      localStorage.setItem(YT_MAP, JSON.stringify(map));
    } catch {}
  }
  return id;
}

// ---------- files: CSV (e.g. Exportify), M3U, plain text ----------
function csvRows(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
export function parseFile(name, text) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const base = name.replace(/\.[^.]+$/, '');
  let items = [];
  if (ext === 'csv' || ext === 'tsv') {
    const rows = csvRows(text);
    const head = (rows.shift() || []).map((h) => h.toLowerCase().trim());
    const col = (...names) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)));
    const ti = col('track name', 'title', 'titel', 'name', 'song'), ai = col('artist name', 'artist', 'künstler', 'interpret'), al = col('album name', 'album'), du = col('duration (ms)', 'duration', 'dauer'), uri = col('track uri', 'spotify uri', 'uri');
    items = rows.map((r) => {
      let d = Number(r[du]) || 0;
      if (d > 10000) d /= 1000;
      const u = r[uri] || '';
      const sp = u.match(/spotify:track:([A-Za-z0-9]+)/);
      return { source: sp ? 'spotify' : 'files', ext_id: sp ? sp[1] : '', title: r[ti] || '', artist: (r[ai] || '').replace(/;/g, ', '), album: r[al] || '', duration: d, cover: '', url: sp ? `https://open.spotify.com/track/${sp[1]}` : '' };
    });
  } else if (ext === 'm3u' || ext === 'm3u8') {
    let pend = null;
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      if (l.startsWith('#EXTINF:')) {
        const m = l.match(/^#EXTINF:(-?\d+)[^,]*,(.*)$/);
        pend = m ? { d: Number(m[1]), t: m[2] } : null;
      } else if (!l.startsWith('#')) {
        const label = pend?.t || decodeURIComponent(l.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''));
        const [a, t] = label.includes(' - ') ? [label.slice(0, label.indexOf(' - ')), label.slice(label.indexOf(' - ') + 3)] : ['', label];
        items.push({ source: 'files', ext_id: '', title: t.trim(), artist: a.trim(), album: '', duration: pend?.d > 0 ? pend.d : 0, cover: '', url: '' });
        pend = null;
      }
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      const i = l.search(/\s[-–—]\s/);
      items.push({ source: 'files', ext_id: '', title: (i > 0 ? l.slice(i + 3) : l).trim(), artist: i > 0 ? l.slice(0, i).trim() : '', album: '', duration: 0, cover: '', url: '' });
    }
  }
  return { source: 'files', name: base, url: '', cover: '', items: items.filter((x) => x.title) };
}

/** Save an import on the server. */
export async function saveImport(data) {
  return post('/api/imports', data);
}

// ---------- search on platforms ----------
export async function searchYouTube(q, source = 'youtube') {
  if (!settings.youtubeKey) return [];
  const j = await (await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=10&q=${encodeURIComponent(q)}&key=${settings.youtubeKey}`)).json();
  return (j.items || []).map((it) => {
    const { artist, title } = splitYouTube(it.snippet.title.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'), it.snippet.channelTitle);
    return extTrack({ source, ext_id: it.id.videoId, title, artist, album: '', duration: 0, cover: `https://i.ytimg.com/vi/${it.id.videoId}/mqdefault.jpg`, url: `https://www.youtube.com/watch?v=${it.id.videoId}` });
  });
}
const spImg = (images) => (images || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || '';
/** Songs, artists, albums and playlists from Spotify, with current pictures. */
export async function searchSpotifyAll(q) {
  if (!spotify.connected()) return null;
  const j = await spotify.api(`/search?type=track,artist,album,playlist&limit=10&market=from_token&q=${encodeURIComponent(q)}`);
  return {
    tracks: (j.tracks?.items || []).map((x) => spotify.item(x)).filter(Boolean),
    artists: (j.artists?.items || []).filter(Boolean).map((a) => ({ id: a.id, name: a.name, picture: spImg(a.images), followers: a.followers?.total || 0, popularity: a.popularity || 0 })),
    albums: (j.albums?.items || []).filter(Boolean).map((a) => ({ id: a.id, title: a.name, artist: (a.artists || []).map((x) => x.name).join(', '), cover: spImg(a.images), year: (a.release_date || '').slice(0, 4) })),
    playlists: (j.playlists?.items || []).filter(Boolean).map((p) => ({ id: p.id, title: p.name, owner: p.owner?.display_name || '', cover: spImg(p.images), total: p.tracks?.total || p.items?.total || 0 }))
  };
}
export async function spotifyArtist(id) {
  const [a, top, al] = await Promise.all([
    spotify.api(`/artists/${id}`),
    // Spotify removed "top tracks" for apps like this one: the artist's best search hits instead
    spotify.api(`/artists/${id}`).then((x) => spotify.api(`/search?type=track&limit=10&market=from_token&q=${encodeURIComponent(`artist:"${x.name}"`)}`)).then((j) => ({ tracks: (j.tracks?.items || []).filter((t) => (t.artists || []).some((a) => a.id === id)) })).catch(() => ({ tracks: [] })),
    spotify.api(`/artists/${id}/albums?include_groups=album,single&limit=30`).catch(() => ({ items: [] }))
  ]);
  return {
    artist: { id: a.id, name: a.name, picture: spImg(a.images), followers: a.followers?.total || 0, genres: a.genres || [] },
    tracks: (top.tracks || []).map((x) => spotify.item(x)).filter(Boolean),
    albums: (al.items || []).map((x) => ({ id: x.id, title: x.name, artist: (x.artists || []).map((y) => y.name).join(', '), cover: spImg(x.images), year: (x.release_date || '').slice(0, 4) }))
  };
}
export async function spotifyAlbum(id) {
  const a = await spotify.api(`/albums/${id}`);
  const items = (await spotify.all(`/albums/${id}/tracks?limit=50`)).map((x) => spotify.item(x, a)).filter(Boolean);
  return { name: a.name, artist: (a.artists || []).map((x) => x.name).join(', '), artistId: a.artists?.[0]?.id || '', cover: spImg(a.images), year: (a.release_date || '').slice(0, 4), label: a.label || '', items };
}
/** YouTube videos without a key (the server asks YouTube's own search). */
/** Songs on YouTube Music (the plain audio tracks with album covers, no videos) */
export async function searchYouTubeMusic(q) {
  const l = await get('/api/ytmsearch?q=' + encodeURIComponent(q));
  return l.map((v) => extTrack({ source: 'ytmusic', ext_id: v.id, title: v.title, artist: v.artist, album: v.album || '', duration: v.duration || 0, cover: v.cover, url: `https://music.youtube.com/watch?v=${v.id}` }));
}
export async function searchYouTubeFree(q, source = 'ytmusic') {
  const l = await get('/api/ytsearch?q=' + encodeURIComponent(q));
  return l.map((v) => {
    const { artist, title } = splitYouTube(v.title, v.channel);
    return extTrack({ source, ext_id: v.id, title, artist, album: '', duration: v.duration || 0, cover: v.cover, url: `https://www.youtube.com/watch?v=${v.id}` });
  });
}
export async function searchSpotify(q) {
  if (!spotify.connected()) return [];
  const j = await spotify.api(`/search?type=track&limit=10&market=from_token&q=${encodeURIComponent(q)}`);
  return (j.tracks?.items || []).map((t) => extTrack(spotify.item(t))).filter(Boolean);
}
