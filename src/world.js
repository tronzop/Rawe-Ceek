// The simulation. Owns every gameplay entity and advances them by dt.
// It knows nothing about the canvas or audio; it reports interesting moments
// through `emit(event, payload)` so the presentation layer can react.
//
// Events for the race-craft layer (flow, track position, the pit window, the weather radar):
//  - 'flowTier'      { tier, mult, up, reason }  flow tier changed (0 = ×1–1.25, 1 = ×1.5, 2 = ×2, 3 = ×2.5, 4 = ×3);
//                    reason on a drop: 'timeout' | 'contact' | 'oil' | 'penalty' | 'pit'
//  - 'scrape'        { driver, type }  a close call nearer than FLOW.scrapeGap (double pay, slow motion)
//  - 'passedBy'      { hz, driver, team, teammate, side: 'left'|'right', position }  a car from behind cleared
//                    your nose (left = above you on screen); costs a place
//  - 'pitOpen'       { reason: 'window'|'puncture'|'damage'|'sc' }
//  - 'pitWindowTick' { left }  the last two seconds of a window, every half second (2, 1.5, 1, 0.5)
//  - 'pitOut'        adds { lossMetres, places, position } to the wheel-gun summary
//  - 'drs'           { gain }  battery actually added
//  - 'forecast'      { kind: 'rain'|'dry', in, peak?, best? }  the radar: rain in `in` s (peak 1 heavy, WEATHER.damp light), or the end of it
//  - 'rainStart'     { peak, best }
//  - 'chequered'     adds { position, points } (F1 points by position)
import {
  COMPOUNDS, COMPOUND_ORDER, DAMAGE, ERS, FLOW, GP, HITBOX, PIT, PITGAME, PLAYER, RIVAL_AI, SAFETY_CAR, SC_GAME, SCORING, SCORING_EXTRA, SLIPSTREAM,
  SPAWN, SPEED, START, STORM, TEAMMATE, TYRES, TYRE_TEMP, VENUES, WARN, WEATHER, WORLD,
} from './config.js';
import {
  baseSpeed, bestCompound, clamp, gpsCompleted, gripFactor, lerp, nextPitWindowIn, pick, pickHazard, pitWindowOpen, rand, rectCircleGap,
  rectEllipseGap, rectGap, playerSpeed, wrongForWeather, spawnInterval, tempGrip, towFactor, venueIndexAt, wearDelta, judgeWheel, sweepPos, stopSummary,
  contactOutcome, damageEffects, lightsFullAt, lightsLit, totalDamage, weaveBonus, weaveHeat, weaveZone,
  carHitParts, foldY, freeLanes, partsGap, partsOverlap, pickInLanes, rectsBounds,
  clampPosition, flowPay, flowStep, flowTier, forecastHorizon, pitLossMetres, pitOpenLeft, placesLost, pointsFor, wearForecast,
} from './logic.js';
import { EMPTY_RUN } from './career.js';
import { DRIVERS, LEGEND_BONUS, LEGEND_CHANCE, TEAMS, teamOf } from './grid.js';
import { carById, DEFAULT_CAR } from './cars.js';

const LEGENDS = DRIVERS.filter((d) => d.legend);
/** The current grid split by the team you drive for: its drivers are your team-mates, the rest are rivals. */
export function rosterFor(teamId) {
  return {
    mates: DRIVERS.filter((d) => !d.legend && d.team === teamId),
    others: DRIVERS.filter((d) => !d.legend && d.team !== teamId),
  };
}
/** Picks a rival driver: your team-mate, a legend, or somebody from the rest of the grid. */
export function pickDriver(teammate, teamId = DEFAULT_CAR) {
  const { mates, others } = rosterFor(teamId);
  if (teammate) return pick(mates);
  return pick(Math.random() < LEGEND_CHANCE ? LEGENDS : others);
}

let nextId = 1;
/** Where the car sits across the screen: further back on narrow (phone-portrait-ish) aspects so more track shows ahead. */
export const playerXFor = (width, height) => width * (width / height < 1.5 ? WORLD.playerXNarrow : WORLD.playerX);
/** Seconds the world holds still on the moment of impact before the tumble plays (the crash freeze-frame). */
export const CRASH_FREEZE = 0.4;
/** What each score source is called in World.run.scoreBy. */
export const SCORE_SOURCES = ['distance', 'passes', 'close', 'pit', 'gp', 'other'];

export class World {
  /** `car` is an entry from cars.js (or its id); it decides the livery, the handling and who your team-mate is. */
  constructor(emit, car = DEFAULT_CAR) {
    this.emit = emit || (() => {});
    this.width = 1280;
    this.height = WORLD.height;
    this.car = typeof car === 'string' ? carById(car) : car;
    this.reset();
  }

  // ----- geometry helpers -----
  get trackTop() { return this.height * WORLD.trackTop; }
  get trackBottom() { return this.height * WORLD.trackBottom; }
  get pitTop() { return this.height * WORLD.pitLaneTop; }
  get pitBottom() { return this.height * WORLD.pitLaneBottom; }
  get pitY() { return (this.pitTop + this.pitBottom) / 2; }

  resize(width, height) {
    this.width = width;
    this.height = height;
    // a crashed car keeps tumbling from where it was, and a car in the pit lane stays in it
    if (!this.gameOver) this.player.x = playerXFor(width, height);
    if (!this.pit.inLane && !this.gameOver) this.player.y = clamp(this.player.y, this.trackTop, this.trackBottom);
  }

  reset() {
    this.elapsed = 0;
    this.distance = 0; // metres
    this.score = 0;
    this.bonus = 0;
    this.speed = 0; // sitting on the grid
    this.scroll = 0;
    this.gameOver = false;
    this.gameOverTime = 0;
    this.shake = 0;
    this.overtakes = 0;
    this.closeCalls = 0;
    this.pushTimer = 0;
    this.milestone = 0;
    this.hazards = [];
    this.particles = [];
    this.popups = [];
    this.spawnTimer = 1.2;
    this.breather = 0; // seconds of no spawns left (after the chequered flag)
    this.warnings = []; // edge warnings for hazards about to come on screen (see updateWarnings)
    this.crashCause = null; // why the race ended (see crash()); the retirement screen explains it
    this.crashShapes = null; // both hitboxes at the moment of impact, outlined during the freeze-frame
    this.cliffAt = null; // race time the current set of tyres went over the cliff
    this.drsTimer = rand(SPAWN.drsEvery.min, SPAWN.drsEvery.max);
    this.rain = 0; // 0..1 track wetness
    this.raining = false;
    this.rainTimer = 0;
    this.dryTimer = WEATHER.firstRainAfter;
    this.rainPeak = 1; // how wet this shower gets: 1, or WEATHER.damp for a light one
    this.dampHold = 0; // s the drying track still holds at WEATHER.damp
    this.forecast = null; // { kind: 'rain'|'dry', in: seconds, peak } once the wall can see the weather turning
    // flow: chained close calls / overtakes / DRS gates multiply what they pay (see FLOW)
    this.flow = { mult: 1, timer: 0, tier: 0 };
    this.slowmo = 0; // s of scrape slow motion left
    this.scrapeFlash = 0; // 0..1 white rim round the car after a scrape
    // track position: P13 at the back of the grid, a place per pass either way, places lost in the pits
    this.position = START.gridCars + 1;
    this.flash = 0; // lightning
    this.tyre = { compound: 'medium', wear: 0, punctured: false, temp: 1, rate: 0 }; // rate: wear %/s (EMA), for the forecast
    this.nextCompound = 'medium';
    this.ers = { charge: ERS.max, boosting: false };
    this.pit = {
      open: false, wasOpen: false, inLane: false, phase: 'none', timer: 0, stopFor: 0, slow: false, stops: 0, requested: false, game: null, cooldown: 0,
      // why it is open ('window' | 'puncture' | 'damage' | 'sc'), seconds of window left, the last countdown tick
      reason: null, left: 0, tick: 0,
      lossPx: 0, lossMetres: 0, placesLost: 0, // what the current / last stop cost against the field
    };
    this.player = {
      x: playerXFor(this.width, this.height),
      y: (this.trackTop + this.trackBottom) / 2,
      vy: 0,
      throttle: 1,
      tilt: 0,
      spin: 0, // seconds of remaining spin from oil
      angle: 0,
      frame: 0,
      parts: { wing: 0, floor: 0 }, // damage 0..100 per part (see DAMAGE)
      grace: 0, // seconds of invulnerability after rejoining from the pits
      alive: true,
    };
    // the start: grid → lights → go. `launch` counts down the forgiving opening phase.
    this.start = { phase: 'grid', t: 0, lit: 0, hold: rand(START.hold.min, START.hold.max), launch: 0, sinceGo: 0, reaction: null, jumped: false, slots: [] };
    this.packV = 0; // reference speed of the launching field (a neutral-throttle launch), rivals track it
    // calendar
    this.venueIndex = 0;
    this.venuePrev = 0;
    this.venueBlend = 1; // 0..1 morph from venuePrev to venueIndex
    this.night = VENUES[0].night ? 1 : 0;
    this.gps = 0;
    // safety car
    this.sc = {
      active: false, phase: 'none', timer: 0, cooldown: SAFETY_CAR.firstAfter, restartTimer: 0, grace: 0, takeover: 0, clean: true, car: null,
      // the neutralised phase: the car drives itself, you weave to keep the tyres warm
      neutral: false, weave: null, countdown: -1, lastCount: -1,
      // the jump: hit the throttle right after the green (but not before)
      jump: 0, jumpArmed: false,
    };
    this.pointerLastY = null; // for the weave: the finger's direction of travel, not its position
    this.penalty = 0;
    this.cine = 0; // 0..1 pit-entry cinematic blend
    // slipstream
    this.tow = 0;
    this.towRival = null;
    this.towAnnounced = false;
    this.lastRadio = 0;
    this.radioLog = [];
    this.stats = { maxSpeed: 0 };
    this.run = EMPTY_RUN();
    this.run.car = this.car.id;
    // where the score came from, for the retirement screen's breakdown (distance is filled in every frame)
    this.run.scoreBy = Object.fromEntries(SCORE_SOURCES.map((k) => [k, 0]));
    this.placeGrid();
  }

