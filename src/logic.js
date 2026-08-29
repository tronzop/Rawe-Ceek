// Pure gameplay maths. No DOM, no canvas, no side effects — this module is
// unit-tested under Node (see test/logic.test.js) and shared by the world sim.
import { COMPOUNDS, ERS, PIT, SPAWN, SPEED, TYRES } from './config.js';

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (min, max) => Math.random() * (max - min) + min;
export const randInt = (min, max) => Math.floor(rand(min, max + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Base scroll speed before throttle/boost/grip, as a function of time survived. */
export function baseSpeed(elapsed) {
  return Math.min(SPEED.max, SPEED.base + elapsed * SPEED.perSecond);
}

/**
 * Grip multiplier (0..~1.12) from compound, wear and weather.
 * Wear is 0..100. rain is 0..1 (track wetness).
 */
export function gripFactor(compoundId, wear, rain) {
  const c = COMPOUNDS[compoundId];
  let g = c.grip;
  if (wear > TYRES.cliffStart) {
    const t = (wear - TYRES.cliffStart) / (100 - TYRES.cliffStart);
    g *= lerp(1, TYRES.gripAtCliff, clamp(t, 0, 1));
  }
  // weather suitability: dry tyres hate water, wets hate a dry track
  const wetness = clamp(rain, 0, 1);
  const suitability = c.wet === undefined ? 1 - wetness : 1 - Math.abs(c.wet - wetness);
  g *= lerp(TYRES.wrongWeatherGrip, 1, clamp(suitability, 0, 1));
  return g;
}

/** Wear added over dt seconds at a given speed. */
export function wearDelta(compoundId, speed, dt) {
  const c = COMPOUNDS[compoundId];
  const ratio = speed / SPEED.base;
  return ratio * ratio * c.wearRate * TYRES.wearPerSecond * dt;
}

/** Player scroll speed given the current state. */
export function playerSpeed({ elapsed, throttle, boosting, grip, inPit, spun }) {
  if (inPit) return SPEED.pitLimit;
  let v = baseSpeed(elapsed) * throttle;
  // low grip caps how much of the throttle you can actually use
  v *= lerp(0.55, 1, clamp(grip, 0, 1));
  if (boosting) v *= ERS.boostMultiplier;
  if (spun) v *= 0.35;
  return v;
}

/** Seconds until next hazard spawn. */
export function spawnInterval(elapsed) {
  return Math.max(SPAWN.minInterval, SPAWN.baseInterval - elapsed * SPAWN.intervalDecayPerSecond);
}

/** Weighted hazard choice; rivals and oil become more common later. */
export function pickHazard(elapsed, r = Math.random()) {
  const w = { ...SPAWN.weights };
  const late = clamp(elapsed / 120, 0, 1);
  w.rival += late * 2.5;
  w.oil += late * 1.2;
  w.debris += late * 0.8;
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let acc = 0;
  for (const [k, v] of Object.entries(w)) {
    acc += v / total;
    if (r < acc) return k;
  }
  return 'tyre';
}

/** Whether a pit window is open at time t. */
export function pitWindowOpen(elapsed) {
  if (elapsed < PIT.firstWindowAt) return false;
  const phase = (elapsed - PIT.firstWindowAt) % PIT.interval;
  return phase < PIT.openFor;
}
export function nextPitWindowIn(elapsed) {
  if (elapsed < PIT.firstWindowAt) return PIT.firstWindowAt - elapsed;
  const phase = (elapsed - PIT.firstWindowAt) % PIT.interval;
  return phase < PIT.openFor ? 0 : PIT.interval - phase;
}

/** Axis-aligned rect vs circle. */
export function rectCircle(rect, cx, cy, r) {
  return rectCircleGap(rect, cx, cy, r) <= 0;
}
/** Distance from circle edge to rect (<= 0 when touching/overlapping). */
export function rectCircleGap(rect, cx, cy, r) {
  const nx = clamp(cx, rect.x, rect.x + rect.w);
  const ny = clamp(cy, rect.y, rect.y + rect.h);
  return Math.hypot(cx - nx, cy - ny) - r;
}
export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
/** Gap between two rects (negative when overlapping). */
export function rectGap(a, b) {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  if (dx < 0 && dy < 0) return Math.max(dx, dy);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}

export function formatDistance(metres) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.floor(metres)} m`;
}
export function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// Expansion helpers (pure, tested)
// ---------------------------------------------------------------------------
import { GP, SLIPSTREAM, TYRE_TEMP, VENUES } from './config.js';

/** Index into VENUES for a distance in metres (loops around the calendar). */
export function venueIndexAt(metres) {
  return Math.floor(Math.max(0, metres) / GP.lengthMetres) % VENUES.length;
}
/** How many GPs have been completed at this distance. */
export function gpsCompleted(metres) {
  return Math.floor(Math.max(0, metres) / GP.lengthMetres);
}
/** 0..1 progress through the current GP. */
export function gpProgress(metres) {
  return (Math.max(0, metres) % GP.lengthMetres) / GP.lengthMetres;
}

/**
 * Slipstream strength 0..1 for a rival `dx` px ahead of the player's nose and
 * `dy` px off the player's centre line. Zero when behind or misaligned.
 */
export function towFactor(dx, dy) {
  if (dx <= 0 || dx > SLIPSTREAM.range) return 0;
  const lateral = 1 - clamp(Math.abs(dy) / SLIPSTREAM.lateral, 0, 1);
  const depth = 1 - dx / SLIPSTREAM.range;
  return clamp(lateral * (0.35 + 0.65 * depth), 0, 1);
}

/** Grip multiplier from tyre temperature 0..1. */
export function tempGrip(temp) {
  return lerp(TYRE_TEMP.coldGrip, 1, clamp(temp, 0, 1));
}

/** Position label for the HUD from overtakes (starts P20, can't go past P1). */
export function positionLabel(overtakes) {
  return `P${Math.max(1, 20 - overtakes)}`;
}

// ---------------------------------------------------------------------------
// Pit-stop mini-game maths
// ---------------------------------------------------------------------------
import { PITGAME } from './config.js';

/** Marker position 0..1 for a wheel that has been live for `t` seconds (ping-pong sweep). */
export function sweepPos(t) {
  const x = (t * PITGAME.sweepSpeed) % 2;
  return x <= 1 ? x : 2 - x;
}
/** Judges a wheel-gun press at marker position `pos` (0..1). */
export function judgeWheel(pos, jammed = false) {
  const d = Math.abs(pos - 0.5);
  if (d <= PITGAME.perfectHalf) return 'perfect';
  if (d <= (jammed ? PITGAME.jamZoneHalf : PITGAME.zoneHalf)) return 'good';
  return 'miss';
}
/** Total stationary time for a list of wheel results ('perfect' | 'good' | 'miss'). */
export function stopTime(results) {
  return PITGAME.time.base + results.reduce((s, r) => s + PITGAME.time[r], 0);
}
/** Summary of a finished stop. */
export function stopSummary(results) {
  const time = stopTime(results);
  const misses = results.filter((r) => r === 'miss').length;
  const perfects = results.filter((r) => r === 'perfect').length;
  return { time, misses, perfects, clean: misses === 0, record: misses === 0 && time < PITGAME.recordUnder };
}

// ---------------------------------------------------------------------------
// Engine model (shared by the synth and the sample player)
// ---------------------------------------------------------------------------
export const ENGINE = { gears: 8, idleRpm: 4000, maxRpm: 12500, cylinders: 12 };
/**
 * Gear, normalised rpm (0..1 of the rev range) and the V12 firing frequency for a
 * speed ratio 0..1. Sequential box: rpm climbs through a gear and drops on the upshift.
 */
export function engineState(speedRatio) {
  const r = clamp(speedRatio, 0, 1);
  const pos = r * ENGINE.gears;
  const gear = Math.min(ENGINE.gears, Math.floor(pos) + 1);
  const inGear = pos - (gear - 1); // 0..1
  // the lower gears rev out over a smaller speed band, so the redline arrives sooner
  const rpmNorm = clamp(0.3 + 0.7 * inGear, 0, 1);
  const rpm = ENGINE.idleRpm + rpmNorm * (ENGINE.maxRpm - ENGINE.idleRpm);
  // a four-stroke fires every cylinder once per two revolutions
  const firingHz = (rpm / 60) * (ENGINE.cylinders / 2);
  return { gear, rpmNorm, rpm, firingHz };
}
