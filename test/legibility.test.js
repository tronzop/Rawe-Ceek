// Gameplay legibility: edge warnings for what is coming (B1), car-shaped hitboxes (B2), crashes that
// explain themselves (B3) and fair spawns with a gentler curve (B4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CRASH_FREEZE, World, playerXFor } from '../src/world.js';
import { carById } from '../src/cars.js';
import { DAMAGE, GP, HITBOX, PLAYER, SPAWN, START, WARN, WORLD } from '../src/config.js';
import {
  baseSpeed, carHitParts, describeCrash, foldY, freeLanes, partsGap, partsOverlap, pickInLanes, rectCircleGap, rectGap, spawnInterval,
} from '../src/logic.js';

const DT = 1 / 60;
const idle = () => ({ up: false, down: false, left: false, right: false, boost: false, pointerY: null, pointerBoost: false });

/** Racing, launch over, empty track, no random safety car or rain, nothing spawning unless asked. */
function racingWorld(events = [], elapsed = 20, width = 1280) {
  const w = new World((e, p) => events.push([e, p]), carById('ferrari'));
  w.resize(width, 720);
  w.reset();
  w.start.phase = 'go';
  w.start.lit = 5;
  w.start.sinceGo = 20;
  w.start.launch = 0;
  w.start.reaction = 0.2;
  w.hazards = [];
  w.sc.cooldown = 1e9;
  w.dryTimer = 1e9;
  w.spawnTimer = 1e9;
  w.drsTimer = 1e9;
  w.elapsed = elapsed;
  w.speed = baseSpeed(elapsed);
  return w;
}
const step = (w, input, seconds) => { for (let t = 0; t < seconds; t += DT) w.update(DT, input); };
function seeded(seed, fn) {
  const real = Math.random;
  let a = seed >>> 0;
  Math.random = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  try { return fn(); } finally { Math.random = real; }
}
const tyre = (x, y, r = 8, extra = {}) => ({ id: 900 + Math.random(), type: 'tyre', x, y, r, vx: 0, vy: 0, spin: 0, bounce: false, compound: { id: 'medium', label: 'MEDIUM', color: '#ffd400' }, ...extra });
const rivalAt = (w, x, y, rel, extra = {}) => ({
  id: 800 + Math.random(), type: 'rival', x, y, w: PLAYER.width * 0.92, h: PLAYER.height * 0.92, rel, pace: rel / baseSpeed(w.elapsed), vy: 0, scPace: 0,
  team: { name: 'Red Bull', primary: '#1e2a78', accent: '#ffcc00' }, driver: { id: 'ver', name: 'Verstappen', short: 'VER' }, teammate: false,
  fromBehind: false, weave: false, weavePhase: 0, passed: false, frame: 0, defend: false, brake: 0, ...extra,
});

// ---------------------------------------------------------------- B2: hitboxes

test('hit parts: a body block and a cockpit block, with nothing over the nose', () => {
  const [body, cockpit] = carHitParts(0, 0, PLAYER.width, PLAYER.height);
  assert.ok(body.w > cockpit.w, 'the body runs the length of the car');
  assert.ok(cockpit.y < body.y, 'the cockpit sits on top');
  assert.ok(Math.abs(cockpit.y + cockpit.h - body.y) < 1e-9, 'stacked, no gap between them');
  // the air over the nose: right of the cockpit, above the body
  const nose = { x: PLAYER.width * 0.35, y: -PLAYER.height * 0.33 - 4 };
  assert.ok(partsGap([body, cockpit], (r) => rectCircleGap(r, nose.x, nose.y, 6)) > 0, 'a tyre over the nose misses');
  // ...which the old one-box hitbox called a hit
  const old = { x: -PLAYER.width / 2 + PLAYER.hitboxInset.x, y: -PLAYER.height / 2 + PLAYER.hitboxInset.y, w: PLAYER.width - 12, h: PLAYER.height - 16 };
  assert.ok(rectCircleGap(old, nose.x, nose.y, 6) <= 0);
  assert.ok(partsGap([body, cockpit], (r) => rectCircleGap(r, -20, -PLAYER.height * 0.33 - 4, 6)) <= 0, 'the cockpit block is still the car');
  // overlap is judged on the touching pairs
  const other = carHitParts(PLAYER.width * 0.8, 0, PLAYER.width * 0.92, PLAYER.height * 0.92, HITBOX.rival);
  const o = partsOverlap([body, cockpit], other);
  assert.equal(o.hit, true);
  assert.ok(o.ox > 0 && o.oy > 0);
  assert.equal(partsOverlap([body, cockpit], carHitParts(500, 0, 100, 40, HITBOX.rival)).hit, false);
});