  /** Lines the field up ahead of you: two staggered columns, you at the back of the inside one. */
  placeGrid() {
    const p = this.player;
    const w = PLAYER.width * 0.92;
    const h = PLAYER.height * 0.92;
    const lanes = [this.trackTop + h * 0.5 + 28, this.trackBottom - h * 0.5 - 28];
    p.y = lanes[1];
    this.start.slots = [{ x: p.x, y: p.y }];
    // everyone on the current grid once, your team-mate somewhere in the pack
    const { mates, others } = rosterFor(this.car.team);
    const field = [...others].sort(() => Math.random() - 0.5).slice(0, START.gridCars - 1);
    field.splice(Math.floor(rand(1, START.gridCars - 1)), 0, pick(mates));
    field.forEach((driver, i) => {
      const slot = i + 1;
      const x = p.x + slot * START.spacing;
      const y = lanes[(slot + 1) % 2] + rand(-5, 5); // staggered: the car directly ahead of you is two slots up
      this.start.slots.push({ x, y });
      this.hazards.push({
        id: nextId++, type: 'rival', x, y, w, h, rel: 0, vy: 0, scPace: 0, team: teamOf(driver), driver, teammate: driver.team === this.car.team,
        fromBehind: false, weave: false, weavePhase: rand(0, 6.28), passed: false, frame: 0, defend: false, brake: 0,
        grid: true, v: 0, // absolute speed while the field launches
      });
    });
  }

  // ----- public read helpers -----
  /** The team whose colours you race in. */
  get team() { return TEAMS[this.car.team]; }
  get venue() { return VENUES[this.venueIndex]; }
  get prevVenue() { return VENUES[this.venuePrev]; }
  get grip() { return gripFactor(this.tyre.compound, this.tyre.wear, this.rain) * tempGrip(this.tyre.temp) * damageEffects(this.player.parts).gripMul; }
  get damage() { return totalDamage(this.player.parts); }
  get racing() { return this.start.phase === 'go'; }
  get kmh() { return Math.round(this.speed * SPEED.kmhPerPx); }
  get intensity() { return clamp((this.speed - SPEED.base) / (SPEED.max - SPEED.base), 0, 1); }
  /** The car's hit parts: a body block and a cockpit block (the air above the nose is not the car). */
  get playerParts() {
    const p = this.player;
    return carHitParts(p.x, p.y, PLAYER.width, PLAYER.height, HITBOX.player);
  }
  /** Bounding box of the hit parts (overtake bookkeeping, layout). */
  get playerRect() { return rectsBounds(this.playerParts); }
  /** Hit parts of a rival or stranded car. */
  hazardParts(hz) { return carHitParts(hz.x, hz.y, hz.w, hz.h, HITBOX.rival); }
  /** Banks points and books them against a score source (World.run.scoreBy). */
  addScore(pts, source = 'other') {
    this.bonus += pts;
    const by = this.run.scoreBy;
    by[source] = (by[source] || 0) + pts;
  }
  pitCountdown() { return nextPitWindowIn(this.elapsed); }
  /**
   * The tyre card's forecast: projected wear when the next window you could still use closes, and the
   * verdict (makesIt | marginal | wontLast). Null in the lane, on a puncture, or before the rate is known.
   */
  get wearForecast() {
    if (this.pit.inLane || this.tyre.punctured || this.tyre.rate <= 0) return null;
    return wearForecast(this.tyre.wear, this.tyre.rate, forecastHorizon(this.elapsed));
  }
  /** What the wetness will be once the weather the wall can see has arrived (the forecast, else now). */
  get expectedRain() {
    const fc = this.forecast;
    if (fc && fc.kind === 'rain') return fc.peak;
    if (fc && fc.kind === 'dry') return 0;
    return this.raining ? this.rainPeak : 0; // not raining: the track is dry or drying
  }

  radio(kind, ctx) {
    this.emit('radio', { kind, ctx });
  }

  setNextCompound(id) {
    if (!COMPOUNDS[id] || id === this.nextCompound) return;
    this.nextCompound = id;
    this.emit('compound', { compound: id });
  }
  cycleCompound() {
    const i = COMPOUND_ORDER.indexOf(this.nextCompound);
    this.setNextCompound(COMPOUND_ORDER[(i + 1) % COMPOUND_ORDER.length]);
  }

  /** Wheel-gun trigger during a stop (Space / B / tap). Returns the judgement or null. */
  pitAction() {
    const g = this.pit.game;
    if (!g || this.pit.phase !== 'stop' || g.wheel >= PITGAME.wheels.length || g.hold > 0) return null;
    return this.resolveWheel(judgeWheel(sweepPos(g.t), g.jammed[g.wheel], this.car.pitCrew), false);
  }
  resolveWheel(result, timedOut) {
    const g = this.pit.game;
    const index = g.wheel;
    g.results.push(result);
    g.lastResult = result;
    g.flash = 1;
    g.wheel += 1;
    // the wheel takes its time; a miss is a cross-threaded nut and a very long second
    g.hold = PITGAME.time[result] + (g.wheel >= PITGAME.wheels.length ? PITGAME.time.base : 0);
    if (result === 'miss') this.shake = 0.35;
    this.emit('pitWheel', { index, wheel: PITGAME.wheels[index], result, timedOut, jammed: g.jammed[index] });
    return result;
  }

  /** Box this lap: if the window is open the car drives itself to the pit entry. */
  requestPit() {
    if (this.gameOver || this.pit.inLane) return false;
    if (!this.pit.open) { this.emit('pitDenied'); return false; }
    this.pit.requested = true;
    this.emit('pitRequested');
    return true;
  }

  /** The weave: a reversal of steering direction counts once the car has actually swung `minSwing` px. */
  countWeave(dir) {
    const w = this.sc.weave;
    if (!w || dir === 0) return;
    if (w.dir !== 0 && dir !== w.dir && Math.abs(this.player.y - w.lastY) >= SC_GAME.minSwing) {
      w.weaves += 1;
      w.pending = (w.pending || 0) + 1;
      w.lastY = this.player.y;
      this.emit('weave', { heat: w.heat, zone: w.zone });
    }
    if (w.dir === 0) w.lastY = this.player.y;
    w.dir = dir;
  }

  /**
   * A floating label. `value` (points) makes it a score popup: drawn as "+value TEXT" and bigger the
   * more it pays. Popups landing on top of a fresh one stack upwards instead of overprinting it.
   */
  addPopup(x, y, text, color = '#ffd400', value = 0) {
    let yy = y;
    for (let i = 0; i < 6 && this.popups.some((pp) => pp.age < 0.5 && Math.abs(pp.x - x) < 90 && Math.abs(pp.y - yy) < 18); i++) yy -= 22;
    this.popups.push({ x, y: yy, text, color, value, age: 0, life: 1.1 });
  }

  // ----- flow -----
  /** One more chained move: the multiplier steps up and the window refills. Returns the new multiplier. */
  bumpFlow() {
    const f = this.flow;
    f.mult = flowStep(f.mult);
    f.timer = FLOW.window;
    this.run.flowMax = Math.max(this.run.flowMax || 1, f.mult);
    this.syncFlowTier();
    return f.mult;
  }
  /** Contact, oil, a penalty or the pit lane: the chain is broken. */
  breakFlow(reason) {
    const f = this.flow;
    if (f.mult <= 1 && f.timer <= 0) return;
    f.mult = 1;
    f.timer = 0;
    this.syncFlowTier(reason);
  }
  syncFlowTier(reason = null) {
    const tier = flowTier(this.flow.mult);
    if (tier === this.flow.tier) return;
    const up = tier > this.flow.tier;
    this.flow.tier = tier;
    this.emit('flowTier', { tier, mult: this.flow.mult, up, reason });
  }

  // ----- main step -----
  update(dt, input) {
    if (this.gameOver) {
      // the freeze-frame: everything holds on the impact (both hitboxes outlined), then the tumble
      // plays, easing up from slow motion to full speed
      this.gameOverTime += dt;
      const t = this.gameOverTime - CRASH_FREEZE;
      if (t > 0) this.updateCrashed(dt * clamp(0.4 + t, 0.4, 1));
      return;
    }
    this.elapsed += dt;
    this.updateStart(dt, input);
    // "box box" cinematic: the world drops into slow motion while the car peels off / rejoins
    const cineTarget = this.pit.requested || (this.pit.inLane && (this.pit.phase === 'entry' || this.pit.phase === 'merge')) ? 1 : 0;
    if (this.player.grace > 0) this.player.grace = Math.max(0, this.player.grace - dt);
    this.cine += (cineTarget - this.cine) * Math.min(1, dt * 5);
    // world time for everything that could hit you (a scrape drops it into slow motion for a beat)
    const wdt = dt * lerp(1, 0.45, this.cine) * (this.slowmo > 0 ? 0.3 : 1);
    if (this.slowmo > 0) this.slowmo = Math.max(0, this.slowmo - dt);
    this.scrapeFlash = Math.max(0, this.scrapeFlash - dt * 4);
    // the flow chain runs out unless the next move comes inside the window
    if (this.flow.timer > 0) {
      this.flow.timer = Math.max(0, this.flow.timer - dt);
      if (this.flow.timer === 0) { this.flow.mult = 1; this.syncFlowTier('timeout'); }
    }
    this.updateWeather(dt);
    this.updateVenue(dt);
    this.updateSafetyCar(dt, input);
    this.updatePit(dt, input);
    this.updatePlayer(dt, input);
    this.updateSpawns(wdt);
    this.updateHazards(wdt);
    this.updateParticles(dt);
    if (this.gameOver) return; // crashed this frame: the score stands as the crash reported it
    this.scroll += this.speed * wdt;
    // no distance credit while serving a penalty: the stewards add it to your time
    if (this.penalty <= 0) this.distance += this.speed * dt * WORLD.metresPerPx;
    this.score = Math.floor(this.distance) + this.bonus;
    this.run.scoreBy.distance = Math.floor(this.distance);
    this.stats.maxSpeed = Math.max(this.stats.maxSpeed, this.speed);
    this.shake = Math.max(0, this.shake - dt * 3);
    this.flash = Math.max(0, this.flash - dt * 2.5);

    // run stats
    const r = this.run;
    r.metres = this.distance;
    r.score = this.score;
    r.overtakes = this.overtakes;
    r.stops = this.pit.stops;
    if (this.raining) r.rainTime += dt;
    if (this.night > 0.5) r.nightTime += dt;

    const ms = Math.floor(this.distance / SCORING.milestoneMetres);
    if (ms > this.milestone) {
      this.milestone = ms;
      this.emit('milestone', { km: ms });
    }
  }

