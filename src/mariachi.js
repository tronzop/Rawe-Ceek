// "Rawe Ceek Mariachi" — an original soundtrack in the mariachi style: two trumpets
// in thirds over guitarrón bass, vihuela off-beat strums and güiro/shaker. Written
// for this game (it is not the F1 broadcast theme, which is copyrighted). Everything
// is synthesised with WebAudio; tempo and layers follow the race intensity.
//
// Two arrangements share the band:
//   mariachi — "Rawe Ceek Mariachi": 2/4 son feel in D major, 8 sixteenth steps per bar, 16 bars = 128 steps.
//   jarabe   — "Jarabe Rawe": a jauntier 6/8 huapango in G major, 12 sixteenth steps per bar, 16 bars = 192 steps,
//              faster, staccato trumpets, hemiola bass (3 against 2), strums on every off-beat and more gritos.

// scale degrees (major) in semitones above the arrangement's tonic, octave-agnostic helper
const degIn = (tonic, d, oct = 0) => tonic * Math.pow(2, ([0, 2, 4, 5, 7, 9, 11][((d % 7) + 7) % 7] + 12 * (Math.floor(d / 7) + oct)) / 12);

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

// ---------- "Jarabe Rawe" — 6/8, G major, 12 steps per bar ----------
// Progression: I IV V I | I IV V V | vi IV V I | IV I V I  (bright, resolves every four bars)
const J_CHORDS = [
  [0, 2, 4], [3, 5, 7], [4, 6, 8], [0, 2, 4],
  [0, 2, 4], [3, 5, 7], [4, 6, 8], [4, 6, 8],
  [5, 7, 9], [3, 5, 7], [4, 6, 8], [0, 2, 4],
  [3, 5, 7], [0, 2, 4], [4, 6, 8], [0, 2, 4],
];
const J_BASS = J_CHORDS.map((c) => [c[0], c[0] + 4]);
// Lead in eighths (every other 16th) with skipping sixteenth turns; 12 entries per bar.
const J_LEAD = [
  // A: skipping call (bars 1-4)
  0, '-', 2, '-', 4, '-', 7, '-', 4, '-', 2, '-',
  3, '-', 5, '-', 7, '-', 9, '-', 7, '-', 5, '-',
  4, '-', 6, '-', 8, '-', 11, '-', 8, 6, 4, '-',
  7, '-', '-', '-', 4, '-', 0, '-', '-', '-', null, null,
  // A': same shape, lands on the dominant and hangs there (bars 5-8)
  0, '-', 2, '-', 4, '-', 7, '-', 9, '-', 7, '-',
  5, '-', 7, '-', 9, '-', 10, '-', 9, '-', 7, '-',
  8, '-', 9, '-', 11, '-', 13, '-', 11, 9, 8, '-',
  11, '-', '-', '-', 8, '-', 4, '-', '-', '-', 4, 6,
  // B: up the hill (bars 9-12)
  7, '-', 9, '-', 12, '-', 14, '-', 12, '-', 9, '-',
  10, '-', 12, '-', 14, '-', 12, '-', 10, '-', 7, '-',
  8, '-', 11, '-', 13, '-', 15, '-', 13, 11, 8, '-',
  14, '-', '-', '-', 11, '-', 7, '-', '-', '-', null, null,
  // B': tumble home, big cadence (bars 13-16)
  10, '-', 9, '-', 7, '-', 9, '-', 7, '-', 5, '-',
  4, '-', 7, '-', 9, '-', 11, '-', 9, '-', 7, '-',
  8, '-', 6, '-', 4, '-', 8, '-', 11, '-', 13, '-',
  14, '-', '-', '-', '-', '-', 7, '-', 0, '-', null, null,
];

/**
 * Arrangement table. `steps` per loop, `perBar`, `tempo` multiplier on the race bpm,
 * `schedule(a, out, bar, sb, step, t, i)` fires everything for one step.
 */
export const ARRANGEMENTS = {
  mariachi: { name: 'Rawe Ceek Mariachi', tonic: 293.66 /* D4 */, perBar: 8, steps: LEAD.length, tempo: 1.12, lead: LEAD },
  jarabe: { name: 'Jarabe Rawe', tonic: 392.0 /* G4 */, perBar: 12, steps: J_LEAD.length, tempo: 1.35, lead: J_LEAD, staccato: true },
};
export const MARIACHI_TRACKS = Object.keys(ARRANGEMENTS);

/**
 * Schedules everything that sounds on `step` at time `t` for arrangement `arr` (default: mariachi).
 * `a` is the AudioEngine (for ctx, musicBus, noise buffer); `i` is intensity 0..1.
 */
