// Audio: sample SFX (the meme clips), a procedural synth soundtrack driven by
// the game's intensity, and a 1.6 L V6 turbo-hybrid whose revs follow the speedo.
// Everything is created lazily on the first user gesture (browser autoplay rules).
//
// Bus layout:  master ─ compressor ─ out
//                ├─ duck ─ musicBus (─ mariachiBus)
//                └─ sfxBus ─┬─ engineBus  (engine, turbo whistle, MGU-K; −6 dB under voice)
//                           ├─ ambBus     (tow, rain, grid, crowd, safety car burble)
//                           └─ one-shots  (at most MAX_ONESHOTS at once; a crash pre-empts them)
// Every synth cue is scheduled on the AudioContext clock (`at` = seconds from now), never setTimeout.
import { STORAGE_KEYS } from './config.js';
import { OPTIONAL_CLIPS, resolveClip } from './grid.js';
import { ENGINE, engineState, firingHzFromNorm } from './logic.js';
import { ARRANGEMENTS, MARIACHI_GAIN, MARIACHI_TRACKS, scheduleMariachi, setMariachiTempo } from './mariachi.js';

export const TRACKS = [...MARIACHI_TRACKS, 'synth'];

// The four meme clips that ship in assets/. The meme-pack clips (OPTIONAL_CLIPS)
// are resolved at load time from whatever files exist in assets/clips/.
const SFX_FILES = {
  gameover: 'assets/gameover.mp3',
  scream: 'assets/scream.mp3',
  pushing: 'assets/pushinglikeananimal.mp3',
  sonotright: 'assets/sonotright.mp3',
};
// Optional licensed recordings (see assets/README.md). Each has a synth fallback, and they
// play through playSfx (never the voice channel), so a missing file just means the synth.
export const SFX_OPTIONAL = {
  chequered_crowd: 'assets/sfx/chequered_crowd.ogg', // WebbFilmsUK, CC BY 4.0
  record_cheer: 'assets/sfx/record_cheer.ogg', // starlite, public domain
  wheelgun: 'assets/sfx/wheelgun.ogg', // dudebrobrodude, CC0
  radio_ping: 'assets/sfx/radio_ping.ogg', // Fenrir21, CC0
};
const MAX_ONESHOTS = 6;
// long crowd / launch beds on ambBus have their own small pool, so short cues never steal them
const MAX_AMB_ONESHOTS = 3;
// the pit limiter holds the engine at 6000 rpm
const LIMITER_NORM = (6000 - ENGINE.idleRpm) / (ENGINE.maxRpm - ENGINE.idleRpm);

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const rand = (a, b) => a + Math.random() * (b - a);
/** Close-call side → stereo position: the car's left (the top of the screen) is pan left. */
const sidePan = (side) => (typeof side === 'number' ? Math.sign(side) : side === 'up' || side === 'top' || side === 'left' ? -1 : side ? 1 : 0);
/** Asymmetric soft clip for the exhaust: adds even harmonics like a real pipe. */
function makeEngineCurve() {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const y = Math.tanh(x * 1.8 + 0.15 * x * x);
    curve[i] = y / Math.tanh(1.95);
  }
  return curve;
}
/** Soft-clip transfer curve for the radio voice. */
function makeRadioCurve() {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 2.6) / Math.tanh(2.6);
  }
  return curve;
}

