// Gameplay that is a decision: defenders that telegraph (B5), flow (B6), track position and
// points (B7), pit-window clarity (B8) and weather you can plan for (B9).
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { carById } from '../src/cars.js';
import { applyRun, evaluateTrophies, EMPTY_CAREER, EMPTY_RUN } from '../src/career.js';
import { COMPOUNDS, FLOW, GP, PIT, PLAYER, RIVAL_AI, SCORING, START, TYRES, WEATHER } from '../src/config.js';
import {
  baseSpeed, bestCompound, flowPay, flowStep, flowTier, forecastHorizon, gripFactor, pitLossMetres, pitOpenLeft, placesLost, pointsFor,
  suitability, wearDelta, wearForecast,
} from '../src/logic.js';

const DT = 1 / 60;
const idle = () => ({ up: false, down: false, left: false, right: false, boost: false, pointerY: null, pointerBoost: false });

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
  w.spawnTimer = 1e9;
  w.drsTimer = 1e9;
  w.elapsed = elapsed;
  w.speed = baseSpeed(elapsed);
  return w;
}
const step = (w, input, seconds) => { for (let t = 0; t < seconds; t += DT) w.update(DT, input); };
const rival = (x, y, rel, extra = {}) => ({
  id: 90000 + Math.floor(Math.random() * 1e6), type: 'rival', x, y, w: PLAYER.width * 0.92, h: PLAYER.height * 0.92, rel, pace: 0, vy: 0, scPace: 0,
  team: { name: 'Test' }, driver: null, teammate: false, fromBehind: false, weave: false, weavePhase: 0, passed: false, frame: 0, defend: false, brake: 0, ...extra,
});
/** A loose tyre `gap` px above the car's cockpit (r = 10, not moving). */
const tyreAbove = (w, gap) => {
  const p = w.player;
  const top = w.playerParts[1].y; // the cockpit block's top edge
  return { id: Math.random(), type: 'tyre', x: p.x - 20, y: top - 10 - gap, r: 10, vx: 0, vy: 0, spin: 0, compound: COMPOUNDS.medium, bounce: false };
};

// ---------- B5: defenders ----------
test('a defender commits to a lane, shows it, then holds it while the player moves', () => {
  const w = racingWorld();
  const p = w.player;
  p.y = w.trackBottom - 60;
  const hz = rival(p.x + RIVAL_AI.commitRange - 40, w.trackTop + 40, w.speed, { defend: true });
  w.hazards = [hz];
  w.update(DT, idle());
  assert.ok(hz.commitY !== undefined, 'committed inside commitRange');
  const target = hz.commitY;
  assert.ok(Math.abs(target - p.y) < 1, 'it picked your lane at that moment');
  assert.ok(hz.tell > 0, 'and telegraphs it first');
  const y0 = hz.y;
  step(w, idle(), RIVAL_AI.commitTell * 0.8);
  assert.equal(hz.y, y0, 'no movement during the tell');
  // now you dodge to the top: the defender keeps going for the lane it called
  for (let t = 0; t < 9; t += DT) {
    hz.rel = w.speed; // hold the gap
    w.update(DT, { ...idle(), up: true });
  }
  assert.ok(p.y < w.trackTop + 60, 'the player moved away');
  assert.equal(hz.commitY, target, 'target lane never changes');
  assert.ok(Math.abs(hz.y - target) < 2, 'it slid there and holds');
});

// ---------- B6: flow ----------
test('flow maths: steps of 0.25 to ×3, whole-point pay, tiers per half', () => {
  assert.equal(flowStep(1), 1.25);
  assert.equal(flowStep(2.9), FLOW.max);
  assert.deepEqual([1.25, 1.5, 1.75].map((m) => flowPay(25, m)), [31, 38, 44]);
  assert.deepEqual([1, 1.25, 1.5, 1.75, 2, 2.5, 3].map(flowTier), [0, 0, 1, 1, 2, 3, 4]);
});

test('three close calls inside 3 s pay 25 × (1.25, 1.5, 1.75), and the chain then runs out', () => {
  const events = [];
  const w = racingWorld(events);
  const paid = [];
  for (let i = 0; i < 3; i++) {
    const before = w.run.scoreBy.close;
    w.collide(tyreAbove(w, 10), w.playerRect, w.player);
    paid.push(w.run.scoreBy.close - before);
    step(w, idle(), 1);
  }
  assert.deepEqual(paid, [25 * 1.25, 25 * 1.5, 25 * 1.75].map(Math.round));
  assert.equal(w.flow.mult, 1.75);
  assert.ok(events.some(([e, p]) => e === 'flowTier' && p.tier === 1 && p.up));
  step(w, idle(), FLOW.window + 0.1);
  assert.equal(w.flow.mult, 1, 'window ran out');
  assert.ok(events.some(([e, p]) => e === 'flowTier' && p.tier === 0 && p.reason === 'timeout'));
});

