// Other platforms: which ones are on, logins, reading playlists, and turning their songs into queue items.
import { get, put, post, extCovers } from './api.js';

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
export const playerOf = (src) => (src === 'ytmusic' ? 'youtube' : src);

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

/** Turn import items into playable tracks: local first, then the platform if it is on. */
export function playableItems(items) {
  return items.map((it) => {
    if (it.local) return { ...it.local, _pos: it.pos };
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
export const spotify = {
  redirectUri: () => location.origin + '/',
  canLogin: () => !!(window.crypto && crypto.subtle) && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname)),
  connected: () => {
    const s = spLoad();
    return !!(s.access && (s.refresh || s.exp > Date.now()));
  },
  async login() {
    const id = settings.spotifyClientId;
    if (!id) throw new Error('spotify_no_client');
    if (!this.canLogin()) throw new Error('spotify_https');
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
    sessionStorage.setItem('musik.sp.pkce', JSON.stringify({ verifier, state, back: location.hash }));
    const q = new URLSearchParams({ response_type: 'code', client_id: id, scope: SP_SCOPES, redirect_uri: this.redirectUri(), code_challenge_method: 'S256', code_challenge: challenge, state });
    location.href = 'https://accounts.spotify.com/authorize?' + q;
  },
  /** Called on start: finishes the login when Spotify sent us back with ?code= */
  async finishLogin() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return false;
    let saved = {};
    try {
      saved = JSON.parse(sessionStorage.getItem('musik.sp.pkce')) || {};
    } catch {}
    sessionStorage.removeItem('musik.sp.pkce');
    history.replaceState(null, '', location.pathname + (saved.back || '#/sources'));
    if (q.get('state') !== saved.state || !q.get('code')) return false;
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: this.redirectUri(), client_id: settings.spotifyClientId, code_verifier: saved.verifier })
    });
    if (!r.ok) return false;
    const j = await r.json();
    spSave({ access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
    return true;
  },
  setToken(token) {
    spSave({ access: token.trim(), refresh: '', exp: Date.now() + 55 * 60 * 1000 });
  },
  logout() {
    localStorage.removeItem(SP_KEY);
  },
  async token() {
    const s = spLoad();
    if (s.access && s.exp > Date.now()) return s.access;
    if (!s.refresh) throw new Error('spotify_login');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refresh, client_id: settings.spotifyClientId })
    });
    if (!r.ok) throw new Error('spotify_login');
    const j = await r.json();
    spSave({ access: j.access_token, refresh: j.refresh_token || s.refresh, exp: Date.now() + (j.expires_in - 60) * 1000 });
    return j.access_token;
  },
  async api(path, opts = {}) {
    const r = await fetch('https://api.spotify.com/v1' + path, { ...opts, headers: { Authorization: 'Bearer ' + (await this.token()), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (r.status === 204) return null;
    if (r.status === 401) throw new Error('spotify_login');
    if (r.status === 403) throw new Error('spotify_forbidden');
    if (!r.ok) throw new Error('spotify_' + r.status);
    return r.json();
  },
  async all(path, pick = (j) => j) {
    const out = [];
    let next = path;
    for (let n = 0; next && n < 100; n++) {
      const j = pick(await this.api(next.replace('https://api.spotify.com/v1', '')));
      out.push(...(j.items || []));
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
export async function fetchLink(raw) {
  const L = parseLink(raw);
  if (!L) throw new Error('bad_link');
  const url = String(raw).trim();
  if (L.source === 'spotify') {
    if (L.kind === 'playlist') return spotifyPlaylist(L.id, url);
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

export async function spotifyPlaylist(id, url = `https://open.spotify.com/playlist/${id}`) {
  const p = await spotify.api(`/playlists/${id}?fields=name,images,owner(display_name)`);
  let raw;
  try {
    raw = await spotify.all(`/playlists/${id}/items?limit=50`);
  } catch {
    raw = await spotify.all(`/playlists/${id}/tracks?limit=50`).catch(() => []);
  }
  const items = raw.map((x) => spotify.item(x.item || x.track)).filter(Boolean);
  if (!items.length) throw new Error('spotify_not_own');
  return { source: 'spotify', name: p.name, url, cover: p.images?.[0]?.url || '', items };
}
export async function spotifyLiked() {
  const items = (await spotify.all('/me/tracks?limit=50')).map((x) => spotify.item(x.track)).filter(Boolean);
  return { source: 'spotify', name: 'Spotify Lieblingssongs', url: 'spotify:liked', cover: '', items };
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
export async function searchSpotify(q) {
  if (!spotify.connected()) return [];
  const j = await spotify.api(`/search?type=track&limit=10&q=${encodeURIComponent(q)}`);
  return (j.tracks?.items || []).map((t) => extTrack(spotify.item(t))).filter(Boolean);
}