const readPref = (key, fallback) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
};
const writePref = (key, v) => {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ }
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicBus = null;
    this.sfxBus = null;
    this.engineBus = null;
    this.ambBus = null;
    this.buffers = {};
    this.sfx = {}; // optional licensed recordings (SFX_OPTIONAL) that loaded
    this.synthetic = {}; // clip name -> true when it is a TTS placeholder (gets the radio filter)
    this.channelBusy = false; // a sample clip is currently playing
    this.current = null; // the clip source on the channel
    this.queue = []; // clips waiting for the channel
    this.voices = []; // live synth one-shots
    this.musicOn = readPref(STORAGE_KEYS.music, true);
    this.track = TRACKS.includes(readPref(STORAGE_KEYS.track, 'mariachi')) ? readPref(STORAGE_KEYS.track, 'mariachi') : 'mariachi';
    this.sfxOn = readPref(STORAGE_KEYS.sfx, true);
    this.lastPlayed = {};
    this.held = false; // paused on purpose: don't auto-resume
    this.wetness = 0; // last rain level, for the skid colour
    this.windDipUntil = 0; // DRS open: wind noise dips until this ctx time
    // sequencer
    this.seq = { running: false, nextNoteTime: 0, step: 0, bpm: 100, intensity: 0, timer: null };
    this.engine = null;
    this.noise = null;
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  init() {
    if (this.ctx) { this.wake(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    // iOS drops to 'interrupted' (calls, Siri, the lock screen) and Safari can start 'suspended':
    // whenever that happens outside a pause, the next tap or key brings the sound back
    this.ctx.onstatechange = () => this.armWake();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = this.musicOn ? 1 : 0;
    // broadcast-style ducking: the band drops under team radio and fades out on a crash
    this.duck = this.ctx.createGain();
    this.duck.gain.value = 1;
    this.musicBus.connect(this.duck).connect(this.master);
    this.mariachiBus = this.ctx.createGain();
    this.mariachiBus.gain.value = MARIACHI_GAIN;
    this.mariachiBus.connect(this.musicBus);
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = this.sfxOn ? 1 : 0;
    this.sfxBus.connect(this.master);
    this.engineBus = this.ctx.createGain();
    this.engineBus.connect(this.sfxBus);
    this.ambBus = this.ctx.createGain();
    this.ambBus.connect(this.sfxBus);
    this.noise = this.makeNoise();
    this.pink = this.makePink();
    this.loadAll();
    this.createEngine();
  }

  get ready() { return !!this.ctx; }

  /** Resumes a context that is not running (suspended, or iOS 'interrupted') unless we paused it. */
  wake() {
    const s = this.ctx && this.ctx.state;
    if (s && s !== 'running' && s !== 'closed' && !this.held) this.ctx.resume().catch(() => {});
  }
  /** The context stopped behind our back: retry on the next user gesture (resume needs one on iOS). */
  armWake() {
    const s = this.ctx && this.ctx.state;
    if (!s || s === 'running' || s === 'closed' || this.held || this.wakeArmed) return;
    this.wakeArmed = true;
    const events = ['pointerdown', 'touchend', 'keydown'];
    const retry = () => {
      this.wakeArmed = false;
      for (const ev of events) window.removeEventListener(ev, retry, true);
      this.wake();
    };
    for (const ev of events) window.addEventListener(ev, retry, true);
  }

  /**
   * `available` is a promise for { clips: [...filenames] } from /api/assets.
   * Optional clips (under assets/clips/) are only fetched when listed; the four
   * shipped clips are always fetched. Set it before init().
   */
  setAvailable(promise) { this.available = promise; }

  async loadAll() {
    const av = await (this.available || Promise.resolve(null)).catch(() => null);
    const wanted = Object.entries(SFX_FILES);
    for (const id of Object.keys(OPTIONAL_CLIPS)) {
      // with a server we know exactly which files exist; without one, try the shipped .wav
      const file = av ? resolveClip(id, av.clips || []) : id === 'thunder' ? null : `${id}.wav`;
      if (file) wanted.push([id, `assets/clips/${file}`]);
    }
    // licensed SFX: when the server lists assets/sfx/ only fetch what is there (any audio
    // extension with the right stem); otherwise just try the .ogg
    const sfxWanted = [];
    for (const [id, url] of Object.entries(SFX_OPTIONAL)) {
      if (av && Array.isArray(av.sfx)) {
        const f = av.sfx.find((n) => n.replace(/\.[^.]+$/, '') === id);
        if (f) sfxWanted.push([id, `assets/sfx/${f}`]);
      } else sfxWanted.push([id, url]);
    }
    const load = async (url) => {
      const res = await fetch(url);
      if (!res.ok) return null;
      return this.ctx.decodeAudioData(await res.arrayBuffer());
    };
    await Promise.all([
      ...wanted.map(async ([name, url]) => {
        try {
          const buf = await load(url);
          if (!buf) return;
          this.buffers[name] = buf;
          // the shipped TTS readings are .wav; give them a team-radio voice
          this.synthetic[name] = url.endsWith('.wav');
        } catch { /* missing asset is fine */ }
      }),
      ...sfxWanted.map(async ([name, url]) => {
        try {
          const buf = await load(url);
          if (buf) this.sfx[name] = buf;
        } catch { /* the synth fallback covers it */ }
      }),
    ]);
  }

  makeNoise() {
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  /** Two seconds of pink noise (Paul Kellet's filter): the crowd and grid beds. */
  makePink() {
    const n = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return buf;
  }

  // ---------- preferences ----------
  toggleMusic() {
    this.musicOn = !this.musicOn;
    writePref(STORAGE_KEYS.music, this.musicOn);
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(this.musicOn ? 1 : 0, this.ctx.currentTime, 0.05);
    return this.musicOn;
  }
  /** Cycles the soundtrack (mariachi → jarabe → synth); the sequencer picks it up on the next step. */
  toggleTrack() {
    return this.setTrack(TRACKS[(TRACKS.indexOf(this.track) + 1) % TRACKS.length]);
  }
  /** Selects a soundtrack by name; unknown names are ignored. */
  setTrack(name) {
    if (!TRACKS.includes(name)) return this.track;
    if (name !== this.track) this.seq.step = 0;
    this.track = name;
    writePref(STORAGE_KEYS.track, this.track);
    return this.track;
  }
  toggleSfx() {
    this.sfxOn = !this.sfxOn;
    writePref(STORAGE_KEYS.sfx, this.sfxOn);
    if (this.sfxBus) this.sfxBus.gain.setTargetAtTime(this.sfxOn ? 1 : 0, this.ctx.currentTime, 0.05);
    return this.sfxOn;
  }

  // ---------- one-shot samples: one radio channel, clips never talk over each other ----------
  /**
   * Plays a clip, or queues it if another clip is on the channel. Returns the clip name
   * when it will be heard (now or shortly), false otherwise. Queued clips expire after
   * 4.5 s and the queue holds at most two, so a burst of events never becomes a monologue.
   * `opts.onStart(name)` fires the moment the clip actually starts (so a subtitle can
   * appear in sync with the voice, not when the event happened).
   */
  play(name, opts = {}) {
    if (!this.ctx) return false;
    const { minGap = 0 } = opts;
    const now = performance.now();
    if (minGap && now - (this.lastPlayed[name] || -1e9) < minGap * 1000) return false;
    if (!this.buffers[name]) return false;
    if (this.channelBusy) {
      if (this.queue.length >= 2 || this.queue.some((q) => q.name === name)) return false;
      this.queue.push({ name, opts, at: now });
      this.lastPlayed[name] = now;
      return name;
    }
    return this.playNow(name, opts);
  }
  /** Channel finished: start the next queued clip that is still fresh, else bring the band back up. */
  nextInQueue() {
    this.channelBusy = false;
    this.current = null;
    while (this.queue.length) {
      const q = this.queue.shift();
      if (performance.now() - q.at < 4500) { this.playNow(q.name, q.opts); return; }
    }
    this.duckMusic(1, 0.35);
    this.duckEngine(1, 0.3);
  }
  /** Seconds a loaded clip runs for (0 when missing). */
  duration(name) { return this.buffers[name] ? this.buffers[name].duration : 0; }
  playNow(name, { volume = 1, rate = 1, onStart } = {}) {
    const buf = this.buffers[name];
    if (!buf) return false;
    this.lastPlayed[name] = performance.now();
    this.channelBusy = true;
    this.duckMusic(0.4, 0.08);
    this.duckEngine(0.5, 0.08); // −6 dB: the car stays audible under the voice
    if (onStart) onStart(name);
    const src = this.ctx.createBufferSource();
    this.current = src;
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    if (this.synthetic[name]) {
      // team-radio treatment: narrow band, a little crunch; key-up static + ping, squelch tail on close
      const t = this.ctx.currentTime;
      const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 420;
      const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2900;
      const peak = this.ctx.createBiquadFilter(); peak.type = 'peaking'; peak.frequency.value = 1800; peak.Q.value = 1.2; peak.gain.value = 6;
      const shaper = this.ctx.createWaveShaper();
      shaper.curve = this.radioCurve || (this.radioCurve = makeRadioCurve());
      const comp = this.ctx.createDynamicsCompressor(); comp.threshold.value = -24; comp.ratio.value = 8; comp.attack.value = 0.003;
      src.connect(hp).connect(lp).connect(peak).connect(shaper).connect(comp).connect(g).connect(this.sfxBus);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.setValueAtTime(0.0001, t + 0.14);
      g.gain.exponentialRampToValueAtTime(volume * 1.2, t + 0.18);
      this.radioClick({ ping: true });
      src.start(t + 0.16);
      src.onended = () => { this.squelchTail(); this.nextInQueue(); };
    } else {
      src.connect(g).connect(this.sfxBus);
      src.start();
      src.onended = () => this.nextInQueue();
    }
    return name;
  }
  /** Cuts the clip on air and empties the queue (a new run must not inherit the last one's voice). */
  stopClips() {
    this.queue.length = 0;
    const src = this.current;
    this.current = null;
    if (src) {
      src.onended = null;
      try { src.stop(); } catch { /* already stopped */ }
    }
    this.channelBusy = false;
    if (this.ctx) { this.duckMusic(1, 0.1); this.duckEngine(1, 0.1); }
  }

  /** Plays the first clip in `names` that is loaded. Returns its name, or false if none played. */
  playAny(names, opts) {
    for (const n of names) if (n && this.buffers[n] && this.play(n, opts)) return n;
    return false;
  }
  /** Music level under speech / on a crash: 1 = full band. */
  duckMusic(level, tc = 0.2) {
    // while the band is fading out (game over) nothing brings it back up: not a voice clip's duck to
    // 0.4, nor the end of one; startMusic clears it
    if (this.musicFading && level > 0.001) return;
    if (this.duck) this.duck.gain.setTargetAtTime(level, this.ctx.currentTime, tc);
  }
  /** Engine level under speech: 1 = full. */
  duckEngine(level, tc = 0.2) {
    if (this.engineBus) this.engineBus.gain.setTargetAtTime(level, this.ctx.currentTime, tc);
  }
  /** Which optional clips actually loaded (for the title-screen asset checklist). */
  loaded(name) { return !!this.buffers[name] || !!this.sfx[name]; }

  /**
   * Fire-and-forget sample (an SFX_OPTIONAL recording, or any loaded clip such as thunder)
   * that bypasses the voice channel and its queue. Returns true when it played, so the
   * caller can fall back to a synth: `audio.playSfx('x') || audio.synthX()`.
   * opts: volume, rate, at (s from now), dur (s, trims with a short fade), pan, minGap (s), bus.
   */
  playSfx(name, opts = {}) {
    if (!this.ctx) return false;
    const buf = this.sfx[name] || this.buffers[name];
    if (!buf) return false;
    const { volume = 1, rate = 1, at = 0, dur = 0, pan = 0, minGap = 0, bus = null } = opts;
    const now = performance.now();
    if (minGap && now - (this.lastPlayed['sfx:' + name] || -1e9) < minGap * 1000) return false;
    const len = dur || buf.duration / rate;
    const v = this.voice(at + len, { bus });
    if (!v) return false;
    this.lastPlayed['sfx:' + name] = now;
    const t = this.ctx.currentTime + at;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(volume, t);
    if (dur) { g.gain.setValueAtTime(volume, t + Math.max(0, dur - 0.06)); g.gain.linearRampToValueAtTime(0, t + dur); }
    src.connect(g);
    this.route(g, pan, v.out);
    src.start(t);
    if (dur) src.stop(t + dur + 0.02);
    return true;
  }

  // ---------- synth one-shots: voices and the shared recipe helpers ----------
  /**
   * Opens a one-shot voice lasting `len` seconds: a gain node the recipe connects into.
   * At most MAX_ONESHOTS live at once; when full, prio 0 (engine pops, ticks) is dropped
   * and anything else steals the oldest voice of equal or lower priority. prio 2 = crash.
   * Ambience beds (bus = ambBus) count against their own MAX_AMB_ONESHOTS pool instead.
   */
  voice(len, { prio = 1, bus = null } = {}) {
    if (!this.ctx) return null;
    const t = this.ctx.currentTime;
    this.voices = this.voices.filter((v) => v.end > t);
    const amb = !!bus && bus === this.ambBus;
    const pool = this.voices.filter((v) => !!v.amb === amb);
    if (pool.length >= (amb ? MAX_AMB_ONESHOTS : MAX_ONESHOTS)) {
      if (prio === 0) return null;
      let victim = null;
      for (const v of pool) if (v.prio <= prio && (!victim || v.prio < victim.prio || (v.prio === victim.prio && v.start < victim.start))) victim = v;
      if (!victim) return null;
      this.killVoice(victim, t);
    }
    const out = this.ctx.createGain();
    out.connect(bus || this.sfxBus);
    const v = { out, prio, amb, start: t, end: t + len + 0.05 };
    this.voices.push(v);
    return v;
  }
  killVoice(v, t = this.ctx.currentTime) {
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setValueAtTime(v.out.gain.value, t);
    v.out.gain.linearRampToValueAtTime(0, t + 0.015);
    v.end = 0;
    this.voices = this.voices.filter((x) => x !== v);
  }
  /** Connects `node` to `dest`, through a stereo panner when `pan` (and the browser) allow. */
  route(node, pan, dest, pan1 = pan, t0 = 0, t1 = 0) {
    if ((pan || pan1) && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), t0 || this.ctx.currentTime);
      if (pan1 !== pan && t1 > t0) p.pan.linearRampToValueAtTime(Math.max(-1, Math.min(1, pan1)), t1);
      node.connect(p).connect(dest);
    } else node.connect(dest);
  }
  /**
   * Filtered noise hit: `attack` up, then an exponential decay over `dur`. `f1` sweeps the
   * filter across the hit. `buf` picks the noise colour (white by default, this.pink for crowds).
   * Uses `dest` (a voice) when given, otherwise opens its own. Returns the voice or null.
   */
  noiseBurst({ filter = 'bandpass', freq = 1000, f1 = 0, q = 1, attack = 0.002, dur = 0.1, vol = 0.3, at = 0, pan = 0, dest = null, prio = 1, buf = null } = {}) {
    if (!this.ctx) return null;
    const v = dest || this.voice(at + attack + dur, { prio });
    if (!v) return null;
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = buf || this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + attack + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + Math.max(0.0005, attack));
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
    src.connect(f).connect(g);
    this.route(g, pan, v.out, pan, t);
    // a random offset so stacked hits don't share the same noise grain
    src.start(t, Math.random() * (src.buffer.duration - 0.1));
    src.stop(t + attack + dur + 0.02);
    return v;
  }
  /** Percussive oscillator: `attack` up, exponential decay over `dur`, optional glide f0 → f1. */
  tone({ type = 'sine', f0 = 440, f1 = 0, dur = 0.1, vol = 0.2, at = 0, attack = 0.003, pan = 0, dest = null, prio = 1 } = {}) {
    if (!this.ctx) return null;
    const v = dest || this.voice(at + dur, { prio });
    if (!v) return null;
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    if (attack > 0) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
    } else g.gain.setValueAtTime(Math.max(0.0002, vol), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    this.route(g, pan, v.out, pan, t);
    o.start(t);
    o.stop(t + dur + 0.02);
    return v;
  }
  /**
   * Sustained oscillator through an optional sweeping filter: pitch f0 → f1 over `dur`,
   * up in `attack`, held, then released over the last `release` seconds. `pan` → `pan1`
   * moves it across the stereo field. The engine-ish voices (launch, pass-by, rev surge) use it.
   */
  sweep({ type = 'sawtooth', f0 = 440, f1 = 0, dur = 0.3, vol = 0.1, at = 0, attack = 0.01, release = 0, filter = null, pan = 0, pan1 = pan, detune = 0, dest = null, prio = 1 } = {}) {
    if (!this.ctx) return null;
    const v = dest || this.voice(at + dur, { prio });
    if (!v) return null;
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const rel = Math.min(release || dur * 0.5, dur - attack);
    const o = ctx.createOscillator();
    o.type = type;
    o.detune.value = detune;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    let node = o;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = filter.type || 'lowpass';
      f.Q.value = filter.q || 0.8;
      f.frequency.setValueAtTime(filter.f0, t);
      if (filter.f1) f.frequency.exponentialRampToValueAtTime(filter.f1, t + dur);
      node = node.connect(f);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
    g.gain.setValueAtTime(Math.max(0.0002, vol), t + dur - rel);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g);
    this.route(g, pan, v.out, pan1, t, t + dur);
    o.start(t);
    o.stop(t + dur + 0.02);
    return v;
  }

  // ---------- UI blips and game cues (score feedback, not F1 sounds) ----------
  blip(freq = 880, dur = 0.08, type = 'square', vol = 0.25, at = 0) {
    return this.tone({ type, f0: freq, dur, vol, at, attack: 0 });
  }
  /** Two rising square blips: the clean-stop / good-thing chime (it used to be the DRS sound). */
  goodChime() {
    const v = this.voice(0.25);
    if (!v) return;
    this.tone({ type: 'square', f0: 660, dur: 0.09, vol: 0.18, attack: 0, dest: v });
    this.tone({ type: 'square', f0: 990, dur: 0.12, vol: 0.18, at: 0.09, attack: 0, dest: v });
  }
  overtake(vol = 0.2) {
    const v = this.voice(0.18);
    if (!v) return;
    this.tone({ type: 'triangle', f0: 523, dur: 0.06, vol, attack: 0, dest: v });
    this.tone({ type: 'triangle', f0: 784, dur: 0.1, vol, at: 0.06, attack: 0, dest: v });
  }
  /** Descending stewards' beep for a penalty. */
  penalty() { const v = this.voice(0.42); if (v) [880, 660, 440].forEach((f, i) => this.tone({ type: 'sawtooth', f0: f, dur: 0.14, vol: 0.16, at: i * 0.13, attack: 0, dest: v })); }
  /** "Safety car in this lap": three rising beeps so the restart is audible before it is visible. */
  scEnding() { const v = this.voice(0.45); if (v) [660, 784, 988].forEach((f, i) => this.tone({ type: 'square', f0: f, dur: 0.12, vol: 0.14, at: i * 0.16, attack: 0, dest: v })); }
  /** Chequered-flag fanfare. */
  fanfare() { const v = this.voice(0.52); if (v) [523, 659, 784, 1046].forEach((f, i) => this.tone({ type: 'triangle', f0: f, dur: 0.18, vol: 0.22, at: i * 0.11, attack: 0, dest: v })); }
  /** Flow multiplier went up a tier: three quick notes a semitone apart, higher each tier. */
  flowTierUp(tier = 1) {
    const v = this.voice(0.22);
    if (!v) return;
    const base = 523.25 * Math.pow(2, Math.min(12, Math.max(0, tier)) / 12);
    for (let i = 0; i < 3; i++) this.tone({ type: 'triangle', f0: base * Math.pow(2, i / 12), dur: 0.07, vol: 0.12, at: i * 0.05, attack: 0.002, dest: v });
  }
  /** First sight of a car closing from behind: a rising 520 → 780 Hz blip. */
  mirrorBlip() { this.tone({ type: 'sine', f0: 520, f1: 780, dur: 0.12, vol: 0.25, attack: 0.005 }); }

  // ---------- start ----------
  /**
   * One tick per start light. The real gantry is silent; this is game feedback. A 940 Hz triangle,
   * above the launch-control revs (≈500 Hz) so it is not masked, and loud enough to sit over them.
   */
  lightTick() { this.tone({ type: 'triangle', f0: 940, dur: 0.06, vol: 0.3, attack: 0.002 }); }
  /** Jump start: an FIA-style double tone, 2 × 1 kHz square, 80 ms on, 80 ms gap. */
  jumpStartTone() {
    const v = this.voice(0.26);
    if (!v) return;
    this.tone({ type: 'square', f0: 1000, dur: 0.08, vol: 0.1, attack: 0.002, dest: v });
    this.tone({ type: 'square', f0: 1000, dur: 0.08, vol: 0.1, at: 0.16, attack: 0.002, dest: v });
  }
  /**
   * The grid around you: band-passed crowd/air noise plus five detuned V6s rev-bouncing at
   * 3–5 Hz, panned wide. `level` 0..1 (drop it ~2 dB per light); 0 hushes it in about 80 ms.
   */
  gridAmbience(level) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    level = clamp01(level);
    if (level <= 0) {
      if (this.grid) {
        const g = this.grid;
        this.grid = null;
        g.out.gain.cancelScheduledValues(t);
        g.out.gain.setTargetAtTime(0, t, 0.025);
        for (const s of g.srcs) s.stop(t + 0.4);
      }
      return;
    }
    if (!this.grid) {
      const out = ctx.createGain(); out.gain.value = 0;
      out.connect(this.ambBus);
      const srcs = [];
      const bed = ctx.createBufferSource(); bed.buffer = this.pink; bed.loop = true;
      const bbp = ctx.createBiquadFilter(); bbp.type = 'bandpass'; bbp.frequency.value = 700; bbp.Q.value = 0.6;
      const bg = ctx.createGain(); bg.gain.value = 0.5;
      bed.connect(bbp).connect(bg).connect(out);
      bed.start(t, Math.random()); srcs.push(bed);
      for (let i = 0; i < 5; i++) {
        // launch-control revs sit around 10,000–11,000 rpm: 500–550 Hz firing
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = firingHzFromNorm(rand(0.72, 0.85));
        const lfo = ctx.createOscillator(); lfo.type = 'triangle'; lfo.frequency.value = rand(3, 5);
        const depth = ctx.createGain(); depth.gain.value = rand(50, 70); // ±4 % in cents
        lfo.connect(depth).connect(o.detune);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400; lp.Q.value = 0.7;
        const g = ctx.createGain(); g.gain.value = 0.11;
        o.connect(lp).connect(g);
        this.route(g, -0.85 + (i / 4) * 1.7, out);
        o.start(t); lfo.start(t);
        srcs.push(o, lfo);
      }
      this.grid = { out, srcs };
    }
    this.grid.out.gain.setTargetAtTime(level * 0.12, t, 0.15);
  }
  /** Five engine voices sweeping f0 → f1 across the stereo field: the pack launching or surging. */
  packSweep(v, { f0, f1, dur, vol, at = 0 }) {
    for (let i = 0; i < 5; i++) {
      this.sweep({
        type: 'sawtooth', f0: f0 * rand(0.94, 1.06), f1: f1 * rand(0.95, 1.05), dur: dur * rand(0.9, 1.1), vol,
        at: at + rand(0, 0.06), attack: 0.08, release: dur * 0.55, filter: { type: 'lowpass', f0: 800, f1: 3200, q: 0.7 },
        pan: -0.85 + (i / 4) * 1.7, dest: v,
      });
    }
  }
  /**
   * On the grid (before the lights go out): the engine holds about 10,000 rpm with a 4 Hz ±4 %
   * launch-control bounce, and climbs when → is held. Call every frame; on=false hands back to the speedo.
   */
  setGridRevs(on, held = false) {
    const e = this.engine;
    if (!e) return;
    if (!on) { e.grid = null; return; }
    if (!e.grid) e.grid = { phase: Math.random(), hz: rand(3, 5) };
    e.grid.held = !!held;
  }
  /**
   * Every continuous cue off at once (a restart, a retirement): the grid bed, the safety car's
   * burble, the damage scrape, the limiter and the grid revs. Pause needs none of this: the
   * context is suspended, which freezes them all.
   */
  stopLoops() {
    if (!this.ctx) return;
    this.gridAmbience(0);
    this.scCarBurble(false);
    this.updateScrape(0);
    this.pitLimiter(false, { beep: false });
    this.setGridRevs(false);
    this.windDipUntil = 0;
  }
  /** Lights out: hush, then the whole grid launches, a wheelspin chirp, and the crowd goes up. */
  launch() {
    if (!this.ctx) return;
    this.gridAmbience(0);
    const v = this.voice(2.2, { bus: this.ambBus });
    if (!v) return;
    this.packSweep(v, { f0: firingHzFromNorm(0.8), f1: firingHzFromNorm(1.05), dur: 1.1, vol: 0.035, at: 0.08 });
    this.noiseBurst({ filter: 'bandpass', freq: 800, f1: 1200, q: 4, attack: 0.02, dur: 0.25, vol: 0.8, at: 0.08, dest: v });
    this.noiseBurst({ buf: this.pink, filter: 'bandpass', freq: 1000, q: 0.5, attack: 0.4, dur: 1.6, vol: 0.16, at: 0.1, dest: v });
  }

  // ---------- passes and near misses ----------
  /**
   * Doppler pass-by of another V6. `relSpeed` is the closing speed in m/s (clamped 5..80;
   * 30 m/s ≈ ±9 % pitch). The voice pans panFrom → panTo (+0.8 → −0.8 when you pass, the
   * reverse when you are passed) with a bell-shaped level. The score chime plays at −12 dB
   * underneath unless `chime: false`.
   */
  passBy(relSpeed = 30, panFrom = 0.8, panTo = -0.8, { chime = true } = {}) {
    if (!this.ctx) return;
    const v = this.voice(0.7);
    if (!v) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 0.6;
    const k = Math.max(5, Math.min(80, Math.abs(relSpeed))) / 343;
    const f0 = firingHzFromNorm(rand(0.75, 0.95));
    const N = 32;
    const pitch = new Float32Array(N), level = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      // the pitch drops fastest at the closest approach, the level peaks there
      pitch[i] = f0 * (1 - k * Math.tanh((x - 0.5) * 6) / Math.tanh(3));
      level[i] = Math.max(0.0001, Math.exp(-(((x - 0.5) / 0.2) ** 2)));
    }
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueCurveAtTime(level.map((l) => l * 0.1), t, dur);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.8;
    for (const [ratio, gain] of [[1, 1], [0.5, 0.45]]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueCurveAtTime(pitch.map((p) => p * ratio), t, dur);
      const og = ctx.createGain(); og.gain.value = gain;
      o.connect(og).connect(lp);
      o.start(t); o.stop(t + dur + 0.02);
    }
    lp.connect(g);
    this.route(g, panFrom, v.out, panTo, t, t + dur);
    if (chime) this.overtake(0.05);
  }
  /** Close call: a band-passed whoosh 2 kHz → 600 Hz, panned to the side it went by; `scrape` adds a 4 kHz grain. */
  closeWhoosh(side = 0, scrape = false) {
    const v = this.voice(0.32);
    if (!v) return;
    const pan = sidePan(side) * 0.6;
    this.noiseBurst({ filter: 'bandpass', freq: 2000, f1: 600, q: 1.2, attack: 0.03, dur: 0.25, vol: 0.32, pan, dest: v });
    if (scrape) this.scrapeGrain(side, v);
  }
  /** Scrape: five 4 kHz grains, paint on paint, on the side it happened (its own voice unless `dest`). */
  scrapeGrain(side = 0, dest = null) {
    const v = dest || this.voice(0.18);
    if (!v) return;
    const pan = sidePan(side) * 0.6;
    for (let i = 0; i < 5; i++) this.noiseBurst({ filter: 'highpass', freq: 4000, attack: 0.001, dur: 0.008, vol: 0.14, at: 0.02 + i * 0.025 + rand(0, 0.01), pan, dest: v });
  }

  // ---------- pit lane ----------
  /**
   * Pit limiter on/off: 6000 rpm, a 10 Hz ignition-cut stutter with pops, a double dash beep on
   * entry. `beep: false` switches it silently (off in the box while the engine idles, back on to roll out).
   */
  pitLimiter(on, { beep = true } = {}) {
    const e = this.engine;
    if (!e || e.limiter === !!on) return;
    e.limiter = !!on;
    const t = this.ctx.currentTime;
    e.limGain.gain.setTargetAtTime(on ? 0.65 : 1, t, 0.02);
    e.limDepth.gain.setTargetAtTime(on ? 0.35 : 0, t, 0.02); // square LFO ±0.35 around 0.65: 70 % depth
    if (on && beep) {
      const v = this.voice(0.25);
      if (v) { this.tone({ type: 'square', f0: 1000, dur: 0.07, vol: 0.09, attack: 0.002, dest: v }); this.tone({ type: 'square', f0: 1000, dur: 0.07, vol: 0.09, at: 0.12, attack: 0.002, dest: v }); }
    }
  }
  /** Front jack slams in: a metal clank (noise plus damped 900 Hz and 1.4 kHz). */
  jackClank() {
    const v = this.voice(0.15);
    if (!v) return;
    this.noiseBurst({ filter: 'bandpass', freq: 1200, q: 1, attack: 0.001, dur: 0.06, vol: 0.25, dest: v });
    this.tone({ type: 'sine', f0: 900, dur: 0.12, vol: 0.18, attack: 0.001, dest: v });
    this.tone({ type: 'sine', f0: 1400, dur: 0.1, vol: 0.12, attack: 0.001, dest: v });
  }
  /** Jacks down: an air hiss, then the car lands on its suspension. */
  jacksDown() {
    const v = this.voice(0.32);
    if (!v) return;
    this.noiseBurst({ filter: 'highpass', freq: 2000, attack: 0.005, dur: 0.2, vol: 0.2, dest: v });
    this.tone({ type: 'sine', f0: 55, dur: 0.1, vol: 0.22, at: 0.18, attack: 0.004, dest: v });
  }
  /**
   * Wheel gun hit: air-motor whirr (900 → 1600 Hz), the impact hammer at 30 Hz for 250 ms,
   * then the spin-down pssht. `count` guns fire together, staggered up to 60 ms. Uses the
   * optional wheelgun recording (pitched up 4 semitones, trimmed to 0.3 s) when it loaded.
   */
  wheelGun(count = 1) {
    if (!this.ctx) return;
    if (this.sfx.wheelgun) {
      for (let i = 0; i < count; i++) this.playSfx('wheelgun', { rate: 1.26, dur: 0.3, at: i ? rand(0.01, 0.06) : 0, volume: 0.5, pan: count > 1 ? rand(-0.5, 0.5) : 0 });
      return;
    }
    const v = this.voice(0.5);
    if (!v) return;
    for (let i = 0; i < count; i++) {
      const at = i ? rand(0.01, 0.06) : 0;
      const pan = count > 1 ? rand(-0.5, 0.5) : 0;
      const vol = 1 / Math.pow(count, 0.3);
      this.sweep({ type: 'sawtooth', f0: 900, f1: 1600, dur: 0.08, vol: 0.07 * vol, at, attack: 0.005, release: 0.02, filter: { type: 'bandpass', f0: 1200, f1: 1800, q: 2 }, pan, dest: v });
      for (let k = 0; k < 8; k++) this.noiseBurst({ filter: 'bandpass', freq: 3000, q: 3, attack: 0.0005, dur: 0.006, vol: 0.35 * vol, at: at + 0.07 + k / 30, pan, dest: v });
      this.noiseBurst({ filter: 'highpass', freq: 3000, attack: 0.004, dur: 0.1, vol: 0.09 * vol, at: at + 0.33, pan, dest: v });
    }
  }
  /** Wheel gun miss: the gun bogs down and sputters out. */
  gunStall() {
    const v = this.voice(0.7);
    if (!v) return;
    this.sweep({ type: 'sawtooth', f0: 1400, f1: 350, dur: 0.45, vol: 0.06, attack: 0.005, release: 0.2, filter: { type: 'bandpass', f0: 1500, f1: 700, q: 2 }, dest: v });
    let at = 0.03;
    [0.03, 0.04, 0.055, 0.075, 0.1, 0.13].forEach((gap, i) => {
      this.noiseBurst({ filter: 'bandpass', freq: 2600, q: 3, attack: 0.0005, dur: 0.008, vol: 0.28 * (1 - i * 0.12), at, dest: v });
      at += gap;
    });
    this.noiseBurst({ filter: 'highpass', freq: 2500, attack: 0.01, dur: 0.12, vol: 0.05, at: at + 0.02, dest: v });
  }
  /** Released from the box: limiter off, a full-throttle rev and a wheelspin chirp. */
  pitRelease() {
    this.pitLimiter(false);
    if (this.engine) this.engine.revT = 0.5;
    this.noiseBurst({ filter: 'bandpass', freq: 800, f1: 1200, q: 4, attack: 0.02, dur: 0.25, vol: 0.8 });
  }

  // ---------- safety car ----------
  /** Safety car deployed: radio key-up, a triple dash beep, the engine bed pushed down for a second. No siren: F1 has none. */
  scAlert() {
    if (!this.ctx) return;
    this.radioClick();
    const v = this.voice(0.55);
    if (v) for (let i = 0; i < 3; i++) this.tone({ type: 'sine', f0: 2000, dur: 0.09, vol: 0.12, at: 0.1 + i * 0.15, attack: 0.003, dest: v });
    const e = this.engine;
    if (e) {
      const t = this.ctx.currentTime;
      e.out.gain.cancelScheduledValues(t);
      e.out.gain.setTargetAtTime(0.35, t, 0.05);
      e.out.gain.setTargetAtTime(1, t + 1, 0.25);
    }
  }
  /** The safety car's road-car V8 burbling on screen (call with on=false when it leaves). */
  scCarBurble(on) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (!this.scNode) {
      if (!on) return;
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 90;
      const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 45.4;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 1.2;
      const am = ctx.createGain(); am.gain.value = 0.6;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 7.3;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.4;
      lfo.connect(lfoG).connect(am.gain);
      const g = ctx.createGain(); g.gain.value = 0;
      o.connect(lp); o2.connect(lp); lp.connect(am).connect(g).connect(this.ambBus);
      o.start(); o2.start(); lfo.start();
      this.scNode = { g };
    }
    this.scNode.g.gain.setTargetAtTime(on ? 0.06 : 0, ctx.currentTime, on ? 0.3 : 0.5);
  }
  /** "Safety car in this lap": its lights go off, two relay clicks. */
  scLightsOff() {
    const v = this.voice(0.2);
    if (!v) return;
    for (let i = 0; i < 2; i++) this.noiseBurst({ filter: 'bandpass', freq: 2500, q: 2, attack: 0.0005, dur: 0.01, vol: 0.25, at: i * 0.12, dest: v });
  }
  /** Green flag: the whole field revs up at once. */
  fieldRevSurge() {
    const v = this.voice(1.4, { bus: this.ambBus });
    if (v) this.packSweep(v, { f0: firingHzFromNorm(0.35), f1: firingHzFromNorm(1), dur: 1.2, vol: 0.035 });
  }

  // ---------- car ----------
  /** DRS flap opens: a short actuator click, then the wind noise dips for 1.5 s. */
  drsOpen() {
    if (!this.ctx) return;
    this.noiseBurst({ filter: 'bandpass', freq: 2000, q: 1.5, attack: 0.001, dur: 0.025, vol: 0.5 });
    this.windDipUntil = this.ctx.currentTime + 1.5;
  }
  /** 1 normally, about 0.55 while the DRS flap is open. */
  windFactor() { return this.ctx && this.ctx.currentTime < this.windDipUntil ? 0.55 : 1; }
  /** Carbon on carbon: a short, dull crunch for contact you survive (the crash noise is the long one). */
  crunch(vol = 0.5) {
    this.noiseBurst({ filter: 'lowpass', freq: 1800, f1: 200, q: 0.7, attack: 0.002, dur: 0.3, vol: Math.min(0.8, vol) });
  }
  /**
   * The big one: a 20 ms carbon crack, the body crunch sweeping 2 kHz → 150 Hz over 0.6 s, then
   * 6–10 debris tinkles over 0.8 s. Pre-empts every other one-shot (not the voice clips) and
   * stalls the engine.
   */
  crash() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const v of [...this.voices]) this.killVoice(v, t);
    this.stallEngine(t);
    if (this.ersNode) { this.ersNode.dg.gain.setTargetAtTime(0, t, 0.05); this.ersNode.hg.gain.setTargetAtTime(0, t, 0.05); }
    if (this.scrapeNode) this.scrapeNode.g.gain.setTargetAtTime(0, t, 0.05);
    const v = this.voice(1.2, { prio: 2 });
    if (!v) return;
    this.noiseBurst({ filter: 'highpass', freq: 800, attack: 0.001, dur: 0.02, vol: 0.85, dest: v });
    this.noiseBurst({ filter: 'lowpass', freq: 2000, f1: 150, q: 0.7, attack: 0.012, dur: 0.6, vol: 1, at: 0.008, dest: v });
    const n = 6 + Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i++) {
      this.noiseBurst({ filter: 'bandpass', freq: rand(2000, 5000), q: 6, attack: 0.001, dur: rand(0.01, 0.03), vol: rand(0.1, 0.22), at: 0.12 + rand(0, 0.8), pan: rand(-0.6, 0.6), dest: v });
    }
  }
  /**
   * Tyre lock-up / squeal: noise through a narrow band (Q 10) at 1.0–1.6 kHz with a 6 Hz
   * ±40 Hz wobble and a faint 2nd harmonic. Slicks squeal less than road tyres, so it is
   * short; in the wet it sits at 1.8 kHz with more hiss.
   */
  skid(vol = 0.35) {
    if (!this.ctx) return;
    const wet = this.wetness > 0.3;
    const dur = wet ? 0.45 : 0.38;
    const v = this.voice(dur + 0.05);
    if (!v) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const f = wet ? 1800 : rand(1000, 1150);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(vol * 0.85, t + 0.02);
    env.gain.setValueAtTime(vol * 0.85, t + dur - 0.12);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    env.connect(v.out);
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 6;
    const jitter = ctx.createGain(); jitter.gain.value = 40;
    lfo.connect(jitter);
    for (const [mul, gain] of [[1, 1], [2, 0.3]]) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 10;
      bp.frequency.setValueAtTime(f * mul, t);
      bp.frequency.linearRampToValueAtTime((wet ? f : Math.min(1600, f * 1.4)) * mul, t + dur);
      jitter.connect(bp.frequency);
      const g = ctx.createGain(); g.gain.value = gain;
      src.connect(bp).connect(g).connect(env);
    }
    if (wet) {
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4000;
      const g = ctx.createGain(); g.gain.value = 0.12;
      src.connect(hp).connect(g).connect(env);
    }
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
    lfo.start(t); lfo.stop(t + dur + 0.02);
  }
  /** Wing or floor dragging on the tarmac: looped 3 kHz+ hiss with an irregular crackle. level 0..1. */
  updateScrape(level) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (!this.scrapeNode) {
      if (!(level > 0)) return;
      const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
      // two square LFOs at unrelated rates gate the hiss into crackle
      const gate = ctx.createGain(); gate.gain.value = 0.5;
      for (const [hz, depth] of [[13, 0.25], [29, 0.25]]) {
        const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = hz;
        const lg = ctx.createGain(); lg.gain.value = depth;
        lfo.connect(lg).connect(gate.gain);
        lfo.start();
      }
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(hp).connect(gate).connect(g).connect(this.sfxBus);
      src.start();
      this.scrapeNode = { g };
    }
    this.scrapeNode.g.gain.setTargetAtTime(clamp01(level) * 0.05, ctx.currentTime, 0.08);
  }

  // ---------- crowd ----------
  /** Air horn stab: detuned saws at 440 Hz with a minor-third partner, band-passed 500 Hz–3 kHz. */
  airHorn(v, at, hold = 0.5) {
    for (const [f, vol] of [[440, 0.045], [446, 0.035], [440 * 1.19, 0.035]]) {
      this.sweep({ type: 'sawtooth', f0: f, dur: 0.03 + hold + 0.08, vol, at, attack: 0.03, release: 0.08, filter: { type: 'bandpass', f0: 1200, q: 0.6 }, dest: v });
    }
  }
  /** Chequered flag: the crowd-and-air-horns recording if it is installed, else a pink-noise roar with horn stabs. */
  chequeredCrowd() {
    if (!this.ctx || this.playSfx('chequered_crowd', { volume: 0.6, bus: this.ambBus })) return;
    const v = this.voice(4.2, { bus: this.ambBus });
    if (!v) return;
    this.noiseBurst({ buf: this.pink, filter: 'bandpass', freq: 950, q: 0.35, attack: 0.4, dur: 3.6, vol: 0.2, dest: v });
    const stabs = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < stabs; i++) this.airHorn(v, 0.35 + i * rand(0.7, 0.9), rand(0.4, 0.6));
  }
  /** Record pit stop: a short cheer (recording if installed, else a quick crowd swell). */
  recordStopCheer() {
    if (!this.ctx || this.playSfx('record_cheer', { volume: 0.6, dur: 2, bus: this.ambBus })) return;
    this.noiseBurst({ buf: this.pink, filter: 'bandpass', freq: 1100, q: 0.4, attack: 0.25, dur: 1.4, vol: 0.16 });
  }

  // ---------- engine: procedural 1.6 L V6 turbo-hybrid, or real loops when assets/engine/*.wav exist ----------
  createEngine() {
    const ctx = this.ctx;
    const master = ctx.createGain();
    master.gain.value = 0;
    // exhaust colouring shared by both sources: two formant peaks, soft clip, a little air
    const f1 = ctx.createBiquadFilter(); f1.type = 'peaking'; f1.frequency.value = 450; f1.Q.value = 1.1; f1.gain.value = 6;
    const f2 = ctx.createBiquadFilter(); f2.type = 'peaking'; f2.frequency.value = 1400; f2.Q.value = 1.4; f2.gain.value = 5;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 60;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.engineCurve || (this.engineCurve = makeEngineCurve());
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 6; comp.attack.value = 0.005; comp.release.value = 0.12;
    // pit limiter: a 10 Hz square LFO chops the level (depth 0 until pitLimiter(true))
    const limGain = ctx.createGain(); limGain.gain.value = 1;
    const limLfo = ctx.createOscillator(); limLfo.type = 'square'; limLfo.frequency.value = 10;
    const limDepth = ctx.createGain(); limDepth.gain.value = 0;
    limLfo.connect(limDepth).connect(limGain.gain);
    limLfo.start();
    // the bed the safety-car alert pushes down; the turbo whistle joins here (an ignition cut doesn't stop the turbine)
    const out = ctx.createGain(); out.gain.value = 1;
    hp.connect(f1).connect(f2).connect(shaper).connect(comp).connect(master).connect(limGain).connect(out).connect(this.engineBus);

    // --- procedural V6 ---
    // 90° V6 firing at rpm/60 × 3: the fundamental, a once-per-rev half for the uneven firing, and two upper partials
    const oscs = [
      { type: 'sawtooth', ratio: 1, gain: 0.5 },
      { type: 'sawtooth', ratio: 0.5, gain: 0.175 },
      { type: 'sawtooth', ratio: 1.5, gain: 0.075 },
      { type: 'sawtooth', ratio: 2, gain: 0.1 },
    ].map((spec) => {
      const o = ctx.createOscillator();
      o.type = spec.type;
      const g = ctx.createGain();
      g.gain.value = spec.gain;
      o.connect(g);
      o.start();
      return { o, g, ratio: spec.ratio };
    });
    const synthBus = ctx.createGain();
    synthBus.gain.value = 1;
    for (const { g } of oscs) g.connect(synthBus);
    // intake / exhaust turbulence: noise around twice the firing frequency
    const noise = ctx.createBufferSource();
    noise.buffer = this.noise;
    noise.loop = true;
    const nbp = ctx.createBiquadFilter(); nbp.type = 'bandpass'; nbp.Q.value = 0.9;
    const ng = ctx.createGain(); ng.gain.value = 0.06;
    noise.connect(nbp).connect(ng).connect(synthBus);
    noise.start();
    // slow wobble so a held rpm never sounds static
    const lfo = ctx.createOscillator(); lfo.frequency.value = 6.3;
    const lfoG = ctx.createGain(); lfoG.gain.value = 3;
    lfo.connect(lfoG);
    for (const { o } of oscs) lfoG.connect(o.detune);
    lfo.start();
    // throttle-body tone control: 1.2 kHz off throttle → 4 kHz flat out, 900 Hz on a lift
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.Q.value = 1; tone.frequency.value = 1200;
    synthBus.connect(tone).connect(hp);

    // --- turbo / MGU-H whistle: compressor blade-pass whine (artistic, plausible), follows boost not rpm ---
    const wh = ctx.createOscillator(); wh.type = 'sine'; wh.frequency.value = 6000;
    const wh2 = ctx.createOscillator(); wh2.type = 'triangle'; wh2.frequency.value = 2500;
    const whG = ctx.createGain(); whG.gain.value = 0;
    const wh2G = ctx.createGain(); wh2G.gain.value = 0;
    wh.connect(whG).connect(out); wh2.connect(wh2G).connect(out);
    wh.start(); wh2.start();

    // --- real loops (optional) ---
    const sampleBus = ctx.createGain();
    sampleBus.gain.value = 0;
    sampleBus.connect(hp);

    this.engine = {
      master, out, limGain, limDepth, oscs, nbp, ng, tone, synthBus, sampleBus, wh, wh2, whG, wh2G,
      gear: 1, rpm: 0.3, cut: 0, blipT: 0, revT: 0, boost: 0, lift: 0, liftCool: 0, thrHist: [],
      limiter: false, limPhase: 0, grid: null, stalled: false, running: false, throttle: 0, speedRatio: 0, loops: null,
    };
    this.loadEngineLoops();
  }

  /**
   * Looks for assets/engine/low.* and high.* (idle-ish and near-redline loops of a real
   * engine). When both decode, they replace the synth: pitch-tracked and crossfaded by rpm.
   */
  async loadEngineLoops() {
    const av = await (this.available || Promise.resolve(null)).catch(() => null);
    const files = av?.engine || [];
    const find = (stem) => files.find((f) => f.replace(/\.[^.]+$/, '') === stem);
    const lowF = find('low'), highF = find('high');
    if (!lowF || !highF || !this.engine) return;
    try {
      const load = async (f) => this.ctx.decodeAudioData(await (await fetch(`assets/engine/${f}`)).arrayBuffer());
      const [low, high] = await Promise.all([load(lowF), load(highF)]);
      const mk = (buf) => {
        const src = this.ctx.createBufferSource();
        src.buffer = buf; src.loop = true;
        const g = this.ctx.createGain(); g.gain.value = 0;
        src.connect(g).connect(this.engine.sampleBus);
        src.start();
        return { src, g };
      };
      this.engine.loops = { low: mk(low), high: mk(high) };
      this.engine.synthBus.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
      this.engine.sampleBus.gain.setTargetAtTime(1, this.ctx.currentTime, 0.3);
    } catch { /* fall back to the synth */ }
  }

  /**
   * Called every frame. speedRatio 0..1 of max speed; running=false silences the engine;
   * throttle 0..1 shapes loudness/tone; boosting adds a harder edge.
   */
  updateEngine(dt, speedRatio, running, throttle = 1, boosting = false) {
    if (!this.engine) return;
    const e = this.engine;
    const t = this.ctx.currentTime;
    e.running = running;
    e.throttle = throttle;
    e.speedRatio = speedRatio;
    if (e.stalled) {
      if (!running) return; // let the stall play out
      this.unstallEngine(t);
    }
    const { gear, rpmNorm } = engineState(speedRatio);
    const load = clamp01(0.55 + throttle * 0.45 + (boosting ? 0.15 : 0));
    const vol0 = 0.16 * load * (0.6 + 0.4 * Math.min(1, e.rpm)) * (1 - 0.4 * e.lift);
    if (gear !== e.gear) {
      if (gear > e.gear && running) {
        // upshift: a 40 ms ignition cut with an exhaust crack, the revs drop at once and glide on
        e.cut = 0.04;
        e.master.gain.cancelScheduledValues(t);
        e.master.gain.setTargetAtTime(vol0 * 0.1, t, 0.003);
        e.master.gain.setTargetAtTime(vol0, t + 0.04, 0.01);
        e.rpm = Math.max(rpmNorm, e.rpm - 0.28);
        this.gearClunk(gear);
      } else if (gear < e.gear && running) {
        // downshift: an auto-blip over the redline and a crackle of overrun pops
        e.blipT = 0.06;
        this.overrunPops(1 + Math.floor(Math.random() * 3));
      }
      e.gear = gear;
    }
    e.cut = Math.max(0, e.cut - dt);
    e.blipT = Math.max(0, e.blipT - dt);
    e.revT = Math.max(0, e.revT - dt);
    e.liftCool = Math.max(0, e.liftCool - dt);
    // standing still (in the box) is true idle, 4000 rpm; the gearbox model never drops below 0.3 on the move
    let target = e.limiter ? LIMITER_NORM : speedRatio <= 0 ? 0 : rpmNorm;
    if (e.grid) {
      // launch control: ±0.05 of the rev range is ±4 % of the firing frequency at 10,000 rpm
      e.grid.phase = (e.grid.phase + dt * e.grid.hz) % 1;
      target = (e.grid.held ? 0.87 : 0.75) + 0.05 * Math.sin(e.grid.phase * Math.PI * 2);
    }
    if (e.revT > 0) target = 0.95;
    if (e.blipT > 0) target += 0.15;
    e.rpm += (target - e.rpm) * Math.min(1, dt * (e.grid ? 25 : target < e.rpm ? 9 : e.blipT > 0 ? 30 : 5));
    // lift: throttle down by more than 0.4 inside 100 ms → wastegate pssh, then a duller, quieter burble with pops
    e.thrHist.push([t, throttle]);
    while (e.thrHist.length && e.thrHist[0][0] < t - 0.1) e.thrHist.shift();
    const recent = Math.max(...e.thrHist.map((h) => h[1]));
    if (running && !e.limiter && e.liftCool <= 0 && recent - throttle > 0.4) {
      e.liftCool = 0.5;
      this.noiseBurst({ filter: 'highpass', freq: 4000, attack: 0.005, dur: 0.15, vol: 0.1 });
    }
    const liftTarget = e.limiter || e.revT > 0 ? 0 : clamp01((0.25 - throttle) / 0.2);
    e.lift += (liftTarget - e.lift) * Math.min(1, dt * 8);
    if (running && e.lift > 0.5 && e.rpm > 0.35 && Math.random() < dt * 2.5) this.overrunPops(1, 0.25);
    // turbo boost spools with rpm × throttle: τ 0.3 s up, 0.6 s down
    const boostTarget = running ? clamp01(Math.min(1, e.rpm) * (e.revT > 0 ? 1 : throttle) + (boosting ? 0.1 : 0)) : 0;
    e.boost += (boostTarget - e.boost) * (1 - Math.exp(-dt / (boostTarget > e.boost ? 0.3 : 0.6)));
    if (!running) {
      e.master.gain.setTargetAtTime(0, t, 0.06);
      e.whG.gain.setTargetAtTime(0, t, 0.1);
      e.wh2G.gain.setTargetAtTime(0, t, 0.1);
      return;
    }
    const vol = 0.16 * load * (0.6 + 0.4 * Math.min(1, e.rpm)) * (1 - 0.4 * e.lift);
    if (e.cut <= 0) e.master.gain.setTargetAtTime(vol, t, 0.06);
    // pit limiter: a pop on most ignition cuts
    if (e.limiter) {
      e.limPhase += dt * 10;
      while (e.limPhase >= 1) { e.limPhase -= 1; if (Math.random() < 0.6) this.overrunPops(1, 0.18); }
    }
    // live firing frequency from the smoothed rpm
    const fHz = firingHzFromNorm(e.rpm);
    for (const { o, ratio } of e.oscs) o.frequency.setTargetAtTime(fHz * ratio, t, 0.02);
    e.nbp.frequency.setTargetAtTime(fHz * 2, t, 0.03);
    e.ng.gain.setTargetAtTime((0.04 + 0.1 * Math.min(1, e.rpm) * throttle) * this.windFactor(), t, 0.05);
    const open = 1200 + 2800 * clamp01(throttle * (0.7 + 0.3 * Math.min(1, e.rpm)) + (boosting ? 0.15 : 0));
    e.tone.frequency.setTargetAtTime(open + (900 - open) * e.lift, t, 0.04);
    e.wh.frequency.setTargetAtTime(6000 + 3000 * e.boost, t, 0.05);
    e.wh2.frequency.setTargetAtTime(2200 + 700 * e.boost, t, 0.05);
    e.whG.gain.setTargetAtTime(0.012 + 0.038 * e.boost, t, 0.05);
    e.wh2G.gain.setTargetAtTime((0.012 + 0.038 * e.boost) * 0.3, t, 0.05);
    if (e.loops) {
      // real loops: assume `low` was recorded near idle and `high` near the redline
      const x = Math.min(1, e.rpm);
      e.loops.low.g.gain.setTargetAtTime(Math.cos(x * Math.PI / 2) * 0.9, t, 0.05);
      e.loops.high.g.gain.setTargetAtTime(Math.sin(x * Math.PI / 2) * 0.9, t, 0.05);
      e.loops.low.src.playbackRate.setTargetAtTime(0.85 + x * 1.1, t, 0.05);
      e.loops.high.src.playbackRate.setTargetAtTime(0.55 + x * 0.6, t, 0.05);
    }
  }
  /** Crash: the oscillators fall to 20 % pitch over 0.4 s while the level dies. */
  stallEngine(t = this.ctx.currentTime) {
    const e = this.engine;
    if (!e || e.stalled) return;
    e.stalled = true;
    const fall = (param, floor = 1) => {
      const v = param.value;
      param.cancelScheduledValues(t);
      param.setValueAtTime(v, t);
      param.exponentialRampToValueAtTime(Math.max(floor, v * 0.2), t + 0.4);
    };
    for (const { o } of e.oscs) fall(o.frequency);
    fall(e.nbp.frequency, 20);
    const g = e.master.gain.value;
    e.master.gain.cancelScheduledValues(t);
    e.master.gain.setValueAtTime(g, t);
    e.master.gain.linearRampToValueAtTime(0, t + 0.45);
    e.whG.gain.setTargetAtTime(0, t, 0.15);
    e.wh2G.gain.setTargetAtTime(0, t, 0.15);
    e.boost = 0;
  }
  unstallEngine(t) {
    const e = this.engine;
    e.stalled = false;
    for (const { o } of e.oscs) o.frequency.cancelScheduledValues(t);
    e.nbp.frequency.cancelScheduledValues(t);
    e.master.gain.cancelScheduledValues(t);
    e.master.gain.setValueAtTime(0, t);
    e.rpm = 0.3;
    e.lift = 0;
    e.thrHist.length = 0;
  }
  /** Upshift ignition-cut crack: noise through a 2 kHz band, 1 ms attack, 40 ms decay. */
  gearClunk(gear = 1) {
    this.noiseBurst({ filter: 'bandpass', freq: 1900 + gear * 30, q: 2, attack: 0.001, dur: 0.04, vol: 0.6 });
  }
  /** Overrun crackle: `n` short pops (800 Hz–2 kHz, 15–30 ms) 20–60 ms apart. Low priority: dropped when busy. */
  overrunPops(n = 2, vol = 0.35) {
    const v = this.voice(0.25, { prio: 0 });
    if (!v) return;
    let at = 0;
    for (let i = 0; i < n; i++) {
      this.noiseBurst({ filter: 'bandpass', freq: rand(800, 2000), q: 2.5, attack: 0.001, dur: rand(0.015, 0.03), vol: vol * rand(0.6, 1), at, dest: v });
      at += rand(0.02, 0.06);
    }
  }

  // ---------- soundtrack: lookahead step sequencer ----------
  startMusic() {
    if (!this.ctx) return;
    if (this.fadeTimer) { clearTimeout(this.fadeTimer); this.fadeTimer = null; }
    this.musicFading = false;
    this.duckMusic(1, 0.05);
    if (this.seq.running) return;
    this.seq.running = true;
    this.seq.step = 0;
    this.seq.nextNoteTime = this.ctx.currentTime + 0.05;
    const tick = () => {
      if (!this.seq.running) return;
      const lookahead = 0.12;
      while (this.seq.nextNoteTime < this.ctx.currentTime + lookahead) {
        const arr = ARRANGEMENTS[this.track];
        // the bands play quicker than the synth for the same race pace (each arrangement sets how much)
        const bpm = arr ? this.seq.bpm * arr.tempo : this.seq.bpm;
        if (arr) { setMariachiTempo(bpm); scheduleMariachi(this, this.seq.step, this.seq.nextNoteTime, this.seq.intensity, arr); }
        else this.scheduleStep(this.seq.step, this.seq.nextNoteTime);
        const secondsPerBeat = 60 / bpm;
        this.seq.nextNoteTime += secondsPerBeat / 4; // 16th notes
        this.seq.step = (this.seq.step + 1) % (arr ? arr.steps : 64);
      }
      this.seq.timer = setTimeout(tick, 30);
    };
    tick();
  }
  stopMusic() {
    this.seq.running = false;
    if (this.fadeTimer) { clearTimeout(this.fadeTimer); this.fadeTimer = null; }
    if (this.seq.timer) clearTimeout(this.seq.timer);
    this.seq.timer = null;
  }
  /** The band dies with the car: a short fade instead of a hard cut, then the sequencer stops. */
  fadeOutMusic(seconds = 0.6) {
    if (!this.ctx) return;
    this.duckMusic(0.0001, seconds / 3);
    this.musicFading = true;
    if (this.fadeTimer) clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => { this.fadeTimer = null; this.stopMusic(); }, seconds * 1000);
  }
  /** bpm follows the speed; intensity 0..1 adds layers. */
  setMusicState(bpm, intensity) {
    this.seq.bpm = bpm;
    this.seq.intensity = intensity;
  }

  scheduleStep(step, t) {
    const i = this.seq.intensity;
    const bar = Math.floor(step / 16);
    const s16 = step % 16;
    // kick: four on the floor, extra syncopation when intense
    if (s16 % 4 === 0) this.kick(t);
    if (i > 0.6 && s16 === 14) this.kick(t, 0.6);
    // snare / clap on 2 and 4
    if (i > 0.25 && (s16 === 4 || s16 === 12)) this.snare(t);
    // hats: 8ths, then 16ths
    if (s16 % 2 === 0) this.hat(t, 0.09 + i * 0.05);
    else if (i > 0.45) this.hat(t, 0.04 + i * 0.04);
    // bass line: minor pentatonic riff, two bar phrase
    const riff = [0, 0, 7, 0, 5, 0, 3, 0, 0, 0, 7, 0, 10, 0, 5, 0, 0, 0, 7, 0, 5, 0, 3, 0, 12, 0, 10, 0, 7, 0, 5, 0];
    const idx = (bar % 2) * 16 + s16;
    if (riff[idx] !== undefined && (idx % 2 === 0)) {
      const root = 41.2; // E1
      const semis = riff[idx];
      this.bass(t, root * Math.pow(2, semis / 12), 0.12 + i * 0.1);
    }
    // arpeggio lead once the track is spicy
    if (i > 0.5 && s16 % 2 === 1) {
      const scale = [0, 3, 5, 7, 10, 12, 15];
      const n = scale[(step * 3 + bar) % scale.length];
      this.lead(t, 329.6 * Math.pow(2, n / 12), 0.05 + (i - 0.5) * 0.08);
    }
  }
  kick(t, vel = 1) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.22);
    g.gain.setValueAtTime(0.9 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(this.musicBus);
    o.start(t);
    o.stop(t + 0.32);
  }
  hat(t, vel) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 8000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    src.connect(hp).connect(g).connect(this.musicBus);
    src.start(t);
    src.stop(t + 0.06);
  }
  snare(t) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    src.connect(bp).connect(g).connect(this.musicBus);
    src.start(t);
    src.stop(t + 0.2);
  }
  bass(t, freq, vel) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(lp).connect(g).connect(this.musicBus);
    o.start(t);
    o.stop(t + 0.26);
  }
  lead(t, freq, vel) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g).connect(this.musicBus);
    o.start(t);
    o.stop(t + 0.12);
  }

  // ---------- weather, radio and continuous cues ----------
  /** Thunder: the recorded clap if it is installed (through playSfx, not the voice channel), else a long low-passed rumble. */
  thunder() {
    if (!this.ctx) return false;
    if (this.sfx.thunder || this.buffers.thunder) return this.playSfx('thunder', { volume: 0.8, minGap: 4, bus: this.ambBus });
    this.noiseBurst({ filter: 'lowpass', freq: 400, f1: 60, q: 0.7, attack: 0.08, dur: 2.1, vol: 0.7 });
    return true;
  }
  /**
   * Team radio key-up: a 50 ms static burst (3 kHz, Q 2) and a 1 ms click. `ping` adds the
   * open tone: the radio_ping recording if installed, else 1200 Hz then 1600 Hz at −18 dB.
   */
  radioClick({ ping = false } = {}) {
    const v = this.voice(0.2);
    if (!v) return;
    this.noiseBurst({ filter: 'bandpass', freq: 3000, q: 2, attack: 0.002, dur: 0.05, vol: 0.12, dest: v });
    this.noiseBurst({ filter: 'highpass', freq: 1500, attack: 0.0005, dur: 0.001, vol: 0.3, at: 0.05, dest: v });
    if (!ping) return;
    if (this.playSfx('radio_ping', { volume: 0.35, at: 0.05, dur: 0.4 })) return;
    this.tone({ type: 'sine', f0: 1200, dur: 0.06, vol: 0.12, at: 0.05, attack: 0.004, dest: v });
    this.tone({ type: 'sine', f0: 1600, dur: 0.06, vol: 0.12, at: 0.11, attack: 0.004, dest: v });
  }
  /** Team radio key-down: a 100 ms squelch tail, band-passed 1.5–4 kHz, fast decay. */
  squelchTail(at = 0) {
    this.noiseBurst({ filter: 'bandpass', freq: 2500, q: 0.8, attack: 0.002, dur: 0.1, vol: 0.3, at });
  }
  /** Continuous slipstream whoosh; call every frame with tow 0..1. */
  updateTow(tow) {
    if (!this.ctx) return;
    if (!this.towNode) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1200;
      bp.Q.value = 0.8;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      src.connect(bp).connect(g).connect(this.ambBus);
      src.start();
      this.towNode = { g, bp };
    }
    this.towNode.g.gain.setTargetAtTime(tow * 0.09 * this.windFactor(), this.ctx.currentTime, 0.08);
    this.towNode.bp.frequency.setTargetAtTime(900 + tow * 900, this.ctx.currentTime, 0.1);
  }
  /** Rain on the bodywork: broadband hiss that follows the track wetness (0..1). */
  updateRain(wetness) {
    if (!this.ctx) return;
    this.wetness = clamp01(wetness);
    if (!this.rainNode) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
      const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
      const g = this.ctx.createGain(); g.gain.value = 0;
      src.connect(hp).connect(lp).connect(g).connect(this.ambBus);
      src.start();
      this.rainNode = { g, lp };
    }
    const t = this.ctx.currentTime;
    this.rainNode.g.gain.setTargetAtTime(clamp01(wetness) * 0.11, t, 0.4);
    this.rainNode.lp.frequency.setTargetAtTime(2200 + clamp01(wetness) * 3000, t, 0.4);
  }
  /**
   * MGU-K, under the engine. Deploy (ERS held): a sine rising 600 Hz → 1.2 kHz as the battery
   * empties, so you hear the boost running out. Harvest (off throttle with room in the
   * battery): a sine falling 1.5 kHz → 400 Hz with the speed. `harvest` 0..1 overrides the
   * guess from the engine's last throttle.
   */
  updateErs(boosting, charge01, harvest = null) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (!this.ersNode) {
      const d = ctx.createOscillator(); d.type = 'sine'; d.frequency.value = 600;
      const dg = ctx.createGain(); dg.gain.value = 0;
      const h = ctx.createOscillator(); h.type = 'sine'; h.frequency.value = 1500;
      const hg = ctx.createGain(); hg.gain.value = 0;
      d.connect(dg).connect(this.engineBus);
      h.connect(hg).connect(this.engineBus);
      d.start(); h.start();
      this.ersNode = { d, dg, h, hg };
    }
    const e = this.engine;
    const t = ctx.currentTime;
    const live = e && e.running && !e.stalled;
    const c = clamp01(charge01);
    const harv = harvest !== null ? clamp01(harvest) : live && !boosting && !e.limiter && e.throttle < 0.15 && c < 0.999 ? 1 : 0;
    this.ersNode.d.frequency.setTargetAtTime(600 + (1 - c) * 600, t, 0.06);
    this.ersNode.dg.gain.setTargetAtTime(boosting && live ? 0.035 : 0, t, boosting ? 0.05 : 0.12);
    this.ersNode.h.frequency.setTargetAtTime(400 + 1100 * clamp01(e ? e.speedRatio : 0), t, 0.08);
    this.ersNode.hg.gain.setTargetAtTime(harv * 0.04, t, harv ? 0.08 : 0.15);
  }
  /** Flat-tyre thump: a low knock once per wheel revolution while you limp back to the pits. */
  updatePuncture(punctured, speedRatio) {
    if (!this.ctx) return;
    if (!this.punctureNode) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 1.5;
      // pulse gate: a square LFO opens the gain once per revolution
      const gate = this.ctx.createGain(); gate.gain.value = 0.5; // ±0.5 from the LFO → 0..1
      const lfo = this.ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 6;
      const lfoG = this.ctx.createGain(); lfoG.gain.value = 0.5;
      lfo.connect(lfoG).connect(gate.gain);
      const g = this.ctx.createGain(); g.gain.value = 0;
      src.connect(lp).connect(gate).connect(g).connect(this.sfxBus);
      src.start(); lfo.start();
      this.punctureNode = { g, lfo };
    }
    const t = this.ctx.currentTime;
    this.punctureNode.g.gain.setTargetAtTime(punctured ? 0.35 : 0, t, 0.1);
    this.punctureNode.lfo.frequency.setTargetAtTime(3 + clamp01(speedRatio) * 14, t, 0.1);
  }

  /** Pause: suspend and stay suspended (no auto-resume on taps) until resume(). */
  suspend() {
    this.held = true;
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }
  resume() { this.held = false; this.wake(); }
}
