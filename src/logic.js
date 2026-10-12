// Pure gameplay maths. No DOM, no canvas, no side effects — this module is
// unit-tested under Node (see test/logic.test.js) and shared by the world sim.
import { COMPOUNDS, ERS, FLOW, PIT, SC_GAME, SPAWN, SPEED, TYRES, WORLD } from './config.js';

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
  g *= lerp(TYRES.wrongWeatherGrip, 1, suitability(compoundId, rain));
  return g;
}
/**
 * How well a compound suits a track this wet, 0..1 (see TYRES.suit). Slicks fall off above a
 * damp track, inters own the middle, full wets win once it is properly wet: at 0 / 0.5 / 0.9
 * wetness the best tyre is a slick / an inter / a wet (the same answer as bestCompound).
 */
export function suitability(compoundId, rain) {
  const c = COMPOUNDS[compoundId];
  const w = clamp(rain, 0, 1);
  const S = TYRES.suit;
  // 1 at `full`, 0 at `zero`, linear between (either way round)
  const ramp = (full, zero) => clamp((w - zero) / (full - zero), 0, 1);
  if (c.wet === undefined) return ramp(S.slick.full, S.slick.zero);
  if (c.wet < 1) {
    if (w < S.inter.lo) return lerp(S.inter.dry, 1, w / S.inter.lo);
    if (w > S.inter.hi) return lerp(1, S.inter.flooded, (w - S.inter.hi) / (1 - S.inter.hi));
    return 1;
  }
  return ramp(S.wet.full, S.wet.zero);
}

/**
 * Wear added over dt seconds at a given speed; `wearMul` is the car's tyre-wear multiplier.
 * `refSpeed` is what counts as neutral (the world passes the current base speed), so pushing
 * costs rubber but merely surviving longer does not.
 */
export function wearDelta(compoundId, speed, dt, wearMul = 1, refSpeed = SPEED.base, rain = null) {
  const c = COMPOUNDS[compoundId];
  const ratio = speed / refSpeed;
  // inters and wets on a dry track (`rain` given and below TYRES.dryBelow) cook themselves
  const dry = rain !== null && rain < TYRES.dryBelow && c.dryWear ? c.dryWear : 1;
  return ratio * ratio * c.wearRate * TYRES.wearPerSecond * wearMul * dry * dt;
}

/**
 * Player scroll speed given the current state; `speedMul` is the car's top-speed multiplier and
 * `pace` the compound's straight-line pace (COMPOUNDS.*.pace).
 */
export function playerSpeed({ elapsed, throttle, boosting, grip, inPit, spun, speedMul = 1, pace = 1 }) {
  if (inPit) return SPEED.pitLimit;
  let v = baseSpeed(elapsed) * throttle * speedMul;
  // low grip caps how much of the throttle you can actually use; extra grip above 1 buys nothing here,
  // a soft's advantage on the straight is its pace
  v *= lerp(0.55, 1, clamp(grip, 0, 1)) * pace;
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
/** Seconds left before the open pit window closes (0 when it is closed). */
export function pitOpenLeft(elapsed) {
  if (elapsed < PIT.firstWindowAt) return 0;
  const phase = (elapsed - PIT.firstWindowAt) % PIT.interval;
  return phase < PIT.openFor ? PIT.openFor - phase : 0;
}
/**
 * How long the current tyres have to last if you do not box now: to the end of the next window
 * after this one when a window is open (skip it and that is your next chance), else to the end of
 * the coming window.
 */
export function forecastHorizon(elapsed) {
  const left = pitOpenLeft(elapsed);
  return left > 0 ? left + PIT.interval : nextPitWindowIn(elapsed) + PIT.openFor;
}
/**
 * Wear forecast for the tyre card: where `wear` (0..100) will be after `horizon` seconds at `rate`
 * %/s, and the verdict: MAKES IT (still before the cliff), MARGINAL (over the cliff but no
 * puncture) or WON'T LAST (it will go before you can box).
 */
export function wearForecast(wear, rate, horizon) {
  const at = wear + Math.max(0, rate) * Math.max(0, horizon);
  const verdict = at >= 100 ? 'wontLast' : at > TYRES.cliffStart ? 'marginal' : 'makesIt';
  return { wear: Math.min(100, at), verdict };
}
export const FORECAST_LABEL = { makesIt: 'MAKES IT', marginal: 'MARGINAL', wontLast: "WON'T LAST" };

// ----- car-shaped hitboxes -----
import { HITBOX } from './config.js';
/**
 * The hit parts of a car drawn w×h centred on (x, y): `[body, cockpit]` rects (see config.HITBOX).
 * `profile` is HITBOX.player (the sprite) or HITBOX.rival (the vector car).
 */
export function carHitParts(x, y, w, h, profile = HITBOX.player) {
  const r = (b) => ({ x: x + b.x0 * w, y: y + b.y0 * h, w: (b.x1 - b.x0) * w, h: (b.y1 - b.y0) * h });
  return [r(profile.body), r(profile.cockpit)];
}
/** Bounding rect of a list of rects. */
export function rectsBounds(rects) {
  const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w)), y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
