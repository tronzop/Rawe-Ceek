// Tyre maths: stints last about as long late in the race as early on, compound pace is separate
// from grip, the oil slick is an ellipse, and the wall knows which tyre suits the weather.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { carById } from '../src/cars.js';
import { COMPOUNDS, SPEED, TYRES } from '../src/config.js';
import { baseSpeed, bestCompound, gripFactor, playerSpeed, rectEllipseGap, tempGrip, wearDelta, wrongForWeather } from '../src/logic.js';

const DT = 1 / 60;
const idle = () => ({ up: false, down: false, left: false, right: false, boost: false, pointerY: null, pointerBoost: false });

/** Seconds of neutral-throttle racing on fresh, warm `compound` from `elapsed` until the tyre reaches the cliff. */
function stintToCliff(compound, elapsed) {
  const w = new World(() => {}, carById('ferrari'));
  w.resize(1280, 720);
  w.reset();
  Object.assign(w.start, { phase: 'go', lit: 5, sinceGo: 20, launch: 0, reaction: 0.2 });
  w.hazards = [];
  w.sc.cooldown = 1e9;
  w.dryTimer = 1e9;
  w.spawnTimer = 1e9;
  w.drsTimer = 1e9;
  w.elapsed = elapsed;
  w.tyre = { compound, wear: 0, punctured: false, temp: 1 };
  w.speed = baseSpeed(elapsed);
  let t = 0;
  while (w.tyre.wear < TYRES.cliffStart && t < 300) { w.update(DT, idle()); t += DT; }
  return t;
}

test('wear: normalised to the reference speed, so pushing costs rubber but surviving does not', () => {
  assert.equal(wearDelta('medium', SPEED.base, 1), wearDelta('medium', 900, 1, 1, 900));
  assert.ok(wearDelta('medium', 1000, 1, 1, 900) > wearDelta('medium', 900, 1, 1, 900));
});

test('stints: soft, medium and hard last about as long at t=200 as at t=30', () => {
  const med30 = stintToCliff('medium', 30);
  assert.ok(med30 > 24 && med30 < 36, `medium at neutral throttle reaches the cliff in ${med30.toFixed(1)} s (want ~30)`);
  const lengths = {};
  for (const c of ['soft', 'medium', 'hard']) {
    const early = stintToCliff(c, 30);
    const late = stintToCliff(c, 200);
    lengths[c] = early;
    assert.ok(Math.abs(late - early) / early <= 0.2, `${c}: ${early.toFixed(1)} s at t=30 vs ${late.toFixed(1)} s at t=200`);
  }
  assert.ok(lengths.soft < lengths.medium && lengths.medium < lengths.hard, JSON.stringify(lengths));
});

test('compound pace: on a dry track fresh softs are faster than mediums, which are faster than hards', () => {
  const speed = (c) => playerSpeed({ elapsed: 60, throttle: 1, boosting: false, grip: gripFactor(c, 0, 0) * tempGrip(1), inPit: false, spun: false, pace: COMPOUNDS[c].pace });
  assert.ok(speed('soft') > speed('medium'), `${speed('soft')} vs ${speed('medium')}`);
  assert.ok(speed('medium') > speed('hard'), `${speed('medium')} vs ${speed('hard')}`);
  assert.ok(Math.abs(speed('soft') / speed('medium') - COMPOUNDS.soft.pace) < 1e-9, 'grip above 1 adds nothing on the straight; pace does');
  // and the world uses it
  const top = (c) => {
    const w = new World(() => {}, carById('ferrari'));
    w.resize(1280, 720);
    Object.assign(w.start, { phase: 'go', lit: 5, sinceGo: 20, launch: 0, reaction: 0.2 });
    w.hazards = [];
    w.sc.cooldown = w.dryTimer = w.spawnTimer = w.drsTimer = 1e9;
    w.elapsed = 60;
    w.tyre = { compound: c, wear: 0, punctured: false, temp: 1 };
    for (let i = 0; i < 180; i++) w.update(DT, idle());
    return w.speed;
  };
  assert.ok(top('soft') > top('medium') && top('medium') > top('hard'));
});

test('oil: rect/ellipse gap is exact, so the bounding-box corner misses', () => {
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  assert.ok(rectEllipseGap(rect, 5, 5, 4, 2) < 0, 'centre overlap');
  assert.ok(rectEllipseGap(rect, 15, 5, 6, 2) < 0, 'reaches across the long axis');
  assert.ok(rectEllipseGap(rect, 15, 15, 6, 6) > 0, 'diagonal: inside the bounding box, outside the ellipse');
  assert.ok(Math.abs(rectEllipseGap(rect, 16, 5, 6, 2)) < 1e-9, 'just touching');
});

test('weather tyres: wrong tyres and the wall\'s pick', () => {
  assert.equal(bestCompound(0), 'medium');
  assert.equal(bestCompound(0.5), 'inter');
  assert.equal(bestCompound(0.9), 'wet');
  assert.equal(wrongForWeather('medium', 0.5), true);
  assert.equal(wrongForWeather('soft', 0.2), false);
  assert.equal(wrongForWeather('inter', 0.05), true);
  assert.equal(wrongForWeather('wet', 0.5), false);
  assert.equal(wrongForWeather('inter', 0.2), false, 'between the thresholds nothing is wrong');
  for (const r of [0, 0.5, 0.9]) assert.equal(wrongForWeather(bestCompound(r), r), false);
});