export function scheduleMariachi(a, step, t, i, arr = ARRANGEMENTS.mariachi) {
  // the band has its own bus so the mix sits under the engine and radio (see AudioEngine.init)
  const out = a.mariachiBus || a.musicBus;
  currentArr = arr;
  (arr === ARRANGEMENTS.jarabe ? scheduleJarabe : scheduleSon)(a.ctx, a, out, step, t, i, arr);
}

function scheduleSon(ctx, a, out, step, t, i, arr) {
  const deg = (d, oct = 0) => degIn(arr.tonic, d, oct);
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

function scheduleJarabe(ctx, a, out, step, t, i, arr) {
  const deg = (d, oct = 0) => degIn(arr.tonic, d, oct);
  const bar = Math.floor(step / 12);
  const s12 = step % 12;
  const chord = J_CHORDS[bar];
  const hemiola = bar % 2 === 1; // odd bars feel like 3/4: bass on the three quarter notes

  // guitarrón: even bars two dotted quarters (1 and 4), odd bars three quarters (1, 3, 5) — the sesquiáltera
  if (!hemiola && (s12 === 0 || s12 === 6)) guitarron(ctx, out, deg(J_BASS[bar][s12 === 0 ? 0 : 1], -2), t, 0.55 + 0.2 * i);
  if (hemiola && s12 % 4 === 0) guitarron(ctx, out, deg(J_BASS[bar][s12 === 4 ? 1 : 0], -2), t, 0.5 + 0.2 * i);
  // walking pickup into the next bar when pushing
  if (i > 0.5 && s12 === 10) guitarron(ctx, out, deg(J_BASS[bar][0] + 1, -2), t, 0.28);

  // vihuela: every off-beat eighth (2, 3, 5, 6 of the six), alternating up/down, a rasgueado on the downbeat every 4th bar
  if ([2, 4, 8, 10].includes(s12)) strum(ctx, out, chord.map((d) => deg(d, 0)), t, s12 === 4 || s12 === 10 ? 0.17 : 0.12, s12 % 8 === 4);
  if (bar % 4 === 3 && s12 === 0) strum(ctx, out, chord.map((d) => deg(d, 0)), t, 0.2, true);

  // percussion: güiro on the dotted quarters, shaker straight eighths, cajón slaps on 4 and 6 when lively
  if (s12 === 0 || s12 === 6) guiro(ctx, out, a.noise, t, 0.13);
  if (i > 0.25 && s12 % 2 === 0) shaker(ctx, out, a.noise, t, 0.05 + 0.06 * i);
  if (i > 0.55 && (s12 === 6 || s12 === 10)) cajon(ctx, out, t, s12 === 6 ? 0.36 : 0.22);

  // trumpets: short and bright; harmony a third below from the second phrase on, or once the race is on
  const n = J_LEAD[step];
  if (typeof n === 'number') {
    const len = noteLength(step);
    trumpet(ctx, out, deg(n, 1), t, len, 0.15 + 0.08 * i, false);
    if ((bar >= 4 || i > 0.5) && i > 0.2) trumpet(ctx, out, deg(n - 2, 1), t, len, 0.09 + 0.05 * i, true);
  }
  // gritos at the end of every phrase once the race is moving, always at the top of the hill
  if ((i > 0.55 && (step === 46 || step === 190)) || (i > 0.35 && step === 142)) grito(ctx, out, t);
}
/** Level the band sits at relative to the music bus. */
export const MARIACHI_GAIN = 0.42;

/** How many 16ths a lead note holds (counts the following '-' steps). */
function noteLength(step) {
  const lead = currentArr.lead;
  let k = 1;
  while (lead[(step + k) % lead.length] === '-' && k < 8) k++;
  return k;
}

/** Trumpet: bright saw + square with vibrato, brassy formant, quick attack, tail. */
function trumpet(ctx, out, freq, t, steps16, vel, second) {
  const stepSec = 60 / (currentBpm || 120) / 4;
  // staccato arrangements clip every note short so the tune skips rather than sings
  const dur = Math.max(0.1, steps16 * stepSec * (currentArr.staccato ? 0.62 : 0.9));
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
let currentArr = ARRANGEMENTS.mariachi;
/** The sequencer tells us the tempo so note lengths are right. */
export function setMariachiTempo(bpm) { currentBpm = bpm; }
export const MARIACHI_STEPS = LEAD.length; // 128 (the original arrangement; see ARRANGEMENTS[x].steps)