/** Smallest gap between any of `parts` and a shape tested by `gapFn(rect)` (<= 0 when touching). */
export function partsGap(parts, gapFn) {
  let g = Infinity;
  for (const r of parts) g = Math.min(g, gapFn(r));
  return g;
}
/**
 * Overlap between two sets of parts: the largest x and y overlap over the touching pairs
 * (`ox`/`oy` are 0 when nothing touches). Used to judge a touch the same way the hit was found.
 */
export function partsOverlap(a, b) {
  let ox = 0, oy = 0, hit = false;
  for (const p of a) {
    for (const q of b) {
      if (!rectsOverlap(p, q)) continue;
      hit = true;
      ox = Math.max(ox, Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x));
      oy = Math.max(oy, Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y));
    }
  }
  return { hit, ox, oy };
}

/** y after `t` seconds at `vy`, bouncing off lo/hi (how a loose tyre comes off the kerbs). */
export function foldY(y, vy, t, lo, hi) {
  const span = hi - lo;
  if (span <= 0) return lo;
  let u = (y + vy * t - lo) % (2 * span);
  if (u < 0) u += 2 * span;
  return lo + (u <= span ? u : 2 * span - u);
}

/**
 * Fair spawns. Where can a new hazard's centre go so that the car still has a gap it fits through?
 * Every hazard is turned into the stretch of time it spends crossing the car's line (`playerX`,
 * car `opts.playerLen` long) at its closing speed; the ones crossing at about the same time as the
 * new one (within `opts.slack` s) are a wall, and their y extents (projected to that moment, folded
 * at the kerbs) are blocked. Returns `[lo, hi]` intervals for the new centre: never on top of an
 * existing hazard, and always leaving a gap of at least `opts.minGap` px. Empty when there is none.
 *  - `opts.size`: half the new hazard's height (r, or h/2); `opts.len`: half its length along the track
 *  - `opts.closing`: px/s it will close on the car at
 */