test('a tyre bouncing over the nose misses; one on the cockpit still retires you', () => {
  const miss = racingWorld();
  miss.speed = 0;
  const p = miss.player;
  miss.hazards.push(tyre(p.x + PLAYER.width * 0.35, p.y - PLAYER.height * 0.33 - 4, 6));
  miss.update(DT, idle());
  assert.equal(miss.gameOver, false);

  const hit = racingWorld();
  hit.speed = 0;
  hit.hazards.push(tyre(hit.player.x - 20, hit.player.y - PLAYER.height * 0.33 - 4, 6));
  hit.update(DT, idle());
  assert.equal(hit.gameOver, true);
});

test('close calls are measured against the same parts', () => {
  const events = [];
  const w = racingWorld(events);
  w.speed = 0;
  const p = w.player;
  // 10 px clear of the nose-top air would have been a hit before; now it is just close to the body
  const t = tyre(p.x + PLAYER.width * 0.35, p.y - PLAYER.height * 0.08 - 6 - 10, 6);
  w.hazards.push(t);
  w.update(DT, idle());
  assert.equal(w.gameOver, false);
  t.y -= 40; // and gone by: the close call is paid once it is clear
  w.update(DT, idle());
  assert.ok(events.some(([e]) => e === 'closeCall'));
});

// ---------------------------------------------------------------- B3: explain the crash

/** Runs one crash scenario and returns the crash payload. */
function crashWith(setup) {
  const events = [];
  const w = racingWorld(events);
  setup(w);
  for (let i = 0; i < 60 && !w.gameOver; i++) w.update(DT, idle());
  assert.equal(w.gameOver, true, 'crashed');
  const payload = events.find(([e]) => e === 'crash')[1];
  assert.deepEqual(payload.cause, w.crashCause);
  return payload;
}

test('every kind of crash has its own cause line and tip', () => {
  const near = (w) => w.player.x + PLAYER.width * 0.46;
  const scenarios = {
    tyre: (w) => { w.speed = 0; w.hazards.push(tyre(w.player.x, w.player.y, 20)); },
    nose: (w) => { const r = rivalAt(w, 0, w.player.y, w.speed - DAMAGE.maxClosing - 150); r.x = near(w) - HITBOX.rival.body.x0 * r.w - 1; w.hazards.push(r); },
    rear: (w) => { const r = rivalAt(w, 0, w.player.y, w.speed + 250, { fromBehind: true }); r.x = w.player.x - PLAYER.width * 0.46 - HITBOX.rival.body.x1 * r.w + 1; w.hazards.push(r); },
    'terminal-part': (w) => { w.player.parts.floor = 100; const r = rivalAt(w, w.player.x, w.player.y - PLAYER.height * 0.75, w.speed); w.hazards.push(r); },
    stranded: (w) => { w.speed = 0; w.hazards.push({ id: 7, type: 'stranded', x: w.player.x + 60, y: w.player.y, w: 138, h: 42, rel: 0, vy: 0, team: { primary: '#fff' }, driver: { short: 'ALB', name: 'Albon' }, angle: 0, frame: 0, smoke: 0 }); },
    debris: (w) => { w.speed = 0; w.player.parts.wing = 100; w.hazards.push({ id: 8, type: 'debris', x: w.player.x + 40, y: w.player.y, r: 10, vx: 0, vy: 0, spin: 0, bounce: false }); },
  };
  const lines = new Set();
  const tips = new Set();
  for (const [kind, setup] of Object.entries(scenarios)) {
    const { cause } = crashWith(setup);
    assert.equal(cause.kind, kind, `${kind} scenario`);
    const d = describeCrash(cause);
    assert.ok(d.line.length > 10 && d.tip.length > 10, `${kind}: ${d.line} / ${d.tip}`);
    lines.add(d.line);
    tips.add(d.tip);
  }
  assert.equal(lines.size, Object.keys(scenarios).length, 'no two kinds read the same');
  assert.equal(tips.size, Object.keys(scenarios).length);
  // the nose line names the driver and the closing speed
  const nose = describeCrash(crashWith(scenarios.nose).cause);
  assert.match(nose.line, /VER/);
  assert.match(nose.line, /km\/h closing/);
});