test('contact breaks the chain; a scrape pays double with slow motion', () => {
  const events = [];
  const w = racingWorld(events);
  w.collide(tyreAbove(w, 10), w.playerRect, w.player);
  w.collide(tyreAbove(w, 10), w.playerRect, w.player);
  assert.equal(w.flow.mult, 1.5);
  w.contact(rival(w.player.x + 140, w.player.y, 0), 'wing', { ahead: true, oy: 30, sideRub: false });
  assert.equal(w.flow.mult, 1);
  assert.ok(events.some(([e, p]) => e === 'flowTier' && p.reason === 'contact'));
  // scrape: the close call first, then the same tyre nearer than paint
  const t = tyreAbove(w, 10);
  const before = w.run.scoreBy.close;
  w.collide(t, w.playerRect, w.player);
  t.y += 7; // gap 3
  w.collide(t, w.playerRect, w.player);
  assert.equal(w.run.scoreBy.close - before, 2 * flowPay(SCORING.closeCall, 1.25));
  assert.ok(w.slowmo > 0 && w.scrapeFlash === 1);
  assert.ok(events.some(([e]) => e === 'scrape'));
  assert.equal(w.popups.at(-1).text, 'SCRAPE');
});

test('DRS reports the real battery gain and builds flow; Flow ×3 unlocks its trophy', () => {
  const events = [];
  const w = racingWorld(events);
  w.ers.charge = 90;
  const gate = { id: 1, type: 'drs', x: w.player.x, y: w.player.y, w: 26, h: 64, rel: 0, vy: 0, taken: false };
  w.collide(gate, w.playerRect, w.player);
  const drs = events.find(([e]) => e === 'drs');
  assert.equal(drs[1].gain, 10);
  assert.equal(w.flow.mult, 1.25);
  for (let i = 0; i < 10; i++) w.bumpFlow();
  assert.equal(w.run.flowMax, FLOW.max);
  assert.ok(evaluateTrophies(EMPTY_CAREER(), w.run).includes('flow3'));
  assert.ok(!evaluateTrophies(EMPTY_CAREER(), EMPTY_RUN()).includes('flow3'));
});

test('popups carry a label and a value, and stack instead of overprinting', () => {
  const w = racingWorld();
  w.addPopup(100, 300, 'CLOSE', '#fff', 31);
  w.addPopup(110, 302, 'PASS', '#fff', 60);
  assert.equal(w.popups[0].value, 31);
  assert.equal(w.popups[1].y, 302 - 22);
});

// ---------- B7: track position ----------
test('place maths and the points table', () => {
  assert.deepEqual([1, 2, 3, 10, 11, 20].map(pointsFor), [25, 18, 15, 1, 0, 0]);
  assert.equal(pointsFor(0), 25, 'clamped to P1');
  assert.equal(placesLost(0), 0);
  assert.equal(placesLost(GP.placeGapMetres * 2.4), 2);
  assert.equal(placesLost(GP.placeGapMetres * 2.6), 3);
  const normal = pitLossMetres(baseSpeed(60), 2.5);
  const sc = pitLossMetres(baseSpeed(60) * 0.6, 2.5);
  assert.ok(normal > 150 && normal < 320, `a stop costs ${normal} m`);
  assert.ok(sc < normal * 0.65, 'a stop under the safety car is cheap');
});

test('position: a pass gains a place, a fromBehind car clearing your nose costs one', () => {
  const events = [];
  const w = racingWorld(events);
  assert.equal(w.position, START.gridCars + 1);
  const p = w.player;
  // a car attacking from behind, about to clear your nose
  const hz = rival(p.x + PLAYER.width / 2 + 5, p.y - 80, w.speed + 300, { fromBehind: true });
  hz.x = p.x + PLAYER.width / 2 + hz.w / 2 - 2;
  w.hazards = [hz];
  step(w, idle(), 0.1);
  assert.equal(w.position, START.gridCars + 2);
  const ev = events.find(([e]) => e === 'passedBy');
  assert.ok(ev && ev[1].hz === hz && ev[1].side === 'left');
  // and you pass a slow one
  w.hazards = [rival(p.x - 10, p.y + 120, 100)];
  step(w, idle(), 1);
  assert.equal(w.overtakes, 1);
  assert.equal(w.position, START.gridCars + 1);
});