export function freeLanes(hazards, spawnX, playerX, scrollV, trackTop, trackBottom, opts = {}) {
  const { size = 20, len = size, closing = scrollV, minGap = SPAWN.minGap, slack = SPAWN.wallSlack, playerLen = 140, step = 4 } = opts;
  const half = playerLen / 2;
  const c0 = Math.max(1, closing);
  const t0 = (spawnX - len - (playerX + half)) / c0;
  const t1 = (spawnX + len - (playerX - half)) / c0;
  const blocked = [];
  for (const hz of hazards) {
    if (hz.type === 'drs' || hz.dead) continue;
    const hl = hz.r ?? hz.w / 2;
    const hh = hz.r ?? hz.h / 2;
    const v = hz.type === 'tyre' || hz.type === 'debris' ? hz.vx : (hz.rel ?? 0);
    const c = scrollV - v;
    if (c <= 1) continue; // not coming to you (or leaving you behind)
    const a = (hz.x - hl - (playerX + half)) / c;
    const b = (hz.x + hl - (playerX - half)) / c;
    if (b < 0 || b < t0 - slack || a > t1 + slack) continue;
    // where it will be when the new hazard gets there (rivals that weave sweep a band)
    const tm = clamp((t0 + t1) / 2, Math.max(0, a), Math.max(0, b));
    const y = hz.vy ? foldY(hz.y, hz.vy, tm, trackTop + hh, trackBottom - hh) : hz.y;
    const sweep = hz.weave ? 44 : hz.defend ? 30 : 0;
    blocked.push([y - hh - sweep, y + hh + sweep]);
  }
  // gaps left on the track once a hazard of half-height `size` sits at `yc` (null: as it is now)
  const widest = (yc) => {
    const spans = blocked.slice();
    if (yc !== null) spans.push([yc - size, yc + size]);
    spans.sort((p, q) => p[0] - q[0]);
    let best = 0, edge = trackTop;
    for (const [lo, hi] of spans) {
      if (lo > edge) best = Math.max(best, lo - edge);
      edge = Math.max(edge, hi);
    }
    return Math.max(best, trackBottom - edge);
  };
  const out = [];
  if (widest(null) < minGap) return out;
  let run = null;
  for (let yc = trackTop + size; yc <= trackBottom - size + 1e-6; yc += step) {
    const onTop = blocked.some(([lo, hi]) => yc + size > lo && yc - size < hi);
    const ok = !onTop && widest(yc) >= minGap;
    if (ok) { if (run) run[1] = yc; else run = [yc, yc]; }
    else if (run) { out.push(run); run = null; }
  }
  if (run) out.push(run);
  return out;
}
/** Picks a y from freeLanes intervals, uniformly over their total length; null when there are none. */
export function pickInLanes(lanes, r = Math.random()) {
  const total = lanes.reduce((s, [lo, hi]) => s + (hi - lo) + 1, 0);
  if (!lanes.length) return null;
  let acc = r * total;
  for (const [lo, hi] of lanes) {
    const len = hi - lo + 1;
    if (acc <= len) return lo + Math.min(hi - lo, acc);
    acc -= len;
  }
  return lanes[lanes.length - 1][1];
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
/**
 * Gap between a rect and an axis-aligned ellipse, measured in ellipse radii (<= 0 when touching).
 * Exact: squash space so the ellipse becomes a unit circle, then it is a rect/circle test.
 */
export function rectEllipseGap(rect, cx, cy, rx, ry) {
  const nx = (clamp(cx, rect.x, rect.x + rect.w) - cx) / rx;
  const ny = (clamp(cy, rect.y, rect.y + rect.h) - cy) / ry;
  return Math.hypot(nx, ny) - 1;
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

// ----- the safety-car weave -----
/** One step of the weave: `weaves` counted reversals this step add heat, safety-car pace bleeds it. */
export function weaveHeat(heat, dt, weaves = 0) {
  return clamp(heat + weaves * SC_GAME.heatPerWeave - SC_GAME.coolPerSecond * dt, 0, 1);
}
/** cold | warm | hot against the temperature window. */
export function weaveZone(heat) {
  return heat < SC_GAME.band.lo ? 'cold' : heat > SC_GAME.band.hi ? 'hot' : 'warm';
}
/** Restart bonus for time spent in the window, rounded to tens so the popup reads cleanly. */
export function weaveBonus(inBand, total) {
  if (total <= 0) return 0;
  return Math.round((SC_GAME.bonus * clamp(inBand / total, 0, 1)) / 10) * 10;
}

// ----- tyres for the weather -----
/** Slicks on a wet track (rain above 0.35) or rain tyres on a dry one (below 0.1). */
export function wrongForWeather(compoundId, rain) {
  const c = COMPOUNDS[compoundId];
  if (!c) return false;
  return c.wet === undefined ? rain > 0.35 : rain < 0.1;
}
/** The tyre the wall would fit for this much water: medium, inter, or full wet. */
export function bestCompound(rain) {
  return rain > 0.7 ? 'wet' : rain > 0.35 ? 'inter' : 'medium';
}

/** Grip multiplier from tyre temperature 0..1. */
export function tempGrip(temp) {
  return lerp(TYRE_TEMP.coldGrip, 1, clamp(temp, 0, 1));
}

/** Position label for the HUD (World.position, held between P1 and the back of the field). */
export function positionLabel(position) {
  return `P${clampPosition(position)}`;
}
export const clampPosition = (position) => clamp(Math.round(position), 1, GP.fieldSize);
/** Championship points for finishing a Grand Prix in `position` (F1's 25-18-15-…-1 for the top ten). */
export function pointsFor(position) {
  return GP.points[clampPosition(position) - 1] || 0;
}
/**
 * Track a pit stop gives away against the field (metres): the lane at the pit limiter while they run
 * at `refSpeed`, plus `stopSeconds` stationary. `laneSeconds` is the time spent rolling in the lane.
 */
export function pitLossMetres(refSpeed, stopSeconds, laneSeconds = PIT.laneTravel + PIT.mergeTime) {
  return (Math.max(0, refSpeed - SPEED.pitLimit) * laneSeconds + Math.max(0, refSpeed) * stopSeconds) * WORLD.metresPerPx;
}
/**
 * Places a loss of `metres` costs (one per GP.placeGapMetres, rounded). The gap between cars is a
 * time gap, so in metres it grows with the field's speed: pass `elapsed` and the gap scales with
 * baseSpeed(elapsed) / SPEED.base, which keeps a typical stop at about three places all race.
 */
export function placesLost(metres, elapsed = 0) {
  const gap = GP.placeGapMetres * (baseSpeed(elapsed) / SPEED.base);
  return Math.max(0, Math.round(metres / gap));
}

// ----- flow -----
/** The flow multiplier after one more chained move (capped at FLOW.max). */
export function flowStep(mult) {
  return Math.min(FLOW.max, mult + FLOW.step);
}
/** Points a move worth `base` pays at multiplier `mult` (whole points). */
export function flowPay(base, mult) {
  return Math.round(base * mult);
}
/** Flow tier for the HUD and the audio: 0 below ×1.5, then one per half (×1.5, ×2, ×2.5, ×3 → 1..4). */
export function flowTier(mult) {
  return Math.max(0, Math.floor((mult - 1) / 0.5 + 1e-9));
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
/** Half-widths of the good and perfect zones for a wheel; `crew` is the car's pit-crew multiplier. */
export function wheelZones(jammed = false, crew = 1) {
  return { good: (jammed ? PITGAME.jamZoneHalf : PITGAME.zoneHalf) * crew, perfect: PITGAME.perfectHalf * crew };
}
/** Judges a wheel-gun press at marker position `pos` (0..1). */
export function judgeWheel(pos, jammed = false, crew = 1) {
  const d = Math.abs(pos - 0.5);
  const z = wheelZones(jammed, crew);
  if (d <= z.perfect) return 'perfect';
  if (d <= z.good) return 'good';
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
// The start and the damage model (pure, tested)
// ---------------------------------------------------------------------------
import { DAMAGE, START } from './config.js';

/** Red lights lit `t` seconds after the sequence began (0 before it starts, capped at five). */
export function lightsLit(t) {
  if (t < 0) return 0;
  return Math.min(START.lights, Math.floor(t / START.lightInterval) + 1);
}
/** Seconds of lights before they can go out (the random hold is added on top). */
export const lightsFullAt = () => START.lights * START.lightInterval;

/**
 * What a touch with a rival costs. `ahead`: the rival is in front of you. `ox`/`oy`: overlap
 * of the two hitboxes; `h`: your hitbox height. `closing`: how fast you were gaining on it.
 * Returns the part that takes the hit ('wing' | 'floor') or 'crash'.
 *  - alongside (little vertical overlap): a floor rub, always survivable
 *  - nose into the car ahead: wing damage if the impact was gentle, or during the launch
 *  - anything into a part already at 100, or a hard hit outside the launch: crash
 */
export function contactOutcome({ ahead, ox, oy, h, closing, launch, parts }) {
  const sideRub = oy < h * 0.5;
  const part = sideRub || !ahead ? 'floor' : 'wing';
  // `reason` is what the retirement screen explains: terminal (part already gone), hard (too fast),
  // deep (nose buried too far in), rear (run into from behind); survivable: launch, side, gentle
  if (parts[part] >= 100) return { crash: true, part, reason: 'terminal' };
  if (launch) return { crash: false, part, reason: 'launch' };
  if (sideRub) return { crash: false, part, reason: 'side' };
  if (!ahead) return { crash: true, part, reason: 'rear' };
  if (closing > DAMAGE.maxClosing) return { crash: true, part, reason: 'hard' };
  if (ox > DAMAGE.frontalDepth) return { crash: true, part, reason: 'deep' };
  return { crash: false, part, reason: 'gentle' };
}
/** Throttle ceiling lost to wing damage and the grip multiplier from floor damage. */
export function damageEffects(parts) {
  return {
    throttleLoss: (clamp(parts.wing, 0, 100) / 100) * DAMAGE.wingThrottleLoss,
    gripMul: lerp(1, 1 - DAMAGE.floorGripLoss, clamp(parts.floor, 0, 100) / 100),
  };
}
/** Single 0..100 figure for the damage meter: the worst part. */
export const totalDamage = (parts) => Math.max(parts.wing, parts.floor);

const PART_NAME = { wing: 'front wing', floor: 'floor' };
/**
 * The retirement screen's explanation of a crash (World.crashCause): `line` says what happened,
 * `tip` how to survive it next time, `extra` (or null) points at the tyres when they were the
 * real reason. Every kind reads differently so the player learns the rule that got them.
 */
export function describeCrash(cause) {
  if (!cause) return { line: 'Retired.', tip: '', extra: null };
  const who = cause.driver ? cause.driver.short || cause.driver.name : 'the car ahead';
  const kmh = cause.closingKmh ? `+${cause.closingKmh} km/h closing` : 'speed';
  let line, tip;
  switch (cause.kind) {
    case 'tyre':
      line = `Loose ${cause.compound ? `${cause.compound} ` : ''}tyre${cause.big ? ' — a big one' : ''}. A rolling tyre is always fatal.`;
      tip = 'Watch the right edge: a chevron in the tyre\'s colour shows where it will come on.';
      break;
    case 'nose':
      line = cause.reason === 'deep'
        ? `Nose buried in ${who}'s gearbox. Too deep to be a touch.`
        : `Nose into ${who}'s gearbox at ${kmh}.`;
      tip = 'Side-by-side is survivable; lift (◀) to soften a hit from behind a slower car.';
      break;
    case 'rear':
      line = `${cause.driver ? who : 'A faster car'} ran into the back of you at ${kmh}.`;
      tip = 'A ◀◀ on the left edge is a car coming from behind: get out of its lane.';
      break;
    case 'terminal-part':
      line = `Hit ${cause.driver ? who : 'a car'} with the ${PART_NAME[cause.part] || 'bodywork'} already gone.`;
      tip = 'At 100 % the damage card reads NEXT HIT = OUT: box for repairs, the crew fixes it with the tyres.';
      break;
    case 'debris':
      line = 'Debris went under the car: the front wing was already gone.';
      tip = 'Debris only costs bodywork while there is a wing to take it. Box once the card reads NEXT HIT = OUT.';
      break;
    case 'stranded':
      line = `Into ${cause.driver ? `${who}'s` : 'the'} stranded car under the yellow. A stopped car is always fatal.`;
      tip = 'The flashing yellow chevron on the right edge marks where it sits.';
      break;
    default:
      line = 'Retired.';
      tip = '';
  }
  let extra = null;
  if (cause.punctured) extra = 'And you were limping on a puncture.';
  else if (cause.cliffAt !== null && cause.cliffAt !== undefined) {
    extra = cause.stops ? `Tyres had been over the cliff since ${formatTime(cause.cliffAt)}.` : `You never boxed: tyres hit the cliff at ${formatTime(cause.cliffAt)}.`;
  }
  return { line, tip, extra };
}

// ---------------------------------------------------------------------------
// Engine model (shared by the synth and the sample player)
// ---------------------------------------------------------------------------
export const ENGINE = { gears: 8, idleRpm: 4000, maxRpm: 12000, cylinders: 6 };
/**
 * Firing frequency of the 1.6 L V6 for a normalised rpm (0 = idle, 1 = the race redline).
 * A four-stroke fires every cylinder once per two revolutions: rpm/60 × 3, so 200 Hz at
 * idle and 600 Hz flat out. Above 1 is allowed (downshift blips overshoot the redline).
 */
export function firingHzFromNorm(rpmNorm) {
  const rpm = ENGINE.idleRpm + Math.max(0, rpmNorm) * (ENGINE.maxRpm - ENGINE.idleRpm);
  return (rpm / 60) * (ENGINE.cylinders / 2);
}
/**
 * Gear, normalised rpm (0..1 of the rev range) and the V6 firing frequency for a
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
  const firingHz = firingHzFromNorm(rpmNorm);
  return { gear, rpmNorm, rpm, firingHz };
}
