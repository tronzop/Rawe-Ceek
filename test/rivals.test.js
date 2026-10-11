// Rival speeds are absolute: traffic runs at a share of the base speed, cars from behind actually
// come past, bunched safety-car traffic holds the car's pace, and spawning follows track covered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { carById } from '../src/cars.js';
import { DAMAGE, HITBOX, RIVAL_AI, SAFETY_CAR, WARN } from '../src/config.js';
import { baseSpeed } from '../src/logic.js';

const DT = 1 / 60;
const idle = () => ({ up: false, down: false, left: false, right: false, boost: false, pointerY: null, pointerBoost: false });

/** Same harness as safetycar.test.js: racing, launch over, empty track, no random safety car or rain. */
function racingWorld(events = [], elapsed = 20) {
  const w = new World((e, p) => events.push([e, p]), carById('ferrari'));
  w.resize(1280, 720);
  w.reset();
  w.start.phase = 'go';
  w.start.lit = 5;
  w.start.sinceGo = 20;
  w.start.launch = 0;
  w.start.reaction = 0.2;
  w.hazards = [];
  w.sc.cooldown = 1e9;
  w.dryTimer = 1e9;
  w.spawnTimer = 1e9; // nothing spawns unless a test asks for it
  w.drsTimer = 1e9;
  w.elapsed = elapsed;
  w.speed = baseSpeed(elapsed);
  return w;
}
const step = (w, input, seconds) => { for (let t = 0; t < seconds; t += DT) w.update(DT, input); };

/** Deterministic Math.random for the duration of `fn`. */
function seeded(seed, fn) {
  const real = Math.random;
  let a = seed >>> 0;
  Math.random = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  try { return fn(); } finally { Math.random = real; }
}

/** Spawns rivals until one matches `want`, discarding the rest. */
function spawnRival(w, want) {
  for (let i = 0; i < 500; i++) {
    w.spawnHazard('rival');
    const hz = w.hazards.pop();
    if (want(hz)) { w.hazards.push(hz); return hz; }
  }
  throw new Error('no matching rival spawned');
}

test('traffic at t=20 comes back to you, slower than you but never backwards', () => {
  const w = racingWorld();
  for (let i = 0; i < 60; i++) {
    const hz = spawnRival(w, (h) => !h.fromBehind);
    const screenV = hz.rel - w.speed;
    assert.ok(screenV < 0, `rival screen velocity ${screenV} should be negative`);
    assert.ok(Math.abs(screenV) < w.speed, `|${screenV}| should be below the player speed ${w.speed}`);
    assert.ok(hz.rel > 0, 'absolute speed is forwards');
    assert.ok(hz.pace >= RIVAL_AI.paceRange[0] && hz.pace <= RIVAL_AI.paceRange[1]);
  }
  // and the gap holds as the race speeds up: the pace is a share of the base speed
  const late = racingWorld([], 200);
  const hz = spawnRival(late, (h) => !h.fromBehind);
  hz.y = late.trackTop + 30;
  late.player.y = late.trackBottom - 30;
  step(late, idle(), 3);
  assert.ok(Math.abs(hz.rel - baseSpeed(late.elapsed) * hz.pace) < 3, `rel ${hz.rel} tracks ${baseSpeed(late.elapsed) * hz.pace}`);
});

test('a gentle nose-to-tail touch costs the front wing, not the race', () => {
  const events = [];
  const w = racingWorld(events);
  const prect = w.playerRect;
  const rival = spawnRival(w, (h) => !h.fromBehind);
  rival.y = w.player.y;
  rival.x = prect.x + prect.w - HITBOX.rival.body.x0 * rival.w - 1; // its gearbox just touching your nose
  rival.rel = w.speed - 100;
  rival.pace = rival.rel / baseSpeed(w.elapsed);
  rival.defend = false;
  rival.weave = false;
  assert.ok(w.speed - rival.rel < DAMAGE.maxClosing);
  w.update(DT, idle());
  assert.equal(w.gameOver, false);
  assert.ok(w.player.parts.wing > 0, 'the wing took it');
  assert.ok(events.some(([e, p]) => e === 'contact' && p.part === 'wing'));
  // ...and staying on its gearbox while the touch plays out is one hit, not a second, deeper crash
  step(w, idle(), 1.5);
  assert.equal(w.gameOver, false);
});