test('the cause line points at the tyres when they were the real problem', () => {
  const cliff = crashWith((w) => { w.speed = 0; w.tyre.wear = 90; w.cliffAt = 72; w.hazards.push(tyre(w.player.x, w.player.y, 20)); });
  assert.match(describeCrash(cliff.cause).extra, /never boxed.*1:12/);
  const fresh = crashWith((w) => { w.speed = 0; w.hazards.push(tyre(w.player.x, w.player.y, 20)); });
  assert.equal(describeCrash(fresh.cause).extra, null);
});

test('crash freeze-frame: the world holds on the impact, then the tumble plays', () => {
  const w = racingWorld();
  w.speed = 0;
  w.distance = 432.1;
  w.addScore(60, 'passes');
  w.hazards.push(tyre(w.player.x, w.player.y, 20));
  w.update(DT, idle());
  assert.equal(w.gameOver, true);
  assert.ok(w.crashShapes && w.crashShapes.player.length === 2 && w.crashShapes.circle);
  assert.equal(Object.values(w.run.scoreBy).reduce((a, b) => a + b, 0), w.score, 'the breakdown adds up on the crash frame too');
  const { x, y, angle } = w.player;
  step(w, idle(), CRASH_FREEZE - 0.05);
  assert.deepEqual([w.player.x, w.player.y, w.player.angle], [x, y, angle], 'frozen');
  step(w, idle(), 0.6);
  assert.notEqual(w.player.angle, angle, 'tumbling');
});

test('contact shows what it cost at the car, and reports the side it came from', () => {
  const events = [];
  const w = racingWorld(events);
  const r = rivalAt(w, 0, w.player.y, w.speed - 60);
  r.x = w.player.x + PLAYER.width * 0.46 - HITBOX.rival.body.x0 * r.w - 1;
  w.hazards.push(r);
  w.update(DT, idle());
  const c = events.find(([e]) => e === 'contact');
  assert.ok(c, 'contact');
  assert.equal(c[1].side, 'front');
  assert.equal(c[1].part, 'wing');
  assert.ok(c[1].amount > 0);
  assert.ok(w.popups.some((pp) => /^WING \d+%$/.test(pp.text)), w.popups.map((pp) => pp.text).join(','));
});

test('score sources add up to the score', () => {
  const w = racingWorld();
  w.distance = 812.7;
  w.addScore(60, 'passes');
  w.addScore(25, 'close');
  w.addScore(50, 'pit');
  w.addScore(150, 'gp');
  w.addScore(20, 'other');
  w.update(DT, idle());
  const by = w.run.scoreBy;
  assert.equal(Object.values(by).reduce((a, b) => a + b, 0), w.score);
  assert.equal(by.passes, 60);
  assert.equal(by.distance, Math.floor(w.distance));
});

// ---------------------------------------------------------------- B4: fair spawns

test('freeLanes: a wall of three tyres leaves nowhere to go, a gap in it does', () => {
  const top = 223, bottom = 626;
  const at = (y) => ({ type: 'tyre', x: 1400, y, r: 30, vx: 0, vy: 0 });
  const opts = { size: 20, closing: 500, playerLen: 140, minGap: SPAWN.minGap };
  // spaced so every gap is narrower than the car needs
  const wall = [at(top + 30 + 56), at(top + 30 + 56 + 60 + 56), at(top + 30 + 56 + 2 * (60 + 56))];
  assert.deepEqual(freeLanes(wall, 1400, 280, 500, top, bottom, opts), []);
  // move one out of the way: there is a lane now, and placing the new hazard in it keeps a gap
  const gap = [wall[0], wall[1], at(bottom - 30)];
  const lanes = freeLanes(gap, 1400, 280, 500, top, bottom, opts);
  assert.ok(lanes.length > 0);
  for (const [lo, hi] of lanes) {
    for (const y of [lo, hi]) assert.ok(!gap.some((h) => Math.abs(h.y - y) < h.r + opts.size), 'never on top of another hazard');
  }
  // hazards that cross your line at another time do not count
  const later = wall.map((h) => ({ ...h, x: 4000 }));
  assert.ok(freeLanes(later, 1400, 280, 500, top, bottom, opts).length > 0);
  const y = pickInLanes(lanes, 0.5);
  assert.ok(lanes.some(([lo, hi]) => y >= lo && y <= hi));
  assert.equal(pickInLanes([], 0.5), null);
});