test('the chequered flag pays F1 points by position into the run, then resets to the grid slot', () => {
  const events = [];
  const w = racingWorld(events);
  w.position = 3;
  w.distance = GP.lengthMetres + 1;
  w.update(DT, idle());
  const ev = events.find(([e]) => e === 'chequered');
  assert.equal(ev[1].position, 3);
  assert.equal(ev[1].points, 15);
  assert.equal(w.run.points, 15);
  assert.equal(w.position, START.gridCars + 1);
  assert.equal(applyRun(EMPTY_CAREER(), w.run).points, 15);
});

/** Boxes now and plays the wheel gun perfectly; returns the pitOut payload. */
function doStop(w, events) {
  w.player.y = w.trackTop + PLAYER.height / 2 - 12;
  assert.equal(w.requestPit(), true);
  for (let t = 0; t < 20 && !events.some(([e]) => e === 'pitOut'); t += DT) {
    const g = w.pit.game;
    if (g && g.hold <= 0 && g.t > 0.3) w.pitAction();
    w.update(DT, idle());
  }
  return events.find(([e]) => e === 'pitOut')?.[1];
}

test('a pit stop costs places; under the safety car it costs fewer', () => {
  const run = (sc) => {
    const events = [];
    const w = racingWorld(events, 60);
    w.position = 8;
    if (sc) { w.deploySafetyCar(); w.sc.timer = 60; w.hazards = []; }
    else w.elapsed = PIT.firstWindowAt + PIT.interval; // a window is open
    w.update(DT, idle());
    assert.equal(w.pit.reason, sc ? 'sc' : 'window');
    const out = doStop(w, events);
    assert.ok(out, 'stop finished');
    assert.equal(out.position, 8 + out.places);
    assert.equal(w.position, 8 + out.places);
    return out;
  };
  const normal = run(false);
  const cheap = run(true);
  assert.ok(normal.places >= 2, `normal stop: ${normal.places} places, ${Math.round(normal.lossMetres)} m`);
  assert.ok(cheap.lossMetres < normal.lossMetres * 0.75, `SC stop ${Math.round(cheap.lossMetres)} m vs ${Math.round(normal.lossMetres)} m`);
  assert.ok(cheap.places < normal.places);
});

// ---------- B8: pit-window clarity ----------
test('pitOpenLeft counts the open window down and is 0 when it is shut', () => {
  assert.equal(pitOpenLeft(0), 0);
  assert.equal(pitOpenLeft(PIT.firstWindowAt), PIT.openFor);
  assert.ok(Math.abs(pitOpenLeft(PIT.firstWindowAt + 3) - (PIT.openFor - 3)) < 1e-9);
  assert.equal(pitOpenLeft(PIT.firstWindowAt + PIT.openFor + 1), 0);
  assert.ok(Math.abs(pitOpenLeft(PIT.firstWindowAt + PIT.interval + 1) - (PIT.openFor - 1)) < 1e-9);
});

test('wear forecast: horizon to the next usable window, and the verdicts', () => {
  // open: skip it and you have to last to the end of the next one
  assert.ok(Math.abs(forecastHorizon(PIT.firstWindowAt + 2) - (PIT.openFor - 2 + PIT.interval)) < 1e-9);
  // shut: to the end of the coming one
  assert.ok(Math.abs(forecastHorizon(PIT.firstWindowAt - 5) - (5 + PIT.openFor)) < 1e-9);
  assert.equal(wearForecast(10, 1, 20).verdict, 'makesIt');
  assert.equal(wearForecast(40, 1, 40).verdict, 'marginal');
  assert.equal(wearForecast(60, 2, 30).verdict, 'wontLast');
  assert.equal(wearForecast(60, 2, 30).wear, 100);
});

test('the world learns the wear rate and forecasts with it', () => {
  const w = racingWorld([], 30);
  step(w, idle(), 3);
  const expected = wearDelta('medium', w.speed, 1, w.car.tyreWear, baseSpeed(w.elapsed));
  assert.ok(Math.abs(w.tyre.rate - expected) / expected < 0.2, `rate ${w.tyre.rate} vs ${expected}`);
  assert.ok(w.wearForecast && ['makesIt', 'marginal', 'wontLast'].includes(w.wearForecast.verdict));
});

