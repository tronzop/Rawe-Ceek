// "Rawe Ceek Mariachi" — an original soundtrack in the mariachi style: two trumpets
// in thirds over guitarrón bass, vihuela off-beat strums and güiro/shaker. Written
// for this game (it is not the F1 broadcast theme, which is copyrighted). Everything
// is synthesised with WebAudio; tempo and layers follow the race intensity.
//
// Time: 2/4 son-style feel written in 16ths: 8 steps per bar, 16 bars per loop = 128 steps.

const D = 293.66; // D4 — the key is D major
const semi = (n) => D * Math.pow(2, n / 12);
// scale degrees in semitones (D major), octave-agnostic helper
const deg = (d, oct = 0) => semi([0, 2, 4, 5, 7, 9, 11][((d % 7) + 7) % 7] + 12 * (Math.floor(d / 7) + oct));

// Chord progression, one chord per bar (I  I  IV  V | I  V  IV  I | vi IV  V  V | I  IV  V  I)
const CHORDS = [
  [0, 2, 4], [0, 2, 4], [3, 5, 7], [4, 6, 8],
  [0, 2, 4], [4, 6, 8], [3, 5, 7], [0, 2, 4],
  [5, 7, 9], [3, 5, 7], [4, 6, 8], [4, 6, 8],
  [0, 2, 4], [3, 5, 7], [4, 6, 8], [0, 2, 4],
];
// Bass note (root, then fifth) per bar
const BASS = CHORDS.map((c) => [c[0], c[0] + 4]);

// Lead trumpet, one entry per 16th step (128). null = rest, '-' = hold.
// A rising fanfare that answers itself; second half climbs to the top and lands home.
const LEAD = [
  // bar 1-4: fanfare call
  0, '-', 2, '-', 4, '-', 7, '-',   7, '-', '-', '-', 6, '-', 4, '-',
  3, '-', 5, '-', 7, '-', 9, '-',   8, '-', '-', '-', 7, '-', 4, '-',
  // bar 5-8: answer
  0, '-', 4, '-', 7, '-', 11, '-',  11, '-', 9, '-', 7, '-', '-', '-',
  5, '-', 4, '-', 3, '-', 2, '-',   0, '-', '-', '-', null, null, 4, 5,
  // bar 9-12: the climb (vi IV V V)
  5, '-', 7, '-', 9, '-', 12, '-',  12, '-', 11, '-', 9, '-', 7, '-',
  8, '-', 9, '-', 11, '-', 13, '-', 14, '-', '-', '-', 13, '-', 11, '-',
  // bar 13-16: home stretch, big finish
  14, '-', 13, '-', 11, '-', 9, '-', 10, '-', 9, '-', 7, '-', 5, '-',
  4, '-', 6, '-', 8, '-', 11, '-',  14, '-', '-', '-', '-', '-', null, null,
];
// Second trumpet: a third below, only in the busier sections
const HARMONY_ON = (bar) => bar >= 4;

// Vihuela strums on the off-beats ("and" of 1 and 2), plus a pickup every other bar
const STRUM_STEPS = [2, 3, 6, 7];

/**
 * Schedules everything that sounds on `step` (0..127) at time `t`.
 * `a` is the AudioEngine (for ctx, musicBus, noise buffer); `i` is intensity 0..1.
 */
export function scheduleMariachi(a, step, t, i) {
  const ctx = a.ctx;
  // the band has its own bus so the mix sits under the engine and radio (see AudioEngine.init)
  const out = a.mariachiBus || a.musicBus;
  const bar = Math.floor(step / 8);
  const s8 = step % 8;
  const chord = CHORDS[bar];

  // guitarrón: root on 1, fifth on 2 (steps 0 and 4), octave below the trumpets
  if (s8 === 0 || s8 === 4) guitarron(ctx, out, deg(BASS[bar][s8 === 0 ? 0 : 1], -2), t, 0.5 + 0.2 * i);
  // busier bass when the race is hot: passing note on the "and" of 2
  if (i > 0.55 && s8 === 6) guitarron(ctx, out, deg(BASS[bar][0] + 2, -2), t, 0.3);

  // vihuela strums
  if (STRUM_STEPS.includes(s8)) strum(ctx, out, chord.map((d) => deg(d, 0)), t, s8 % 4 === 2 ? 0.16 : 0.11, s8 % 4 === 3);

  // güiro on the beat, shaker 16ths once it gets going
  if (s8 === 0 || s8 === 4) guiro(ctx, out, a.noise, t, 0.12);
  if (i > 0.35 && s8 % 2 === 1) shaker(ctx, out, a.noise, t, 0.05 + 0.06 * i);
  if (i > 0.7 && s8 === 4) cajon(ctx, out, t, 0.35);

  // trumpets: lead always, harmony when the section allows and the race is lively
  const n = LEAD[step];
  if (typeof n === 'number') {
    const len = noteLength(step);
    trumpet(ctx, out, deg(n, 1), t, len, 0.14 + 0.08 * i, false);
    if (HARMONY_ON(bar) && i > 0.3) trumpet(ctx, out, deg(n - 2, 1), t, len, 0.08 + 0.05 * i, true);
  }
  // grito! a whooping falsetto slide at the top of the climb, only when flat out
  if (i > 0.8 && step === 88) grito(ctx, out, t);
}
/** Level the band sits at relative to the music bus. */
export const MARIACHI_GAIN = 0.42;

