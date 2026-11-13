// Players for songs from other platforms, all through their official embeds / SDKs.
// Every adapter: load(id, pos, autoplay), play(), pause(), seek(sec), stop(), position, duration, playing
// and emits 'time' {position, duration}, 'playing' {playing}, 'buffering' {buffering}, 'ended', 'error'.
import { ytApi, scApi, spotify } from './sources.js';
import { get, audioOut } from './api.js';

/** The visible box the YouTube / SoundCloud players live in (their rules want the player on screen). */
export const stage = (() => {
  const el = document.createElement('div');
  el.id = 'ext-stage';
  el.className = 'ext-stage';
  el.innerHTML = '<div class="ext-yt"><div id="ext-yt"></div></div><div class="ext-sc"></div>';
  const add = () => document.body.appendChild(el);
  if (document.body) add();
  else addEventListener('DOMContentLoaded', add);
  return el;
})();
export function showStage(kind) {
  stage.dataset.kind = kind || '';
  placeStage();
}
/** Put the stage over the cover in the full screen player, or as a small box above the mini player. */
export function placeStage() {
  const fs = document.getElementById('fs');
  const cover = document.getElementById('fs-cover');
  const open = fs?.classList.contains('open');
  stage.classList.toggle('in-fs', !!open);
  if (open && cover) {
    const r = cover.getBoundingClientRect();
    const size = Math.min(r.width, r.height || r.width);
    Object.assign(stage.style, { left: r.left + (r.width - size) / 2 + 'px', top: r.top + 'px', width: size + 'px', height: size + 'px' });
  } else {
    stage.removeAttribute('style');
  }
}
addEventListener('resize', () => placeStage());

class Adapter extends EventTarget {
  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

// ---------- YouTube ----------
export class YouTubeAdapter extends Adapter {
  constructor() {
    super();
    this.p = null;
    this.ready = null;
    this.timer = null;
    this.playing = false;
  }
  async #player() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const YT = await ytApi();
      return new Promise((res) => {
        this.p = new YT.Player('ext-yt', {
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1, autoplay: 1 },
          events: {
            onReady: () => res(this.p),
            onStateChange: (e) => this.#state(e.data),
            onError: (e) => this.emit('error', { message: 'youtube_blocked', code: e?.data })
          }
        });
      });
    })();
    return this.ready;
  }
  #state(s) {
    // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    if (s === 1) {
      this.playing = true;
      this.emit('playing', { playing: true });
      this.emit('buffering', { buffering: false });
      this.#tick();
    } else if (s === 2) {
      this.playing = false;
      this.emit('playing', { playing: false });
    } else if (s === 3) this.emit('buffering', { buffering: true });
    else if (s === 0) {
      this.playing = false;
      this.emit('ended');
    }
  }
  #tick() {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.p?.getCurrentTime) return;
      this.emit('time', { position: this.position, duration: this.duration });
    }, 500);
  }
  async load(id, pos = 0, autoplay = true) {
    showStage('yt');
    const p = await this.#player();
    if (autoplay) p.loadVideoById({ videoId: id, startSeconds: pos || 0 });
    else p.cueVideoById({ videoId: id, startSeconds: pos || 0 });
  }
  play() {
    this.p?.playVideo();
  }
  pause() {
    this.p?.pauseVideo();
  }
  seek(sec) {
    this.p?.seekTo(sec, true);
  }
  setVolume(v) {
    this.p?.setVolume?.(Math.round(v * 100));
  }
  stop() {
    clearInterval(this.timer);
    try {
      this.p?.stopVideo();
    } catch {}
    this.playing = false;
  }
  get position() {
    return this.p?.getCurrentTime?.() || 0;
  }
  get duration() {
    return this.p?.getDuration?.() || 0;
  }
}

