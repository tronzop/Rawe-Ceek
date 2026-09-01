// The simulation. Owns every gameplay entity and advances them by dt.
// It knows nothing about the canvas or audio; it reports interesting moments
// through `emit(event, payload)` so the presentation layer can react.
import {
  COMPOUNDS, COMPOUND_ORDER, DAMAGE, ERS, GP, PIT, PITGAME, PLAYER, RIVAL_AI, SAFETY_CAR, SCORING, SCORING_EXTRA, SLIPSTREAM,
  SPAWN, SPEED, START, STORM, TEAMMATE, TYRES, TYRE_TEMP, VENUES, WEATHER, WORLD,
} from './config.js';
import {
  baseSpeed, clamp, gpsCompleted, gripFactor, lerp, nextPitWindowIn, pick, pickHazard, pitWindowOpen, rand, rectCircleGap,
  rectGap, playerSpeed, spawnInterval, tempGrip, towFactor, venueIndexAt, wearDelta, judgeWheel, sweepPos, stopSummary,
  contactOutcome, damageEffects, lightsFullAt, lightsLit, totalDamage,
} from './logic.js';
import { EMPTY_RUN } from './career.js';
import { DRIVERS, LEGEND_BONUS, LEGEND_CHANCE, TEAMS, teamOf } from './grid.js';

const MODERN = DRIVERS.filter((d) => !d.legend && d.team !== 'ferrari');
const LEGENDS = DRIVERS.filter((d) => d.legend);
const FERRARI = DRIVERS.filter((d) => d.team === 'ferrari');
/** Picks a rival driver: your team-mate, a legend, or somebody from the current grid. */
export function pickDriver(teammate) {
  if (teammate) return pick(FERRARI);
  return pick(Math.random() < LEGEND_CHANCE ? LEGENDS : MODERN);
}

let nextId = 1;

