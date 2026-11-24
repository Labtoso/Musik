// Queue + playback. Two engines with the same interface:
//  - HtmlEngine: <audio> element (browser, desktop)
//  - NativeEngine: Android bridge (ExoPlayer service, keeps playing in background)
import { api, streamUrl, coverUrl, post, get, ytSongUrl, ytAudioUrl, podAudioUrl, audioOut, extCovers, audioPrefs } from './api.js';
import { extTrack } from './sources.js';
import { YouTubeAdapter, SoundCloudAdapter, SpotifyAdapter, DeezerAdapter, showStage } from './engines.js';
import { toBands } from './viz.js';
import { findOnYouTube, spotify } from './sources.js';
const NQ_KEY = 'musik.nativeQueue';
const spotifyReady = () => {
  try {
    return spotify.connected();
  } catch {
    return false;
  }
};

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

class HtmlEngine extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    audioOut.add(this.audio);
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';
    this.adapters = {};
    this.active = null; // adapter of another platform, or null for <audio>
    this.volume = 1;
    this.items = [];
    this.index = -1;
    this.repeat = 'off';
    const a = this.audio;
    a.addEventListener('timeupdate', () => this.#emit('time', { position: a.currentTime, duration: a.duration || 0 }));
    a.addEventListener('durationchange', () => this.#emit('time', { position: a.currentTime, duration: a.duration || 0 }));
    a.addEventListener('play', () => this.#emit('playing', { playing: true }));
    a.addEventListener('pause', () => this.#emit('playing', { playing: false }));
    a.addEventListener('waiting', () => this.#emit('buffering', { buffering: true }));
    a.addEventListener('playing', () => this.#emit('buffering', { buffering: false }));
    a.addEventListener('error', () => {
      if (this.index < 0) return;
      const cur = this.items[this.index];
      if (cur?.streamed && cur.url) return this.#streamFailed(cur);
      this.#emit('error', { message: 'playback' });
      // skip broken files instead of stopping
      this.#skipAfterError(800);
    });
    a.addEventListener('playing', () => (this.fails = 0));
    a.addEventListener('ended', () => {
      if (this.repeat === 'one') {
        // the same song again fades in too (crossfade)
        this.fadeIn = this.opts?.crossfade > 0;
        this.fadeK = this.fadeIn ? 0 : 1;
        this.#applyVol();
        a.currentTime = 0;
        a.play().catch(() => {});
        this.#emit('index', { index: this.index, reason: 'repeat' });
        return;
      }
      this.#advance('ended');
    });
  }
  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  /** After an error: on to the next song, but stop when several in a row fail (server or network down). */
  #skipAfterError(ms, guard = () => true) {
    this.fails = (this.fails || 0) + 1;
    if (this.fails >= 3) {
      this.fails = 0;
      return this.#emit('playing', { playing: false });
    }
    // only for the song that failed: the user may have picked another one meanwhile
    const load = this.loadId;
    setTimeout(() => load === this.loadId && guard() && this.#advance('error'), ms);
  }
  /** The server could not stream a song: ask it why, then say so or use the YouTube player (hidden) as a last way out. */
  async #streamFailed(cur) {
    const mine = () => this.items[this.index] === cur;
    let code = 'offline';
    // no answer in time counts as offline
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const r = await fetch(cur.url, { headers: { Range: 'bytes=0-0' }, signal: ac.signal });
      code = r.ok ? 'playback' : (await r.json().catch(() => ({}))).error || 'youtube_unreachable';
      if (ac.signal.aborted) code = 'offline';
      r.body?.cancel?.().catch?.(() => {});
    } catch {
      code = 'offline';
    } finally {
      clearTimeout(timer);
    }
    if (!mine()) return;
    if (code === 'notfound') {
      this.#emit('error', { message: 'song_not_on_ytm' });
      return this.#skipAfterError(900, mine);
    }
    if (code === 'offline' || code === 'unauthorized') {
      this.#emit('error', { message: code === 'offline' ? 'offline' : 'playback' });
      return this.#emit('playing', { playing: false });
    }
    // the song exists but its stream did not open: once through the official player, without showing it
    if (!cur._embedTried) {
      cur._embedTried = true;
      cur.url = '';
      cur.streamed = false;
      return this.#load(this.index, 0, true, 'retry');
    }
    this.#emit('error', { message: 'stream_failed' });
    this.#skipAfterError(900, mine);
  }
  #adapter(kind) {
    if (this.adapters[kind]) return this.adapters[kind];
    const Cls = { youtube: YouTubeAdapter, soundcloud: SoundCloudAdapter, spotify: SpotifyAdapter, deezer: DeezerAdapter }[kind];
    if (!Cls) return null;
    const ad = new Cls();
    const mine = (fn) => (ev) => ad === this.active && fn(ev.detail || {});
    ad.addEventListener('time', mine((d) => this.#emit('time', d)));
    ad.addEventListener('playing', mine((d) => (d.playing && (this.fails = 0), this.#emit('playing', d))));
    ad.addEventListener('buffering', mine((d) => this.#emit('buffering', d)));
    ad.addEventListener('error', mine((d) => {
      // the label switched off playing outside YouTube: quietly take the next best video for the same song
      const cur = this.items[this.index];
      const blockedId = this.ytVid || (cur?.ext?.source === 'ytmusic' ? cur.ext.id : '');
      if (d.message === 'youtube_blocked' && cur?.ext && blockedId && (cur.ext.player === 'ytfind' || cur.ext.source === 'deezer' || cur.ext.source === 'ytmusic')) {
        cur._ytSkip = [...new Set([...(cur._ytSkip || []), blockedId])];
        this.ytVid = '';
        if (cur._ytSkip.length <= 5) return this.#load(this.index, 0, true, 'retry');
      }
      this.#emit('error', { message: d.message || 'playback' });
      // a missing device would fail the same way for every song: stop instead of skipping the whole list
      if (d.message === 'spotify_no_device') return this.#emit('playing', { playing: false });
      this.#skipAfterError(1200, () => ad === this.active);
    }));
    ad.addEventListener('ended', mine(() => {
      if (this.repeat === 'one') {
        // the same song again: through the normal loading (songs found on YouTube have another id than their own)
        return this.#load(this.index, 0, true, 'repeat');
      }
      this.#advance('ended');
    }));
    this.adapters[kind] = ad;
    return ad;
  }
  // ---------- equalizer (WebAudio, only for songs from the server) ----------
  /** WebAudio chain, built on first use: source -> preamp -> 10 filters -> analyser -> speakers. */
  #graph() {
    if (this.ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      audioOut.add(this.ctx);
      const src = this.ctx.createMediaElementSource(this.audio);
      this.pre = this.ctx.createGain();
      this.filters = EQ_FREQS.map((f, i) => {
        const b = this.ctx.createBiquadFilter();
        b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
        b.frequency.value = f;
        b.Q.value = 1.1;
        b.gain.value = 0;
        return b;
      });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.55;
      this.fft = new Uint8Array(this.analyser.frequencyBinCount);
      this.comp = this.ctx.createDynamicsCompressor();
      this.makeup = this.ctx.createGain();
      [src, this.pre, ...this.filters, this.comp, this.makeup, this.analyser].reduce((a, b) => (a.connect(b), b)).connect(this.ctx.destination);
      this.#normalize();
      this.audio.addEventListener('play', () => this.ctx.state === 'suspended' && this.ctx.resume());
      return true;
    } catch {
      this.ctx = null;
      return false;
    }
  }
  /** Spectrum of the song playing in <audio>; false for platform players (no access to their sound). */
  bands(out) {
    if (this.active || this.audio.paused || !this.#graph()) return false;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.analyser.getByteFrequencyData(this.fft);
    toBands(this.fft, this.ctx.sampleRate, out);
    return true;
  }
  setEq(eq) {
    this.eq = eq;
    if (!eq?.on && !this.ctx) return;
    try {
      if (!this.#graph()) return;
      const on = !!eq?.on;
      this.filters.forEach((b, i) => (b.gain.value = on ? Number(eq.gains?.[i]) || 0 : 0));
      this.pre.gain.value = on ? Math.pow(10, (Number(eq.pre) || 0) / 20) : 1;
      if (this.ctx.state === 'suspended' && !this.audio.paused) this.ctx.resume();
    } catch {}
  }
  #advance(reason) {
    if (this.index + 1 < this.items.length) this.#load(this.index + 1, 0, true, reason);
    else if (this.repeat === 'all' && this.items.length) this.#load(0, 0, true, reason);
    else {
      this.#emit('index', { index: this.index, reason: 'end' });
      this.#emit('playing', { playing: false });
    }
  }
  /** Like the Msik bot: look up the next songs on YouTube already, so they start at once. */
  #prefetchYt(i) {
    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = setTimeout(() => {
      for (const n of [1, 2, 3]) {
        const nx = this.items[i + n];
        if (nx?.ext && (nx.ext.player === 'ytfind' || nx.ext.source === 'deezer')) findOnYouTube(nx.ext.source + ':' + nx.ext.id, nx).catch(() => {});
      }
    }, 1500);
  }
  #load(i, pos, autoplay, reason) {
    const it = this.items[i];
    if (!it) return;
    this.index = i;
    this.loadId = (this.loadId || 0) + 1;
    this.#dropSeek();
    // fade in only when one song runs into the next, not when the user picks a song
    this.fadeIn = (reason === 'ended' || reason === 'repeat') && !pos && this.opts?.crossfade > 0;
    this.fadeK = this.fadeIn ? 0 : 1;
    this.#applyVol();
    // songs from Spotify and the Deezer catalog: names and covers from there, the whole song from YouTube
    const viaYt = it.ext && !it.url && (it.ext.player === 'ytfind' || it.ext.source === 'deezer' || !!it._ytSkip?.length);
    const kind = viaYt ? 'youtube' : it.ext?.player;
    const ad = it.ext && !it.url ? this.#adapter(kind) : null;
    if (this.active && this.active !== ad) this.active.stop();
    if (it.ext && !it.url) {
      this.ytVid = '';
      this.audio.pause();
      this.active = ad;
      if (!ad) {
        this.#emit('index', { index: i, reason });
        return setTimeout(() => this.#advance('error'), 300);
      }
      ad.setVolume?.(this.volume);
      if (viaYt) {
        // name and artist from Spotify, the sound from YouTube
        const mine = () => this.items[this.index] === it;
        this.ytVid = '';
        findOnYouTube(it.ext.source + ':' + it.ext.id, it, it._ytSkip || [])
          .then((vid) => {
            if (!mine()) return;
            if (!vid) throw Object.assign(new Error('notfound'), { code: 'notfound' });
            this.ytVid = vid;
            return ad.load(vid, pos, autoplay, '');
          })
          .catch(async (e) => {
            if (!mine()) return;
            const code = e?.code || e?.message || 'playback';
            const setup = ['no_youtube_key', 'youtube_key_bad', 'youtube_quota', 'offline', 'youtube_unreachable'].includes(code);
            // the Deezer catalog still has its 30 second preview
            if (it.ext.source === 'deezer') {
              const dz = this.#adapter('deezer');
              this.active?.stop?.();
              this.active = dz;
              dz.setVolume?.(this.volume);
              return dz.load(it.ext.id, pos, autoplay, it.ext.url).catch(() => {
                if (!mine()) return;
                this.#emit('error', { message: setup ? code : 'song_not_on_ytm' });
                this.#emit('playing', { playing: false });
              });
            }
            // no YouTube: play it on Spotify itself when that works (Spotify Premium, browser or Spotify app open)
            if (setup && it.ext.source === 'spotify' && spotifyReady()) {
              const sp = this.#adapter('spotify');
              this.active = sp;
              sp.setVolume?.(this.volume);
              return sp.load(it.ext.id, pos, autoplay);
            }
            this.#emit('error', { message: code });
            if (setup) {
              // the same thing would happen for every song: stop instead of skipping through the list
              this.#emit('playing', { playing: false });
              return;
            }
            // counts towards the errors in a row, so a list of songs that are nowhere to be found stops
            this.#skipAfterError(1200, mine);
          });
      } else ad.load(it.ext.id, pos, autoplay, it.ext.url).catch(() => this.#emit('error', { message: 'playback' }));
      this.#emit('index', { index: i, reason });
      this.#prefetchYt(i);
      return;
    }
    this.active = null;
    showStage('');
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
    this.audio.src = it.url;
    // podcasts play at their own speed, songs always at normal speed
    const rate = it.pod ? this.rate || 1 : 1;
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
    if (pos) {
      const seek = () => {
        this.#dropSeek();
        this.audio.currentTime = pos;
      };
      this.pendingSeek = seek;
      this.audio.addEventListener('loadedmetadata', seek);
    }
    if (autoplay) this.audio.play().catch(() => this.#emit('playing', { playing: false }));
    this.#emit('index', { index: i, reason });
  }
  /** Forget the start position of a song that is being replaced. */
  #dropSeek() {
    if (!this.pendingSeek) return;
    this.audio.removeEventListener('loadedmetadata', this.pendingSeek);
    this.pendingSeek = null;
  }
  /** Playback speed of podcast episodes (songs keep 1×). */
  setSpeed(r) {
    this.rate = r;
    if (this.items[this.index]?.pod && !this.active) {
      this.audio.defaultPlaybackRate = r;
      this.audio.playbackRate = r;
    }
  }
  setQueue(items, index, pos = 0, autoplay = true) {
    this.items = items.slice();
    if (index >= 0 && index < items.length) this.#load(index, pos, autoplay, 'user');
    else {
      this.index = -1;
      this.loadId = (this.loadId || 0) + 1;
      this.#dropSeek();
      this.active?.stop();
      this.active = null;
      showStage('');
      this.audio.removeAttribute('src');
      this.audio.load();
    }
  }
  insert(at, items) {
    this.items.splice(at, 0, ...items);
    if (at <= this.index) this.index += items.length;
  }
  remove(i) {
    this.items.splice(i, 1);
    if (i < this.index) this.index--;
    else if (i === this.index) {
      if (this.index < this.items.length) this.#load(this.index, 0, this.playing, 'user');
      else {
        this.setQueue(this.items, -1);
        // the player has to know nothing is loaded any more
        this.#emit('index', { index: -1, reason: 'user' });
      }
    }
  }
  move(from, to) {
    const [it] = this.items.splice(from, 1);
    this.items.splice(to, 0, it);
    if (this.index === from) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
  }
  jump(i) {
    this.#load(i, 0, true, 'user');
  }
  play() {
    if (this.index < 0 && this.items.length) return this.#load(0, 0, true, 'user');
    if (this.active) return this.active.play();
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
    this.audio.play().catch(() => {});
  }
  pause() {
    if (this.active) return this.active.pause();
    this.audio.pause();
  }
  seek(sec) {
    if (!Number.isFinite(sec)) return;
    if (this.active) return this.active.seek(sec);
    this.audio.currentTime = sec;
  }
  next() {
    if (this.index + 1 < this.items.length) this.#load(this.index + 1, 0, true, 'user');
    else if (this.repeat === 'all' && this.items.length) this.#load(0, 0, true, 'user');
  }
  prev() {
    if (this.index > 0) this.#load(this.index - 1, 0, true, 'user');
    else this.seek(0);
  }
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this.#applyVol();
  }
  /** Volume times the fade at the start and end of a song (crossfade setting). */
  #applyVol() {
    const f = this.fadeK ?? 1;
    this.audio.volume = Math.max(0, Math.min(1, this.volume * f));
    this.active?.setVolume?.(this.volume * f);
  }
  /** { crossfade: seconds, normalize: bool } */
  setOptions(o) {
    this.opts = o;
    if (o.normalize && !this.ctx && !this.#graph()) return;
    this.#normalize();
    clearInterval(this.fadeTimer);
    this.fadeK = 1;
    this.#applyVol();
    if (o.crossfade > 0) {
      // songs fade out at their end and in at their start, so changes are soft
      this.fadeTimer = setInterval(() => {
        const cf = this.opts.crossfade;
        const pos = this.position;
        const dur = this.active ? this.active.duration || 0 : this.audio.duration || 0;
        if (!dur || dur < cf * 3) return this.fadeK !== 1 && ((this.fadeK = 1), this.#applyVol());
        const k = Math.min(1, (dur - pos) / cf, this.fadeIn ? pos / cf : 1);
        if (Math.abs(k - (this.fadeK ?? 1)) < 0.01) return;
        this.fadeK = Math.max(0, k);
        this.#applyVol();
      }, 60);
    }
  }
  /** Same loudness for every song: a gentle compressor with make-up gain in the WebAudio chain. */
  #normalize() {
    if (!this.ctx || !this.comp) return;
    const on = !!this.opts?.normalize;
    const c = this.comp;
    c.threshold.value = on ? -24 : 0;
    c.knee.value = on ? 24 : 0;
    c.ratio.value = on ? 4 : 1;
    c.attack.value = 0.01;
    c.release.value = 0.4;
    this.makeup.gain.value = on ? 1.6 : 1;
  }
  setRepeat(mode) {
    this.repeat = mode;
  }
  get position() {
    return this.active ? this.active.position : this.audio.currentTime || 0;
  }
  get playing() {
    return this.active ? this.active.playing : !this.audio.paused;
  }
}

class NativeEngine extends EventTarget {
  constructor(bridge) {
    super();
    this.b = bridge;
    this.items = [];
    this.index = -1;
    this.pos = 0;
    this.isPlaying = false;
    window.__musikNative = (json) => {
      const e = typeof json === 'string' ? JSON.parse(json) : json;
      if (e.type === 'index') this.index = e.index;
      if (e.type === 'time') this.pos = e.position;
      if (e.type === 'playing') this.isPlaying = e.playing;
      this.dispatchEvent(new CustomEvent(e.type, { detail: e }));
    };
  }
  setQueue(items, index, pos = 0, autoplay = true) {
    this.items = items.slice();
    this.index = index;
    this.b.setQueue(JSON.stringify(items), index, Math.round(pos * 1000), autoplay);
  }
  insert(at, items) {
    this.items.splice(at, 0, ...items);
    if (at <= this.index) this.index += items.length;
    this.b.insert(at, JSON.stringify(items));
  }
  remove(i) {
    this.items.splice(i, 1);
    if (i < this.index) this.index--;
    this.b.remove(i);
  }
  move(from, to) {
    const [it] = this.items.splice(from, 1);
    this.items.splice(to, 0, it);
    if (this.index === from) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
    this.b.move(from, to);
  }
  jump(i) {
    this.b.jump(i);
  }
  play() {
    this.b.play();
  }
  pause() {
    this.b.pause();
  }
  seek(sec) {
    this.b.seek(Math.round(sec * 1000));
  }
  next() {
    this.b.next();
  }
  prev() {
    this.b.prev();
  }
  setVolume(v) {
    this.b.setVolume(v);
  }
  setRepeat(mode) {
    this.b.setRepeat(mode);
  }
  setSpeed(r) {
    try {
      this.b.setSpeed?.(r);
    } catch {}
  }
  get position() {
    return this.pos;
  }
  get playing() {
    return this.isPlaying;
  }
}

// The server streams YouTube sound itself (yt-dlp, like the Msik bot) when it can
let serverStreams = true;
get('/api/info')
  .then((i) => {
    serverStreams = i?.ytdlp !== false;
    // after an update the songs are looked up again: forget what this device remembered
    try {
      if (i?.version && localStorage.getItem('musik.ytver') !== i.version) {
        Object.keys(localStorage).filter((k) => k.startsWith('musik.ytmap')).forEach((k) => localStorage.removeItem(k));
        localStorage.setItem('musik.ytver', i.version);
      }
    } catch {}
  })
  .catch(() => {});
const viaSearch = (x) => x.player === 'ytfind' || x.source === 'deezer' || x.source === 'spotify';
const viaVideo = (x) => x.source === 'youtube' || x.source === 'ytmusic';
/** Songs whose sound the server streams like a song of its own */
export const streams = (t) => !!t?.ext && serverStreams && !t._noStream && (viaSearch(t.ext) || viaVideo(t.ext));
const needsHtml = (t) => !!t?.ext && !streams(t);
function streamOf(t) {
  return viaVideo(t.ext) ? ytAudioUrl(t.ext.id) : ytSongUrl(t);
}
/** What the server keeps of a song from another platform when it is played. */
function songOf(t) {
  if (!t?.ext) return null;
  return { id: t.id, title: t.title, artist: t.artist || '', album: t.album || '', duration: t.duration || 0, cover: extCovers.get(t.id) || '', source: t.ext.source, ext_id: String(t.ext.id), url: t.ext.url || '', ext: t.ext };
}
function toItem(t) {
  // a podcast episode: the server passes the show's own audio file on
  if (t.pod) return { id: t.id, url: podAudioUrl(t.pod.show, t.pod.ep), pod: true, title: t.title, artist: t.artist || '', album: t.album || '', artwork: coverUrl(t.id), duration: t.duration || 0 };
  if (streams(t)) return { id: t.id, ext: t.ext, url: streamOf(t), streamed: true, title: t.title, artist: t.artist || '', album: t.album || '', artwork: coverUrl(t.id), duration: t.duration || 0 };
  if (t.ext) return { id: t.id, ext: t.ext, url: '', title: t.title, artist: t.artist || '', album: t.album || '', artwork: coverUrl(t.id), duration: t.duration || 0 };
  return {
    id: t.id,
    url: streamUrl(t.id),
    title: t.title,
    artist: t.artist || '',
    album: t.album || '',
    artwork: t.has_cover !== false ? coverUrl(t.id) : '',
    duration: t.duration || 0
  };
}

const EVENTS_KEY = 'musik.pendingEvents';

const warmed = new Set();
/** Look songs up on YouTube before anybody taps them, so the first play starts at once. */
export function warmSongs(tracks) {
  const fresh = tracks.filter((t) => streams(t) && !warmed.has(String(t.id))).slice(0, 8);
  if (!fresh.length) return;
  fresh.forEach((t) => warmed.add(String(t.id)));
  if (warmed.size > 600) warmed.clear();
  post('/api/ytprefetch', {
    ids: fresh.filter((t) => viaVideo(t.ext)).map((t) => t.ext.id),
    songs: fresh.filter((t) => !viaVideo(t.ext)).map((t) => ({ title: t.title, artist: t.artist || '', duration: t.duration || 0 }))
  }).catch(() => fresh.forEach((t) => warmed.delete(String(t.id))));
}
/**
 * The "preload" button of a playlist: every song is looked up and its start fetched ahead, 8 at a time.
 * Returns how many songs were preloaded and the ones whose batch failed, so those are tried again later.
 */
export async function preloadSongs(tracks, progress = () => {}) {
  const all = tracks.filter((t) => streams(t));
  const list = all.slice(0, 300);
  // failed batches and streaming songs past the limit were not sent
  const failed = all.slice(300);
  let n = 0;
  let done = 0;
  progress(0, list.length);
  for (let i = 0; i < list.length; i += 8) {
    const part = list.slice(i, i + 8);
    const sent = await api('POST', '/api/ytprefetch', {
      wait: true,
      ids: part.filter((t) => viaVideo(t.ext)).map((t) => t.ext.id),
      songs: part.filter((t) => !viaVideo(t.ext)).map((t) => ({ title: t.title, artist: t.artist || '', duration: t.duration || 0 }))
    }, { timeout: 300000 }).then(() => true, () => false);
    if (sent) {
      part.forEach((t) => warmed.add(String(t.id)));
      n += part.length;
    } else failed.push(...part);
    done += part.length;
    progress(done, list.length);
  }
  return { n, failed };
}
export class Player extends EventTarget {
  constructor() {
    super();
    this.native = !!window.MusikAndroid;
    this.nativeEngine = this.native ? new NativeEngine(window.MusikAndroid) : null;
    this.htmlEngine = null;
    this.engine = this.native ? this.nativeEngine : this.#html();
    this.queue = [];
    this.original = null; // order before shuffle
    this.index = -1;
    this.position = 0;
    this.duration = 0;
    this.playing = false;
    this.buffering = false;
    this.repeat = 'off';
    this.shuffled = false;
    this.podSpeed = (() => {
      try {
        return Number(localStorage.getItem('musik.podSpeed')) || 1;
      } catch {
        return 1;
      }
    })();
    this.volume = 1;
    this.autoplay = true;
    this.listen = null; // { id, played, duration, last }
    this.fetchingMore = false;
    try {
      this.pending = JSON.parse(localStorage.getItem(EVENTS_KEY)) || [];
    } catch {
      this.pending = [];
    }
    if (this.nativeEngine) {
      this.#bind(this.nativeEngine);
      // keep the queue so a reloaded page finds the song the phone is still playing
      let saveT = 0;
      this.addEventListener('change', () => {
        clearTimeout(saveT);
        saveT = setTimeout(() => { try { localStorage.setItem(NQ_KEY, JSON.stringify(this.queue.slice(0, 1000))); } catch {} }, 400);
      });
    }
    setInterval(() => this.flushEvents(), 20000);
    addEventListener('pagehide', () => this.#finishListen('partial', true));
    this.#mediaSession();
  }

  #html() {
    if (!this.htmlEngine) {
      this.htmlEngine = new HtmlEngine();
      if (this.eq) this.htmlEngine.setEq(this.eq);
      if (this.opts) this.htmlEngine.setOptions(this.opts);
      this.#bind(this.htmlEngine);
    }
    return this.htmlEngine;
  }
  /** On Android, songs from other platforms can only play in the app view, so the queue moves there. */
  #pickEngine(list) {
    if (!this.native) return;
    const want = list.some(needsHtml) ? this.#html() : this.nativeEngine;
    if (want === this.engine) return;
    this.engine.pause();
    this.engine = want;
    // the other engine plays on with the chosen volume and repeat mode
    want.setVolume(this.volume);
    want.setRepeat(this.repeat);
  }

  #bind(e) {
    const mine = (fn) => (ev) => e === this.engine && fn(ev);
    e.addEventListener('time', mine((ev) => {
      const { position, duration } = ev.detail;
      if (this.listen && this.playing) {
        const d = position - this.listen.last;
        if (d > 0 && d < 3) this.listen.played += d;
      }
      if (this.listen) this.listen.last = position;
      this.position = position;
      if (duration) this.duration = duration;
      this.#emit('time');
    }));
    e.addEventListener('playing', mine((ev) => {
      this.playing = ev.detail.playing;
      this.#emit('state');
    }));
    e.addEventListener('buffering', mine((ev) => {
      this.buffering = ev.detail.buffering;
      this.#emit('state');
    }));
    e.addEventListener('error', mine((ev) => ((this.lastError = ev.detail?.message), this.#emit('error'))));
    e.addEventListener('index', mine((ev) => {
      // the page was reloaded while the phone kept playing: take the queue back so the player bar stays
      if (ev.detail.reason === 'restore' && !this.queue.length) {
        try {
          const q = JSON.parse(localStorage.getItem(NQ_KEY) || '[]');
          if (q.length && (!ev.detail.count || q.length === ev.detail.count)) {
            this.queue = q;
            if (this.nativeEngine) this.nativeEngine.items = q.slice();
          }
        } catch {}
      }
      this.#onIndex(ev.detail.index, ev.detail.reason);
      if (ev.detail.reason === 'restore') this.#emit('change');
    }));
  }

  /** Crossfade, same loudness and quality from the settings, for the browser and the Android player. */
  setOptions(o) {
    this.opts = o;
    // automatic: less data on a slow or saving connection, like Spotify
    const c = navigator.connection;
    const slow = c && (c.saveData || /2g|3g/.test(c.effectiveType || ''));
    audioPrefs.q = o.streamQ === 'auto' || !o.streamQ ? (slow ? 'low' : 'auto') : o.streamQ;
    this.htmlEngine?.setOptions(o);
    if (this.native) {
      try {
        window.MusikAndroid.setPlayOptions?.(JSON.stringify(o));
      } catch {}
    }
  }
  /** Equalizer settings { on, pre, gains[10] } for the browser and the Android player. */
  setEq(eq) {
    this.eq = eq;
    this.htmlEngine?.setEq(eq);
    if (this.native) {
      try {
        window.MusikAndroid.setEq?.(JSON.stringify(eq));
      } catch {}
    }
  }

  #emit(type) {
    this.dispatchEvent(new Event(type));
  }

  get current() {
    return this.queue[this.index] || null;
  }

  /** How long (ms) the sound takes from the player to the ear: Bluetooth adds a lot. */
  outputLatency() {
    if (this.native) {
      const now = performance.now();
      if (!this._lat || now - this._lat.at > 3000) this._lat = { at: now, ms: Number(window.MusikAndroid.outLatency?.() || 0) };
      return this._lat.ms;
    }
    const c = this.htmlEngine?.ctx;
    return c ? ((c.outputLatency || 0) + (c.baseLatency || 0)) * 1000 : 0;
  }

  /** Fill `out` (0..1 per band) with the current spectrum. False when no real audio data is available. */
  spectrum(out) {
    if (this.engine === this.htmlEngine) return this.htmlEngine.bands(out);
    if (this.native && this.playing) {
      try {
        const raw = window.MusikAndroid.vizBands?.();
        if (!raw) return false;
        const v = raw.split(',');
        for (let i = 0; i < out.length; i++) out[i] = (Number(v[i]) || 0) / 255;
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
  /** Android asks for the audio permission its visualizer needs; elsewhere nothing to do. */
  startViz() {
    if (this.native) {
      try {
        window.MusikAndroid.vizStart?.();
      } catch {}
    }
  }
  stopViz() {
    if (this.native) {
      try {
        window.MusikAndroid.vizStop?.();
      } catch {}
    }
  }

  // ---------- listening events for the recommendation engine ----------
  #finishListen(kindHint, flush = false) {
    const l = this.listen;
    if (!l) return;
    this.listen = null;
    const dur = l.duration || this.duration || 0;
    let kind = kindHint;
    if (kind === 'auto') kind = dur && l.played >= dur * 0.9 ? 'complete' : 'partial';
    if (kind === 'skip' && dur && l.played >= dur * 0.9) kind = 'complete';
    if (kind === 'partial' && l.played < 10) return; // too short to mean anything
    const ev = { trackId: l.id, kind, played: Math.round(l.played), duration: Math.round(dur), ts: Date.now() };
    // songs from Spotify, Deezer, YouTube count too: the server learns from them like from own files
    if (typeof l.id !== 'number') {
      if (!l.song) return;
      ev.song = l.song;
    }
    this.pending.push(ev);
    this.#savePending();
    if (flush || this.pending.length >= 5) this.flushEvents();
  }
  #savePending() {
    try {
      localStorage.setItem(EVENTS_KEY, JSON.stringify(this.pending.slice(-500)));
    } catch {}
  }
  /** Forgets unsent listening events (logout), so they are never sent with another account's session. */
  dropEvents() {
    this.listen = null;
    this.pending = [];
    try {
      localStorage.removeItem(EVENTS_KEY);
    } catch {}
  }
  async flushEvents() {
    if (!this.pending.length || this.flushing) return;
    this.flushing = true;
    const queue = this.pending;
    const batch = queue.slice(0, 200);
    try {
      await post('/api/events', { events: batch });
      // dropEvents() (logout) replaced the list meanwhile: the new events were not part of this batch
      if (this.pending !== queue) return;
      queue.splice(0, batch.length);
      this.#savePending();
    } catch {
      /* retry later */
    } finally {
      this.flushing = false;
    }
  }

  #onIndex(index, reason) {
    const prev = this.listen;
    const cont = this.engineSwitch && prev && index === this.index && this.queue[index]?.id === prev.id ? this.engineSwitch : null;
    if (prev && (index !== this.index || reason === 'repeat' || reason === 'end')) {
      this.#finishListen(reason === 'ended' || reason === 'repeat' || reason === 'end' ? 'auto' : this.skipHint || 'skip');
    }
    this.skipHint = null;
    this.index = index;
    // like the Msik bot: the next songs are looked up on YouTube while this one plays
    const next = this.queue.slice(index + 1, index + 4).filter(streams);
    if (next.length)
      post('/api/ytprefetch', {
        ids: next.filter((t) => viaVideo(t.ext)).map((t) => t.ext.id),
        songs: next.filter((t) => !viaVideo(t.ext)).map((t) => ({ title: t.title, artist: t.artist || '', duration: t.duration || 0 }))
      }).catch(() => {});
    this.position = cont ? cont.pos : 0;
    const cur = this.current;
    this.duration = cur?.duration || 0;
    if (this.native) this.#applySpeed(cur);
    if (cont) this.listen = { ...prev, last: cont.pos };
    else if (cur && reason !== 'end') this.listen = { id: cur.id, played: 0, duration: cur.duration || 0, last: 0, song: songOf(cur) };
    this.#emit('change');
    this.#updateSession();
    this.#maybeExtend();
  }

  async #maybeExtend() {
    if (this.current?.pod) return;
    if (!this.autoplay || this.repeat !== 'off' || this.fetchingMore || !this.current) return;
    if (this.queue.length - this.index - 1 >= 2) return;
    this.fetchingMore = true;
    const seq = this.queueSeq;
    try {
      let more;
      if (this.current.ext) {
        // like Spotify's autoplay: more songs in the mood of the last ones, none of the queue again
        const seeds = this.queue.slice(Math.max(0, this.index - 4), this.index + 1).filter((t) => t.artist).map((t) => ({ title: t.title, artist: t.artist }));
        const exclude = this.queue.slice(-300).map((t) => ({ title: t.title, artist: t.artist || '' }));
        if (!seeds.length) return;
        more = (await post('/api/catalog/radio', { seeds, exclude, limit: 12 })).map(extTrack);
      } else {
        const exclude = this.queue.slice(-200).map((t) => t.id).filter((id) => typeof id === 'number').join(',');
        more = await get(`/api/recommend/radio/${this.current.id}?limit=10&exclude=${exclude}`);
      }
      // the queue was replaced (or autoplay switched off) while the server was asked
      if (seq !== this.queueSeq || !this.autoplay) return;
      if (more.length) this.add(more, false);
    } catch {
    } finally {
      this.fetchingMore = false;
      // a new queue started while this answer was on its way: check that one now
      if (seq !== this.queueSeq) this.#maybeExtend();
    }
  }

  // ---------- queue control ----------
  playList(tracks, start = 0, { shuffle = false, at = 0 } = {}) {
    if (!tracks.length) return;
    this.#finishListen('skip');
    // answers (autoplay, smart shuffle) asked for an earlier queue are thrown away
    this.queueSeq = (this.queueSeq || 0) + 1;
    this.shuffleSeq = (this.shuffleSeq || 0) + 1;
    let list = tracks.slice();
    let idx = start;
    this.original = null;
    this.shuffled = false;
    if (shuffle) {
      this.original = list.slice();
      list = this.#localShuffle(list);
      idx = 0;
      this.shuffled = true;
      if (!list.some((t) => t.ext)) this.#smartShuffle(list.map((t) => t.id), 0);
    }
    this.queue = list;
    this.index = -1;
    this.listen = null;
    this.#pickEngine(list);
    this.#applySpeed(list[idx]);
    this.engine.setQueue(list.map(toItem), idx, shuffle ? 0 : at || 0, true);
    this.#emit('change');
  }
  /** Podcast speed (0.5× to 3×), kept on this device; songs always play at 1×. */
  get speed() {
    return this.podSpeed || 1;
  }
  setSpeed(r) {
    this.podSpeed = Math.min(3, Math.max(0.5, Number(r) || 1));
    try {
      localStorage.setItem('musik.podSpeed', String(this.podSpeed));
    } catch {}
    this.#applySpeed(this.current);
    this.#emit('state');
  }
  #applySpeed(cur) {
    const r = cur?.pod ? this.speed : 1;
    this.htmlEngine?.setSpeed(this.speed);
    if (this.native) this.nativeEngine.setSpeed(r);
  }
  /** Back or forward by some seconds (podcasts: 15). */
  skipBy(sec) {
    const d = this.duration || this.current?.duration || 0;
    this.seek(Math.max(0, Math.min(d ? d - 1 : Infinity, this.position + sec)));
  }

  #localShuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Ask the server for a smarter order of the upcoming songs, then reorder in place. */
  async #smartShuffle(ids, fromIndex) {
    const seq = this.shuffleSeq;
    try {
      const { ids: order } = await post('/api/recommend/shuffle', { ids: ids.slice(fromIndex + 1) });
      // shuffle was switched off (or on again, or a new list started) meanwhile
      if (seq !== this.shuffleSeq || !this.shuffled) return;
      const upcoming = this.queue.slice(this.index + 1);
      if (upcoming.length !== order.length) return;
      const byId = new Map(upcoming.map((t) => [t.id, t]));
      const sorted = order.map((id) => byId.get(id)).filter(Boolean);
      if (sorted.length !== upcoming.length) return;
      this.#replaceUpcoming(sorted);
    } catch {}
  }

  #replaceUpcoming(list) {
    const keep = this.queue.slice(0, this.index + 1);
    for (let i = this.queue.length - 1; i > this.index; i--) this.engine.remove(i);
    this.queue = keep.concat(list);
    this.engine.insert(this.index + 1, list.map(toItem));
    this.#emit('change');
  }

  toggleShuffle() {
    this.shuffleSeq = (this.shuffleSeq || 0) + 1;
    if (!this.queue.length) {
      this.shuffled = !this.shuffled;
      return this.#emit('change');
    }
    if (!this.shuffled) {
      this.original = this.queue.slice();
      const upcoming = this.#localShuffle(this.queue.slice(this.index + 1));
      this.shuffled = true;
      this.#replaceUpcoming(upcoming);
      if (!this.queue.some((t) => t.ext)) this.#smartShuffle(this.queue.map((t) => t.id), this.index);
    } else {
      this.shuffled = false;
      if (this.original && this.current) {
        // the songs still to come go back to their old order; songs added while shuffled stay at the end
        // first every entry that is still the same object keeps its old place, only then the
        // rest is matched by id (a new copy of a song must not take the place of the original)
        const used = new Set();
        const same = new Map();
        for (const t of this.queue) {
          const i = this.original.findIndex((o, k) => !used.has(k) && o === t);
          if (i >= 0) { used.add(i); same.set(t, (same.get(t) || []).concat(i)); }
        }
        const rank = (t) => {
          const own = same.get(t);
          if (own?.length) return own.shift();
          const i = this.original.findIndex((o, k) => !used.has(k) && o.id === t.id);
          if (i < 0) return Infinity;
          used.add(i);
          return i;
        };
        this.queue.slice(0, this.index + 1).forEach(rank);
        const upcoming = this.queue.slice(this.index + 1).map((t) => [rank(t), t]);
        this.#replaceUpcoming(upcoming.sort((a, b) => a[0] - b[0]).map((x) => x[1]));
      }
      this.original = null;
      this.#emit('change');
    }
  }

  /** Android: a song from another platform joined a queue that runs in the background service. */
  #moveToHtml() {
    if (!this.native || this.engine === this.htmlEngine) return false;
    const pos = this.position, playing = this.playing;
    this.engine.pause();
    this.engine = this.#html();
    this.engine.setVolume(this.volume);
    this.engine.setRepeat(this.repeat);
    // the same song goes on in the other engine: its listening session too
    this.engineSwitch = { pos };
    try {
      this.engine.setQueue(this.queue.map(toItem), this.index, pos, playing);
    } finally {
      this.engineSwitch = null;
    }
    return true;
  }

  add(tracks, toast = true) {
    if (!this.queue.length) return this.playList(tracks, 0);
    const at = this.queue.length;
    this.queue.push(...tracks);
    if (tracks.some(needsHtml) && this.#moveToHtml()) return (this.#emit('change'), toast);
    this.engine.insert(at, tracks.map(toItem));
    this.#emit('change');
    return toast;
  }

  playNext(tracks) {
    if (!this.queue.length) return this.playList(tracks, 0);
    const at = this.index + 1;
    this.queue.splice(at, 0, ...tracks);
    if (tracks.some(needsHtml) && this.#moveToHtml()) return this.#emit('change');
    this.engine.insert(at, tracks.map(toItem));
    this.#emit('change');
  }

  removeAt(i) {
    if (i < 0 || i >= this.queue.length) return;
    if (i === this.index) this.#finishListen('skip');
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    this.engine.remove(i);
    if (!this.queue.length) this.index = -1;
    this.#emit('change');
  }

  move(from, to) {
    if (from === to) return;
    const [t] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, t);
    if (this.index === from) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
    this.engine.move(from, to);
    this.#emit('change');
  }

  clearUpcoming() {
    for (let i = this.queue.length - 1; i > this.index; i--) this.engine.remove(i);
    this.queue = this.queue.slice(0, this.index + 1);
    this.#emit('change');
  }

  jump(i) {
    this.skipHint = 'skip';
    this.engine.jump(i);
  }
  toggle() {
    if (this.playing) this.engine.pause();
    else this.engine.play();
  }
  play() {
    this.engine.play();
  }
  pause() {
    this.engine.pause();
  }
  next() {
    this.skipHint = 'skip';
    this.engine.next();
  }
  prev(always = false) {
    if (this.position > 3 && !always) return this.seek(0);
    this.skipHint = 'skip';
    this.engine.prev();
  }
  seek(sec) {
    this.seekedAt = performance.now(); // the visualizer settles gently after a jump
    if (this.listen) this.listen.last = sec;
    this.engine.seek(sec);
    this.position = sec;
    this.#emit('time');
  }
  setVolume(v) {
    this.seekedAt = performance.now(); // the visualizer does not jump with the volume
    this.volume = v;
    this.engine.setVolume(v);
    this.#emit('state');
  }
  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.engine.setRepeat(this.repeat);
    this.#emit('change');
  }

  /** Update track objects (e.g. liked flag) without touching playback. */
  patch(id, fields) {
    for (const t of this.queue) if (t.id === id) Object.assign(t, fields);
    this.#emit('change');
  }

  // ---------- OS media controls (browser / desktop) ----------
  #mediaSession() {
    if (this.native || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const h = {
      play: () => this.play(),
      pause: () => this.pause(),
      nexttrack: () => this.next(),
      previoustrack: () => this.prev(),
      seekto: (d) => this.seek(d.seekTime),
      seekbackward: (d) => this.skipBy(-(d?.seekOffset || 15)),
      seekforward: (d) => this.skipBy(d?.seekOffset || 15)
    };
    for (const [k, fn] of Object.entries(h)) {
      try {
        ms.setActionHandler(k, fn);
      } catch {}
    }
  }
  #updateSession() {
    if (this.native || !('mediaSession' in navigator)) return;
    const t = this.current;
    if (!t) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist || '',
      album: t.album || '',
      artwork: t.has_cover !== false ? [{ src: coverUrl(t.id), sizes: '512x512' }] : []
    });
  }
}