  // ----- the start -----
  updateStart(dt, input) {
    const s = this.start;
    const go = input.right || input.boost || input.pointerBoost;
    if (s.phase === 'go') {
      if (s.launch > 0) s.launch = Math.max(0, s.launch - dt);
      s.sinceGo += dt;
      this.packV += (baseSpeed(this.elapsed) - this.packV) * Math.min(1, dt * START.launchAccel);
      if (s.reaction === null) {
        if (go) {
          s.reaction = s.sinceGo;
          if (!s.jumped && s.reaction <= START.reactionWindow) {
            this.addScore(START.reactionBonus, 'other');
            this.run.greatStarts += 1;
            this.addPopup(this.player.x, this.player.y - 50, 'GREAT START', '#2ecc71', START.reactionBonus);
            this.emit('greatStart', { reaction: s.reaction });
          }
        } else if (s.sinceGo > 1.2) { s.reaction = s.sinceGo; this.emit('slowStart'); }
      }
      return;
    }
    s.t += dt;
    const lit = lightsLit(s.t - START.preLights);
    if (lit > s.lit) { s.lit = lit; this.emit('light', { n: lit }); }
    // going for it while the lights are still on: no penalty, but the wall notices and the bonus is gone
    if (!s.jumped && s.lit > 0 && go) { s.jumped = true; this.emit('jumpStart'); }
    if (s.lit >= START.lights && s.t - START.preLights >= lightsFullAt() + s.hold) {
      s.phase = 'go';
      s.launch = START.launchSeconds;
      this.spawnTimer = 1.5; // (spawns are held off for the whole launch anyway; this is the gap after it)
      for (const hz of this.hazards) {
        if (!hz.grid) continue;
        const fast = Math.random() < START.fastShare;
        hz.fast = fast;
        hz.launchRel = fast ? rand(...START.rivalLaunch.fast) : rand(...START.rivalLaunch.slow);
        hz.launchAccel = rand(START.rivalAccel.min, START.rivalAccel.max);
        hz.launchBog = rand(...START.launchBog); // how well this one gets off the line in the first moment
      }
      this.emit('lightsOut', { jumped: s.jumped });
    }
  }

  updateWeather(dt) {
    const bias = this.venue.rainBias;
    const wasRain = this.rain;
    const step = dt / WEATHER.transition;
    const fc = this.forecast;
    if (fc) fc.in = Math.max(0, fc.in - dt);
    if (this.raining) {
      this.rainTimer -= dt;
      // towards this shower's peak (a light one only makes the track damp)
      this.rain = this.rain < this.rainPeak ? Math.min(this.rainPeak, this.rain + step) : Math.max(this.rainPeak, this.rain - step);
      // the wall sees the end of it coming
      if (!fc && bias > 0 && this.rainTimer > 0 && this.rainTimer <= WEATHER.dryForecast) {
        this.forecast = { kind: 'dry', in: this.rainTimer };
        this.emit('forecast', { kind: 'dry', in: this.rainTimer });
      }
      if (this.rainTimer <= 0 || bias === 0) {
        this.raining = false;
        this.dryTimer = WEATHER.dryGap;
        this.forecast = null;
        // a properly wet track dries through the inter window, and holds there a while
        this.dampHold = this.rain > WEATHER.damp ? rand(WEATHER.hold.min, WEATHER.hold.max) : 0;
        this.emit('rainStop');
      }
      // storms: lightning once the track is properly wet
      if (this.rain > STORM.minRain && Math.random() < STORM.chancePerSecond * dt) {
        this.flash = 1;
        this.emit('thunder');
      }
    } else {
      // drying: down to damp, hold, then on to dry
      if (this.rain > WEATHER.damp) this.rain = Math.max(this.dampHold > 0 ? WEATHER.damp : 0, this.rain - step);
      else if (this.dampHold > 0 && this.rain > 0) this.dampHold = Math.max(0, this.dampHold - dt);
      else this.rain = Math.max(0, this.rain - step);
      if (fc && fc.kind === 'rain') {
        // the forecast shower arrives (or the venue turns out to be a desert)
        if (bias === 0) this.forecast = null;
        else if (fc.in <= 0) {
          this.raining = true;
          this.rainTimer = rand(WEATHER.rainDuration.min, WEATHER.rainDuration.max);
          this.rainPeak = fc.peak;
          this.forecast = null;
          this.emit('rainStart', { peak: fc.peak, best: bestCompound(fc.peak) });
        }
      } else {
        if (fc) this.forecast = null;
        this.dryTimer -= dt;
        if (this.dryTimer <= 0 && Math.random() < WEATHER.rainChancePerSecond * bias * dt) {
          // the radar sees it first: a few seconds to get the right tyre on the plan
          const peak = Math.random() < WEATHER.lightShare ? WEATHER.damp : 1;
          this.forecast = { kind: 'rain', in: rand(WEATHER.forecast.min, WEATHER.forecast.max), peak };
          this.emit('forecast', { kind: 'rain', in: this.forecast.in, peak, best: bestCompound(peak) });
        }
      }
    }
    // the planned tyre follows the weather: when the track crosses into slick-killing wet (or dries
    // out from under a rain tyre) the wall changes the plan. Only on the crossing, so you can overrule it.
    const crossedWet = wasRain <= 0.35 && this.rain > 0.35;
    const crossedDry = wasRain >= 0.1 && this.rain < 0.1;
    if ((crossedWet || crossedDry) && wrongForWeather(this.nextCompound, this.rain)) this.setNextCompound(bestCompound(this.rain));
  }

  // ----- calendar -----
  updateVenue(dt) {
    const idx = venueIndexAt(this.distance);
    const done = gpsCompleted(this.distance);
    if (done > this.gps) {
      this.gps = done;
      this.run.gps = done;
      this.addScore(GP.finishBonus, 'gp');
      this.breather = SPAWN.breather; // a moment to breathe (and read the flag) before the next round's traffic
      // championship points for where you crossed the line; the next round starts from the back of the grid again
      const position = clampPosition(this.position);
      const points = pointsFor(position);
      this.run.points = (this.run.points || 0) + points;
      this.run.bestFinish = Math.min(this.run.bestFinish || GP.fieldSize, position);
      this.position = START.gridCars + 1;
      this.addPopup(this.player.x, this.player.y - 50, 'CHEQUERED', '#fff', GP.finishBonus);
      this.emit('chequered', { gp: done, bonus: GP.finishBonus, venue: this.venue.name, position, points });
    }
    if (idx !== this.venueIndex) {
      this.venuePrev = this.venueIndex;
      this.venueIndex = idx;
      this.venueBlend = 0;
      this.flash = Math.max(this.flash, 0.35);
      this.emit('venue', { venue: this.venue, index: idx });
      if (this.venue.night && !this.prevVenue.night) this.emit('night');
    }
    this.venueBlend = Math.min(1, this.venueBlend + dt / GP.transition);
    const targetNight = this.venue.night ? 1 : 0;
    this.night += (targetNight - this.night) * Math.min(1, dt / GP.transition * 1.5);
  }

  // ----- safety car -----
  /** True while the car is off your hands behind the safety car (not when you have called for the box). */
  get neutralised() { return this.sc.active && this.sc.neutral && !this.pit.inLane && !this.pit.requested; }
  updateSafetyCar(dt, input) {
    const sc = this.sc;
    if (this.penalty > 0) this.penalty = Math.max(0, this.penalty - dt);
    if (sc.restartTimer > 0) sc.restartTimer = Math.max(0, sc.restartTimer - dt);
    if (sc.grace > 0) sc.grace = Math.max(0, sc.grace - dt);
    if (sc.takeover > 0) sc.takeover = Math.max(0, sc.takeover - dt);

    if (!sc.active) {
      // the jump: throttle within the window after the green, but only if you were not already on it
      if (sc.jump > 0) {
        sc.jump = Math.max(0, sc.jump - dt);
        const go = input.right || input.boost || input.pointerBoost;
        if (!go) sc.jumpArmed = true;
        else if (sc.jumpArmed) {
          sc.jump = 0;
          this.addScore(SC_GAME.jumpBonus, 'other');
          this.run.scJumps += 1;
          this.addPopup(this.player.x, this.player.y - 80, 'JUMP', '#2ecc71', SC_GAME.jumpBonus);
          this.emit('scJump');
        }
      }
      sc.cooldown -= dt;
      if (sc.cooldown <= 0 && !this.pit.inLane && Math.random() < SAFETY_CAR.chancePerSecond * dt) this.deploySafetyCar();
      return;
    }
    sc.timer -= dt;
    const car = sc.car;
    // once the field has bunched up the race is neutralised: the car is taken off you until the green
    // (between the grace and the takeover you are driving under yellow: pass a car and it is a penalty)
    if (!sc.neutral && sc.takeover <= 0 && sc.phase === 'deployed' && !this.pit.inLane && !this.pit.requested) {
      sc.neutral = true;
      // the weave starts from wherever the tyres actually are, the car from wherever it is
      sc.weave = { heat: clamp(this.tyre.temp, 0.35, 0.8), dir: 0, lastY: this.player.y, weaves: 0, inBand: 0, total: 0, zone: 'warm' };
      this.ers.boosting = false;
      this.emit('scNeutral');
    }
    // the safety car sweeps in from the right and settles ahead of the player
    if (sc.phase === 'deployed') {
      const targetX = this.player.x + 340;
      car.x += (targetX - car.x) * Math.min(1, dt * 2.2);
      car.y += ((this.trackTop + this.trackBottom) / 2 - car.y) * Math.min(1, dt * 2);
      car.frame = (car.frame + this.speed * dt * 0.02) % 8;
      if (sc.timer <= SC_GAME.countdown) {
        sc.phase = 'ending';
        sc.lastCount = -1;
        this.emit('scEnding');
      }
    } else if (sc.phase === 'ending') {
      // peels off into the pit lane while the countdown runs: 3, 2, 1, green
      car.y += (this.pitY - car.y) * Math.min(1, dt * 2.5);
      car.x += 160 * dt;
      car.frame = (car.frame + this.speed * dt * 0.02) % 8;
      sc.countdown = Math.max(0, sc.timer);
      const n = Math.ceil(sc.countdown);
      if (n !== sc.lastCount && n > 0) { sc.lastCount = n; this.emit('scCount', { n }); }
      if (sc.timer <= 0) this.endSafetyCar(input);
    }
  }
  deploySafetyCar() {
    const sc = this.sc;
    sc.active = true;
    sc.phase = 'deployed';
    sc.timer = rand(SAFETY_CAR.duration.min, SAFETY_CAR.duration.max);
    sc.clean = true;
    sc.grace = SAFETY_CAR.graceSeconds;
    sc.takeover = SC_GAME.takeoverAfter;
    sc.car = { x: this.width + 200, y: (this.trackTop + this.trackBottom) / 2, frame: 0 };
    this.ers.boosting = false;
    // the field bunches up: every rival ahead of you settles to safety-car pace so you can hold station behind it
    for (const hz of this.hazards) if (hz.type === 'rival' && hz.x > this.player.x) { hz.scPace = rand(...SAFETY_CAR.bunchSpread); hz.weave = false; hz.defend = false; hz.fromBehind = false; }
    this.run.scPeriods += 1;
    // the reason for the yellow: a stranded car on the far side of the track
    const w = PLAYER.width * 0.92;
    const h = PLAYER.height * 0.92;
    const y = Math.random() < 0.5 ? this.trackTop + h : this.trackBottom - h;
    const driver = pickDriver(false, this.car.team);
    this.hazards.push({
      id: nextId++, type: 'stranded', x: this.width + 700, y, w, h, rel: 0, vy: 0, team: teamOf(driver), driver, angle: rand(-0.5, 0.5),
      frame: 0, smoke: 0,
    });
    this.emit('scDeployed');
  }
  endSafetyCar(input = {}) {
    const sc = this.sc;
    sc.active = false;
    sc.phase = 'none';
    sc.car = null;
    sc.countdown = -1;
    sc.cooldown = SAFETY_CAR.minGap;
    sc.restartTimer = SAFETY_CAR.restartWindow;
    // the jump window opens now; being on the throttle already is going early (no bonus until you lift and go again)
    sc.jump = SC_GAME.jumpWindow;
    sc.jumpArmed = !(input.right || input.boost || input.pointerBoost);
    let popY = this.player.y - 50;
    if (sc.clean) {
      this.run.scClean += 1;
      this.addScore(SAFETY_CAR.restartBonus, 'other');
      this.addPopup(this.player.x, popY, 'CLEAN', '#2ecc71', SAFETY_CAR.restartBonus);
      popY -= 26;
    }
    // the weave pays out: warm tyres restart with grip and a bonus, cold ones restart on ice
    const w = sc.weave;
    let warm = null, weaveBonusPts = 0;
    if (w && w.total > 0.5) {
      weaveBonusPts = weaveBonus(w.inBand, w.total);
      warm = weaveZone(w.heat) === 'warm';
      if (warm) this.run.warmRestarts += 1;
      if (weaveBonusPts > 0) this.addPopup(this.player.x, popY, warm ? 'WARM TYRES' : 'WEAVE', '#ffd400', weaveBonusPts);
      else this.addPopup(this.player.x, popY, weaveZone(w.heat) === 'cold' ? 'COLD TYRES' : 'BLISTERED', weaveZone(w.heat) === 'cold' ? '#7df9ff' : '#ff3b3b');
      this.addScore(weaveBonusPts, 'other');
      this.run.scWeaves += w.weaves;
    }
    sc.neutral = false;
    sc.weave = null;
    this.emit('scRestart', { clean: sc.clean, warm, weaveBonus: weaveBonusPts });
  }