// ---------- SoundCloud ----------
export class SoundCloudAdapter extends Adapter {
  constructor() {
    super();
    this.w = null;
    this.pos = 0;
    this.dur = 0;
    this.playing = false;
  }
  async #widget(url) {
    const SC = await scApi();
    if (this.w) return this.w;
    const box = stage.querySelector('.ext-sc');
    const fr = document.createElement('iframe');
    fr.allow = 'autoplay; encrypted-media';
    fr.src = 'https://w.soundcloud.com/player/?visual=true&show_comments=false&auto_play=true&url=' + encodeURIComponent(url);
    box.appendChild(fr);
    this.w = SC.Widget(fr);
    const E = SC.Widget.Events;
    await new Promise((res) => this.w.bind(E.READY, res));
    this.w.bind(E.PLAY, () => ((this.playing = true), this.emit('playing', { playing: true })));
    this.w.bind(E.PAUSE, () => ((this.playing = false), this.emit('playing', { playing: false })));
    this.w.bind(E.FINISH, () => ((this.playing = false), this.emit('ended')));
    this.w.bind(E.ERROR, () => this.emit('error', { message: 'soundcloud' }));
    this.w.bind(E.PLAY_PROGRESS, (e) => {
      this.pos = e.currentPosition / 1000;
      this.emit('time', { position: this.pos, duration: this.dur });
    });
    this.fresh = true;
    return this.w;
  }
  async load(id, pos = 0, autoplay = true, url = '') {
    showStage('sc');
    const target = url && /soundcloud\.com/.test(url) ? url : `https://api.soundcloud.com/tracks/${id}`;
    const w = await this.#widget(target);
    const after = () => {
      w.getDuration((d) => (this.dur = d / 1000));
      if (pos) w.seekTo(pos * 1000);
      if (autoplay) w.play();
    };
    if (this.fresh) {
      this.fresh = false;
      after();
    } else w.load(target, { auto_play: autoplay, visual: true, show_comments: false, callback: after });
  }
  play() {
    this.w?.play();
  }
  pause() {
    this.w?.pause();
  }
  seek(sec) {
    this.w?.seekTo(sec * 1000);
  }
  setVolume(v) {
    this.w?.setVolume(Math.round(v * 100));
  }
  stop() {
    this.w?.pause();
    this.playing = false;
  }
  get position() {
    return this.pos;
  }
  get duration() {
    return this.dur;
  }
}

