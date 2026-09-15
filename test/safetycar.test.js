// The safety-car takeover: the car is neutralised, the weave keeps the tyres warm, a countdown
// hands it back, and the jump pays for a throttle press after (not before) the green.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { carById } from '../src/cars.js';
import { SAFETY_CAR, SC_GAME } from '../src/config.js';
import { baseSpeed, weaveBonus, weaveHeat, weaveZone } from '../src/logic.js';

const DT = 1 / 60;
const idle = () => ({ up: false, down: false, left: false, right: false, boost: false, pointerY: null, pointerBoost: false });

/** A world that is racing, with an empty track, so nothing but the safety car can happen. */
function racingWorld(events = []) {
  const w = new World((e, p) => events.push([e, p]), carById('ferrari'));
  w.resize(1280, 720);
  w.reset();
  w.start.phase = 'go';
  w.start.lit = 5;
  w.start.sinceGo = 20;
  w.start.reaction = 0.2;
  w.hazards = [];
  w.sc.cooldown = 1e9; // no random deployments
  return w;
}
const step = (w, input, seconds) => { for (let t = 0; t < seconds; t += DT) w.update(DT, input); };
/** Deploys the safety car and pins its timer so the period only ends when a test says so. */
const deploy = (w) => { w.deploySafetyCar(); w.sc.timer = 60; };

test('weave maths: heat rises per weave, bleeds with time, zones and bonus follow the window', () => {
  assert.ok(weaveHeat(0.5, 1, 0) < 0.5);
  assert.ok(weaveHeat(0.5, 0, 1) > 0.5);
  assert.equal(weaveHeat(0, 10, 0), 0);
  assert.equal(weaveHeat(1, 0, 5), 1);
  assert.equal(weaveZone(SC_GAME.band.lo - 0.01), 'cold');
  assert.equal(weaveZone((SC_GAME.band.lo + SC_GAME.band.hi) / 2), 'warm');
  assert.equal(weaveZone(SC_GAME.band.hi + 0.01), 'hot');
  assert.equal(weaveBonus(0, 10), 0);
  assert.equal(weaveBonus(10, 10), SC_GAME.bonus);
  assert.equal(weaveBonus(5, 10) % 10, 0);
  assert.equal(weaveBonus(1, 0), 0);
});

test('the car is taken off you once the field has bunched up, and given back at the green', () => {
  const events = [];
  const w = racingWorld(events);
  deploy(w);
  assert.equal(w.sc.neutral, false);
  step(w, idle(), SC_GAME.takeoverAfter + 0.1);
  assert.equal(w.neutralised, true);
  assert.ok(events.some(([e]) => e === 'scNeutral'));
  // your throttle does nothing: speed sits at the neutralised pace whether you push or lift
  const pace = () => baseSpeed(w.elapsed) * SAFETY_CAR.speedCap * SC_GAME.paceFactor;
  step(w, { ...idle(), right: true }, 2);
  assert.ok(Math.abs(w.speed - pace()) < 3, `pushing: speed ${w.speed} vs pace ${pace()}`);
  step(w, { ...idle(), left: true }, 2);
  assert.ok(Math.abs(w.speed - pace()) < 3, `lifting: speed ${w.speed} vs pace ${pace()}`);
  // steering is confined to the weave band around the centre line
  step(w, { ...idle(), up: true }, 3);
  const centre = (w.trackTop + w.trackBottom) / 2;
  assert.ok(w.player.y >= centre - SC_GAME.weaveAmplitude - 1);
  assert.ok(w.player.y < centre, 'weaving up moves the car above the centre line');
  // countdown then green
  w.sc.timer = SC_GAME.countdown + 0.01;
  step(w, idle(), SC_GAME.countdown + 0.1);
  const counts = events.filter(([e]) => e === 'scCount').map(([, p]) => p.n);
  assert.deepEqual(counts, [3, 2, 1]);
  assert.equal(w.sc.active, false);
  assert.equal(w.neutralised, false);
  assert.ok(events.some(([e]) => e === 'scRestart'));
  // control is back: steering reaches beyond the weave band again
  step(w, { ...idle(), up: true }, 3);
  assert.ok(w.player.y < centre - SC_GAME.weaveAmplitude - 5);
});