  /** Speed the field runs at while you are in the lane (what a stop is measured against): the safety car's, when it is out. */
  get pitRef() {
    const base = baseSpeed(this.elapsed);
    return this.sc.active ? base * SAFETY_CAR.speedCap * SC_GAME.paceFactor : base;
  }
  /** Metres a typical stop would cost right now (the SC cheap-stop chip). */
  pitEstimate() { return pitLossMetres(this.pitRef, PIT.typicalStop); }

  updatePit(dt, input) {
    const p = this.player;
    const pit = this.pit;
    if (pit.cooldown > 0) pit.cooldown = Math.max(0, pit.cooldown - dt);
    // Why the lane is open: a puncture or a part at 100 % opens it any time (fresh-tyre cooldown or not);
    // otherwise the window, or the whole of a safety-car period (the cheap stop).
    const emergency = this.tyre.punctured ? 'puncture' : Math.max(p.parts.wing, p.parts.floor) >= 100 ? 'damage' : null;
    const scOpen = this.sc.active && this.sc.phase === 'deployed';
    const reason = emergency || (pit.cooldown > 0 ? null : pitWindowOpen(this.elapsed) ? 'window' : scOpen ? 'sc' : null);
    const open = reason !== null;
    pit.reason = reason;
    pit.left = reason === 'window' ? pitOpenLeft(this.elapsed) : 0;
    if (open && !pit.wasOpen && !pit.inLane) this.emit('pitOpen', { reason });
    pit.wasOpen = open;
    pit.open = open;
    // the last two seconds of a window tick down, twice a second (the HUD blinks with it)
    if (reason === 'window' && !pit.inLane && !pit.requested && pit.left <= 2) {
      const tick = Math.ceil(pit.left / 0.5);
      if (tick > 0 && tick !== pit.tick) { pit.tick = tick; this.emit('pitWindowTick', { left: tick * 0.5 }); }
    } else pit.tick = 0;

    if (!pit.inLane) {
      // "Box box": a pit request steers the car up to the entry by itself. A confirmed call is
      // latched: the window closing while the car is on its way up does not cancel it.
      // the highest the car can steer (see the clamp in updatePlayer)
      const entryY = this.trackTop + PLAYER.height / 2 - 12;
      if (pit.requested) {
        // arc up towards the wall, lifting off the throttle as we go
        p.y += (entryY - p.y) * Math.min(1, dt * 4.5);
        p.vy = -Math.abs(entryY - p.y) * 3;
        p.throttle += (0.8 - p.throttle) * Math.min(1, dt * 3);
      }
      // Entering: window open and the car is at the top edge (steered or requested).
      if (((open && input.up) || pit.requested) && p.y <= entryY + 2) {
        pit.inLane = true;
        pit.requested = false;
        pit.phase = 'entry';
        pit.timer = PIT.laneTravel * 0.45;
        pit.lossPx = 0;
        this.ers.boosting = false;
        this.breakFlow('pit');
        this.emit('pitIn');
      }
      return;
    }

    pit.timer -= dt;
    // the field keeps going while you are on the limiter: that is what the stop costs
    pit.lossPx += Math.max(0, this.pitRef - this.speed) * dt;
    if (pit.phase === 'merge') {
      // arc down from the lane onto the top of the track, nose dipping
      const targetY = this.trackTop + PLAYER.height;
      p.y += (targetY - p.y) * Math.min(1, dt * 4);
      p.tilt += (0.12 - p.tilt) * Math.min(1, dt * 5);
    } else {
      // glide the car into the lane
      p.y += (this.pitY - p.y) * Math.min(1, dt * 6);
    }
    switch (pit.phase) {
      case 'entry':
        if (pit.timer <= 0) {
          pit.phase = 'stop';
          pit.slow = false;
          // the mini-game: four wheels, one at a time, fire the gun in the zone
          // a slow crew jams the gun more often; the zone width follows the car's pit crew too (see logic.wheelZones)
          pit.game = {
            wheel: 0, t: 0, results: [], flash: 0, lastResult: null, total: 0, hold: 0, crew: this.car.pitCrew,
            jammed: PITGAME.wheels.map(() => Math.random() < PITGAME.jamChance * (2 - this.car.pitCrew)),
          };
          this.emit('pitStop', { game: true });
        }
        break;
      case 'stop': {
        const g = pit.game;
        g.total += dt;
        g.flash = Math.max(0, g.flash - dt * 4);
        if (g.wheel < PITGAME.wheels.length) {
          if (g.hold > 0) {
            // waiting out the time the last wheel cost before the next gun comes in
            g.hold -= dt;
            if (g.hold <= 0) g.t = 0;
          } else {
            g.t += dt;
            if (g.t >= PITGAME.window) this.resolveWheel('miss', true); // too slow: mechanic sorts it, slowly
          }
        } else {
          g.hold -= dt;
          if (g.hold <= 0) {
            const s = stopSummary(g.results);
            // (the forecast starts from what this compound wears at neutral throttle, then learns how you drive)
            const base = baseSpeed(this.elapsed);
            this.tyre = { compound: this.nextCompound, wear: 0, punctured: false, temp: 0, rate: wearDelta(this.nextCompound, base, 1, this.car.tyreWear, base, this.rain) };
            this.cliffAt = null;
            // boxing under the safety car: the weave starts again from these cold tyres when you rejoin
            if (this.sc.neutral) { this.sc.neutral = false; this.sc.weave = null; }
            if (totalDamage(this.player.parts) > 0) this.run.repairs += 1;
            this.player.parts = { wing: 0, floor: 0 }; // new nose and floor go on with the tyres
            pit.stops += 1;
            pit.slow = !s.clean;
            pit.stopFor = s.time;
            if (pit.slow) this.run.slowStops += 1;
            if (s.record) { this.run.recordStops += 1; this.addScore(PITGAME.recordBonus, 'pit'); this.addPopup(p.x, p.y + 60, 'RECORD STOP', '#7df9ff', PITGAME.recordBonus); }
            else if (s.clean) { this.run.cleanStops += 1; this.addScore(PITGAME.cleanBonus, 'pit'); this.addPopup(p.x, p.y + 60, 'CLEAN STOP', '#2ecc71', PITGAME.cleanBonus); }
            if (s.perfects === PITGAME.wheels.length) this.run.perfectStops += 1;
            pit.phase = 'exit';
            pit.timer = PIT.laneTravel * 0.55;
            pit.game = null;
            // what it cost: the lane so far plus the roll down to the blend line, in places
            const rest = Math.max(0, this.pitRef - SPEED.pitLimit) * (pit.timer + PIT.mergeTime);
            pit.lossMetres = (pit.lossPx + rest) * WORLD.metresPerPx;
            pit.placesLost = placesLost(pit.lossMetres);
            this.position = clampPosition(this.position + pit.placesLost);
            this.emit('pitOut', { compound: this.nextCompound, ...s, lossMetres: pit.lossMetres, places: pit.placesLost, position: this.position });
          }
        }
        break;
      }
      case 'exit':
        // roll down the lane, then peel back onto the track over the blend line
        if (pit.timer <= 0) {
          pit.phase = 'merge';
          pit.timer = PIT.mergeTime;
          // nothing may be sitting where we are about to rejoin
          const mergeY = this.trackTop + PLAYER.height;
          for (const hz of this.hazards) {
            if (hz.x > p.x - 200 && hz.x < p.x + 520 && hz.y < mergeY + 90) {
              if (hz.type === 'rival' || hz.type === 'stranded') hz.y = Math.max(hz.y, this.trackBottom - hz.h);
              else hz.dead = true;
            }
          }
          this.emit('pitExit');
        }
        break;
      case 'merge':
        if (pit.timer <= 0) {
          pit.inLane = false;
          pit.phase = 'none';
          pit.cooldown = PIT.cooldown; // fresh tyres: the wall will not take you back straight away
          p.grace = PIT.graceAfterExit; // ghosted for a moment while the field streams past
          this.emit('coldTyres');
        }
        break;
      default:
        break;
    }
  }