// ---------- Spotify: Web Playback SDK (Premium, browsers with DRM), else Spotify Connect ----------
export class SpotifyAdapter extends Adapter {
  constructor() {
    super();
    this.player = null;
    this.device = null;
    this.mode = null; // 'sdk' | 'connect'
    this.pos = 0;
    this.dur = 0;
    this.playing = false;
    this.cur = null;
    this.timer = null;
  }
  async #sdk() {
    if (this.mode) return this.mode;
    // the Web Playback SDK needs Widevine; app windows (WebView2, Android WebView) do not have it
    try {
      await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4;codecs="mp4a.40.2"' }] }]);
    } catch {
      return (this.mode = 'connect');
    }
    try {
      await new Promise((res, rej) => {
        if (window.Spotify?.Player) return res();
        window.onSpotifyWebPlaybackSDKReady = res;
        const s = document.createElement('script');
        s.src = 'https://sdk.scdn.co/spotify-player.js';
        s.onerror = rej;
        document.head.appendChild(s);
        setTimeout(() => rej(new Error('timeout')), 12000);
      });
      this.player = new window.Spotify.Player({ name: 'Musik', getOAuthToken: (cb) => spotify.token().then(cb).catch(() => {}), volume: 1 });
      const ok = await new Promise((res) => {
        this.player.addListener('ready', ({ device_id }) => ((this.device = device_id), res(true)));
        ['initialization_error', 'authentication_error', 'account_error'].forEach((e) => this.player.addListener(e, () => res(false)));
        this.player.addListener('player_state_changed', (s) => this.#onState(s));
        this.player.connect();
        setTimeout(() => res(false), 12000);
      });
      this.mode = ok ? 'sdk' : 'connect';
    } catch {
      this.mode = 'connect';
    }
    return this.mode;
  }
  #onState(s) {
    if (!s) return;
    const t = s.track_window?.current_track;
    this.pos = s.position / 1000;
    this.dur = s.duration / 1000;
    const was = this.playing;
    this.playing = !s.paused;
    if (was !== this.playing) this.emit('playing', { playing: this.playing });
    // finished: paused at 0 with our song now in the history
    if (s.paused && s.position === 0 && s.track_window?.previous_tracks?.some((p) => p.id === this.cur)) {
      if (!this.endedFor || this.endedFor !== this.cur) {
        this.endedFor = this.cur;
        this.emit('ended');
      }
    }
    if (t) this.emit('time', { position: this.pos, duration: this.dur });
  }
  #poll() {
    clearInterval(this.timer);
    this.timer = setInterval(async () => {
      if (this.mode === 'sdk') {
        const s = await this.player.getCurrentState();
        if (s) this.#onState(s);
        return;
      }
      try {
        const s = await spotify.api('/me/player');
        if (!s) return;
        this.pos = (s.progress_ms || 0) / 1000;
        this.dur = (s.item?.duration_ms || 0) / 1000;
        const was = this.playing;
        this.playing = !!s.is_playing;
        if (was !== this.playing) this.emit('playing', { playing: this.playing });
        this.emit('time', { position: this.pos, duration: this.dur });
        if (s.item?.id !== this.cur || (!s.is_playing && this.dur && this.pos >= this.dur - 2)) {
          if (this.endedFor !== this.cur && this.started) {
            this.endedFor = this.cur;
            this.emit('ended');
          }
        }
      } catch {}
    }, this.mode === 'sdk' ? 500 : 2000);
  }
  async load(id, pos = 0, autoplay = true) {
    showStage('');
    this.cur = id;
    this.endedFor = null;
    this.started = false;
    const mode = await this.#sdk();
    try {
      let dev = '';
      if (mode === 'sdk') dev = '?device_id=' + this.device;
      else {
        const d = await spotify.api('/me/player/devices');
        const pick = d?.devices?.find((x) => x.is_active) || d?.devices?.[0];
        if (!pick) throw new Error('spotify_no_device');
        dev = '?device_id=' + pick.id;
      }
      await spotify.api('/me/player/play' + dev, { method: 'PUT', body: JSON.stringify({ uris: ['spotify:track:' + id], position_ms: Math.round((pos || 0) * 1000) }) });
      if (!autoplay) await spotify.api('/me/player/pause' + dev, { method: 'PUT' }).catch(() => {});
      setTimeout(() => (this.started = true), 4000);
      this.#poll();
    } catch (e) {
      this.emit('error', { message: e.message || 'spotify' });
    }
  }
  play() {
    if (this.mode === 'sdk') this.player.resume();
    else spotify.api('/me/player/play', { method: 'PUT' }).catch(() => {});
  }
  pause() {
    if (this.mode === 'sdk') this.player.pause();
    else spotify.api('/me/player/pause', { method: 'PUT' }).catch(() => {});
  }
  seek(sec) {
    if (this.mode === 'sdk') this.player.seek(sec * 1000);
    else spotify.api('/me/player/seek?position_ms=' + Math.round(sec * 1000), { method: 'PUT' }).catch(() => {});
  }
  setVolume(v) {
    if (this.mode === 'sdk') this.player.setVolume(v);
  }
  stop() {
    clearInterval(this.timer);
    if (this.playing) this.pause();
    this.playing = false;
  }
  get position() {
    return this.pos;
  }
  get duration() {
    return this.dur;
  }
}

// ---------- Deezer catalog: the official 30 second preview ----------
export class DeezerAdapter extends Adapter {
  constructor() {
    super();
    this.a = new Audio();
    audioOut.add(this.a);
    this.a.preload = 'auto';
    this.a.addEventListener('timeupdate', () => this.emit('time', { position: this.a.currentTime, duration: this.a.duration || 30 }));
    this.a.addEventListener('playing', () => this.emit('playing', { playing: true }));
    this.a.addEventListener('pause', () => this.emit('playing', { playing: false }));
    this.a.addEventListener('waiting', () => this.emit('buffering', { buffering: true }));
    this.a.addEventListener('canplay', () => this.emit('buffering', { buffering: false }));
    this.a.addEventListener('ended', () => this.emit('ended'));
    this.a.addEventListener('error', () => this.emit('error', { message: 'deezer' }));
  }
  async load(id, pos = 0, autoplay = true) {
    showStage('');
    const r = await get('/api/catalog/preview/' + encodeURIComponent(id));
    this.a.src = r.preview;
    if (pos) this.a.currentTime = Math.min(pos, 29);
    if (autoplay) await this.a.play().catch(() => this.emit('playing', { playing: false }));
  }
  play() {
    this.a.play().catch(() => {});
  }
  pause() {
    this.a.pause();
  }
  seek(sec) {
    this.a.currentTime = sec;
  }
  setVolume(v) {
    this.a.volume = v;
  }
  stop() {
    this.a.pause();
  }
  get position() {
    return this.a.currentTime;
  }
  get duration() {
    return this.a.duration || 30;
  }
  get playing() {
    return !this.a.paused;
  }
}