test('weaving counts full swings, warms the tyres and pays at the restart; sitting still leaves them cold', () => {
  const warmEvents = [];
  const w = racingWorld(warmEvents);
  deploy(w);
  step(w, idle(), SC_GAME.takeoverAfter + 0.1);
  const before = w.sc.weave.heat;
  // a steady weave: edge to edge and back, unhurried
  for (let i = 0; i < 8; i++) {
    step(w, { ...idle(), up: true }, 0.6);
    step(w, { ...idle(), down: true }, 0.6);
  }
  assert.ok(w.sc.weave.weaves >= 12, `weaves ${w.sc.weave.weaves}`);
  assert.ok(w.sc.weave.heat >= before - 0.05, `heat held: ${w.sc.weave.heat} from ${before}`);
  assert.equal(w.sc.weave.zone, 'warm');
  assert.equal(w.tyre.temp, w.sc.weave.heat, 'the gauge is the tyre temperature');
  const bonusBefore = w.bonus;
  w.sc.timer = 0.01;
  step(w, idle(), 0.1);
  const restart = warmEvents.find(([e]) => e === 'scRestart')[1];
  assert.equal(restart.warm, true);
  assert.ok(restart.weaveBonus > 0);
  assert.ok(w.bonus >= bonusBefore + restart.weaveBonus + SAFETY_CAR.restartBonus, `bonus ${w.bonus} from ${bonusBefore}`);

  // hurrying the weave overheats them
  const h = racingWorld();
  deploy(h);
  step(h, idle(), SC_GAME.takeoverAfter + 0.1);
  for (let i = 0; i < 16; i++) {
    step(h, { ...idle(), up: true }, 0.3);
    step(h, { ...idle(), down: true }, 0.3);
  }
  assert.equal(h.sc.weave.zone, 'hot');

  // mashing a key without the car moving is not a weave
  const m = racingWorld();
  deploy(m);
  step(m, idle(), SC_GAME.takeoverAfter + 0.1);
  for (let i = 0; i < 60; i++) m.update(DT, { ...idle(), up: i % 2 === 0, down: i % 2 === 1 });
  assert.equal(m.sc.weave.weaves, 0);

  // no weaving: cold at the green, no weave bonus
  const cold = [];
  const c = racingWorld(cold);
  deploy(c);
  step(c, idle(), SC_GAME.takeoverAfter + 0.1);
  c.sc.weave.heat = SC_GAME.band.lo - 0.05;
  step(c, idle(), 3);
  c.sc.timer = 0.01;
  step(c, idle(), 0.1);
  const r = cold.find(([e]) => e === 'scRestart')[1];
  assert.equal(r.warm, false);
  assert.equal(r.weaveBonus, 0);
  assert.ok(c.tyre.temp < SC_GAME.band.lo);
});

test('overheating blisters the tyres', () => {
  const w = racingWorld();
  deploy(w);
  step(w, idle(), SC_GAME.takeoverAfter + 0.1);
  w.sc.weave.heat = 1;
  const wear = w.tyre.wear;
  w.update(DT, idle());
  assert.ok(w.tyre.wear > wear);
});

test('the neutralised car cannot be hit', () => {
  const w = racingWorld();
  deploy(w);
  step(w, idle(), SC_GAME.takeoverAfter + 0.1);
  // park a tyre right on the car
  w.hazards.push({ id: 9999, type: 'tyre', x: w.player.x, y: w.player.y, w: 40, h: 40, r: 20, rel: 0, vy: 0, frame: 0 });
  step(w, idle(), 0.5);
  assert.equal(w.gameOver, false);
});

test('the jump: throttle after the green pays, throttle held through the green does not until you lift', () => {
  const late = [];
  const w = racingWorld(late);
  deploy(w);
  step(w, idle(), SC_GAME.takeoverAfter + 0.1);
  w.sc.timer = 0.01;
  step(w, idle(), 0.05); // green, throttle off
  assert.ok(w.sc.jump > 0);
  const bonus = w.bonus;
  w.update(DT, { ...idle(), right: true });
  assert.equal(w.bonus, bonus + SC_GAME.jumpBonus);
  assert.ok(late.some(([e]) => e === 'scJump'));

  const early = [];
  const e = racingWorld(early);
  deploy(e);
  step(e, idle(), SC_GAME.takeoverAfter + 0.1);
  e.sc.timer = 0.01;
  const held = { ...idle(), right: true };
  step(e, held, 0.2); // on the throttle through the green
  assert.ok(!early.some(([ev]) => ev === 'scJump'), 'going early is not a jump');
  step(e, held, SC_GAME.jumpWindow); // window expires while still held
  e.update(DT, idle());
  e.update(DT, held);
  assert.ok(!early.some(([ev]) => ev === 'scJump'), 'too late once the window has closed');
});

test('calling for the box hands the car back to the pit-entry glide', () => {
  const w = racingWorld();
  deploy(w);
  step(w, idle(), SC_GAME.takeoverAfter + 0.1);
  assert.equal(w.neutralised, true);
  w.pit.requested = true;
  assert.equal(w.neutralised, false);
});