  updatePlayer(dt, input) {
    const p = this.player;
    const inPit = this.pit.inLane;
    const grip = this.grip;

    // throttle: right = push, left = lift
    let targetThrottle = 1;
    if (input.right) targetThrottle = PLAYER.throttleRange.max;
    if (input.left) targetThrottle = PLAYER.throttleRange.min;
    targetThrottle -= damageEffects(p.parts).throttleLoss;
    p.throttle += (targetThrottle - p.throttle) * Math.min(1, dt * PLAYER.throttleLerp);

    // "pushing like an animal": hold full throttle for a few seconds
    if (input.right && !inPit && this.racing) {
      this.pushTimer += dt;
      if (this.pushTimer > 4) {
        this.pushTimer = -18; // cooldown before it can trigger again
        this.run.pushes += 1;
        this.emit('pushing');
      }
    } else if (this.pushTimer > 0) this.pushTimer = 0;
    else this.pushTimer = Math.min(0, this.pushTimer + dt);

    // slipstream: the closest rival straight ahead gives a tow
    this.tow = 0;
    this.towRival = null;
    if (!inPit && this.racing) {
      const nose = p.x + PLAYER.width / 2;
      for (const hz of this.hazards) {
        if (hz.type !== 'rival') continue;
        const t = towFactor(hz.x - hz.w / 2 - nose, hz.y - p.y);
        if (t > this.tow) { this.tow = t; this.towRival = hz; }
      }
      if (this.tow > 0) {
        const harvest = this.tow * SLIPSTREAM.ersPerSecond * this.car.ers * dt;
        this.ers.charge = Math.min(ERS.max, this.ers.charge + harvest);
        this.run.towEnergy += harvest;
        if (!this.towAnnounced && this.tow > 0.6) { this.towAnnounced = true; this.emit('tow'); }
        if (Math.random() < dt * 30 * this.tow) {
          this.particles.push({ kind: 'streak', x: nose + rand(0, 40), y: p.y + rand(-22, 22), vx: -this.speed * 1.4, vy: 0, r: rand(20, 60), life: 0.25, age: 0 });
        }
      }
    }

    // ERS / boost (not under the safety car, not on the grid)
    const wantBoost = (input.boost || input.pointerBoost) && !inPit && p.spin <= 0 && !this.sc.active && this.racing;
    if (wantBoost && (this.ers.boosting ? this.ers.charge > 0 : this.ers.charge > ERS.minToEngage)) {
      this.ers.boosting = true;
      this.ers.charge = Math.max(0, this.ers.charge - ERS.drainPerSecond * dt);
      if (this.ers.charge === 0) this.ers.boosting = false;
    } else {
      this.ers.boosting = false;
      this.ers.charge = Math.min(ERS.max, this.ers.charge + ERS.rechargePerSecond * this.car.ers * dt);
    }

    // spin from oil
    if (p.spin > 0) {
      p.spin -= dt;
      p.angle += dt * 9;
      if (p.spin <= 0) p.angle = 0;
    }

    // speed
    const stopped = inPit && this.pit.phase === 'stop';
    let target = stopped
      ? 0
      : playerSpeed({
        elapsed: this.elapsed, throttle: p.throttle, boosting: this.ers.boosting, grip, inPit, spun: p.spin > 0, speedMul: this.car.speed,
        pace: COMPOUNDS[this.tyre.compound].pace,
      });
    if (!inPit) target *= 1 + this.tow * SLIPSTREAM.speedBonus;
    const neutral = this.neutralised;
    if (neutral) {
      // the car holds station behind the safety car on its own: throttle and speed are not yours
      p.throttle += (1 - p.throttle) * Math.min(1, dt * PLAYER.throttleLerp);
      target = baseSpeed(this.elapsed) * SAFETY_CAR.speedCap * SC_GAME.paceFactor;
    } else if (this.sc.active && !inPit) {
      // capped at safety-car pace; lifting takes you below it so you can drop back from the car ahead
      const lift = clamp((p.throttle - PLAYER.throttleRange.min) / (1 - PLAYER.throttleRange.min), 0, 1);
      target = Math.min(target, baseSpeed(this.elapsed) * SAFETY_CAR.speedCap * lerp(SAFETY_CAR.liftFloor, 1, lift));
    }
    if (this.penalty > 0 && !inPit) target = Math.min(target, baseSpeed(this.elapsed) * SAFETY_CAR.penaltyCap);
    if (!this.racing) target = 0; // lights are on
    const accel = target > this.speed ? (this.start.launch > 0 ? START.launchAccel : 2.5) * this.car.accel : 4.5;
    this.speed += (target - this.speed) * Math.min(1, dt * accel);

    // vertical movement (grip-limited) — pointer overrides keys when active
    // (steering is handed to the pit-entry glide once you have called for the box; none on the grid)
    const hasPointer = input.pointerY !== null && input.pointerY !== undefined;
    if (!inPit && !this.pit.requested && this.racing) {
      let dir = 0;
      if (input.up) dir -= 1;
      if (input.down) dir += 1;
      if (hasPointer && !neutral) {
        const ty = clamp(input.pointerY * this.height, this.trackTop, this.trackBottom);
        const dy = ty - p.y;
        dir = Math.abs(dy) < 6 ? 0 : Math.sign(dy);
      } else if (hasPointer && this.pointerLastY !== null) {
        // weaving by touch: the car mirrors the finger's direction of travel, so a wiggle is a weave
        const dy = input.pointerY - this.pointerLastY;
        if (Math.abs(dy) > 0.002) dir = Math.sign(dy);
      }
      if (p.spin > 0) dir *= 0.3;
      let vmax = PLAYER.verticalSpeed * this.car.handling * lerp(0.5, 1, clamp(grip, 0, 1));
      const half = PLAYER.height / 2;
      let lo = this.trackTop + half - 12;
      let hi = this.trackBottom - half + 12;
      if (neutral) {
        // the weave: a narrow band behind the safety car; outside it the car brings itself in
        const centre = (this.trackTop + this.trackBottom) / 2;
        lo = centre - SC_GAME.weaveAmplitude;
        hi = centre + SC_GAME.weaveAmplitude;
        vmax *= SC_GAME.weaveSpeed;
        if (p.y < lo - 2 || p.y > hi + 2) dir = Math.sign(centre - p.y);
        else this.countWeave(dir);
      }
      const targetVy = dir * vmax;
      p.vy += (targetVy - p.vy) * Math.min(1, dt * 10);
      p.y += p.vy * dt;
      if (p.y < lo) { p.y = lo; p.vy = Math.max(0, p.vy); }
      if (p.y > hi) { p.y = hi; p.vy = Math.min(0, p.vy); }
      p.tilt += ((p.vy / vmax) * 0.16 - p.tilt) * Math.min(1, dt * 8);
    } else if (this.pit.requested) {
      p.tilt += (-0.12 - p.tilt) * Math.min(1, dt * 6); // nose up toward the pit wall
    } else {
      p.vy = 0;
      p.tilt *= 0.9;
    }

    this.pointerLastY = hasPointer ? input.pointerY : null;

    // tyre temperature: fresh rubber warms with speed and steering, rain cools it
    const base = baseSpeed(this.elapsed);
    if (neutral) {
      // ...but at safety-car pace only the weave keeps them warm, and it is what you restart on
      const w = this.sc.weave;
      w.heat = weaveHeat(w.heat, dt, w.pending || 0);
      w.pending = 0;
      w.zone = weaveZone(w.heat);
      w.total += dt;
      if (w.zone === 'warm') w.inBand += dt;
      else if (w.zone === 'hot' && !this.tyre.punctured) this.tyre.wear = Math.min(100, this.tyre.wear + SC_GAME.blisterWear * dt);
      this.tyre.temp = w.heat;
    } else if (!inPit) {
      const heat = (0.6 + 0.6 * (this.speed / base) + Math.abs(p.vy) / PLAYER.verticalSpeed) / TYRE_TEMP.warmupSeconds;
      // a wet track cools slicks faster than they can warm; inters and wets are built for it
      const cooling = this.rain * TYRE_TEMP.rainCooling * (COMPOUNDS[this.tyre.compound].wet === undefined ? 1 : 0.3);
      this.tyre.temp = clamp(this.tyre.temp + (heat - cooling) * dt, 0, 1);
    }

    // tyre wear
    if (!inPit && !this.tyre.punctured) {
      const dWear = wearDelta(this.tyre.compound, this.speed, dt, this.car.tyreWear, base, this.rain);
      // the rate the forecast projects with: smoothed, so a lift or a push moves it but does not jerk it
      if (dt > 0) this.tyre.rate += (dWear / dt - this.tyre.rate) * Math.min(1, dt / TYRES.rateSmoothing);
      this.tyre.wear = Math.min(100, this.tyre.wear + dWear);
      if (this.tyre.wear >= 100) {
        this.tyre.punctured = true;
        this.run.punctures += 1;
        this.emit('puncture');
      } else if (this.tyre.wear > TYRES.cliffStart && this.tyre.wear - dWear <= TYRES.cliffStart) {
        this.emit('tyresHot');
      }
    }
    if (this.cliffAt === null && this.tyre.wear > TYRES.cliffStart) this.cliffAt = this.elapsed;
    if (this.tyre.punctured) {
      // limp mode: crawl until you pit (relative to the race: the field still streams past)
      this.speed = Math.min(this.speed, base * 0.55);
      if (Math.random() < dt * 20) this.spawnSpark(p.x + PLAYER.width * 0.28, p.y + PLAYER.height * 0.4, 1);
    }

    // sprite animation frame from wheel speed
    p.frame = (p.frame + this.speed * dt * 0.02) % 8;

    // exhaust / spray particles
    const rearX = p.x - PLAYER.width * 0.48;
    if (Math.random() < dt * 25 * (0.4 + this.intensity)) {
      this.particles.push({
        kind: this.rain > 0.3 ? 'spray' : 'smoke', x: rearX, y: p.y + rand(-4, 6), vx: -this.speed * 0.5 - rand(40, 120),
        vy: rand(-30, 30), r: rand(3, 6), life: rand(0.25, 0.5), age: 0,
      });
    }
    if (this.ers.boosting && Math.random() < dt * 40) {
      this.particles.push({ kind: 'flame', x: rearX + 6, y: p.y + rand(-3, 3), vx: -this.speed * 0.8 - 150, vy: rand(-20, 20), r: rand(3, 6), life: 0.18, age: 0 });
    }
    // a wing hanging off, or gone: it drags along the track and throws sparks off the nose
    if (!inPit && p.parts.wing >= 50 && this.speed > SPEED.base * 0.5 && Math.random() < dt * (p.parts.wing >= 100 ? 45 : 12)) {
      this.spawnSpark(p.x + PLAYER.width * 0.45, p.y + PLAYER.height * 0.4, 1);
    }
    // titanium skid-block sparks at high speed on a dry track (a damaged floor scrapes sooner and more)
    const floorScrape = 1 + p.parts.floor / 40;
    if (!inPit && this.rain < 0.3 && this.speed > SPEED.max * (0.72 / floorScrape) && Math.random() < dt * 60 * this.intensity * floorScrape) {
      this.particles.push({
        kind: 'spark', x: p.x + rand(-PLAYER.width * 0.35, PLAYER.width * 0.1), y: p.y + PLAYER.height * 0.45,
        vx: -this.speed * 0.9 - rand(50, 200), vy: rand(-40, 60), r: rand(1, 2.2), life: rand(0.15, 0.4), age: 0,
      });
    }
    // cold tyre / wet weather wheelspin smoke
    if (!inPit && this.tyre.temp < 0.5 && this.rain < 0.3 && Math.random() < dt * 20) {
      this.particles.push({ kind: 'smoke', x: p.x - PLAYER.width * 0.3, y: p.y + PLAYER.height * 0.35, vx: -this.speed * 0.6, vy: rand(-40, -10), r: rand(4, 8), life: 0.5, age: 0 });
    }
  }

