// The simulation. Owns every gameplay entity and advances them by dt.
// It knows nothing about the canvas or audio; it reports interesting moments
// through `emit(event, payload)` so the presentation layer can react.
import {
  COMPOUNDS, COMPOUND_ORDER, ERS, PIT, PLAYER, RIVAL_TEAMS, SCORING, SPAWN, SPEED, TYRES, WEATHER, WORLD,
} from './config.js';
import {
  baseSpeed, clamp, gripFactor, lerp, nextPitWindowIn, pick, pickHazard, pitWindowOpen, rand, rectCircleGap,
  rectGap, playerSpeed, spawnInterval, wearDelta,
} from './logic.js';

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
    this.spawnTimer = 1.2;
    this.drsTimer = rand(SPAWN.drsEvery.min, SPAWN.drsEvery.max);
    this.rain = 0; // 0..1 track wetness
    this.raining = false;
    this.rainTimer = 0;
    this.dryTimer = WEATHER.firstRainAfter;
    this.tyre = { compound: 'medium', wear: 0, punctured: false };
    this.nextCompound = 'medium';
    this.ers = { charge: ERS.max, boosting: false };
    this.pit = { open: false, wasOpen: false, inLane: false, phase: 'none', timer: 0, stopFor: 0, slow: false, stops: 0 };
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
    this.lastRadio = 0;
    this.radioLog = [];
    this.stats = { maxSpeed: 0 };
  }

  // ----- public read helpers -----
  get grip() { return gripFactor(this.tyre.compound, this.tyre.wear, this.rain); }
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

  // ----- main step -----
  update(dt, input) {
    if (this.gameOver) {
      this.gameOverTime += dt;
      this.updateCrashed(dt);
      return;
    }
    this.elapsed += dt;
    this.updateWeather(dt);
    this.updatePit(dt, input);
    this.updatePlayer(dt, input);
    this.updateSpawns(dt);
    this.updateHazards(dt);
    this.updateParticles(dt);
    this.scroll += this.speed * dt;
    this.distance += this.speed * dt * WORLD.metresPerPx;
    this.score = Math.floor(this.distance) + this.bonus;
    this.stats.maxSpeed = Math.max(this.stats.maxSpeed, this.speed);
    this.shake = Math.max(0, this.shake - dt * 3);

    const ms = Math.floor(this.distance / SCORING.milestoneMetres);
    if (ms > this.milestone) {
      this.milestone = ms;
      this.emit('milestone', { km: ms });
    }
  }

  updateWeather(dt) {
    if (this.raining) {
      this.rainTimer -= dt;
      this.rain = Math.min(1, this.rain + dt / WEATHER.transition);
      if (this.rainTimer <= 0) {
        this.raining = false;
        this.dryTimer = WEATHER.dryGap;
        this.emit('rainStop');
      }
    } else {
      this.rain = Math.max(0, this.rain - dt / WEATHER.transition);
      this.dryTimer -= dt;
      if (this.dryTimer <= 0 && Math.random() < WEATHER.rainChancePerSecond * dt) {
        this.raining = true;
        this.rainTimer = rand(WEATHER.rainDuration.min, WEATHER.rainDuration.max);
        this.emit('rainStart');
      }
    }
  }

  updatePit(dt, input) {
    const open = pitWindowOpen(this.elapsed);
    if (open && !this.pit.wasOpen && !this.pit.inLane) this.emit('pitOpen');
    this.pit.wasOpen = open;
    this.pit.open = open;
    const p = this.player;
    const pit = this.pit;

    if (!pit.inLane) {
      // Entering: window open and the player pushes above the track edge.
      if (open && input.up && p.y <= this.trackTop + 6) {
        pit.inLane = true;
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
          pit.slow = Math.random() < PIT.slowStopChance;
          pit.stopFor = rand(PIT.stopTime.min, PIT.stopTime.max) + (pit.slow ? rand(PIT.slowStopExtra.min, PIT.slowStopExtra.max) : 0);
          pit.timer = pit.stopFor;
          this.emit('pitStop', { slow: pit.slow, duration: pit.stopFor });
        }
        break;
      case 'stop':
        if (pit.timer <= 0) {
          this.tyre = { compound: this.nextCompound, wear: 0, punctured: false };
          this.player.damage = 0;
          pit.stops += 1;
          pit.phase = 'exit';
          pit.timer = PIT.laneTravel * 0.55;
          this.emit('pitOut', { compound: this.nextCompound });
        }
        break;
      case 'exit':
        if (pit.timer <= 0) {
          pit.inLane = false;
          pit.phase = 'none';
          p.y = this.trackTop + 30;
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
        this.emit('pushing');
      }
    } else if (this.pushTimer > 0) this.pushTimer = 0;
    else this.pushTimer = Math.min(0, this.pushTimer + dt);

    // ERS / boost
    const wantBoost = (input.boost || input.pointerBoost) && !inPit && p.spin <= 0;
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
    const target = stopped
      ? 0
      : playerSpeed({ elapsed: this.elapsed, throttle: p.throttle, boosting: this.ers.boosting, grip, inPit, spun: p.spin > 0 });
    const accel = target > this.speed ? 2.5 : 4.5;
    this.speed += (target - this.speed) * Math.min(1, dt * accel);

    // vertical movement (grip-limited) — pointer overrides keys when active
    if (!inPit) {
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
    } else {
      p.vy = 0;
      p.tilt *= 0.9;
    }

    // tyre wear
    if (!inPit && !this.tyre.punctured) {
      this.tyre.wear = Math.min(100, this.tyre.wear + wearDelta(this.tyre.compound, this.speed, dt));
      if (this.tyre.wear >= 100) {
        this.tyre.punctured = true;
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
  }

  // ----- hazards -----
  updateSpawns(dt) {
    if (this.pit.inLane) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = spawnInterval(this.elapsed) * rand(0.75, 1.25);
      this.spawnHazard(pickHazard(this.elapsed));
    }
    this.drsTimer -= dt;
    if (this.drsTimer <= 0) {
      this.drsTimer = rand(SPAWN.drsEvery.min, SPAWN.drsEvery.max);
      this.spawnDrs();
    }
  }

  laneY(margin = 20) {
    return rand(this.trackTop + margin, this.trackBottom - margin);
  }

  spawnHazard(type) {
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
        const team = pick(RIVAL_TEAMS);
        const w = PLAYER.width * 0.92;
        const h = PLAYER.height * 0.92;
        // slower rivals come from ahead; occasionally a faster one attacks from behind
        const fromBehind = Math.random() < 0.25 && t > 20;
        const rel = fromBehind ? rand(180, 320) : -rand(120, 260) - Math.min(200, t * 1.5);
        this.hazards.push({
          id: nextId++, type, x: fromBehind ? -w - 40 : right + w, y: this.laneY(h), w, h, rel, vy: 0,
          team, fromBehind, weave: Math.random() < 0.4, weavePhase: rand(0, 6.28), passed: false, frame: rand(0, 8),
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
            hz.y = clamp(hz.y, this.trackTop + hz.h / 2, this.trackBottom - hz.h / 2);
          }
          hz.frame = (hz.frame + (scrollV - hz.rel) * dt * 0.02) % 8;
        }
      }

      // cull
      const margin = 260;
      if (hz.x < -margin || hz.x > this.width + margin + 200) continue;

      // interactions
      if (!this.pit.inLane) this.collide(hz, prect, p);
      if (hz.dead) continue;

      // overtake bookkeeping: rival fully behind the player
      if (hz.type === 'rival' && !hz.passed && !hz.fromBehind && hz.x + hz.w / 2 < prect.x) {
        hz.passed = true;
        this.overtakes += 1;
        this.bonus += SCORING.overtake;
        this.emit('overtake', { count: this.overtakes, team: hz.team.name });
      }
      survivors.push(hz);
    }
    this.hazards = survivors;
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
      if (gap < SCORING.closeCallDistance && !hz.nearMiss && (hz.type === 'tyre' || hz.type === 'rival')) {
        hz.nearMiss = true;
        this.closeCalls += 1;
        this.bonus += SCORING.closeCall;
        this.emit('closeCall', { count: this.closeCalls });
      }
      return;
    }

    switch (hz.type) {
      case 'tyre':
      case 'rival':
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
    this.emit('crash', { with: hz.type, score: this.score });
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
      if (pt.kind === 'spark') pt.vy += 500 * dt;
      if (pt.kind === 'smoke' || pt.kind === 'spray') pt.r += dt * 14;
      alive.push(pt);
    }
    this.particles = alive;
  }
}

export { baseSpeed };
