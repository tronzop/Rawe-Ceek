// The simulation. Owns every gameplay entity and advances them by dt.
// It knows nothing about the canvas or audio; it reports interesting moments
// through `emit(event, payload)` so the presentation layer can react.
import {
  COMPOUNDS, COMPOUND_ORDER, ERS, GP, PIT, PITGAME, PLAYER, RIVAL_AI, SAFETY_CAR, SCORING, SCORING_EXTRA, SLIPSTREAM,
  SPAWN, SPEED, STORM, TEAMMATE, TYRES, TYRE_TEMP, VENUES, WEATHER, WORLD,
} from './config.js';
import {
  baseSpeed, clamp, gpsCompleted, gripFactor, lerp, nextPitWindowIn, pick, pickHazard, pitWindowOpen, rand, rectCircleGap,
  rectGap, playerSpeed, spawnInterval, tempGrip, towFactor, venueIndexAt, wearDelta, judgeWheel, sweepPos, stopSummary,
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
    this.speed = SPEED.base;
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
      damage: 0, // debris hits reduce max throttle a little
      alive: true,
    };
    // calendar
    this.venueIndex = 0;
    this.venuePrev = 0;
    this.venueBlend = 1; // 0..1 morph from venuePrev to venueIndex
    this.night = VENUES[0].night ? 1 : 0;
    this.gps = 0;
    // safety car
    this.sc = { active: false, phase: 'none', timer: 0, cooldown: SAFETY_CAR.firstAfter, restartTimer: 0, clean: true, car: null };
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
  }

  // ----- public read helpers -----
  get venue() { return VENUES[this.venueIndex]; }
  get prevVenue() { return VENUES[this.venuePrev]; }
  get grip() { return gripFactor(this.tyre.compound, this.tyre.wear, this.rain) * tempGrip(this.tyre.temp); }
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
    // "box box" cinematic: the world drops into slow motion while the car peels off
    const cineTarget = this.pit.requested || (this.pit.inLane && this.pit.phase === 'entry') ? 1 : 0;
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
    sc.car = { x: this.width + 200, y: (this.trackTop + this.trackBottom) / 2, frame: 0 };
    this.ers.boosting = false;
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
    // glide the car into the lane
    p.y += (this.pitY - p.y) * Math.min(1, dt * 6);
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
            this.player.damage = 0;
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
        if (pit.timer <= 0) {
          pit.inLane = false;
          pit.phase = 'none';
          pit.cooldown = PIT.cooldown; // fresh tyres: the wall will not take you back straight away
          p.y = this.trackTop + 30;
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
    targetThrottle -= p.damage * 0.08;
    p.throttle += (targetThrottle - p.throttle) * Math.min(1, dt * PLAYER.throttleLerp);

    // "pushing like an animal": hold full throttle for a few seconds
    if (input.right && !inPit) {
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
    if (!inPit) {
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

    // ERS / boost (not under the safety car)
    const wantBoost = (input.boost || input.pointerBoost) && !inPit && p.spin <= 0 && !this.sc.active;
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
    if (this.sc.active && !inPit) target = Math.min(target, baseSpeed(this.elapsed) * SAFETY_CAR.speedCap);
    if (this.penalty > 0 && !inPit) target = Math.min(target, baseSpeed(this.elapsed) * SAFETY_CAR.penaltyCap);
    const accel = target > this.speed ? 2.5 : 4.5;
    this.speed += (target - this.speed) * Math.min(1, dt * accel);

    // vertical movement (grip-limited) — pointer overrides keys when active
    // (steering is handed to the pit-entry glide once you have called for the box)
    if (!inPit && !this.pit.requested) {
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
      this.tyre.wear = Math.min(100, this.tyre.wear + wearDelta(this.tyre.compound, this.speed, dt));
      if (this.tyre.wear >= 100) {
        this.tyre.punctured = true;
        this.run.punctures += 1;
        this.emit('puncture');
      } else if (this.tyre.wear > TYRES.cliffStart && this.tyre.wear - wearDelta(this.tyre.compound, this.speed, dt) <= TYRES.cliffStart) {
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
    // titanium skid-block sparks at high speed on a dry track
    if (!inPit && this.rain < 0.3 && this.speed > SPEED.max * 0.72 && Math.random() < dt * 60 * this.intensity) {
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
    if (this.pit.inLane) return;
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
        let rel = fromBehind ? rand(180, 320) : -rand(120, 260) - Math.min(200, t * 1.5);
        if (opts.scRival) rel = -rand(20, 70); // just a little slower than you: tempting
        this.hazards.push({
          id: nextId++, type, x: fromBehind ? -w - 40 : right + w, y: this.laneY(h), w, h, rel, vy: 0,
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
        hz.x += (hz.rel - scrollV) * dt;
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

      // interactions — none once you have called for the box: the car is ghosted on its way in
      if (!this.pit.inLane && !this.pit.requested) this.collide(hz, prect, p);
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
      case 'rival':
      case 'stranded':
        this.crash(hz);
        break;
      case 'debris':
        hz.dead = true;
        p.damage = Math.min(3, p.damage + 1);
        this.shake = 0.5;
        this.spawnSpark(hz.x, hz.y, 10);
        this.emit('debris', { damage: p.damage });
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