test('foldY bounces off the kerbs', () => {
  assert.equal(foldY(100, 50, 1, 0, 200), 150);
  assert.equal(foldY(180, 50, 1, 0, 200), 170); // 230 folds back to 170
  assert.equal(foldY(20, -50, 1, 0, 200), 30);
  assert.equal(foldY(100, 0, 5, 0, 200), 100);
});

test('no wall at the car: five seeded minutes never block every lane at your x', () => {
  for (const seed of [11, 22, 33]) {
    seeded(seed, () => {
      const w = racingWorld([], 0, 960);
      w.spawnTimer = 1;
      w.drsTimer = 5;
      w.tyre.wear = -1e9; // tyres that never go off, so the pace (and the spawn rate) keeps climbing
      w.collide = () => {}; // invulnerable: we are watching the traffic, not the driving
      for (let f = 0; f < 300 * 60; f++) {
        w.update(DT, idle());
        const car = w.playerRect;
        const spans = [];
        for (const hz of w.hazards) {
          if (hz.type === 'drs' || hz.type === 'oil') continue;
          const hl = hz.r ?? hz.w / 2, hh = hz.r ?? hz.h / 2;
          if (hz.x + hl < car.x || hz.x - hl > car.x + car.w) continue;
          spans.push([hz.y - hh, hz.y + hh]);
        }
        spans.sort((a, b) => a[0] - b[0]);
        let best = 0, edge = w.trackTop;
        for (const [lo, hi] of spans) { if (lo > edge) best = Math.max(best, lo - edge); edge = Math.max(edge, hi); }
        best = Math.max(best, w.trackBottom - edge);
        assert.ok(best >= car.h * 1.1, `seed ${seed}: blocked at ${w.elapsed.toFixed(1)} s (widest gap ${best.toFixed(0)} px)`);
      }
    });
  }
});

test('the on-ramp: right after the launch the gaps start long', () => {
  const w = racingWorld([], START.launchSeconds);
  w.start.sinceGo = START.launchSeconds;
  w.spawnTimer = 0.0001;
  w.update(DT, idle());
  assert.ok(w.spawnTimer >= spawnInterval(w.elapsed) * SPAWN.onRamp.mult * 0.75 - 1e-6 || w.spawnTimer === SPAWN.retry, `timer ${w.spawnTimer}`);
  const late = racingWorld([], 60);
  late.start.sinceGo = START.launchSeconds + SPAWN.onRamp.seconds + 1;
  late.spawnTimer = 0.0001;
  late.update(DT, idle());
  assert.ok(late.spawnTimer <= spawnInterval(late.elapsed) * 1.25 + 1e-6);
});

test('a breather after the chequered flag', () => {
  const events = [];
  const w = racingWorld(events);
  w.distance = GP.lengthMetres - 0.01;
  for (let i = 0; i < 5 && !events.some(([e]) => e === 'chequered'); i++) w.update(DT, idle());
  assert.ok(events.some(([e]) => e === 'chequered'));
  w.spawnTimer = 0.0001; // due right now, but the breather holds it
  const n = w.hazards.length;
  step(w, idle(), SPAWN.breather - 0.1);
  assert.equal(w.hazards.length, n, 'nothing spawned');
  step(w, idle(), 0.5);
  assert.ok(w.hazards.length > n, 'traffic again');
});

test('tyres no longer grow with time; one in a dozen or so is a big one', () => {
  seeded(5, () => {
    const w = racingWorld([], 400);
    let big = 0, n = 0;
    for (let i = 0; i < 600; i++) {
      w.hazards = [];
      const hz = w.spawnHazard('tyre');
      if (!hz) continue;
      n += 1;
      if (hz.big) { big += 1; assert.ok(hz.r >= 24 && hz.r <= 45); } else assert.ok(hz.r >= 16 && hz.r <= 30, `r ${hz.r}`);
    }
    assert.ok(big / n > 0.04 && big / n < 0.13, `big share ${big / n}`);
  });
});

test('debris is bigger, so it can be seen', () => {
  const w = racingWorld();
  for (let i = 0; i < 50; i++) {
    w.hazards = [];
    const hz = w.spawnHazard('debris');
    assert.ok(hz.r >= 9 && hz.r <= 14);
  }
});

// ---------------------------------------------------------------- B1: edge warnings