  // ----- hazards -----
  updateSpawns(dt) {
    // no new hazards on the grid or during the launch, while you are on the way in, in the lane, or in the grace moment after rejoining
    if (!this.racing || this.start.launch > 0 || this.pit.inLane || this.pit.requested || this.player.grace > 0) return;
    // a breather after the chequered flag: the next round's traffic waits
    if (this.breather > 0) { this.breather = Math.max(0, this.breather - dt); return; }
    // hazards come up by track covered, not by the clock: crawling home on a puncture is not a bullet hell
    this.spawnTimer -= dt * clamp(this.speed / baseSpeed(this.elapsed), 0.3, 1);
    if (this.spawnTimer <= 0) {
      // the on-ramp: for a while after the launch the gaps start long and ease down to normal
      const ramp = clamp((this.start.sinceGo - START.launchSeconds) / SPAWN.onRamp.seconds, 0, 1);
      const interval = spawnInterval(this.elapsed) * lerp(SPAWN.onRamp.mult, 1, ramp);
      if (this.sc.active) {
        // bunched field: slow rivals you are not allowed to pass
        this.spawnTimer = interval * rand(1.6, 2.4);
        if (this.sc.phase === 'deployed' && !this.sc.neutral) this.spawnHazard('rival', { scRival: true });
      } else {
        this.spawnTimer = interval * rand(0.75, 1.25);
        // no fair lane for it right now (it would close the last gap): try again in a moment
        if (!this.spawnHazard(pickHazard(this.elapsed))) this.spawnTimer = SPAWN.retry;
      }
    }
    this.drsTimer -= dt;
    if (this.drsTimer <= 0) {
      this.drsTimer = rand(SPAWN.drsEvery.min, SPAWN.drsEvery.max);
      if (!this.sc.active) this.spawnDrs();
    }
  }

  laneY(margin = 20) {
    return rand(this.trackTop + margin, this.trackBottom - margin);
  }
  /**
   * A fair y for a new hazard (see logic.freeLanes): never on top of another one and never closing
   * the last gap the car fits through. `size`/`len` are its half height and half length, `closing`
   * how fast it will come at you. Returns null when there is no fair lane.
   */
  fairY(x, size, len, closing) {
    const p = this.player;
    const lanes = freeLanes(this.hazards, x, p.x, this.speed, this.trackTop, this.trackBottom, {
      size, len, closing, playerLen: this.playerRect.w,
    });
    return pickInLanes(lanes);
  }
  /** Spawn x off the right edge: far enough out that its edge warning shows for WARN.lead seconds first. */
  spawnX(closing, extra = 0) {
    return this.width + extra + Math.max(80, closing * WARN.lead);
  }

  /** Spawns a hazard of `type`; returns it, or null when there was no fair lane for it. */
  spawnHazard(type, opts = {}) {
    const right = this.width + 80;
    const t = this.elapsed;
    const scrollV = this.speed;
    let hz = null;
    switch (type) {
      case 'tyre': {
        const compound = pick(Object.values(COMPOUNDS));
        // a rare big one (always fatal like the rest, just harder to get round)
        const big = Math.random() < SPAWN.bigTyreChance;
        const r = rand(16, 30) * (big ? 1.5 : 1);
        const speedMul = compound.id === 'soft' ? 1.35 : compound.id === 'hard' ? 0.75 : 1;
        const vx = -rand(60, 180) * speedMul;
        const x = this.spawnX(scrollV - vx);
        const y = this.fairY(x, r, r, scrollV - vx);
        if (y === null) return null;
        // rolls toward the player with a bit of vertical drift, bounces off the kerbs
        hz = { id: nextId++, type, x, y, r, vx, vy: rand(-90, 90), spin: 0, compound, bounce: true, big };
        break;
      }
      case 'rival': {
        const teammate = Math.random() < TEAMMATE.chance && t > 15;
        const driver = pickDriver(teammate, this.car.team);
        const team = teamOf(driver);
        const w = PLAYER.width * 0.92;
        const h = PLAYER.height * 0.92;
        // `rel` is the car's absolute speed along the track (screen velocity = rel - your speed).
        // Traffic runs at a fixed fraction of the base speed (`pace`), so the gap it gives you holds
        // as the race speeds up; occasionally a faster one attacks from behind.
        const fromBehind = !opts.scRival && Math.random() < 0.25 && t > 20;
        const pace = rand(...RIVAL_AI.paceRange);
        const rel = fromBehind ? this.speed + rand(...RIVAL_AI.passMargin) : baseSpeed(t) * pace;
        // a car from behind starts far enough back for its mirror warning to show first
        const x = fromBehind ? -w / 2 - Math.max(20, (rel - scrollV) * WARN.mirrorLead * 0.95) : right + w;
        let y;
        if (fromBehind) y = this.laneY(h);
        else {
          y = this.fairY(x, h / 2, w / 2, scrollV - rel);
          if (y === null) return null;
        }
        hz = {
          id: nextId++, type, x, y, w, h, rel, pace, vy: 0,
          // under the safety car rivals run at (about) its pace in absolute terms, not relative to you
          scPace: opts.scRival ? rand(...SAFETY_CAR.bunchSpread) : 0,
          team, driver, teammate, fromBehind, weave: !opts.scRival && Math.random() < 0.4, weavePhase: rand(0, 6.28), passed: false, frame: rand(0, 8),
          defend: !fromBehind && !teammate && Math.random() < RIVAL_AI.defendChance, brake: 0,
        };
        break;
      }
      case 'oil': {
        const w = rand(90, 170);
        const h = rand(24, 42);
        const x = this.spawnX(scrollV, w / 2) + w / 2;
        const y = this.fairY(x, h / 2, w / 2, scrollV);
        if (y === null) return null;
        hz = { id: nextId++, type, x, y, w, h, rel: 0, vy: 0 };
        break;
      }
      case 'debris': {
        const r = rand(9, 14);
        const vx = -rand(0, 40);
        const x = this.spawnX(scrollV - vx);
        const y = this.fairY(x, r, r, scrollV - vx);
        if (y === null) return null;
        hz = { id: nextId++, type, x, y, r, vx, vy: rand(-20, 20), spin: 0, bounce: false };
        break;
      }
      default:
        break;
    }
    if (hz) this.hazards.push(hz);
    return hz;
  }
  spawnDrs() {
    const h = 64;
    this.hazards.push({ id: nextId++, type: 'drs', x: this.width + 120, y: this.laneY(h / 2 + 8), w: 26, h, rel: 0, vy: 0, taken: false });
  }