export class World {
  constructor(emit) {
    this.emit = emit || (() => {});
    this.width = 1280;
    this.height = WORLD.height;
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
    this.player.x = width * WORLD.playerX;
    this.player.y = clamp(this.player.y, this.trackTop, this.trackBottom);
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
    this.drsTimer = rand(SPAWN.drsEvery.min, SPAWN.drsEvery.max);
    this.rain = 0; // 0..1 track wetness
    this.raining = false;
    this.rainTimer = 0;
    this.dryTimer = WEATHER.firstRainAfter;
    this.flash = 0; // lightning
    this.tyre = { compound: 'medium', wear: 0, punctured: false, temp: 1 };
    this.nextCompound = 'medium';
    this.ers = { charge: ERS.max, boosting: false };
    this.pit = { open: false, wasOpen: false, inLane: false, phase: 'none', timer: 0, stopFor: 0, slow: false, stops: 0, requested: false, game: null, cooldown: 0 };
    this.player = {
      x: this.width * WORLD.playerX,
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
    this.sc = { active: false, phase: 'none', timer: 0, cooldown: SAFETY_CAR.firstAfter, restartTimer: 0, grace: 0, clean: true, car: null };
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
    const field = [...MODERN].sort(() => Math.random() - 0.5).slice(0, START.gridCars - 1);
    field.splice(Math.floor(rand(1, START.gridCars - 1)), 0, pick(FERRARI));
    field.forEach((driver, i) => {
      const slot = i + 1;
      const x = p.x + slot * START.spacing;
      const y = lanes[(slot + 1) % 2] + rand(-5, 5); // staggered: the car directly ahead of you is two slots up
      this.start.slots.push({ x, y });
      this.hazards.push({
        id: nextId++, type: 'rival', x, y, w, h, rel: 0, vy: 0, scPace: 0, team: teamOf(driver), driver,
        fromBehind: false, weave: false, weavePhase: rand(0, 6.28), passed: false, frame: 0, defend: false, brake: 0,
        grid: true, v: 0, // absolute speed while the field launches
      });
    });
  }

  // ----- public read helpers -----
  get venue() { return VENUES[this.venueIndex]; }
  get prevVenue() { return VENUES[this.venuePrev]; }
  get grip() { return gripFactor(this.tyre.compound, this.tyre.wear, this.rain) * tempGrip(this.tyre.temp) * damageEffects(this.player.parts).gripMul; }
  get damage() { return totalDamage(this.player.parts); }
  get racing() { return this.start.phase === 'go'; }
  get kmh() { return Math.round(this.speed * SPEED.kmhPerPx); }
  get intensity() { return clamp((this.speed - SPEED.base) / (SPEED.max - SPEED.base), 0, 1); }
  get playerRect() {
    const p = this.player;
    const w = PLAYER.width - PLAYER.hitboxInset.x * 2;
    const h = PLAYER.height - PLAYER.hitboxInset.y * 2;
    return { x: p.x - w / 2, y: p.y - h / 2, w, h };
  }
  pitCountdown() { return nextPitWindowIn(this.elapsed); }

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
    return this.resolveWheel(judgeWheel(sweepPos(g.t), g.jammed[g.wheel]), false);
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

  addPopup(x, y, text, color = '#ffd400') {
    this.popups.push({ x, y, text, color, age: 0, life: 1.1 });
  }

  // ----- main step -----
  update(dt, input) {
    if (this.gameOver) {
      this.gameOverTime += dt;
      this.updateCrashed(dt);
      return;
    }
    this.elapsed += dt;
    this.updateStart(dt, input);
    // "box box" cinematic: the world drops into slow motion while the car peels off / rejoins
    const cineTarget = this.pit.requested || (this.pit.inLane && (this.pit.phase === 'entry' || this.pit.phase === 'merge')) ? 1 : 0;
    if (this.player.grace > 0) this.player.grace = Math.max(0, this.player.grace - dt);
    this.cine += (cineTarget - this.cine) * Math.min(1, dt * 5);
    const wdt = dt * lerp(1, 0.45, this.cine); // world time for everything that could hit you
    this.updateWeather(dt);
    this.updateVenue(dt);
    this.updateSafetyCar(dt);
    this.updatePit(dt, input);
    this.updatePlayer(dt, input);
    this.updateSpawns(wdt);
    this.updateHazards(wdt);
    this.updateParticles(dt);
    this.scroll += this.speed * wdt;
    // no distance credit while serving a penalty: the stewards add it to your time
    if (this.penalty <= 0) this.distance += this.speed * dt * WORLD.metresPerPx;
    this.score = Math.floor(this.distance) + this.bonus;
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
            this.bonus += START.reactionBonus;
            this.run.greatStarts += 1;
            this.addPopup(this.player.x, this.player.y - 50, `+${START.reactionBonus} GREAT START`, '#2ecc71');
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
    if (this.raining) {
      this.rainTimer -= dt;
      this.rain = Math.min(1, this.rain + dt / WEATHER.transition);
      if (this.rainTimer <= 0 || bias === 0) {
        this.raining = false;
        this.dryTimer = WEATHER.dryGap;
        this.emit('rainStop');
      }
      // storms: lightning once the track is properly wet
      if (this.rain > STORM.minRain && Math.random() < STORM.chancePerSecond * dt) {
        this.flash = 1;
        this.emit('thunder');
      }
    } else {
      this.rain = Math.max(0, this.rain - dt / WEATHER.transition);
      this.dryTimer -= dt;
      if (this.dryTimer <= 0 && Math.random() < WEATHER.rainChancePerSecond * bias * dt) {
        this.raining = true;
        this.rainTimer = rand(WEATHER.rainDuration.min, WEATHER.rainDuration.max);
        this.emit('rainStart');
      }
    }
  }

  // ----- calendar -----
  updateVenue(dt) {
    const idx = venueIndexAt(this.distance);
    const done = gpsCompleted(this.distance);
    if (done > this.gps) {
      this.gps = done;
      this.run.gps = done;
      this.bonus += GP.finishBonus;
      this.addPopup(this.player.x, this.player.y - 50, `+${GP.finishBonus} CHEQUERED`, '#fff');
      this.emit('chequered', { gp: done, bonus: GP.finishBonus, venue: this.venue.name });
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
  updateSafetyCar(dt) {
    const sc = this.sc;
    if (this.penalty > 0) this.penalty = Math.max(0, this.penalty - dt);
    if (sc.restartTimer > 0) sc.restartTimer = Math.max(0, sc.restartTimer - dt);
    if (sc.grace > 0) sc.grace = Math.max(0, sc.grace - dt);

    if (!sc.active) {
      sc.cooldown -= dt;
      if (sc.cooldown <= 0 && !this.pit.inLane && Math.random() < SAFETY_CAR.chancePerSecond * dt) this.deploySafetyCar();
      return;
    }
    sc.timer -= dt;
    const car = sc.car;
    // the safety car sweeps in from the right and settles ahead of the player
    if (sc.phase === 'deployed') {
      const targetX = this.player.x + 340;
      car.x += (targetX - car.x) * Math.min(1, dt * 2.2);
      car.y += ((this.trackTop + this.trackBottom) / 2 - car.y) * Math.min(1, dt * 2);
      car.frame = (car.frame + this.speed * dt * 0.02) % 8;
      if (sc.timer <= 3) {
        sc.phase = 'ending';
        this.emit('scEnding');
      }
    } else if (sc.phase === 'ending') {
      // peels off into the pit lane
      car.y += (this.pitY - car.y) * Math.min(1, dt * 2.5);
      car.x += 160 * dt;
      car.frame = (car.frame + this.speed * dt * 0.02) % 8;
      if (sc.timer <= 0) this.endSafetyCar();
    }
  }
  deploySafetyCar() {
    const sc = this.sc;
    sc.active = true;
    sc.phase = 'deployed';
    sc.timer = rand(SAFETY_CAR.duration.min, SAFETY_CAR.duration.max);
    sc.clean = true;
    sc.grace = SAFETY_CAR.graceSeconds;
    sc.car = { x: this.width + 200, y: (this.trackTop + this.trackBottom) / 2, frame: 0 };
    this.ers.boosting = false;
    // the field bunches up: every rival ahead of you settles to safety-car pace so you can hold station behind it
    for (const hz of this.hazards) if (hz.type === 'rival' && hz.x > this.player.x) { hz.scPace = rand(...SAFETY_CAR.bunchSpread); hz.weave = false; hz.defend = false; hz.fromBehind = false; }
    this.run.scPeriods += 1;
    // the reason for the yellow: a stranded car on the far side of the track
    const w = PLAYER.width * 0.92;
    const h = PLAYER.height * 0.92;
    const y = Math.random() < 0.5 ? this.trackTop + h : this.trackBottom - h;
    const driver = pickDriver(false);
    this.hazards.push({
      id: nextId++, type: 'stranded', x: this.width + 700, y, w, h, rel: 0, vy: 0, team: teamOf(driver), driver, angle: rand(-0.5, 0.5),
      frame: 0, smoke: 0,
    });
    this.emit('scDeployed');
  }
  endSafetyCar() {
    const sc = this.sc;
    sc.active = false;
    sc.phase = 'none';
    sc.car = null;
    sc.cooldown = SAFETY_CAR.minGap;
    sc.restartTimer = SAFETY_CAR.restartWindow;
    if (sc.clean) {
      this.run.scClean += 1;
      this.bonus += SAFETY_CAR.restartBonus;
      this.addPopup(this.player.x, this.player.y - 50, `+${SAFETY_CAR.restartBonus} CLEAN`, '#2ecc71');
    }
    this.emit('scRestart', { clean: sc.clean });
  }

  updatePit(dt, input) {
    if (this.pit.cooldown > 0) this.pit.cooldown = Math.max(0, this.pit.cooldown - dt);
    const open = pitWindowOpen(this.elapsed) && this.pit.cooldown <= 0;
    if (open && !this.pit.wasOpen && !this.pit.inLane) this.emit('pitOpen');
    this.pit.wasOpen = open;
    this.pit.open = open;
    const p = this.player;
    const pit = this.pit;

    if (!pit.inLane) {
      // "Box box": a pit request steers the car up to the entry by itself.
      if (pit.requested && !open) { pit.requested = false; this.emit('pitDenied'); }
      // the highest the car can steer (see the clamp in updatePlayer)
      const entryY = this.trackTop + PLAYER.height / 2 - 12;
      if (pit.requested) {
        // arc up towards the wall, lifting off the throttle as we go
        p.y += (entryY - p.y) * Math.min(1, dt * 4.5);
        p.vy = -Math.abs(entryY - p.y) * 3;
        p.throttle += (0.8 - p.throttle) * Math.min(1, dt * 3);
      }
      // Entering: window open and the car is at the top edge (steered or requested).
      if (open && (input.up || pit.requested) && p.y <= entryY + 2) {
        pit.inLane = true;
        pit.requested = false;
        pit.phase = 'entry';
        pit.timer = PIT.laneTravel * 0.45;
        this.ers.boosting = false;
        this.emit('pitIn');
      }
      return;
    }

    pit.timer -= dt;
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
          pit.game = {
            wheel: 0, t: 0, results: [], flash: 0, lastResult: null, total: 0, hold: 0,
            jammed: PITGAME.wheels.map(() => Math.random() < PITGAME.jamChance),
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
            this.tyre = { compound: this.nextCompound, wear: 0, punctured: false, temp: 0 };
            if (totalDamage(this.player.parts) > 0) this.run.repairs += 1;
            this.player.parts = { wing: 0, floor: 0 }; // new nose and floor go on with the tyres
            pit.stops += 1;
            pit.slow = !s.clean;
            pit.stopFor = s.time;
            if (pit.slow) this.run.slowStops += 1;
            if (s.record) { this.run.recordStops += 1; this.bonus += PITGAME.recordBonus; this.addPopup(p.x, p.y + 60, `+${PITGAME.recordBonus} RECORD STOP`, '#7df9ff'); }
            else if (s.clean) { this.run.cleanStops += 1; this.bonus += PITGAME.cleanBonus; this.addPopup(p.x, p.y + 60, `+${PITGAME.cleanBonus} CLEAN STOP`, '#2ecc71'); }
            if (s.perfects === PITGAME.wheels.length) this.run.perfectStops += 1;
            pit.phase = 'exit';
            pit.timer = PIT.laneTravel * 0.55;
            pit.game = null;
            this.emit('pitOut', { compound: this.nextCompound, ...s });
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
        const harvest = this.tow * SLIPSTREAM.ersPerSecond * dt;
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
      this.ers.charge = Math.min(ERS.max, this.ers.charge + ERS.rechargePerSecond * dt);
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
      : playerSpeed({ elapsed: this.elapsed, throttle: p.throttle, boosting: this.ers.boosting, grip, inPit, spun: p.spin > 0 });
    if (!inPit) target *= 1 + this.tow * SLIPSTREAM.speedBonus;
    if (this.sc.active && !inPit) {
      // capped at safety-car pace; lifting takes you below it so you can drop back from the car ahead
      const lift = clamp((p.throttle - PLAYER.throttleRange.min) / (1 - PLAYER.throttleRange.min), 0, 1);
      target = Math.min(target, baseSpeed(this.elapsed) * SAFETY_CAR.speedCap * lerp(SAFETY_CAR.liftFloor, 1, lift));
    }
    if (this.penalty > 0 && !inPit) target = Math.min(target, baseSpeed(this.elapsed) * SAFETY_CAR.penaltyCap);
    if (!this.racing) target = 0; // lights are on
    const accel = target > this.speed ? (this.start.launch > 0 ? START.launchAccel : 2.5) : 4.5;
    this.speed += (target - this.speed) * Math.min(1, dt * accel);

    // vertical movement (grip-limited) — pointer overrides keys when active
    // (steering is handed to the pit-entry glide once you have called for the box; none on the grid)
    if (!inPit && !this.pit.requested && this.racing) {
      let dir = 0;
      if (input.up) dir -= 1;
      if (input.down) dir += 1;
      if (input.pointerY !== null && input.pointerY !== undefined) {
        const ty = clamp(input.pointerY * this.height, this.trackTop, this.trackBottom);
        const dy = ty - p.y;
        dir = Math.abs(dy) < 6 ? 0 : Math.sign(dy);
      }
      if (p.spin > 0) dir *= 0.3;
      const vmax = PLAYER.verticalSpeed * lerp(0.5, 1, clamp(grip, 0, 1));
      const targetVy = dir * vmax;
      p.vy += (targetVy - p.vy) * Math.min(1, dt * 10);
      p.y += p.vy * dt;
      const half = PLAYER.height / 2;
      const lo = this.trackTop + half - 12;
      const hi = this.trackBottom - half + 12;
      if (p.y < lo) { p.y = lo; p.vy = Math.max(0, p.vy); }
      if (p.y > hi) { p.y = hi; p.vy = Math.min(0, p.vy); }
      p.tilt += ((p.vy / vmax) * 0.16 - p.tilt) * Math.min(1, dt * 8);
    } else if (this.pit.requested) {
      p.tilt += (-0.12 - p.tilt) * Math.min(1, dt * 6); // nose up toward the pit wall
    } else {
      p.vy = 0;
      p.tilt *= 0.9;
    }

    // tyre temperature: fresh rubber warms with speed and steering, rain cools it
    if (!inPit) {
      const heat = (0.6 + 0.6 * (this.speed / SPEED.base) + Math.abs(p.vy) / PLAYER.verticalSpeed) / TYRE_TEMP.warmupSeconds;
      this.tyre.temp = clamp(this.tyre.temp + heat * dt - this.rain * TYRE_TEMP.rainCooling * dt, 0, 1);
    }

    // tyre wear
    if (!inPit && !this.tyre.punctured) {
      const dWear = wearDelta(this.tyre.compound, this.speed, dt);
      this.tyre.wear = Math.min(100, this.tyre.wear + dWear);
      if (this.tyre.wear >= 100) {
        this.tyre.punctured = true;
        this.run.punctures += 1;
        this.emit('puncture');
      } else if (this.tyre.wear > TYRES.cliffStart && this.tyre.wear - dWear <= TYRES.cliffStart) {
        this.emit('tyresHot');
      }
    }
    if (this.tyre.punctured) {
      // limp mode: crawl until you pit
      this.speed = Math.min(this.speed, SPEED.base * 0.55);
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
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      if (this.sc.active) {
        // bunched field: slow rivals you are not allowed to pass
        this.spawnTimer = spawnInterval(this.elapsed) * rand(1.6, 2.4);
        if (this.sc.phase === 'deployed') this.spawnHazard('rival', { scRival: true });
      } else {
        this.spawnTimer = spawnInterval(this.elapsed) * rand(0.75, 1.25);
        this.spawnHazard(pickHazard(this.elapsed));
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

  spawnHazard(type, opts = {}) {
    const right = this.width + 80;
    const t = this.elapsed;
    switch (type) {
      case 'tyre': {
        const compound = pick(Object.values(COMPOUNDS));
        const r = rand(16, 30) * (1 + Math.min(0.5, t / 240));
        const speedMul = compound.id === 'soft' ? 1.35 : compound.id === 'hard' ? 0.75 : 1;
        // rolls toward the player with a bit of vertical drift, bounces off the kerbs
        this.hazards.push({
          id: nextId++, type, x: right, y: this.laneY(r), r, vx: -rand(60, 180) * speedMul, vy: rand(-90, 90),
          spin: 0, compound, bounce: true,
        });
        break;
      }
      case 'rival': {
        const teammate = Math.random() < TEAMMATE.chance && t > 15;
        const driver = pickDriver(teammate);
        const team = teamOf(driver);
        const w = PLAYER.width * 0.92;
        const h = PLAYER.height * 0.92;
        // slower rivals come from ahead; occasionally a faster one attacks from behind
        const fromBehind = !opts.scRival && Math.random() < 0.25 && t > 20;
        const rel = fromBehind ? rand(180, 320) : -rand(120, 260) - Math.min(200, t * 1.5);
        this.hazards.push({
          id: nextId++, type, x: fromBehind ? -w - 40 : right + w, y: this.laneY(h), w, h, rel, vy: 0,
          // under the safety car rivals run at (about) its pace in absolute terms, not relative to you
          scPace: opts.scRival ? rand(...SAFETY_CAR.bunchSpread) : 0,
          team, driver, fromBehind, weave: !opts.scRival && Math.random() < 0.4, weavePhase: rand(0, 6.28), passed: false, frame: rand(0, 8),
          defend: !fromBehind && !teammate && Math.random() < RIVAL_AI.defendChance, brake: 0,
        });
        break;
      }
      case 'oil': {
        const w = rand(90, 170);
        const h = rand(24, 42);
        this.hazards.push({ id: nextId++, type, x: right + w, y: this.laneY(h), w, h, rel: 0, vy: 0 });
        break;
      }
      case 'debris': {
        const r = rand(7, 12);
        this.hazards.push({ id: nextId++, type, x: right, y: this.laneY(r), r, vx: -rand(0, 40), vy: rand(-20, 20), spin: 0, bounce: false });
        break;
      }
      default:
        break;
    }
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
        // bunched rivals hold safety-car pace until the green flag, then they are slow traffic
        if (hz.scPace) hz.rel = this.sc.active ? hz.scPace * baseSpeed(this.elapsed) * SAFETY_CAR.speedCap - scrollV : -rand(60, 140);
        if (hz.scPace && !this.sc.active) hz.scPace = 0;
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
            const settled = hz.fast ? this.packV + hz.launchRel : hz.launchRel;
            const target = this.packV * (1 - spread) + settled * spread + bog;
            hz.v += (target - hz.v) * Math.min(1, dt * hz.launchAccel * 2);
            hz.rel = hz.v;
          } else {
            hz.grid = false;
            hz.weave = Math.random() < 0.4;
            hz.defend = hz.x > p.x && !hz.team.teammate && Math.random() < RIVAL_AI.defendChance;
          }
        }
        if (hz.contactCd > 0) hz.contactCd -= dt;
        hz.x += (hz.rel + (hz.contactCd > 0 && hz.shoved ? DAMAGE.shove : 0) - scrollV) * dt;
        if (hz.type === 'rival') {
          if (hz.weave) {
            hz.weavePhase += dt * 1.6;
            hz.y += Math.sin(hz.weavePhase) * 70 * dt;
          }
          // defenders drift across to cover your lane when you close in
          if (hz.defend && hz.x > p.x && hz.x - p.x < RIVAL_AI.defendRange) {
            const dy = p.y - hz.y;
            hz.y += clamp(dy, -RIVAL_AI.defendSpeed * dt, RIVAL_AI.defendSpeed * dt);
            hz.brake = 1;
          } else hz.brake = Math.max(0, hz.brake - dt * 3);
          hz.y = clamp(hz.y, this.trackTop + hz.h / 2, this.trackBottom - hz.h / 2);
          hz.frame = (hz.frame + (scrollV - hz.rel) * dt * 0.02) % 8;
        } else if (hz.type === 'stranded') {
          hz.smoke += dt;
          if (Math.random() < dt * 12) {
            this.particles.push({ kind: 'smoke', x: hz.x - hz.w * 0.3, y: hz.y - 6, vx: -scrollV * 0.9, vy: rand(-60, -20), r: rand(5, 10), life: rand(0.6, 1.2), age: 0 });
          }
        }
      }

      // cull
      const margin = 260;
      if (hz.x < -margin || hz.x > this.width + margin + 600) continue;

      // interactions — none while boxing, merging back, or in the grace moment after rejoining
      if (!this.pit.inLane && !this.pit.requested && p.grace <= 0) this.collide(hz, prect, p);
      if (hz.dead) continue;

      // overtake bookkeeping: rival fully behind the player
      if (hz.type === 'rival' && !hz.passed && !hz.fromBehind && hz.x + hz.w / 2 < prect.x) {
        hz.passed = true;
        // cars drifting past while you sit in the pits are not overtakes
        if (!this.pit.inLane) this.onOvertake(hz);
      }
      survivors.push(hz);
    }
    this.hazards = survivors;
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
      this.emit('penalty');
      return;
    }
    this.overtakes += 1;
    let pts = SCORING.overtake;
    let label = `+${pts}`;
    let color = '#ffd400';
    if (hz.grid) { pts = START.overtakeBonus; label = `+${pts} START`; color = '#c9ced9'; }
    if (this.sc.restartTimer > 0) { pts *= SCORING_EXTRA.restartMultiplier; label = `+${pts} RESTART`; color = '#2ecc71'; }
    if (hz.team.teammate) { pts += TEAMMATE.bonus; label = `+${pts} MULTI 21`; color = '#e10600'; this.run.teammatePasses += 1; }
    if (hz.driver?.legend) { pts += LEGEND_BONUS; label = `+${pts} LEGEND`; color = '#d4af37'; this.run.legendPasses = (this.run.legendPasses || 0) + 1; }
    this.bonus += pts;
    this.addPopup(p.x, p.y - 44, label, color);
    if (hz.team.teammate) this.emit('teammate', { count: this.run.teammatePasses, driver: hz.driver });
    else this.emit('overtake', { count: this.overtakes, team: hz.team.name, driver: hz.driver });
  }

  collide(hz, prect, p) {
    let gap;
    if (hz.type === 'tyre' || hz.type === 'debris') {
      gap = rectCircleGap(prect, hz.x, hz.y, hz.r);
    } else {
      const rect = { x: hz.x - hz.w / 2, y: hz.y - hz.h / 2, w: hz.w, h: hz.h };
      // oil/drs only count if the car's centre line crosses them
      gap = rectGap(prect, rect);
    }

    if (gap > 0) {
      if (gap < SCORING.closeCallDistance && !hz.nearMiss && (hz.type === 'tyre' || hz.type === 'rival' || hz.type === 'stranded')) {
        hz.nearMiss = true;
        this.closeCalls += 1;
        const teammate = hz.type === 'rival' && hz.team.teammate;
        const pts = teammate ? SCORING_EXTRA.closeCallTeammate : SCORING.closeCall;
        this.bonus += pts;
        this.addPopup(hz.x, hz.y - 30, `+${pts}`, teammate ? '#e10600' : '#7df9ff');
        this.emit(teammate ? 'teammateClose' : 'closeCall', { count: this.closeCalls, driver: hz.driver });
      }
      return;
    }

    switch (hz.type) {
      case 'tyre':
      case 'stranded':
        this.crash(hz);
        break;
      case 'rival': {
        if (hz.contactCd > 0) break; // still sliding along the same car: one hit per touch
        const rect = { x: hz.x - hz.w / 2, y: hz.y - hz.h / 2, w: hz.w, h: hz.h };
        const ox = Math.min(prect.x + prect.w, rect.x + rect.w) - Math.max(prect.x, rect.x);
        const oy = Math.min(prect.y + prect.h, rect.y + rect.h) - Math.max(prect.y, rect.y);
        const ahead = hz.x > p.x;
        // how fast the two cars were coming together (screen velocity of the rival is rel - speed)
        const closing = Math.max(0, ahead ? this.speed - hz.rel : hz.rel - this.speed);
        const outcome = contactOutcome({ ahead, ox, oy, h: prect.h, closing, launch: !this.racing || this.start.launch > 0, parts: p.parts });
        if (outcome === 'crash') this.crash(hz);
        else this.contact(hz, outcome, { ahead, oy, sideRub: oy < prect.h * 0.5 });
        break;
      }
      case 'debris':
        hz.dead = true;
        this.hurt('wing', DAMAGE.wingPerDebris, { driver: null, cause: 'debris' });
        this.shake = 0.5;
        this.spawnSpark(hz.x, hz.y, 10);
        break;
      case 'oil':
        if (!hz.hit) {
          hz.hit = true;
          p.spin = 0.9;
          this.tyre.wear = Math.min(100, this.tyre.wear + 8);
          this.shake = 0.4;
          this.emit('oil');
        }
        break;
      case 'drs':
        if (!hz.taken) {
          hz.taken = true;
          hz.dead = true;
          this.ers.charge = Math.min(ERS.max, this.ers.charge + ERS.drsRefill);
          this.bonus += 20;
          this.addPopup(hz.x, hz.y - 40, '+20 DRS', '#2ecc71');
          this.emit('drs');
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
    this.hurt(part, amount, { driver: hz.driver, cause: 'contact' });
  }
  /** Applies damage to a part and reports it (with `lost` when the part just reached 100). */
  hurt(part, amount, ctx) {
    const p = this.player;
    const before = p.parts[part];
    p.parts[part] = Math.min(100, before + amount);
    this.shake = Math.max(this.shake, 0.35 + amount / 120);
    this.emit('contact', { ...ctx, part, amount, value: p.parts[part], total: this.damage, lost: p.parts[part] >= 100 && before < 100 });
  }

  crash(hz) {
    if (this.gameOver) return;
    this.gameOver = true;
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
    this.emit('crash', { with: hz.type, score: this.score, driver: hz.driver });
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