test('a car from behind actually comes past, then settles into traffic you can take back', () => {
  const events = [];
  const w = racingWorld(events, 40);
  const hz = spawnRival(w, (h) => h.fromBehind);
  assert.ok(hz.x < 0);
  hz.y = w.trackTop + 40; // out of your lane
  w.player.y = w.trackBottom - 40;
  let t = 0;
  // (it starts far enough back for its mirror warning to show for WARN.mirrorLead first)
  while (hz.x <= 0 && t < 1.5 + WARN.mirrorLead) { w.update(DT, idle()); t += DT; }
  assert.ok(hz.x > 0, `on screen within ${1.5 + WARN.mirrorLead} s (x=${hz.x.toFixed(0)} after ${t.toFixed(2)} s)`);
  step(w, idle(), 3);
  assert.equal(hz.fromBehind, false, 'clear of your nose');
  assert.ok(events.some(([e]) => e === 'passedBy'));
  step(w, idle(), 4);
  assert.ok(hz.rel < w.speed, 'back down to traffic pace');
});

test('bunched safety-car traffic holds the safety car pace', () => {
  const w = racingWorld();
  for (let i = 0; i < 5; i++) {
    const hz = spawnRival(w, (h) => !h.fromBehind);
    hz.x = w.player.x + 400 + i * 160;
    hz.y = w.trackTop + 40 + i * 70;
  }
  w.deploySafetyCar();
  w.sc.timer = 60;
  step(w, idle(), 2);
  const base = baseSpeed(w.elapsed);
  const rivals = w.hazards.filter((h) => h.type === 'rival');
  assert.ok(rivals.length > 0);
  for (const hz of rivals) {
    assert.ok(Math.abs(hz.rel - base * SAFETY_CAR.speedCap) <= 0.05 * base, `rel ${hz.rel} vs cap ${base * SAFETY_CAR.speedCap}`);
  }
  // after the green they are ordinary slow traffic, still moving forwards
  w.sc.timer = 0.01;
  step(w, idle(), 0.5);
  for (const hz of w.hazards.filter((h) => h.type === 'rival')) assert.ok(hz.rel >= 60 && hz.rel < w.speed + 1);
});

test('slow grid starters settle at a share of the pack speed and fade back to you', () => {
  const w = new World(() => {}, carById('ferrari'));
  w.resize(1280, 720);
  w.sc.cooldown = 1e9;
  w.dryTimer = 1e9;
  for (let i = 0; i < 1200 && w.start.phase !== 'go'; i++) w.update(DT, idle());
  assert.equal(w.start.phase, 'go');
  for (let i = 0; i < 60 * 9.5; i++) { w.update(DT, idle()); w.hazards.forEach((h) => { if (h.type !== 'rival') h.dead = true; }); }
  for (const hz of w.hazards.filter((h) => h.grid && !h.fast)) {
    assert.ok(hz.rel > 0 && hz.rel < w.packV, `slow starter at ${hz.rel} vs pack ${w.packV}`);
  }
});

test('spawning follows track covered: limping home on a puncture is not a bullet hell', () => {
  const onScreen = (punctured, seed) => seeded(seed, () => {
    const w = racingWorld([], 150);
    w.collide = () => {}; // count hazards, do not hit them
    w.spawnTimer = 0.2;
    if (punctured) { w.tyre.punctured = true; w.tyre.wear = 100; }
    let sum = 0, n = 0;
    for (let t = 0; t < 10; t += DT) {
      w.update(DT, idle());
      sum += w.hazards.filter((h) => h.type !== 'drs' && h.x > -50 && h.x < w.width + 50).length;
      n += 1;
    }
    return sum / n;
  });
  let healthy = 0, limping = 0;
  for (let s = 1; s <= 12; s++) { healthy += onScreen(false, s); limping += onScreen(true, s); }
  assert.ok(healthy > 0);
  assert.ok(limping <= healthy * 1.5, `limping ${(limping / 12).toFixed(2)} vs healthy ${(healthy / 12).toFixed(2)} on screen`);
  // and the limp cap is relative to the race, not the t=0 speed
  const w = racingWorld([], 150);
  w.tyre.punctured = true;
  step(w, idle(), 2);
  assert.ok(Math.abs(w.speed - baseSpeed(w.elapsed) * 0.55) < 5, `limping at ${w.speed}`);
});