test('a hazard coming on from the right is flagged for WARN.lead seconds before it shows', () => {
  const events = [];
  const w = racingWorld(events, 30, 960);
  const hz = w.spawnHazard('tyre');
  hz.vy = 0;
  w.update(DT, idle());
  const wn = w.warnings.find((x) => x.hz === hz);
  assert.ok(wn, 'warned');
  assert.equal(wn.side, 'right');
  assert.ok(wn.eta > WARN.lead * 0.8, `eta ${wn.eta}`);
  const shown = events.filter(([e]) => e === 'warnShown');
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0][1], { type: 'tyre', side: 'right', big: !!hz.big });
  // once it is on screen the chevron goes
  step(w, idle(), WARN.lead + 0.1);
  assert.ok(hz.x - hz.r < w.width);
  assert.ok(!w.warnings.some((x) => x.hz === hz));
  assert.equal(events.filter(([e]) => e === 'warnShown').length, 1, 'once per hazard');
});

test('a bouncing tyre is flagged where it will arrive, folded at the kerbs', () => {
  const w = racingWorld([], 30, 960);
  const r = 20;
  const hz = tyre(w.width + 200, w.trackBottom - r - 10, r, { vx: -100, vy: 300, bounce: true });
  w.hazards.push(hz);
  w.update(DT, idle());
  const wn = w.warnings.find((x) => x.hz === hz);
  assert.ok(wn);
  assert.ok(wn.y < hz.y && wn.y >= w.trackTop + r, `projected ${wn.y} vs ${hz.y}`);
});

test('a car attacking from behind shows in the mirrors first', () => {
  const events = [];
  const w = racingWorld(events, 40, 960);
  let hz = null;
  for (let i = 0; i < 400 && !hz; i++) { const h = w.spawnHazard('rival'); if (h && h.fromBehind) hz = h; else w.hazards.pop(); }
  assert.ok(hz, 'a car from behind');
  hz.y = w.trackTop + 40;
  w.player.y = w.trackBottom - 40;
  w.update(DT, idle());
  const wn = w.warnings.find((x) => x.hz === hz);
  assert.ok(wn && wn.side === 'left');
  assert.ok(events.some(([e, p]) => e === 'warnShown' && p.side === 'left' && p.type === 'rival'));
  // it was flagged a good while before it reached the screen
  const t0 = w.elapsed;
  while (hz.x + hz.w / 2 < 0 && w.elapsed - t0 < 3) w.update(DT, idle());
  assert.ok(w.elapsed - t0 > WARN.mirrorLead * 0.6, `${(w.elapsed - t0).toFixed(2)} s of mirror warning`);
});

test('every fatal hazard is flagged at least 0.6 s before it reaches the car (960 wide, seeded)', () => {
  for (const seed of [3, 4]) {
    seeded(seed, () => {
      const w = racingWorld([], 0, 960);
      w.spawnTimer = 1;
      w.tyre.wear = -1e9;
      const realCollide = w.collide.bind(w);
      let checked = 0;
      // invulnerable, but note the first moment each tyre / stranded car / rival touches the car
      w.collide = (hz, prect, p) => {
        if (hz.touched || !['tyre', 'stranded', 'rival'].includes(hz.type)) return;
        const parts = w.playerParts;
        const gap = hz.r ? partsGap(parts, (r) => rectCircleGap(r, hz.x, hz.y, hz.r)) : Math.min(...w.hazardParts(hz).map((q) => partsGap(parts, (r) => rectGap(r, q))));
        if (gap > 0) return;
        hz.touched = true;
        checked += 1;
        assert.ok(hz.warnedAt !== undefined, `${hz.type} at ${w.elapsed.toFixed(1)} s was never flagged`);
        assert.ok(w.elapsed - hz.warnedAt >= 0.6, `${hz.type} flagged only ${(w.elapsed - hz.warnedAt).toFixed(2)} s before contact`);
      };
      for (let f = 0; f < 240 * 60; f++) w.update(DT, idle());
      assert.ok(checked > 10, `${checked} contacts checked`);
      void realCollide;
    });
  }
});

test('narrow screens put the car further back', () => {
  assert.equal(playerXFor(1280, 720), 1280 * WORLD.playerX);
  assert.equal(playerXFor(960, 720), 960 * WORLD.playerXNarrow);
  const w = racingWorld();
  w.resize(900, 720);
  assert.equal(w.player.x, 900 * WORLD.playerXNarrow);
});
