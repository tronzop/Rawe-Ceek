import test from 'node:test';
import assert from 'node:assert/strict';
import * as logic from '../src/logic.js';
import * as config from '../src/config.js';
import { sanitize } from '../server/index.js';

const logicP = Promise.resolve(logic);
const configP = Promise.resolve(config);

test('base speed grows with time and caps', async () => {
  const { baseSpeed } = await logicP;
  const { SPEED } = await configP;
  assert.equal(baseSpeed(0), SPEED.base);
  assert.ok(baseSpeed(60) > baseSpeed(0));
  assert.equal(baseSpeed(1e6), SPEED.max);
});

test('grip: soft > medium > hard when fresh and dry', async () => {
  const { gripFactor } = await logicP;
  assert.ok(gripFactor('soft', 0, 0) > gripFactor('medium', 0, 0));
  assert.ok(gripFactor('medium', 0, 0) > gripFactor('hard', 0, 0));
});

test('grip falls off the cliff with wear', async () => {
  const { gripFactor } = await logicP;
  const { TYRES } = await configP;
  const fresh = gripFactor('medium', 0, 0);
  assert.equal(gripFactor('medium', TYRES.cliffStart, 0), fresh);
  assert.ok(gripFactor('medium', 90, 0) < fresh);
  assert.ok(Math.abs(gripFactor('medium', 100, 0) - fresh * TYRES.gripAtCliff) < 1e-9);
});

test('rain favours wets and punishes slicks', async () => {
  const { gripFactor } = await logicP;
  assert.ok(gripFactor('wet', 0, 1) > gripFactor('soft', 0, 1));
  assert.ok(gripFactor('inter', 0, 0.6) > gripFactor('inter', 0, 0));
  assert.ok(gripFactor('wet', 0, 0) < gripFactor('wet', 0, 1));
});

test('wear scales with speed squared and compound', async () => {
  const { wearDelta } = await logicP;
  const { SPEED } = await configP;
  const slow = wearDelta('medium', SPEED.base, 1);
  const fast = wearDelta('medium', SPEED.base * 2, 1);
  assert.ok(Math.abs(fast / slow - 4) < 1e-9);
  assert.ok(wearDelta('soft', SPEED.base, 1) > wearDelta('hard', SPEED.base, 1));
});

test('player speed: pit limiter, boost, spin', async () => {
  const { playerSpeed, baseSpeed } = await logicP;
  const { SPEED, ERS } = await configP;
  const base = { elapsed: 0, throttle: 1, boosting: false, grip: 1, inPit: false, spun: false };
  assert.equal(playerSpeed(base), baseSpeed(0));
  assert.equal(playerSpeed({ ...base, inPit: true }), SPEED.pitLimit);
  assert.ok(Math.abs(playerSpeed({ ...base, boosting: true }) - baseSpeed(0) * ERS.boostMultiplier) < 1e-9);
  assert.ok(playerSpeed({ ...base, spun: true }) < playerSpeed(base));
  assert.ok(playerSpeed({ ...base, grip: 0.5 }) < playerSpeed(base));
});

test('spawn interval decays to a floor', async () => {
  const { spawnInterval } = await logicP;
  const { SPAWN } = await configP;
  assert.equal(spawnInterval(0), SPAWN.baseInterval);
  assert.ok(spawnInterval(60) < spawnInterval(0));
  assert.equal(spawnInterval(1e5), SPAWN.minInterval);
});

test('pickHazard covers all types and is deterministic for a given roll', async () => {
  const { pickHazard } = await logicP;
  const seen = new Set();
  for (let r = 0; r < 1; r += 0.01) seen.add(pickHazard(0, r));
  assert.deepEqual([...seen].sort(), ['debris', 'oil', 'rival', 'tyre']);
  assert.equal(pickHazard(0, 0.0), 'tyre');
  assert.equal(pickHazard(0, 0.999), 'debris');
});

test('pit window schedule', async () => {
  const { pitWindowOpen, nextPitWindowIn } = await logicP;
  const { PIT } = await configP;
  assert.equal(pitWindowOpen(0), false);
  assert.equal(pitWindowOpen(PIT.firstWindowAt + 1), true);
  assert.equal(pitWindowOpen(PIT.firstWindowAt + PIT.openFor + 1), false);
  assert.equal(pitWindowOpen(PIT.firstWindowAt + PIT.interval + 1), true);
  assert.equal(nextPitWindowIn(PIT.firstWindowAt + 1), 0);
  assert.ok(Math.abs(nextPitWindowIn(0) - PIT.firstWindowAt) < 1e-9);
});

test('geometry: rect/circle and rect/rect gaps', async () => {
  const { rectCircle, rectCircleGap, rectGap, rectsOverlap } = await logicP;
  const r = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(rectCircle(r, 5, 5, 1), true);
  assert.equal(rectCircle(r, 15, 5, 4), false);
  assert.equal(rectCircle(r, 15, 5, 5), true);
  assert.ok(Math.abs(rectCircleGap(r, 20, 5, 4) - 6) < 1e-9);
  assert.equal(rectsOverlap(r, { x: 5, y: 5, w: 10, h: 10 }), true);
  assert.equal(rectsOverlap(r, { x: 11, y: 0, w: 10, h: 10 }), false);
  assert.ok(Math.abs(rectGap(r, { x: 13, y: 0, w: 5, h: 5 }) - 3) < 1e-9);
  assert.ok(rectGap(r, { x: 5, y: 5, w: 10, h: 10 }) < 0);
});

test('formatters', async () => {
  const { formatDistance, formatTime } = await logicP;
  assert.equal(formatDistance(999), '999 m');
  assert.equal(formatDistance(1234), '1.23 km');
  assert.equal(formatTime(65.25), '1:05.3');
});

test('server sanitize clamps and strips names', () => {
  const e = sanitize({ name: '<script>Charles!!</script>', score: '123.9', distance: -5, overtakes: 'x' });
  assert.equal(e.name, 'scriptCharlesscr'); // 16-char cap
  assert.equal(e.score, 123);
  assert.equal(e.distance, 0);
  assert.equal(e.overtakes, 0);
  assert.equal(sanitize({}).name, 'anon');
  assert.equal(sanitize({ name: 'a'.repeat(40) }).name.length, 16);
});
