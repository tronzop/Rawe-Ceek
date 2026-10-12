// Simulation fixes: the safety-car penalty window, pitting under the safety car, rain on slicks,
// debris on a missing wing, the oil ellipse, the latched box call, the weather plan, the crash
// frame and resizing mid-race.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { carById, CARS } from '../src/cars.js';
import { PIT, PLAYER, SAFETY_CAR, SC_GAME, WEATHER } from '../src/config.js';
import { baseSpeed, pitWindowOpen } from '../src/logic.js';

const DT = 1 / 60;
const idle = () => ({ up: false, down: false, left: false, right: false, boost: false, pointerY: null, pointerBoost: false });

function racingWorld(events = [], elapsed = 20, car = 'ferrari') {
  const w = new World((e, p) => events.push([e, p]), carById(car));
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
function seeded(seed, fn) {
  const real = Math.random;
  let a = seed >>> 0;
  Math.random = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  try { return fn(); } finally { Math.random = real; }
}
/** A plain rival hazard (no weave, no defending) at an absolute speed. */
const rival = (w, x, y, rel, extra = {}) => ({
  id: 90000 + Math.floor(Math.random() * 1e6), type: 'rival', x, y, w: PLAYER.width * 0.92, h: PLAYER.height * 0.92, rel, pace: 0, vy: 0, scPace: 0,
  team: { name: 'Test' }, driver: null, teammate: false, fromBehind: false, weave: false, weavePhase: 0, passed: false, frame: 0, defend: false, brake: 0, ...extra,
});

test('safety car: the car is only taken off you after takeoverAfter', () => {
  const w = racingWorld();
  w.deploySafetyCar();
  w.sc.timer = 60;
  step(w, idle(), SC_GAME.takeoverAfter - 0.1);
  assert.equal(w.sc.neutral, false, 'still yours just before the takeover');
  step(w, idle(), 0.2);
  assert.equal(w.sc.neutral, true, 'neutralised just after it');
});

test('safety car: passing a bunched car between the grace and the takeover is a penalty', () => {
  for (const at of [SAFETY_CAR.graceSeconds + 0.1, (SAFETY_CAR.graceSeconds + SC_GAME.takeoverAfter) / 2, SC_GAME.takeoverAfter - 0.2]) {
    const events = [];
    const w = racingWorld(events);
    w.deploySafetyCar();
    w.sc.timer = 60;
    step(w, idle(), at);
    assert.equal(w.sc.neutral, false);
    // a bunched car alongside in the next lane, its tail just ahead of yours, slower than you
    const prect = w.playerRect;
    const y = w.player.y > (w.trackTop + w.trackBottom) / 2 ? w.player.y - 90 : w.player.y + 90;
    const hz = rival(w, prect.x - PLAYER.width * 0.46 + 3, y, 0, { scPace: SAFETY_CAR.bunchSpread[0] * 0.9 });
    w.hazards.push(hz);
    let n = 0;
    while (!events.some(([e]) => e === 'penalty') && n++ < 30) w.update(DT, idle());
    assert.ok(events.some(([e]) => e === 'penalty'), `penalised at ${at.toFixed(2)} s`);
    assert.equal(w.penalty, SAFETY_CAR.penaltySeconds);
    assert.equal(w.sc.clean, false);
  }
});

test('safety car: boxing never earns a penalty (100 seeded runs)', () => {
  let penalties = 0, stops = 0;
  for (let s = 1; s <= 100; s++) {
    seeded(s * 31, () => {
      const w = racingWorld([], PIT.firstWindowAt + 0.5);
      assert.ok(pitWindowOpen(w.elapsed));
      w.spawnTimer = 0.1;
      w.deploySafetyCar();
      w.sc.timer = 18;
      // drive it properly until the call: lift so the bunched field stays ahead of you
      const callAt = Math.random() * (PIT.openFor - 1);
      step(w, { ...idle(), left: true }, callAt);
      if (w.gameOver) return;
      assert.equal(w.requestPit(), true);
      for (let t = 0; t < 22 && !w.gameOver; t += DT) {
        if (w.pit.phase === 'stop' && w.pit.game && w.pit.game.hold <= 0 && w.pit.game.t > 0.3) w.pitAction();
        w.update(DT, idle());
      }
      penalties += w.run.penalties;
      stops += w.pit.stops;
    });
  }
  assert.ok(stops >= 90, `${stops} stops completed`);
  assert.equal(penalties, 0);
});

test('safety car: boxing resets the weave, so you rejoin on cold tyres', () => {
  const w = racingWorld([], PIT.firstWindowAt + 0.5);
  w.deploySafetyCar();
  w.sc.timer = 60;
  step(w, idle(), SC_GAME.takeoverAfter + 0.1);
  assert.equal(w.neutralised, true);
  w.sc.weave.heat = 0.75;
  assert.equal(w.requestPit(), true);
  let wasIn = false;
  for (let t = 0; t < 20; t += DT) {
    w.update(DT, idle());
    if (w.pit.inLane) wasIn = true;
    else if (wasIn) break;
  }
  assert.ok(wasIn && !w.pit.inLane && w.pit.stops === 1, 'went through the lane and rejoined');
  assert.equal(w.sc.active, true, 'still under the safety car');
  assert.ok(w.tyre.temp < 0.4, `first frame after the merge: temp ${w.tyre.temp}`);
  w.update(DT, idle());
  assert.ok(w.tyre.temp < 0.4, `second frame: temp ${w.tyre.temp}`);
});

test('rain cools slicks: full rain on mediums while lifting', () => {
  const w = racingWorld();
  w.tyre.temp = 0.9;
  w.rain = 1;
  w.raining = true;
  w.rainTimer = 60;
  step(w, { ...idle(), left: true }, 5);
  assert.ok(w.tyre.temp < 0.9, `temp ${w.tyre.temp}`);
  // inters in the same rain hold their temperature
  const i = racingWorld();
  i.tyre = { compound: 'inter', wear: 0, punctured: false, temp: 0.9 };
  i.nextCompound = 'inter';
  i.rain = 1;
  i.raining = true;
  i.rainTimer = 60;
  step(i, { ...idle(), left: true }, 5);
  assert.ok(i.tyre.temp >= 0.9, `inter temp ${i.tyre.temp}`);
});

test('debris with the wing already gone is a crash', () => {
  const events = [];
  const w = racingWorld(events);
  w.player.parts.wing = 100;
  w.hazards.push({ id: 1, type: 'debris', x: w.player.x + 40, y: w.player.y, r: 9, vx: 0, vy: 0, spin: 0, bounce: false });
  w.update(DT, idle());
  assert.equal(w.gameOver, true);
  assert.equal(events.find(([e]) => e === 'crash')[1].with, 'debris');
  // with a wing to hit it only costs bodywork
  const ok = racingWorld();
  ok.hazards.push({ id: 2, type: 'debris', x: ok.player.x + 40, y: ok.player.y, r: 9, vx: 0, vy: 0, spin: 0, bounce: false });
  ok.update(DT, idle());
  assert.equal(ok.gameOver, false);
  assert.ok(ok.player.parts.wing > 0);
});

test('oil: clipping the corner of its bounding box is not a spin, the middle of it is', () => {
  const w = racingWorld();
  w.speed = 0; // hold everything still for the geometry
  const prect = w.playerRect;
  const ow = 160, oh = 40;
  // bounding box corner just overlapping the car's front-top corner, but outside the ellipse
  const corner = { id: 3, type: 'oil', x: prect.x + prect.w + ow / 2 - 4, y: prect.y - oh / 2 + 4, w: ow, h: oh, rel: 0, vy: 0 };
  w.collide(corner, prect, w.player, DT);
  assert.equal(corner.hit, undefined);
  assert.equal(w.player.spin, 0);
  const centre = { id: 4, type: 'oil', x: w.player.x, y: w.player.y, w: ow, h: oh, rel: 0, vy: 0 };
  w.collide(centre, prect, w.player, DT);
  assert.equal(centre.hit, true);
  assert.ok(w.player.spin > 0);
});

test('a confirmed box call is latched: called from the bottom lane with 0.3 s of window left, you still get in', () => {
  for (const car of CARS) {
    const events = [];
    const w = racingWorld(events, PIT.firstWindowAt + PIT.openFor - 0.3, car.id);
    w.player.y = w.trackBottom - PLAYER.height / 2 + 12;
    w.update(DT, idle());
    assert.equal(w.requestPit(), true);
    let got = false;
    for (let t = 0; t < 3 && !got; t += DT) { w.update(DT, idle()); got = w.pit.inLane; }
    assert.ok(got, `${car.id} made it into the lane`);
    assert.ok(!events.some(([e]) => e === 'pitDenied'));
  }
});

test('the planned tyre follows the weather, on the crossing only', () => {
  const events = [];
  const w = racingWorld(events);
  assert.equal(w.nextCompound, 'medium');
  w.raining = true;
  w.rainPeak = WEATHER.damp; // a light shower: inters (a heavy one goes to wets, see gameplay.test.js)
  w.rainTimer = 60;
  step(w, idle(), WEATHER.transition * 0.35 + 0.5);
  assert.notEqual(w.nextCompound, 'medium');
  assert.equal(w.nextCompound, 'inter');
  assert.ok(events.some(([e, p]) => e === 'compound' && p.compound === 'inter'));
  // the player can overrule it once the track is wet
  w.setNextCompound('soft');
  step(w, idle(), 1);
  assert.equal(w.nextCompound, 'soft');
  // drying out from under a rain tyre goes back to slicks
  w.setNextCompound('wet');
  w.raining = false;
  w.dryTimer = 1e9;
  step(w, idle(), WEATHER.transition * 0.6);
  assert.equal(w.nextCompound, 'medium');
});

test('nothing happens after the crash in the same frame: the score stands as reported', () => {
  const events = [];
  const w = racingWorld(events);
  w.distance = 1234.5;
  w.bonus = 300;
  step(w, idle(), 0.5);
  // a tyre right on the car, a rival just about to be passed, and a close call further along
  w.hazards.push({ id: 5, type: 'tyre', x: w.player.x, y: w.player.y, r: 20, vx: 0, vy: 0, spin: 0, bounce: false, compound: { id: 'medium' } });
  w.hazards.push(rival(w, w.playerRect.x - PLAYER.width * 0.46 + 2, w.trackBottom - 30, w.speed * 0.5));
  w.update(DT, idle());
  assert.equal(w.gameOver, true);
  const crash = events.find(([e]) => e === 'crash')[1];
  assert.equal(w.score, crash.score);
  assert.equal(w.run.score, crash.score);
  assert.ok(!events.some(([e]) => e === 'overtake'), 'no overtake after the crash');
});

test('resize leaves the pit lane and the tumble alone', () => {
  const w = racingWorld([], PIT.firstWindowAt + 0.5);
  w.update(DT, idle());
  assert.equal(w.requestPit(), true);
  for (let t = 0; t < 3 && w.pit.phase !== 'stop'; t += DT) w.update(DT, idle());
  assert.ok(w.pit.inLane);
  const y = w.player.y;
  assert.ok(y < w.trackTop);
  w.resize(1000, 720);
  assert.equal(w.player.y, y, 'still in the lane');

  const c = racingWorld();
  c.hazards.push({ id: 6, type: 'tyre', x: c.player.x, y: c.player.y, r: 20, vx: 0, vy: 0, spin: 0, bounce: false, compound: { id: 'medium' } });
  c.update(DT, idle());
  assert.equal(c.gameOver, true);
  step(c, idle(), 1);
  const { x, y: cy } = c.player;
  c.resize(900, 720);
  assert.equal(c.player.x, x);
  assert.equal(c.player.y, cy);
});