  updateHazards(dt) {
    const p = this.player;
    const prect = this.playerRect;
    const scrollV = this.speed;
    const survivors = [];
    for (const hz of this.hazards) {
      // once something has ended the race this frame, nothing else may score or hit (updateCrashed moves them from here)
      if (this.gameOver) { survivors.push(hz); continue; }
      // motion: everything scrolls left at the player's speed plus its own relative motion
      if (hz.type === 'tyre' || hz.type === 'debris') {
        hz.x += (hz.vx - scrollV) * dt;
        hz.y += hz.vy * dt;
        hz.spin += ((scrollV - hz.vx) / hz.r) * dt;
        if (hz.bounce) {
          if (hz.y - hz.r < this.trackTop) { hz.y = this.trackTop + hz.r; hz.vy = Math.abs(hz.vy); }
          if (hz.y + hz.r > this.trackBottom) { hz.y = this.trackBottom - hz.r; hz.vy = -Math.abs(hz.vy); }
        }
      } else {
        // `rel` is absolute speed along the track. Bunched rivals hold safety-car pace until the green
        // flag, then they are slow traffic at whatever share of the base speed that left them on.
        const base = baseSpeed(this.elapsed);
        if (hz.scPace) {
          if (this.sc.active) hz.rel = hz.scPace * base * SAFETY_CAR.speedCap;
          else {
            hz.rel = Math.max(60, scrollV - rand(60, 140));
            hz.pace = hz.rel / base;
            hz.scPace = 0;
          }
        } else if (hz.fromBehind) {
          // attacking from behind: stays quicker than you until it is clean past your nose, then
          // settles into ordinary traffic (and becomes a car you can take back)
          hz.rel = Math.max(hz.rel, scrollV + RIVAL_AI.passMargin[0]);
          if (hz.x - hz.w / 2 > p.x + PLAYER.width / 2) {
            hz.fromBehind = false;
            hz.pace = rand(...RIVAL_AI.paceRange);
            // a place gone (not while you sit in the lane: the stop already counted what it cost)
            if (!this.pit.inLane) this.position = clampPosition(this.position + 1);
            this.emit('passedBy', { hz, driver: hz.driver, team: hz.team, teammate: hz.teammate, side: hz.y < p.y ? 'left' : 'right', position: this.position });
          }
        } else if (hz.pace) {
          // eases onto its pace (a car that has just gone past you brakes into traffic, it does not teleport)
          hz.rel += (base * hz.pace - hz.rel) * Math.min(1, dt * 1.5);
        }
        // Grid cars. `rel` is a hazard's speed along the track (screen velocity = rel - scrollV), so
        // the pack gets away together by tracking packV (a neutral-throttle launch, ≈ your scroll
        // speed) with a small per-car bog in the first moment, then spreads out over the opening
        // phase: fast starters settle a little above the pack and pull away, the rest fade back to
        // ordinary traffic speeds. After that they are ordinary traffic at whatever they settled to.
        if (hz.grid && this.racing) {
          if (this.start.launch > 0) {
            const t = clamp(this.start.sinceGo / (START.launchSeconds * START.spreadOver), 0, 1);
            const spread = t * t * (3 - 2 * t);
            const bog = hz.launchBog * Math.max(0, 1 - this.start.sinceGo / 1.5);
            const settled = this.packV + (hz.fast ? hz.launchRel : hz.launchRel * this.packV);
            const target = this.packV * (1 - spread) + settled * spread + bog;
            hz.v += (target - hz.v) * Math.min(1, dt * hz.launchAccel * 2);
            hz.rel = hz.v;
          } else {
            hz.grid = false;
            hz.pace = hz.rel / base; // ordinary traffic from here on, at whatever it settled to
            hz.weave = Math.random() < 0.4;
            hz.defend = hz.x > p.x && !hz.teammate && Math.random() < RIVAL_AI.defendChance;
          }
        }
        if (hz.contactCd > 0) hz.contactCd -= dt;
        hz.x += (hz.rel + (hz.contactCd > 0 && hz.shoved ? DAMAGE.shove : 0) - scrollV) * dt;
        if (hz.type === 'rival') {
          if (hz.weave && hz.commitY === undefined) {
            hz.weavePhase += dt * 1.6;
            hz.y += Math.sin(hz.weavePhase) * 70 * dt;
          }
          // Defenders: at commitRange the car picks the lane it will cover (yours, right then), shows it
          // for commitTell (rain light + an arrow), then slides there and holds. No homing: once it has
          // moved, it is your move. It only slides while fully ahead of your nose (never into your side).
          let sliding = false;
          if (hz.defend) {
            const ahead = hz.x - hz.w / 2 > p.x + PLAYER.width / 2;
            if (hz.commitY === undefined) {
              if (ahead && hz.x - p.x < RIVAL_AI.commitRange) {
                hz.commitY = clamp(p.y, this.trackTop + hz.h / 2, this.trackBottom - hz.h / 2);
                hz.tell = RIVAL_AI.commitTell;
              }
            } else if (hz.tell > 0) hz.tell = Math.max(0, hz.tell - dt);
            else if (ahead && Math.abs(hz.commitY - hz.y) > 0.5) {
              hz.y += clamp(hz.commitY - hz.y, -RIVAL_AI.defendSpeed * dt, RIVAL_AI.defendSpeed * dt);
              sliding = true;
            }
          }
          if (sliding) hz.brake = 1;
          else hz.brake = Math.max(0, hz.brake - dt * 3);
          hz.y = clamp(hz.y, this.trackTop + hz.h / 2, this.trackBottom - hz.h / 2);
          hz.frame = (hz.frame + (scrollV - hz.rel) * dt * 0.02) % 8;
        } else if (hz.type === 'stranded') {
          hz.smoke += dt;
          if (Math.random() < dt * 12) {
            this.particles.push({ kind: 'smoke', x: hz.x - hz.w * 0.3, y: hz.y - 6, vx: -scrollV * 0.9, vy: rand(-60, -20), r: rand(5, 10), life: rand(0.6, 1.2), age: 0 });
          }
        }
      }

      // cull: gone off the left, or pulling away off the right. Hazards on their way in can start well
      // out to the right (see spawnX) and a car attacking from behind well back on the left.
      const margin = 260;
      const screenV = (hz.type === 'tyre' || hz.type === 'debris' ? hz.vx : hz.rel) - scrollV;
      if ((hz.x < -margin && !(hz.fromBehind && hz.x > -margin - 1200)) || hz.x > this.width + margin + (screenV < 0 ? 3000 : 600)) continue;

      // interactions — none while boxing, merging back, or in the grace moment after rejoining
      // (the neutralised car is untouchable: the field is bunched and the stewards are watching)
      if (!this.pit.inLane && !this.pit.requested && p.grace <= 0 && !this.neutralised) this.collide(hz, prect, p, dt);
      if (hz.dead) continue;
      if (this.gameOver) { survivors.push(hz); continue; }

      // overtake bookkeeping: rival fully behind the player
      if (hz.type === 'rival' && !hz.passed && !hz.fromBehind && hz.x + hz.w / 2 < prect.x) {
        hz.passed = true;
        // cars drifting past while you sit in the pits, are on your way in, or while the race is neutralised, are not overtakes
        if (!this.pit.inLane && !this.pit.requested && !this.neutralised) this.onOvertake(hz);
      }
      survivors.push(hz);
    }
    this.hazards = survivors;
    if (!this.gameOver) this.updateWarnings();
  }

  /**
   * Edge warnings: every hazard about to come on from the right (within WARN.lead seconds of the
   * edge) gets a chevron at the height it will arrive at, and a car attacking from behind gets a
   * mirror chevron on the left. The renderer draws `this.warnings`; 'warnShown' fires once per hazard.
   */
  updateWarnings() {
    const out = [];
    const W = this.width;
    const scrollV = this.speed;
    for (const hz of this.hazards) {
      if (hz.type === 'drs' || hz.dead) continue;
      const half = hz.r ?? hz.w / 2;
      const v = hz.type === 'tyre' || hz.type === 'debris' ? hz.vx : hz.rel;
      let side = null, eta = 0;
      if (hz.fromBehind) {
        // in the mirrors: off the left edge, or on screen but still behind your car
        const behind = hz.x + half < this.player.x - PLAYER.width / 2;
        if (!behind) continue;
        eta = Math.max(0, (0 - (hz.x + half)) / Math.max(1, v - scrollV));
        if (eta >= WARN.mirrorLead) continue;
        side = 'left';
      } else {
        if (hz.x - half <= W) continue;
        eta = (hz.x - half - W) / Math.max(1, scrollV - v);
        if (eta >= WARN.lead) continue;
        side = 'right';
      }
      const r = hz.r ?? hz.h / 2;
      const y = hz.vy && hz.bounce ? foldY(hz.y, hz.vy, eta, this.trackTop + r, this.trackBottom - r) : hz.y;
      out.push({ hz, side, eta, y });
      if (!hz.warned) {
        hz.warned = true;
        hz.warnedAt = this.elapsed;
        this.emit('warnShown', { type: hz.type, side, big: !!hz.big });
      }
    }
    this.warnings = out;
  }

  onOvertake(hz) {
    const p = this.player;
    if (this.sc.active && this.sc.grace > 0) return; // the field is still bunching up: no penalty, no credit
    if (this.sc.active) {
      // you do not overtake under the safety car
      this.penalty = SAFETY_CAR.penaltySeconds;
      this.sc.clean = false;
      this.run.penalties += 1;
      this.shake = 0.3;
      this.addPopup(p.x, p.y - 50, '5s PENALTY', '#ff3b3b');
      this.breakFlow('penalty');
      this.emit('penalty');
      return;
    }
    this.overtakes += 1;
    this.position = clampPosition(this.position - 1);
    let pts = SCORING.overtake;
    let label = 'PASS';
    let color = '#ffd400';
    if (hz.grid) { pts = START.overtakeBonus; label = 'START'; color = '#c9ced9'; }
    if (this.sc.restartTimer > 0) { pts *= SCORING_EXTRA.restartMultiplier; label = 'RESTART'; color = '#2ecc71'; }
    if (hz.teammate) { pts += TEAMMATE.bonus; label = 'MULTI 21'; color = '#e10600'; this.run.teammatePasses += 1; }
    if (hz.driver?.legend) { pts += LEGEND_BONUS; label = 'LEGEND'; color = '#d4af37'; this.run.legendPasses = (this.run.legendPasses || 0) + 1; }
    // chained moves pay more (grid cars off the line do not build flow: that is just the start)
    if (!hz.grid) pts = flowPay(pts, this.bumpFlow());
    this.addScore(pts, 'passes');
    this.addPopup(p.x, p.y - 44, label, color, pts);
    if (hz.teammate) this.emit('teammate', { count: this.run.teammatePasses, driver: hz.driver });
    else this.emit('overtake', { count: this.overtakes, team: hz.team.name, driver: hz.driver });
  }

