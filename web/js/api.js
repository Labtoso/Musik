// Server connection, login token and JSON helpers.
const KEY = 'musik.conn';

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

export const conn = load(); // { server, token, user }

export function saveConn() {
  try {
    localStorage.setItem(KEY, JSON.stringify(conn));
  } catch {}
}

export function normalizeServer(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (!u.port && u.protocol === 'http:' && !/\.[a-z]{2,}$/i.test(u.hostname)) u.port = '8484';
    return u.origin;
  } catch {
    return '';
  }
}

/** True when this page is served by a Musik server itself (browser use). */
export async function detectSameOrigin() {
  if (!/^https?:$/.test(location.protocol) || location.hostname === 'appassets.androidplatform.net') return null;
  try {
    const r = await fetch(location.origin + '/api/info', { cache: 'no-store' });
    const j = await r.json();
    return j.app === 'musik' ? location.origin : null;
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(method, path, body, { server = conn.server, token = conn.token, timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(server + path, {
      method,
      signal: ctrl.signal,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ApiError(0, 'offline');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    if (res.status === 401 && token && path !== '/api/login') onUnauthorized();
    throw new ApiError(res.status, data?.error || 'error');
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);

/** Like the Msik bot: the server finds the song on YouTube and streams its sound */
export function ytSongUrl(t) {
  const q = new URLSearchParams({ title: t.title || '', artist: t.artist || '', duration: String(Math.round(t.duration || 0)), t: conn.token });
  return `${conn.server}/api/ytsong?${q}`;
}
export function ytAudioUrl(vid) {
  return `${conn.server}/api/ytaudio/${encodeURIComponent(vid)}?t=${conn.token}`;
}
export function streamUrl(id) {
  return `${conn.server}/api/stream/${id}?t=${conn.token}`;
}
/** Cover URLs of songs from other platforms, keyed by their string id (e.g. "yt:abc"). */
export const extCovers = new Map();
export function coverUrl(id) {
  if (typeof id === 'string') return extCovers.get(id) || '';
  return `${conn.server}/api/cover/${id}?t=${conn.token}`;
}

/** Upload one file with progress callback. */
export function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${conn.server}/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Authorization', 'Bearer ' + conn.token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let j = null;
      try {
        j = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(j);
      else reject(new ApiError(xhr.status, j?.error || 'error'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'offline'));
    xhr.send(file);
  });
}
