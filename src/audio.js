// Audio: sample SFX (the meme clips), a procedural synth soundtrack driven by
// the game's intensity, and an engine drone whose pitch follows the speedo.
// Everything is created lazily on the first user gesture (browser autoplay rules).
import { STORAGE_KEYS } from './config.js';
import { OPTIONAL_CLIPS, resolveClip } from './grid.js';
import { engineState } from './logic.js';
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

const clamp01 = (v) => Math.max(0, Math.min(1, v));
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
    this.buffers = {};
    this.synthetic = {}; // clip name -> true when it is a TTS placeholder (gets the radio filter)
    this.channelBusy = false; // a sample clip is currently playing
    this.queue = []; // clips waiting for the channel
    this.musicOn = readPref(STORAGE_KEYS.music, true);
    this.track = TRACKS.includes(readPref(STORAGE_KEYS.track, 'mariachi')) ? readPref(STORAGE_KEYS.track, 'mariachi') : 'mariachi';
    this.sfxOn = readPref(STORAGE_KEYS.sfx, true);
    this.lastPlayed = {};
    // sequencer
    this.seq = { running: false, nextNoteTime: 0, step: 0, bpm: 100, intensity: 0, timer: null };
    this.engine = null;
    this.noise = null;
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
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
    this.noise = this.makeNoise();
    this.loadAll();
    this.createEngine();
  }

  get ready() { return !!this.ctx; }

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
    await Promise.all(
      wanted.map(async ([name, url]) => {
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const ab = await res.arrayBuffer();
          this.buffers[name] = await this.ctx.decodeAudioData(ab);
          // the shipped TTS readings are .wav; give them a team-radio voice
          this.synthetic[name] = url.endsWith('.wav');
        } catch { /* missing asset is fine */ }
      })
    );
  }

  makeNoise() {
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
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
    while (this.queue.length) {
      const q = this.queue.shift();
      if (performance.now() - q.at < 4500) { this.playNow(q.name, q.opts); return; }
    }
    this.duckMusic(1, 0.35);
  }
  /** Seconds a loaded clip runs for (0 when missing). */
  duration(name) { return this.buffers[name] ? this.buffers[name].duration : 0; }
  playNow(name, { volume = 1, rate = 1, onStart } = {}) {
    const buf = this.buffers[name];
    if (!buf) return false;
    this.lastPlayed[name] = performance.now();
    this.channelBusy = true;
    this.duckMusic(0.4, 0.08);
    if (onStart) onStart(name);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    if (this.synthetic[name]) {
      // team-radio treatment: narrow band, a little crunch, squelch click on open
      const t = this.ctx.currentTime;
      const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 420;
      const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2900;
      const peak = this.ctx.createBiquadFilter(); peak.type = 'peaking'; peak.frequency.value = 1800; peak.Q.value = 1.2; peak.gain.value = 6;
      const shaper = this.ctx.createWaveShaper();
      shaper.curve = this.radioCurve || (this.radioCurve = makeRadioCurve());
      const comp = this.ctx.createDynamicsCompressor(); comp.threshold.value = -24; comp.ratio.value = 8; comp.attack.value = 0.003;
      src.connect(hp).connect(lp).connect(peak).connect(shaper).connect(comp).connect(g).connect(this.sfxBus);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(volume * 1.2, t + 0.04);
      this.radioClick();
      src.start(t + 0.06);
      src.onended = () => { this.radioClick(); this.nextInQueue(); };
    } else {
      src.connect(g).connect(this.sfxBus);
      src.start();
      src.onended = () => this.nextInQueue();
    }
    return name;
  }

  /** Plays the first clip in `names` that is loaded. Returns its name, or false if none played. */
  playAny(names, opts) {
    for (const n of names) if (n && this.buffers[n] && this.play(n, opts)) return n;
    return false;
  }
  /** Music level under speech / on a crash: 1 = full band. */
  duckMusic(level, tc = 0.2) {
    if (this.duck) this.duck.gain.setTargetAtTime(level, this.ctx.currentTime, tc);
  }
  /** Which optional clips actually loaded (for the title-screen asset checklist). */
  loaded(name) { return !!this.buffers[name]; }

  // ---------- synthesized SFX ----------
  blip(freq = 880, dur = 0.08, type = 'square', vol = 0.25) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.sfxBus);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  drs() { this.blip(660, 0.09, 'square', 0.18); setTimeout(() => this.blip(990, 0.12, 'square', 0.18), 90); }
  overtake() { this.blip(523, 0.06, 'triangle', 0.2); setTimeout(() => this.blip(784, 0.1, 'triangle', 0.2), 60); }
  wheelGun(count = 4) {
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        const src = this.ctx.createBufferSource();
        src.buffer = this.noise;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2600;
        bp.Q.value = 1.5;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.5, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        src.connect(bp).connect(g).connect(this.sfxBus);
        src.start(t);
        src.stop(t + 0.15);
      }, i * 110);
    }
  }
  crashNoise() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3000, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.9);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
    src.connect(lp).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + 1.1);
  }
  skid(vol = 0.35) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.linearRampToValueAtTime(1600, t + 0.6);
    bp.Q.value = 6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + 0.75);
  }

  // ---------- engine: procedural V12, or real loops when assets/engine/*.wav exist ----------
  createEngine() {
    const ctx = this.ctx;
    const master = ctx.createGain();
    master.gain.value = 0;
    // exhaust colouring shared by both sources: two formant peaks, soft clip, a little air
    const f1 = ctx.createBiquadFilter(); f1.type = 'peaking'; f1.frequency.value = 900; f1.Q.value = 1.1; f1.gain.value = 7;
    const f2 = ctx.createBiquadFilter(); f2.type = 'peaking'; f2.frequency.value = 2600; f2.Q.value = 1.4; f2.gain.value = 5;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 60;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.engineCurve || (this.engineCurve = makeEngineCurve());
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 6; comp.attack.value = 0.005; comp.release.value = 0.12;
    hp.connect(f1).connect(f2).connect(shaper).connect(comp).connect(master).connect(this.sfxBus);

    // --- procedural V12 ---
    // cylinder bank: firing fundamental, its half (crank) and sub-harmonics, each slightly detuned
    const oscs = [
      { type: 'sawtooth', ratio: 1, gain: 0.5 }, // firing frequency: the scream
      { type: 'sawtooth', ratio: 0.5, gain: 0.32 }, // per-revolution content
      { type: 'square', ratio: 0.25, gain: 0.16 }, // body / bank imbalance
      { type: 'sawtooth', ratio: 1.01, gain: 0.22 }, // detuned twin for width
      { type: 'triangle', ratio: 2, gain: 0.12 }, // top-end sizzle
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
    // intake / exhaust turbulence: noise tracking the firing frequency
    const noise = ctx.createBufferSource();
    noise.buffer = this.noise;
    noise.loop = true;
    const nbp = ctx.createBiquadFilter(); nbp.type = 'bandpass'; nbp.Q.value = 0.9;
    const ng = ctx.createGain(); ng.gain.value = 0.08;
    noise.connect(nbp).connect(ng).connect(synthBus);
    noise.start();
    // slow wobble so a held rpm never sounds static
    const lfo = ctx.createOscillator(); lfo.frequency.value = 6.3;
    const lfoG = ctx.createGain(); lfoG.gain.value = 3;
    lfo.connect(lfoG);
    for (const { o } of oscs) lfoG.connect(o.detune);
    lfo.start();
    // throttle-body tone control: opens with rpm
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.Q.value = 1.6; tone.frequency.value = 800;
    synthBus.connect(tone).connect(hp);

    // --- real loops (optional) ---
    const sampleBus = ctx.createGain();
    sampleBus.gain.value = 0;
    sampleBus.connect(hp);

    this.engine = { master, oscs, nbp, ng, tone, synthBus, sampleBus, gear: 1, rpm: 0.3, cut: 0, loops: null };
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
    const { gear, rpmNorm, firingHz } = engineState(speedRatio);
    // upshift: brief ignition cut, then the revs fall into the next gear
    if (gear !== e.gear) {
      if (gear > e.gear) { e.cut = 0.09; this.gearClunk(gear); }
      e.gear = gear;
    }
    e.cut = Math.max(0, e.cut - dt);
    e.rpm += (rpmNorm - e.rpm) * Math.min(1, dt * (rpmNorm < e.rpm ? 9 : 5));
    const load = clamp01(0.55 + throttle * 0.45 + (boosting ? 0.15 : 0));
    const vol = running ? (e.cut > 0 ? 0.03 : 0.16 * load * (0.6 + 0.4 * e.rpm)) : 0;
    e.master.gain.setTargetAtTime(vol, t, e.cut > 0 ? 0.01 : 0.06);
    if (!running) return;
    // live firing frequency from the smoothed rpm
    const rpm = 4000 + e.rpm * 8500;
    const fHz = (rpm / 60) * 6;
    for (const { o, ratio } of e.oscs) o.frequency.setTargetAtTime(fHz * ratio, t, 0.02);
    e.nbp.frequency.setTargetAtTime(fHz * 2.2, t, 0.03);
    e.ng.gain.setTargetAtTime(0.05 + 0.12 * e.rpm * throttle, t, 0.05);
    e.tone.frequency.setTargetAtTime(500 + e.rpm * 5200 * load, t, 0.04);
    if (e.loops) {
      // real loops: assume `low` was recorded near idle and `high` near the redline
      const x = e.rpm;
      e.loops.low.g.gain.setTargetAtTime(Math.cos(x * Math.PI / 2) * 0.9, t, 0.05);
      e.loops.high.g.gain.setTargetAtTime(Math.sin(x * Math.PI / 2) * 0.9, t, 0.05);
      e.loops.low.src.playbackRate.setTargetAtTime(0.85 + x * 1.1, t, 0.05);
      e.loops.high.src.playbackRate.setTargetAtTime(0.55 + x * 0.6, t, 0.05);
    }
  }
  /** Mechanical clunk + short exhaust crack on an upshift. */
  gearClunk(gear) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700 + gear * 40; bp.Q.value = 2.5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + 0.1);
  }

  // ---------- soundtrack: lookahead step sequencer ----------
  startMusic() {
    if (!this.ctx || this.seq.running) return;
    if (this.fadeTimer) { clearTimeout(this.fadeTimer); this.fadeTimer = null; }
    this.duckMusic(1, 0.05);
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
    if (this.seq.timer) clearTimeout(this.seq.timer);
    this.seq.timer = null;
  }
  /** The band dies with the car: a short fade instead of a hard cut, then the sequencer stops. */
  fadeOutMusic(seconds = 0.6) {
    if (!this.ctx) return;
    this.duckMusic(0.0001, seconds / 3);
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

  // ---------- expansion cues ----------
  /** Two-tone safety car siren. */
  siren() {
    for (let i = 0; i < 4; i++) setTimeout(() => this.blip(i % 2 ? 660 : 880, 0.22, 'square', 0.14), i * 240);
  }
  /** Descending stewards' beep for a penalty. */
  penalty() { [880, 660, 440].forEach((f, i) => setTimeout(() => this.blip(f, 0.14, 'sawtooth', 0.16), i * 130)); }
  /** "Safety car in this lap": three rising beeps so the restart is audible before it is visible. */
  scEnding() { [660, 784, 988].forEach((f, i) => setTimeout(() => this.blip(f, 0.12, 'square', 0.14), i * 160)); }
  /** Chequered-flag fanfare. */
  fanfare() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.blip(f, 0.18, 'triangle', 0.22), i * 110)); }
  /** Thunder: long low-passed noise rumble. */
  thunder() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(400, t);
    lp.frequency.exponentialRampToValueAtTime(60, t + 1.8);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.7, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
    src.connect(lp).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + 2.3);
  }
  /** Short static burst when the pit wall opens the radio. */
  radioClick() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3200;
    bp.Q.value = 3;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + 0.08);
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
      src.connect(bp).connect(g).connect(this.sfxBus);
      src.start();
      this.towNode = { g, bp };
    }
    this.towNode.g.gain.setTargetAtTime(tow * 0.09, this.ctx.currentTime, 0.08);
    this.towNode.bp.frequency.setTargetAtTime(900 + tow * 900, this.ctx.currentTime, 0.1);
  }
  /** Rain on the bodywork: broadband hiss that follows the track wetness (0..1). */
  updateRain(wetness) {
    if (!this.ctx) return;
    if (!this.rainNode) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
      const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
      const g = this.ctx.createGain(); g.gain.value = 0;
      src.connect(hp).connect(lp).connect(g).connect(this.sfxBus);
      src.start();
      this.rainNode = { g, lp };
    }
    const t = this.ctx.currentTime;
    this.rainNode.g.gain.setTargetAtTime(clamp01(wetness) * 0.11, t, 0.4);
    this.rainNode.lp.frequency.setTargetAtTime(2200 + clamp01(wetness) * 3000, t, 0.4);
  }
  /**
   * MGU-K deploy whine while the ERS button is held. The pitch climbs as the battery
   * empties, so you can hear the boost running out before the bar tells you.
   */
  updateErs(boosting, charge01) {
    if (!this.ctx) return;
    if (!this.ersNode) {
      const o = this.ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 1400;
      const o2 = this.ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 2800;
      const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 4; bp.frequency.value = 1800;
      const g = this.ctx.createGain(); g.gain.value = 0;
      o.connect(bp); o2.connect(bp); bp.connect(g).connect(this.sfxBus);
      o.start(); o2.start();
      this.ersNode = { o, o2, bp, g };
    }
    const t = this.ctx.currentTime;
    const f = 1300 + (1 - clamp01(charge01)) * 1100;
    this.ersNode.o.frequency.setTargetAtTime(f, t, 0.06);
    this.ersNode.o2.frequency.setTargetAtTime(f * 2, t, 0.06);
    this.ersNode.bp.frequency.setTargetAtTime(f * 1.3, t, 0.06);
    this.ersNode.g.gain.setTargetAtTime(boosting ? 0.045 : 0, t, boosting ? 0.05 : 0.12);
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

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }
}
