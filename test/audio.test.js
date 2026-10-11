// Audio: the V6 engine maths, and the AudioEngine run against a stub WebAudio graph so every
// public cue can be called under Node (no sound, just "does it build without throwing").
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, engineState, firingHzFromNorm } from '../src/logic.js';

test('V6 firing frequency: rpm/60 × 3, 200 Hz at idle, 600 Hz at the redline', () => {
  assert.deepEqual(ENGINE, { gears: 8, idleRpm: 4000, maxRpm: 12000, cylinders: 6 });
  assert.equal(firingHzFromNorm(1), 600);
  assert.equal(firingHzFromNorm(0), 200);
  assert.equal(firingHzFromNorm(-1), 200, 'never below idle');
  assert.ok(firingHzFromNorm(1.15) > 600, 'downshift blips may overshoot the redline');
  // race range 10,500–12,000 rpm → 525–600 Hz
  assert.equal(firingHzFromNorm((10500 - 4000) / 8000), 525);
  for (const r of [0, 0.2, 0.55, 0.9, 1]) assert.equal(engineState(r).firingHz, firingHzFromNorm(engineState(r).rpmNorm));
});

// ---- a minimal WebAudio stand-in: enough surface for the engine to build its graph ----
class Param {
  constructor(v = 0) { this.value = v; }
  setValueAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  exponentialRampToValueAtTime(v) {
    if (!(v > 0)) throw new RangeError('exponential ramp target must be > 0');
    this.value = v; return this;
  }
  setTargetAtTime(v) { this.value = v; return this; }
  setValueCurveAtTime(curve) { this.value = curve[curve.length - 1]; return this; }
  cancelScheduledValues() { return this; }
}
class Node {
  constructor(ctx) { this.ctx = ctx; ctx.nodes++; }
  connect(n) { return n; }
  disconnect() {}
}
class Source extends Node {
  start() { this.ctx.started++; }
  stop() {}
}
class FakeContext {
  constructor() { this.currentTime = 0; this.sampleRate = 8000; this.state = 'running'; this.nodes = 0; this.started = 0; this.destination = new Node(this); }
  createGain() { const n = new Node(this); n.gain = new Param(1); return n; }
  createBiquadFilter() { const n = new Node(this); n.frequency = new Param(350); n.Q = new Param(1); n.gain = new Param(0); return n; }
  createOscillator() { const n = new Source(this); n.frequency = new Param(440); n.detune = new Param(0); return n; }
  createBufferSource() { const n = new Source(this); n.playbackRate = new Param(1); n.loop = false; return n; }
  createStereoPanner() { const n = new Node(this); n.pan = new Param(0); return n; }
  createWaveShaper() { return new Node(this); }
  createDynamicsCompressor() { const n = new Node(this); for (const k of ['threshold', 'ratio', 'attack', 'release', 'knee']) n[k] = new Param(0); return n; }
  createBuffer(ch, len) { const d = new Float32Array(len); return { duration: len / this.sampleRate, getChannelData: () => d }; }
  decodeAudioData() { return Promise.reject(new Error('no decoder')); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
}

async function engineWithStubs() {
  globalThis.window = { AudioContext: FakeContext, addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = async () => ({ ok: false });
  const { AudioEngine } = await import('../src/audio.js');
  const a = new AudioEngine();
  a.setAvailable(Promise.resolve({ clips: [], engine: [] }));
  a.init();
  return a;
}

test('audio: every cue main.js uses still exists, plus the new F1 cues', async () => {
  const { AudioEngine } = await import('../src/audio.js');
  const names = [
    // called by main.js today
    'init', 'resume', 'suspend', 'fadeOutMusic', 'radioClick', 'play', 'duration', 'playAny', 'skid', 'overtake',
    'blip', 'startMusic', 'crunch', 'wheelGun', 'fanfare', 'scEnding', 'penalty', 'thunder', 'toggleMusic',
    'toggleSfx', 'setTrack', 'toggleTrack', 'setAvailable', 'updateEngine', 'setMusicState', 'updateTow', 'updateRain',
    'updateErs', 'updatePuncture',
    // new
    'playSfx', 'stopClips', 'crash', 'goodChime', 'drsOpen', 'gridAmbience', 'launch', 'lightTick', 'jumpStartTone', 'passBy',
    'closeWhoosh', 'flowTierUp', 'mirrorBlip', 'pitLimiter', 'jackClank', 'jacksDown', 'gunStall', 'pitRelease', 'scAlert',
    'scCarBurble', 'scLightsOff', 'fieldRevSurge', 'updateScrape', 'chequeredCrowd', 'recordStopCheer', 'squelchTail',
    'noiseBurst', 'tone', 'sweep', 'scrapeGrain', 'setGridRevs', 'stopLoops',
  ];
  for (const n of names) assert.equal(typeof AudioEngine.prototype[n], 'function', `AudioEngine.${n}`);
  // the legacy aliases are gone now nothing calls them
  for (const n of ['siren', 'drs', 'crashNoise']) assert.equal(AudioEngine.prototype[n], undefined, `AudioEngine.${n} removed`);
});

test('audio: every cue builds against a stub graph without throwing', async () => {
  const a = await engineWithStubs();
  const ctx = a.ctx;
  assert.ok(a.engineBus && a.ambBus && a.engine, 'buses and engine built');
  const tick = (s = 1 / 60) => { ctx.currentTime += s; };
  // a lap of engine: accelerate through the gears, lift, downshift, boost, limiter, stall
  for (let i = 0; i <= 120; i++) { a.updateEngine(1 / 60, i / 120, true, 1, i > 60); tick(); }
  for (let i = 0; i < 30; i++) { a.updateEngine(1 / 60, 0.9 - i / 60, true, 0, false); a.updateErs(false, 0.5); tick(); }
  a.pitLimiter(true);
  for (let i = 0; i < 30; i++) { a.updateEngine(1 / 60, 0.04, true, 0.2, false); tick(); }
  assert.ok(Math.abs(a.engine.rpm - (6000 - 4000) / 8000) < 0.05, 'the limiter holds 6000 rpm');
  a.pitRelease();
  for (const f of ['lightTick', 'jumpStartTone', 'launch', 'mirrorBlip', 'jackClank', 'jacksDown', 'gunStall', 'scAlert', 'scrapeGrain',
    'scLightsOff', 'fieldRevSurge', 'drsOpen', 'goodChime', 'overtake', 'penalty', 'scEnding', 'fanfare', 'chequeredCrowd',
    'recordStopCheer', 'thunder', 'radioClick', 'squelchTail', 'skid', 'crunch']) {
    a[f](); tick(0.3);
  }
  a.gridAmbience(1); a.gridAmbience(0.6); a.gridAmbience(0);
  a.passBy(30, 0.8, -0.8); a.passBy(80, -0.8, 0.8, { chime: false });
  a.closeWhoosh('up', true); a.closeWhoosh(1, false);
  a.flowTierUp(3); a.wheelGun(4); a.wheelGun(1);
  a.scCarBurble(true); a.scCarBurble(false);
  a.updateScrape(0.7); a.updateScrape(0);
  a.updateRain(0.8); a.skid(0.3);
  a.updateTow(0.5); a.updatePuncture(true, 0.4);
  a.crash();
  a.updateEngine(1 / 60, 0.5, false, 0, false);
  assert.ok(a.engine.stalled, 'the crash stalls the engine');
  tick(1);
  a.updateEngine(1 / 60, 0, true, 0.5, false);
  assert.ok(!a.engine.stalled, 'a new run restarts it');
});

test('audio: at most six one-shots; low priority drops, a crash pre-empts the rest', async () => {
  const a = await engineWithStubs();
  for (let i = 0; i < 10; i++) a.voice(1);
  assert.equal(a.voices.length, 6);
  assert.equal(a.voice(1, { prio: 0 }), null, 'engine pops are dropped when full');
  a.crash();
  assert.equal(a.voices.length, 1, 'only the crash is left');
  assert.equal(a.voices[0].prio, 2);
  for (let i = 0; i < 10; i++) a.voice(1);
  assert.ok(a.voices.some((v) => v.prio === 2), 'ordinary cues cannot steal the crash');
});

test('audio: a paused context stays paused; anything else not running is resumed', async () => {
  const a = await engineWithStubs();
  a.suspend();
  assert.equal(a.ctx.state, 'suspended');
  a.init(); // a tap on the pause screen (music toggle) must not resume
  assert.equal(a.ctx.state, 'suspended');
  a.resume();
  assert.equal(a.ctx.state, 'running');
  a.ctx.state = 'interrupted'; // iOS
  a.init();
  assert.equal(a.ctx.state, 'running');
});

test('audio: every audio.<cue>() main.js calls exists on AudioEngine', async () => {
  const { readFileSync } = await import('node:fs');
  const { AudioEngine } = await import('../src/audio.js');
  const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const called = new Set([...src.matchAll(/\baudio\.([a-zA-Z]+)\(/g)].map((m) => m[1]));
  assert.ok(called.size > 20);
  for (const n of called) assert.equal(typeof AudioEngine.prototype[n], 'function', `main.js calls audio.${n}()`);
});

test('audio: grid revs bounce around 10,000 rpm and climb with the throttle; stopLoops hands back', async () => {
  const a = await engineWithStubs();
  const ctx = a.ctx;
  const run = (held, n = 90) => {
    let lo = 9, hi = -9;
    for (let i = 0; i < n; i++) { a.setGridRevs(true, held); a.updateEngine(1 / 60, 0, true, 0.5, false); ctx.currentTime += 1 / 60; if (i > 30) { lo = Math.min(lo, a.engine.rpm); hi = Math.max(hi, a.engine.rpm); } }
    return { lo, hi };
  };
  const idle = run(false);
  assert.ok(idle.lo > 0.65 && idle.hi < 0.85, `bounces around 0.75 (${idle.lo.toFixed(2)}..${idle.hi.toFixed(2)})`);
  assert.ok(idle.hi - idle.lo > 0.04, 'it actually bounces');
  const held = run(true);
  assert.ok((held.lo + held.hi) / 2 > (idle.lo + idle.hi) / 2 + 0.05, 'holding → revs it higher');
  a.gridAmbience(1);
  a.scCarBurble(true);
  a.pitLimiter(true);
  a.stopLoops();
  assert.equal(a.engine.grid, null);
  assert.equal(a.grid, null, 'grid bed gone');
  assert.equal(a.engine.limiter, false);
  assert.equal(a.scNode.g.gain.value, 0, 'safety car burble silenced');
  for (let i = 0; i < 120; i++) { a.updateEngine(1 / 60, 0, true, 0, false); ctx.currentTime += 1 / 60; }
  assert.ok(a.engine.rpm < 0.05, 'back on the speedo: true idle at a standstill (the box)');
});

test('audio: the limiter can switch silently (box idle, roll-out) and beeps only on pit entry', async () => {
  const a = await engineWithStubs();
  a.voices.length = 0;
  a.pitLimiter(true, { beep: false });
  assert.equal(a.voices.length, 0, 'silent switch opens no voice');
  a.pitLimiter(false, { beep: false });
  a.pitLimiter(true);
  assert.equal(a.voices.length, 1, 'dash beep on entry');
  a.pitLimiter(true);
  assert.equal(a.voices.length, 1, 'no second beep while already on');
});