  collide(hz, prect, p, dt = 1 / 60) {
    // everything is measured against the car's hit parts (body + cockpit), close calls included:
    // a tyre bouncing through the air above your nose is a miss, and a close one
    const parts = carHitParts(p.x, p.y, PLAYER.width, PLAYER.height, HITBOX.player);
    let gap;
    let other = null; // the rival's parts, for rival and stranded cars
    if (hz.type === 'tyre' || hz.type === 'debris') {
      gap = partsGap(parts, (r) => rectCircleGap(r, hz.x, hz.y, hz.r));
    } else if (hz.type === 'oil') {
      // the slick is drawn as an ellipse: clipping the corner of its bounding box is not a spin
      // (radii a touch inside the drawn edge, which is feathered)
      gap = partsGap(parts, (r) => rectEllipseGap(r, hz.x, hz.y, hz.w * 0.42, hz.h * 0.42));
    } else if (hz.type === 'drs') {
      const gate = { x: hz.x - hz.w / 2, y: hz.y - hz.h / 2, w: hz.w, h: hz.h };
      gap = partsGap(parts, (r) => rectGap(r, gate));
    } else {
      other = this.hazardParts(hz);
      gap = Infinity;
      for (const q of other) gap = Math.min(gap, partsGap(parts, (r) => rectGap(r, q)));
    }

    if (gap > 0) {
      const near = hz.type === 'tyre' || hz.type === 'rival' || hz.type === 'stranded';
      if (near && gap < SCORING.closeCallDistance && !hz.nearMiss) {
        hz.nearMiss = true;
        this.closeCalls += 1;
        const teammate = hz.type === 'rival' && hz.teammate;
        const base = teammate ? SCORING_EXTRA.closeCallTeammate : SCORING.closeCall;
        hz.closeBase = base;
        const pts = flowPay(base, this.bumpFlow());
        this.addScore(pts, 'close');
        this.addPopup(hz.x, hz.y - 30, 'CLOSE', teammate ? '#e10600' : '#7df9ff', pts);
        this.emit(teammate ? 'teammateClose' : 'closeCall', { count: this.closeCalls, driver: hz.driver, flow: this.flow.mult });
      }
      // a scrape: the same close call, but nearer than paint. It pays again (double in all), with a flash and a beat of slow motion
      if (near && hz.nearMiss && !hz.scraped && gap < FLOW.scrapeGap) {
        hz.scraped = true;
        const pts = flowPay(hz.closeBase || SCORING.closeCall, this.flow.mult);
        this.addScore(pts, 'close');
        this.addPopup(hz.x, hz.y - 30, 'SCRAPE', '#ffffff', pts);
        this.slowmo = FLOW.scrapeSlowmo;
        this.scrapeFlash = 1;
        this.run.scrapes = (this.run.scrapes || 0) + 1;
        this.emit('scrape', { driver: hz.driver || null, type: hz.type });
      }
      return;
    }

    switch (hz.type) {
      case 'tyre':
        this.crash(hz, { kind: 'tyre', compound: hz.compound?.label?.toLowerCase() || null, big: !!hz.big, closingKmh: Math.round(Math.max(0, this.speed - hz.vx) * SPEED.kmhPerPx) });
        break;
      case 'stranded':
        this.crash(hz, { kind: 'stranded', closingKmh: Math.round(this.speed * SPEED.kmhPerPx) });
        break;
      case 'rival': {
        if (hz.contactCd > 0) {
          // still sliding along the same car: one hit per touch. The touch lasts until the cars are
          // apart, and they ease apart meanwhile, so the end of the cooldown is not a second, deeper hit.
          hz.contactCd = Math.max(hz.contactCd, 0.15);
          const dir = Math.sign(p.y - hz.y) || 1;
          p.y += dir * 60 * dt;
          hz.y -= dir * 60 * dt;
          break;
        }
        // judged on the touching parts: cockpit-on-body is a glancing rub, body-on-body square on
        const { ox, oy } = partsOverlap(parts, other);
        const h = rectsBounds(parts).h;
        const ahead = hz.x > p.x;
        // how fast the two cars were coming together (screen velocity of the rival is rel - speed)
        const closing = Math.max(0, ahead ? this.speed - hz.rel : hz.rel - this.speed);
        const out = contactOutcome({ ahead, ox, oy, h, closing, launch: !this.racing || this.start.launch > 0, parts: p.parts });
        if (out.crash) {
          const kind = out.reason === 'terminal' ? 'terminal-part' : out.reason === 'rear' ? 'rear' : 'nose';
          this.crash(hz, { kind, part: out.part, reason: out.reason, closingKmh: Math.round(closing * SPEED.kmhPerPx) });
        } else this.contact(hz, out.part, { ahead, oy, sideRub: oy < h * 0.5 });
        break;
      }
      case 'debris':
        hz.dead = true;
        // no wing left to take it: the carbon goes under the car
        if (p.parts.wing >= 100) { this.crash(hz, { kind: 'debris', part: 'wing' }); break; }
        this.breakFlow('contact');
        this.hurt('wing', DAMAGE.wingPerDebris, { driver: null, cause: 'debris', side: 'front' });
        this.shake = 0.5;
        this.spawnSpark(hz.x, hz.y, 10);
        break;
      case 'oil':
        if (!hz.hit) {
          hz.hit = true;
          p.spin = 0.9;
          this.tyre.wear = Math.min(100, this.tyre.wear + 8);
          this.shake = 0.4;
          this.breakFlow('oil');
          this.emit('oil');
        }
        break;
      case 'drs':
        if (!hz.taken) {
          hz.taken = true;
          hz.dead = true;
          // the battery shows what it really got (it may have been nearly full)
          const before = this.ers.charge;
          this.ers.charge = Math.min(ERS.max, this.ers.charge + ERS.drsRefill * this.car.ers);
          const pts = flowPay(SCORING.drs, this.bumpFlow());
          this.addScore(pts, 'other');
          this.addPopup(hz.x, hz.y - 40, 'DRS', '#2ecc71', pts);
          this.emit('drs', { gain: Math.round(this.ers.charge - before) });
        }
        break;
      default:
        break;
    }
  }

  /** Contact with a rival that the car survives: bodywork, a shove, sparks and carbon. */
  contact(hz, part, { ahead, oy, sideRub }) {
    const p = this.player;
    // the opening is forgiving twice over: every touch is survivable, and it costs half the bodywork
    const amount = (part === 'wing' ? rand(...DAMAGE.wingPerHit) : rand(...DAMAGE.floorPerRub)) * (this.start.launch > 0 ? DAMAGE.launchScale : 1);
    hz.contactCd = 0.7;
    hz.shoved = false;
    if (ahead && !sideRub) {
      // nose into their gearbox: you lose momentum, they get punted on, their brake light comes on
      this.speed *= 0.72;
      hz.shoved = true;
      hz.brake = 1;
      // a grid car you have shoved gets going: it settles a little above the pack and pulls away,
      // instead of fading straight back into your nose for a second hit
      if (hz.grid) { hz.fast = true; hz.launchRel = rand(20, 60); }
    } else {
      // alongside: both cars get pushed apart
      const dir = Math.sign(p.y - hz.y) || 1;
      p.y += dir * (oy * 0.6 + 3);
      p.vy = dir * 140;
      hz.y -= dir * (oy * 0.6 + 3);
      this.speed *= 0.93;
    }
    for (let i = 0; i < 6; i++) {
      this.particles.push({ kind: 'carbon', x: p.x + (ahead ? PLAYER.width * 0.4 : 0), y: p.y + (sideRub ? -Math.sign(p.y - hz.y) * PLAYER.height * 0.4 : 0), vx: rand(-150, 200), vy: rand(-260, -40), r: rand(2, 5), life: rand(0.5, 1.1), age: 0, spin: rand(0, 6) });
    }
    this.spawnSpark(p.x + (ahead ? PLAYER.width * 0.45 : -PLAYER.width * 0.3), p.y, 8);
    this.run.contacts += 1;
    this.breakFlow('contact');
    this.hurt(part, amount, { driver: hz.driver, cause: 'contact', side: sideRub ? 'side' : ahead ? 'front' : 'rear' });
  }
  /** Applies damage to a part and reports it (with `lost` when the part just reached 100). Tough cars take less. */
  hurt(part, rawAmount, ctx) {
    const p = this.player;
    const amount = rawAmount / this.car.durability;
    const before = p.parts[part];
    p.parts[part] = Math.min(100, before + amount);
    this.shake = Math.max(this.shake, 0.35 + amount / 120);
    // what it cost, right at the car: "WING 45%" (or the part gone)
    const lost = p.parts[part] >= 100 && before < 100;
    const label = part === 'wing' ? 'WING' : 'FLOOR';
    this.addPopup(p.x + PLAYER.width * 0.1, p.y - PLAYER.height * 0.9, lost ? `${label} GONE` : `${label} ${Math.round(p.parts[part])}%`, lost ? '#ff3b3b' : '#ff8a00');
    this.emit('contact', { side: 'front', ...ctx, part, amount, value: p.parts[part], total: this.damage, lost });
  }

  /**
   * The race is over. `info` says why (see logic.describeCrash): `kind` is tyre | nose | rear |
   * terminal-part | stranded | debris, plus the part, the closing speed and so on.
   */
  crash(hz, info = {}) {
    if (this.gameOver) return;
    this.gameOver = true;
    const p = this.player;
    this.crashCause = {
      kind: info.kind || hz.type, driver: hz.driver || null, closingKmh: info.closingKmh ?? null, part: info.part || null, reason: info.reason || null,
      compound: info.compound || null, big: !!info.big, at: this.elapsed, cliffAt: this.cliffAt, punctured: this.tyre.punctured, stops: this.pit.stops,
    };
    // both hitboxes as they were on impact, for the freeze-frame outline
    this.crashShapes = {
      player: carHitParts(p.x, p.y, PLAYER.width, PLAYER.height, HITBOX.player),
      rects: hz.type === 'rival' || hz.type === 'stranded' ? this.hazardParts(hz) : [],
      circle: hz.r ? { x: hz.x, y: hz.y, r: hz.r } : null,
    };
    this.score = Math.floor(this.distance) + this.bonus; // anything banked earlier this frame counts
    Object.assign(this.run, { metres: this.distance, score: this.score, overtakes: this.overtakes, stops: this.pit.stops });
    this.run.scoreBy.distance = Math.floor(this.distance);
    this.gameOverTime = 0;
    this.player.alive = false;
    this.shake = 1.2;
    this.crashVy = rand(-260, 260);
    this.crashSpin = rand(6, 10) * (Math.random() < 0.5 ? -1 : 1);
    for (let i = 0; i < 40; i++) this.spawnSpark(this.player.x + rand(-40, 60), this.player.y + rand(-15, 15), 1);
    for (let i = 0; i < 18; i++) {
      this.particles.push({ kind: 'smoke', x: this.player.x + rand(-40, 40), y: this.player.y, vx: rand(-80, 80), vy: rand(-120, -20), r: rand(8, 18), life: rand(0.8, 1.8), age: 0 });
    }
    // bits of carbon fibre
    for (let i = 0; i < 14; i++) {
      this.particles.push({ kind: 'carbon', x: this.player.x + rand(-30, 30), y: this.player.y, vx: rand(-200, 300), vy: rand(-350, -60), r: rand(3, 7), life: rand(0.8, 1.6), age: 0, spin: rand(0, 6) });
    }
    this.emit('crash', { with: hz.type, score: this.score, driver: hz.driver, cause: this.crashCause });
  }

  updateCrashed(dt) {
    // car tumbles off, scenery slows to a halt
    this.speed = Math.max(0, this.speed - dt * 500);
    this.scroll += this.speed * dt;
    const p = this.player;
    p.angle += this.crashSpin * dt;
    p.y += this.crashVy * dt;
    this.crashVy *= 0.97;
    p.x -= dt * 120;
    this.crashSpin *= 0.985;
    this.shake = Math.max(0, this.shake - dt * 1.5);
    for (const hz of this.hazards) {
      if (hz.type === 'tyre' || hz.type === 'debris') hz.x += (hz.vx - this.speed) * dt;
      else hz.x += (hz.rel - this.speed) * dt;
    }
    if (this.sc.car) this.sc.car.x -= this.speed * dt * 0.2;
    if (Math.random() < dt * 8 && this.gameOverTime < 2) {
      this.particles.push({ kind: 'smoke', x: p.x, y: p.y, vx: rand(-40, 40), vy: rand(-80, -20), r: rand(6, 14), life: rand(0.8, 1.6), age: 0 });
    }
    this.updateParticles(dt);
  }

  spawnSpark(x, y, n) {
    for (let i = 0; i < n; i++) {
      this.particles.push({ kind: 'spark', x, y, vx: rand(-300, 100) - this.speed * 0.3, vy: rand(-200, 200), r: rand(1.5, 3), life: rand(0.2, 0.5), age: 0 });
    }
  }
  updateParticles(dt) {
    const alive = [];
    for (const pt of this.particles) {
      pt.age += dt;
      if (pt.age >= pt.life) continue;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      if (pt.kind === 'spark' || pt.kind === 'carbon') pt.vy += 500 * dt;
      if (pt.kind === 'carbon') pt.spin += dt * 8;
      if (pt.kind === 'smoke' || pt.kind === 'spray') pt.r += dt * 14;
      alive.push(pt);
    }
    this.particles = alive;
    const pops = [];
    for (const pp of this.popups) {
      pp.age += dt;
      if (pp.age >= pp.life) continue;
      pp.y -= 40 * dt;
      pops.push(pp);
    }
    this.popups = pops;
  }
}

export { baseSpeed };