test('a puncture outside the window opens the lane, cooldown or not', () => {
  const events = [];
  const w = racingWorld(events, PIT.firstWindowAt + PIT.openFor + 2);
  w.pit.cooldown = 5;
  w.update(DT, idle());
  assert.equal(w.pit.open, false);
  w.tyre.punctured = true;
  w.update(DT, idle());
  assert.equal(w.pit.open, true);
  assert.equal(w.pit.reason, 'puncture');
  w.player.y = w.trackTop + PLAYER.height / 2 - 12;
  w.update(DT, { ...idle(), up: true });
  assert.ok(w.pit.inLane, 'into the lane on a puncture');
  // a part at 100 does the same
  const w2 = racingWorld([], PIT.firstWindowAt + PIT.openFor + 2);
  w2.player.parts.wing = 100;
  w2.update(DT, idle());
  assert.equal(w2.pit.reason, 'damage');
});

test('the last two seconds of a window tick twice a second', () => {
  const events = [];
  const w = racingWorld(events, PIT.firstWindowAt + PIT.openFor - 3);
  step(w, idle(), 3.2);
  const ticks = events.filter(([e]) => e === 'pitWindowTick').map(([, p]) => p.left);
  assert.deepEqual(ticks, [2, 1.5, 1, 0.5]);
});

// ---------- B9: weather ----------
test('bestCompound and grip agree: medium dry, inter at 0.5, wet at 0.9', () => {
  assert.equal(bestCompound(0), 'medium');
  assert.equal(bestCompound(0.5), 'inter');
  assert.equal(bestCompound(0.9), 'wet');
  const g = (id, r) => gripFactor(id, 0, r);
  assert.ok(g('medium', 0) > g('inter', 0) && g('inter', 0) > g('wet', 0));
  assert.ok(g('inter', 0.5) > g('medium', 0.5) && g('inter', 0.5) > g('wet', 0.5) && g('inter', 0.5) > g('soft', 0.5));
  assert.ok(g('wet', 0.9) > g('inter', 0.9) && g('inter', 0.9) > g('medium', 0.9));
  assert.equal(suitability('medium', 0.2), 1);
  assert.equal(suitability('inter', 0.5), 1);
  assert.equal(suitability('wet', 1), 1);
});

test('rain tyres on a dry track wear at their dryWear rate', () => {
  const dry = wearDelta('inter', 400, 1, 1, 400, 0);
  const wet = wearDelta('inter', 400, 1, 1, 400, 0.5);
  assert.ok(Math.abs(dry / wet - COMPOUNDS.inter.dryWear) < 1e-9);
  assert.ok(Math.abs(wearDelta('wet', 400, 1, 1, 400, 0.1) / wearDelta('wet', 400, 1, 1, 400, 0.9) - COMPOUNDS.wet.dryWear) < 1e-9);
  assert.equal(wearDelta('medium', 400, 1, 1, 400, 0), wearDelta('medium', 400, 1, 1, 400, 0.9));
});

test('rain is forecast before it falls, and the end of it is called too', () => {
  const events = [];
  const w = racingWorld(events);
  w.dryTimer = 0;
  const real = Math.random;
  Math.random = () => 0; // the roll succeeds, a light shower, the shortest forecast
  try { w.update(DT, idle()); } finally { Math.random = real; }
  const fc = events.find(([e]) => e === 'forecast');
  assert.ok(fc && fc[1].kind === 'rain');
  assert.equal(fc[1].in >= WEATHER.forecast.min, true);
  assert.equal(w.raining, false, 'not yet');
  assert.equal(w.expectedRain, WEATHER.damp);
  step(w, idle(), fc[1].in + 0.1);
  assert.equal(w.raining, true);
  const start = events.find(([e]) => e === 'rainStart');
  assert.equal(start[1].best, 'inter');
  // a light shower holds at damp
  step(w, idle(), WEATHER.transition);
  assert.equal(w.rain, WEATHER.damp);
  // the end of it is forecast
  w.rainTimer = WEATHER.dryForecast - 1;
  w.update(DT, idle());
  assert.ok(events.some(([e, p]) => e === 'forecast' && p.kind === 'dry'));
  assert.equal(w.expectedRain, 0);
});

test('a soaked track dries through a hold at damp', () => {
  const w = racingWorld();
  w.raining = true;
  w.rainPeak = 1;
  w.rain = 1;
  w.rainTimer = DT / 2;
  w.update(DT, idle());
  assert.equal(w.raining, false);
  assert.ok(w.dampHold >= WEATHER.hold.min);
  step(w, idle(), WEATHER.transition * 0.5 + 0.2);
  assert.equal(w.rain, WEATHER.damp, 'holding');
  step(w, idle(), WEATHER.hold.max + WEATHER.transition * 0.5 + 0.2);
  assert.equal(w.rain, 0, 'dry');
  assert.ok(TYRES.dryBelow > 0);
});