/** How many 16ths a lead note holds (counts the following '-' steps). */
function noteLength(step) {
  let k = 1;
  while (LEAD[(step + k) % LEAD.length] === '-' && k < 8) k++;
  return k;
}

/** Trumpet: bright saw + square with vibrato, brassy formant, quick attack, tail. */
function trumpet(ctx, out, freq, t, steps16, vel, second) {
  const stepSec = 60 / (currentBpm || 120) / 4;
  const dur = Math.max(0.12, steps16 * stepSec * 0.9);
  const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = freq;
  const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = freq * (second ? 1.003 : 0.997);
  const vib = ctx.createOscillator(); vib.frequency.value = 5.5;
  const vibG = ctx.createGain(); vibG.gain.value = 0;
  vibG.gain.setValueAtTime(0, t); vibG.gain.linearRampToValueAtTime(freq * 0.012, t + Math.min(0.25, dur * 0.6));
  vib.connect(vibG); vibG.connect(o1.frequency); vibG.connect(o2.frequency);
  const mix2 = ctx.createGain(); mix2.gain.value = 0.35;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = Math.min(3200, freq * 2.6); bp.Q.value = 0.9;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(freq * 3, t); lp.frequency.exponentialRampToValueAtTime(freq * 6, t + 0.05);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vel, t + 0.025);
  g.gain.setValueAtTime(vel, t + dur * 0.8);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.06);
  o1.connect(bp); o2.connect(mix2).connect(bp);
  bp.connect(lp).connect(g).connect(out);
  o1.start(t); o2.start(t); vib.start(t);
  o1.stop(t + dur + 0.1); o2.stop(t + dur + 0.1); vib.stop(t + dur + 0.1);
}

/** Guitarrón: deep plucked bass — sine + triangle, fast decay, low-passed. */
function guitarron(ctx, out, freq, t, vel) {
  const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = freq;
  const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 0.5;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(180, t + 0.25);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vel, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
  o.connect(lp); o2.connect(lp); lp.connect(g).connect(out);
  o.start(t); o2.start(t); o.stop(t + 0.45); o2.stop(t + 0.45);
}

/** Vihuela: three bright, very short plucks a few ms apart (a strum), up or down. */
function strum(ctx, out, freqs, t, vel, down) {
  const order = down ? [...freqs].reverse() : freqs;
  order.forEach((f, k) => {
    const tt = t + k * 0.012;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f * 2;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel, tt);
    g.gain.exponentialRampToValueAtTime(0.001, tt + 0.14);
    o.connect(hp).connect(g).connect(out);
    o.start(tt); o.stop(tt + 0.16);
  });
}

/** Güiro scrape: band-passed noise with a rising sweep. */
function guiro(ctx, out, noise, t, vel) {
  const src = ctx.createBufferSource(); src.buffer = noise;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 4;
  bp.frequency.setValueAtTime(1800, t); bp.frequency.exponentialRampToValueAtTime(4200, t + 0.09);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  src.connect(bp).connect(g).connect(out);
  src.start(t); src.stop(t + 0.11);
}
function shaker(ctx, out, noise, t, vel) {
  const src = ctx.createBufferSource(); src.buffer = noise;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
  src.connect(hp).connect(g).connect(out);
  src.start(t); src.stop(t + 0.05);
}
function cajon(ctx, out, t, vel) {
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  o.connect(g).connect(out); o.start(t); o.stop(t + 0.2);
}
/** Grito: a whooping "¡ay!" — sawtooth glide up then down through a vowel-ish formant. */
function grito(ctx, out, t) {
  const o = ctx.createOscillator(); o.type = 'sawtooth';
  o.frequency.setValueAtTime(330, t);
  o.frequency.exponentialRampToValueAtTime(880, t + 0.18);
  o.frequency.exponentialRampToValueAtTime(520, t + 0.55);
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 3;
  f.frequency.setValueAtTime(900, t); f.frequency.linearRampToValueAtTime(1800, t + 0.2); f.frequency.linearRampToValueAtTime(1100, t + 0.55);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + 0.05);
  g.gain.setValueAtTime(0.16, t + 0.4); g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
  o.connect(f).connect(g).connect(out);
  o.start(t); o.stop(t + 0.65);
}

let currentBpm = 120;
/** The sequencer tells us the tempo so note lengths are right. */
export function setMariachiTempo(bpm) { currentBpm = bpm; }
export const MARIACHI_STEPS = LEAD.length; // 128
