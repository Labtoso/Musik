// Queue + playback. Two engines with the same interface:
//  - HtmlEngine: <audio> element (browser, desktop)
//  - NativeEngine: Android bridge (ExoPlayer service, keeps playing in background)
import { streamUrl, coverUrl, post, get } from './api.js';
import { YouTubeAdapter, SoundCloudAdapter, SpotifyAdapter, showStage } from './engines.js';

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

class HtmlEngine extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
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
      this.#emit('error', { message: 'playback' });
      // skip broken files instead of stopping
      setTimeout(() => this.#advance('error'), 800);
    });
    a.addEventListener('ended', () => {
      if (this.repeat === 'one') {
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
  #adapter(kind) {
    if (this.adapters[kind]) return this.adapters[kind];
    const Cls = { youtube: YouTubeAdapter, soundcloud: SoundCloudAdapter, spotify: SpotifyAdapter }[kind];
    if (!Cls) return null;
    const ad = new Cls();
    const mine = (fn) => (ev) => ad === this.active && fn(ev.detail || {});
    ad.addEventListener('time', mine((d) => this.#emit('time', d)));
    ad.addEventListener('playing', mine((d) => this.#emit('playing', d)));
    ad.addEventListener('buffering', mine((d) => this.#emit('buffering', d)));
    ad.addEventListener('error', mine((d) => {
      this.#emit('error', { message: d.message || 'playback' });
      setTimeout(() => ad === this.active && this.#advance('error'), 1200);
    }));
    ad.addEventListener('ended', mine(() => {
      if (this.repeat === 'one') {
        const it = this.items[this.index];
        ad.load(it.ext.id, 0, true, it.ext.url);
        return this.#emit('index', { index: this.index, reason: 'repeat' });
      }
      this.#advance('ended');
    }));
    this.adapters[kind] = ad;
    return ad;
  }
  // ---------- equalizer (WebAudio, only for songs from the server) ----------
  setEq(eq) {
    this.eq = eq;
    if (!eq?.on && !this.ctx) return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        const src = this.ctx.createMediaElementSource(this.audio);
        this.pre = this.ctx.createGain();
        this.filters = EQ_FREQS.map((f, i) => {
          const b = this.ctx.createBiquadFilter();
          b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
          b.frequency.value = f;
          b.Q.value = 1.1;
          return b;
        });
        [src, this.pre, ...this.filters].reduce((a, b) => (a.connect(b), b)).connect(this.ctx.destination);
      }
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
  #load(i, pos, autoplay, reason) {
    const it = this.items[i];
    if (!it) return;
    this.index = i;
    const ad = it.ext ? this.#adapter(it.ext.player) : null;
    if (this.active && this.active !== ad) this.active.stop();
    if (it.ext) {
      this.audio.pause();
      this.active = ad;
      if (!ad) {
        this.#emit('index', { index: i, reason });
        return setTimeout(() => this.#advance('error'), 300);
      }
      ad.setVolume?.(this.volume);
      ad.load(it.ext.id, pos, autoplay, it.ext.url).catch(() => this.#emit('error', { message: 'playback' }));
      this.#emit('index', { index: i, reason });
      return;
    }
    this.active = null;
    showStage('');
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
    this.audio.src = it.url;
    if (pos) {
      const seek = () => {
        this.audio.currentTime = pos;
        this.audio.removeEventListener('loadedmetadata', seek);
      };
      this.audio.addEventListener('loadedmetadata', seek);
    }
    if (autoplay) this.audio.play().catch(() => this.#emit('playing', { playing: false }));
    this.#emit('index', { index: i, reason });
  }
  setQueue(items, index, pos = 0, autoplay = true) {
    this.items = items.slice();
    if (index >= 0 && index < items.length) this.#load(index, pos, autoplay, 'user');
    else {
      this.index = -1;
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
      else this.setQueue(this.items, -1);
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
    this.audio.volume = this.volume;
    this.active?.setVolume?.(this.volume);
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
  get position() {
    return this.pos;
  }
  get playing() {
    return this.isPlaying;
  }
}

function toItem(t) {
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
    this.volume = 1;
    this.autoplay = true;
    this.listen = null; // { id, played, duration, last }
    this.fetchingMore = false;
    try {
      this.pending = JSON.parse(localStorage.getItem(EVENTS_KEY)) || [];
    } catch {
      this.pending = [];
    }
    if (this.nativeEngine) this.#bind(this.nativeEngine);
    setInterval(() => this.flushEvents(), 20000);
    addEventListener('pagehide', () => this.#finishListen('partial', true));
    this.#mediaSession();
  }

  #html() {
    if (!this.htmlEngine) {
      this.htmlEngine = new HtmlEngine();
      if (this.eq) this.htmlEngine.setEq(this.eq);
      this.#bind(this.htmlEngine);
    }
    return this.htmlEngine;
  }
  /** On Android, songs from other platforms can only play in the app view, so the queue moves there. */
  #pickEngine(list) {
    if (!this.native) return;
    const want = list.some((t) => t.ext) ? this.#html() : this.nativeEngine;
    if (want === this.engine) return;
    this.engine.pause();
    this.engine = want;
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
    e.addEventListener('index', mine((ev) => this.#onIndex(ev.detail.index, ev.detail.reason)));
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

  // ---------- listening events for the recommendation engine ----------
  #finishListen(kindHint, flush = false) {
    const l = this.listen;
    if (!l) return;
    this.listen = null;
    if (typeof l.id !== 'number') return; // songs from other platforms do not count
    const dur = l.duration || this.duration || 0;
    let kind = kindHint;
    if (kind === 'auto') kind = dur && l.played >= dur * 0.9 ? 'complete' : 'partial';
    if (kind === 'skip' && dur && l.played >= dur * 0.9) kind = 'complete';
    if (kind === 'partial' && l.played < 10) return; // too short to mean anything
    this.pending.push({ trackId: l.id, kind, played: Math.round(l.played), duration: Math.round(dur), ts: Date.now() });
    this.#savePending();
    if (flush || this.pending.length >= 5) this.flushEvents();
  }
  #savePending() {
    try {
      localStorage.setItem(EVENTS_KEY, JSON.stringify(this.pending.slice(-500)));
    } catch {}
  }
  async flushEvents() {
    if (!this.pending.length || this.flushing) return;
    this.flushing = true;
    const batch = this.pending.slice(0, 200);
    try {
      await post('/api/events', { events: batch });
      this.pending.splice(0, batch.length);
      this.#savePending();
    } catch {
      /* retry later */
    } finally {
      this.flushing = false;
    }
  }

  #onIndex(index, reason) {
    const prev = this.listen;
    if (prev && (index !== this.index || reason === 'repeat' || reason === 'end')) {
      this.#finishListen(reason === 'ended' || reason === 'repeat' || reason === 'end' ? 'auto' : this.skipHint || 'skip');
    }
    this.skipHint = null;
    this.index = index;
    this.position = 0;
    const cur = this.current;
    this.duration = cur?.duration || 0;
    if (cur && reason !== 'end') this.listen = { id: cur.id, played: 0, duration: cur.duration || 0, last: 0 };
    this.#emit('change');
    this.#updateSession();
    this.#maybeExtend();
  }

  async #maybeExtend() {
    if (!this.autoplay || this.repeat !== 'off' || this.fetchingMore || !this.current || this.current.ext) return;
    if (this.queue.length - this.index - 1 >= 2) return;
    this.fetchingMore = true;
    try {
      const exclude = this.queue.slice(-200).map((t) => t.id).filter((id) => typeof id === 'number').join(',');
      const more = await get(`/api/recommend/radio/${this.current.id}?limit=10&exclude=${exclude}`);
      if (more.length) this.add(more, false);
    } catch {
    } finally {
      this.fetchingMore = false;
    }
  }

  // ---------- queue control ----------
  playList(tracks, start = 0, { shuffle = false } = {}) {
    if (!tracks.length) return;
    this.#finishListen('skip');
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
    this.engine.setQueue(list.map(toItem), idx, 0, true);
    this.#emit('change');
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
    try {
      const { ids: order } = await post('/api/recommend/shuffle', { ids: ids.slice(fromIndex + 1) });
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
        const pos = this.original.findIndex((t) => t.id === this.current.id);
        if (pos >= 0) this.#replaceUpcoming(this.original.slice(pos + 1));
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
    this.engine.setQueue(this.queue.map(toItem), this.index, pos, playing);
    return true;
  }

  add(tracks, toast = true) {
    if (!this.queue.length) return this.playList(tracks, 0);
    const at = this.queue.length;
    this.queue.push(...tracks);
    if (tracks.some((t) => t.ext) && this.#moveToHtml()) return (this.#emit('change'), toast);
    this.engine.insert(at, tracks.map(toItem));
    this.#emit('change');
    return toast;
  }

  playNext(tracks) {
    if (!this.queue.length) return this.playList(tracks, 0);
    const at = this.index + 1;
    this.queue.splice(at, 0, ...tracks);
    if (tracks.some((t) => t.ext) && this.#moveToHtml()) return this.#emit('change');
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
  prev() {
    if (this.position > 3) return this.seek(0);
    this.skipHint = 'skip';
    this.engine.prev();
  }
  seek(sec) {
    if (this.listen) this.listen.last = sec;
    this.engine.seek(sec);
    this.position = sec;
    this.#emit('time');
  }
  setVolume(v) {
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
      seekto: (d) => this.seek(d.seekTime)
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
