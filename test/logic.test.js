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

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------
import { applyRun, evaluateTrophies, EMPTY_CAREER, EMPTY_RUN, TROPHIES } from '../src/career.js';

test('calendar: venue index loops and GP progress is 0..1', () => {
  const { venueIndexAt, gpsCompleted, gpProgress } = logic;
  const { GP, VENUES } = config;
  assert.equal(venueIndexAt(0), 0);
  assert.equal(venueIndexAt(GP.lengthMetres - 1), 0);
  assert.equal(venueIndexAt(GP.lengthMetres), 1);
  assert.equal(venueIndexAt(GP.lengthMetres * VENUES.length), 0);
  assert.equal(gpsCompleted(GP.lengthMetres * 2.5), 2);
  assert.ok(gpProgress(GP.lengthMetres * 0.25) > 0.24 && gpProgress(GP.lengthMetres * 0.25) < 0.26);
  assert.equal(gpProgress(GP.lengthMetres), 0);
  for (const v of VENUES) {
    assert.ok(['trees', 'harbour', 'dunes', 'stands', 'forest', 'oldcity', 'wheel', 'city', 'tower', 'stadium', 'hills', 'neon', 'lake', 'desert'].includes(v.skyline), v.id);
    assert.equal(v.sky.length, 2);
  }
});

test('slipstream: strongest close and aligned, zero when behind or offset', () => {
  const { towFactor } = logic;
  const { SLIPSTREAM } = config;
  assert.equal(towFactor(-10, 0), 0);
  assert.equal(towFactor(SLIPSTREAM.range + 1, 0), 0);
  assert.equal(towFactor(50, SLIPSTREAM.lateral), 0);
  assert.ok(towFactor(20, 0) > towFactor(200, 0));
  assert.ok(towFactor(100, 0) > towFactor(100, SLIPSTREAM.lateral / 2));
  assert.ok(towFactor(1, 0) <= 1);
});

test('tyre temperature: cold rubber grips less, full temp is neutral', () => {
  const { tempGrip } = logic;
  const { TYRE_TEMP } = config;
  assert.equal(tempGrip(1), 1);
  assert.equal(tempGrip(0), TYRE_TEMP.coldGrip);
  assert.ok(tempGrip(0.5) > TYRE_TEMP.coldGrip && tempGrip(0.5) < 1);
  assert.equal(tempGrip(7), 1);
});

test('position label', () => {
  assert.equal(logic.positionLabel(0), 'P20');
  assert.equal(logic.positionLabel(19), 'P1');
  assert.equal(logic.positionLabel(40), 'P1');
});

test('career: runs fold into totals and unlock trophies exactly once', () => {
  const { GP } = config;
  let career = EMPTY_CAREER();
  const run = { ...EMPTY_RUN(), metres: 3200, gps: 2, overtakes: 4, slowStops: 1, punctures: 1, score: 3500 };
  career = applyRun(career, run, GP.points);
  assert.equal(career.races, 1);
  assert.equal(career.gps, 2);
  assert.equal(career.points, 2 * GP.points);
  assert.equal(career.metres, 3200);
  const unlocked = evaluateTrophies(career, run);
  assert.ok(unlocked.includes('lightsout'));
  assert.ok(unlocked.includes('chequered'));
  assert.ok(unlocked.includes('bono'));
  assert.ok(!unlocked.includes('triple'));
  assert.ok(!unlocked.includes('podium'));
  career.trophies = unlocked;
  assert.deepEqual(evaluateTrophies(career, run), []);
  // ids are unique
  assert.equal(new Set(TROPHIES.map((t) => t.id)).size, TROPHIES.length);
});

import { DRIVERS, TEAMS, OPTIONAL_CLIPS, teamOf } from '../src/grid.js';

test('grid: drivers reference real teams, unique ids, valid helmets and clips', () => {
  const ids = new Set();
  for (const d of DRIVERS) {
    assert.ok(!ids.has(d.id), `duplicate driver id ${d.id}`);
    ids.add(d.id);
    assert.ok(TEAMS[d.team], `${d.id} has unknown team ${d.team}`);
    assert.equal(teamOf(d), TEAMS[d.team]);
    assert.equal(d.helmet.length, 2);
    assert.ok(Number.isInteger(d.number) && d.number > 0 && d.number < 100);
    assert.ok(d.lines.overtake.length >= 1 && d.lines.close.length >= 1, `${d.id} needs quips`);
    for (const c of Object.values(d.clip || {})) assert.ok(OPTIONAL_CLIPS[c], `${d.id} references unknown clip ${c}`);
    if (d.legend) assert.ok(TEAMS[d.team].classic, `legend ${d.id} should drive a classic livery`);
  }
  // every classic team has at least one legend driving it, every modern team has two drivers
  for (const t of Object.values(TEAMS)) {
    const n = DRIVERS.filter((d) => d.team === t.id).length;
    if (t.classic) assert.ok(n >= 1, `${t.id} has no driver`);
    else assert.equal(n, 2, `${t.id} should have two drivers`);
  }
  for (const [id, c] of Object.entries(OPTIONAL_CLIPS)) assert.ok(c.event && c.desc && /^\w+$/.test(id), id);
});

test('radio: driver quips and {d} substitution', async () => {
  const { radioLine } = await import('../src/radio.js');
  const d = DRIVERS.find((x) => x.id === 'alonso');
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(radioLine('overtake', { driver: d }));
  assert.ok([...seen].some((l) => d.lines.overtake.includes(l)), 'driver quip should appear');
  assert.ok(![...seen].some((l) => l.includes('{d}')), 'placeholder must be substituted');
});

test('server: /api/assets lists only media files and tolerates missing dirs', async () => {
  const { listAssets } = await import('../server/index.js');
  const a = listAssets();
  assert.ok(Array.isArray(a.clips) && Array.isArray(a.drivers));
  for (const f of a.clips) assert.match(f, /\.(mp3|ogg|wav|m4a)$/);
  for (const f of a.drivers) assert.match(f, /\.(png|jpe?g|webp|gif)$/);
});

test('pit mini-game: sweep, judgement and stop times', () => {
  const { sweepPos, judgeWheel, stopTime, stopSummary } = logic;
  const { PITGAME } = config;
  assert.equal(sweepPos(0), 0);
  assert.ok(Math.abs(sweepPos(0.5 / PITGAME.sweepSpeed) - 0.5) < 1e-9, 'centre at half a sweep');
  assert.ok(Math.abs(sweepPos(1 / PITGAME.sweepSpeed) - 1) < 1e-9, 'far end after one sweep');
  assert.ok(Math.abs(sweepPos(2 / PITGAME.sweepSpeed)) < 1e-9, 'back to start after two');
  assert.equal(judgeWheel(0.5), 'perfect');
  assert.equal(judgeWheel(0.5 + PITGAME.perfectHalf + 0.01), 'good');
  assert.equal(judgeWheel(0.5 + PITGAME.zoneHalf + 0.01), 'miss');
  assert.equal(judgeWheel(0.5 + PITGAME.jamZoneHalf + 0.01, true), 'miss');
  assert.equal(judgeWheel(0.5 + PITGAME.jamZoneHalf + 0.01, false), 'good');
  const perfect = Array(4).fill('perfect');
  assert.ok(stopTime(perfect) < PITGAME.recordUnder, 'four perfects is a record');
  assert.ok(stopTime(Array(4).fill('good')) > PITGAME.recordUnder, 'four goods is not');
  assert.ok(stopTime(['good', 'good', 'good', 'miss']) > stopTime(Array(4).fill('good')) + 0.8);
  const s = stopSummary(['perfect', 'good', 'miss', 'good']);
  assert.deepEqual([s.misses, s.perfects, s.clean, s.record], [1, 1, false, false]);
  assert.ok(stopSummary(perfect).record);
});

test('meme pack: every clip with words has a subtitle and a speaker', async () => {
  const { OPTIONAL_CLIPS, clipLine } = await import('../src/grid.js');
  for (const [id, c] of Object.entries(OPTIONAL_CLIPS)) {
    if (c.say) assert.ok(c.who, `${id} has a line but no speaker`);
    assert.equal(clipLine(id) === null, !c.say, `clipLine(${id}) disagrees with the data`);
  }
  assert.deepEqual(clipLine('pushing'), { who: 'Pit wall', say: 'Pushing like an animal.' });
  assert.equal(clipLine('scream'), null); // no words: the pit wall's own line shows instead
  assert.equal(clipLine(false), null); // playAny() returned nothing
});

test('meme pack: clip resolution prefers real recordings over the shipped voice pack', async () => {
  const { resolveClip, OPTIONAL_CLIPS, CLIP_EXTENSIONS } = await import('../src/grid.js');
  assert.equal(resolveClip('bwoah', ['bwoah.wav']), 'bwoah.wav');
  assert.equal(resolveClip('bwoah', ['bwoah.wav', 'bwoah.mp3']), 'bwoah.mp3');
  assert.equal(resolveClip('bwoah', ['bwoah.ogg', 'bwoah.wav']), 'bwoah.ogg');
  assert.equal(resolveClip('bwoah', ['what.mp3']), null);
  assert.deepEqual(CLIP_EXTENSIONS[0], 'mp3');
  // every optional clip except thunder ships as a synthesised .wav
  const fs = await import('node:fs');
  for (const id of Object.keys(OPTIONAL_CLIPS)) {
    if (id === 'thunder') continue;
    assert.ok(fs.existsSync(new URL(`../assets/clips/${id}.wav`, import.meta.url)), `missing voice-pack clip ${id}.wav`);
  }
});

test('engine model: gears climb with speed, rpm saws through the range, V12 fires 6× per rev', () => {
  const { engineState, ENGINE } = logic;
  assert.equal(engineState(0).gear, 1);
  assert.equal(engineState(1).gear, ENGINE.gears);
  assert.ok(engineState(0.05).rpmNorm < engineState(0.12).rpmNorm, 'rpm climbs within a gear');
  const before = engineState(1 / ENGINE.gears - 0.001), after = engineState(1 / ENGINE.gears + 0.001);
  assert.equal(after.gear, before.gear + 1);
  assert.ok(after.rpmNorm < before.rpmNorm, 'rpm drops on the upshift');
  const s = engineState(0);
  assert.ok(Math.abs(s.firingHz - (s.rpm / 60) * 6) < 1e-9);
  assert.ok(engineState(1).firingHz > 1000 && engineState(0).firingHz > 300);
});

test('mariachi arrangements are well-formed', async () => {
  const { ARRANGEMENTS, MARIACHI_TRACKS } = await import('../src/mariachi.js');
  assert.deepEqual(MARIACHI_TRACKS, ['mariachi', 'jarabe']);
  for (const [id, arr] of Object.entries(ARRANGEMENTS)) {
    assert.equal(arr.lead.length, arr.steps, `${id}: steps match lead length`);
    assert.equal(arr.steps % arr.perBar, 0, `${id}: whole bars`);
    assert.equal(arr.steps / arr.perBar, 16, `${id}: 16-bar loop`);
    assert.ok(arr.tempo > 1, `${id}: quicker than the synth`);
    for (const n of arr.lead) assert.ok(n === null || n === '-' || (Number.isInteger(n) && n >= -7 && n <= 21), `${id}: bad lead entry ${n}`);
    assert.notEqual(arr.lead[0], '-', `${id}: loop does not start on a hold`);
  }
  assert.ok(ARRANGEMENTS.jarabe.tempo > ARRANGEMENTS.mariachi.tempo, 'jarabe is jauntier');
});

test('venues are complete and distinct', async () => {
  const { VENUES } = await configP;
  const ids = new Set(VENUES.map((v) => v.id));
  assert.equal(ids.size, VENUES.length, 'unique ids');
  assert.equal(new Set(VENUES.map((v) => v.skyline)).size, VENUES.length, 'each venue has its own skyline painter');
  for (const v of VENUES) {
    for (const k of ['name', 'flag', 'skyline', 'horizon', 'ground', 'barrier', 'asphalt']) assert.ok(v[k], `${v.id}.${k}`);
    assert.equal(v.sky.length, 2, `${v.id} sky gradient`);
    assert.equal(typeof v.night, 'boolean');
    assert.ok(v.rainBias >= 0);
  }
});

test('safety car pace: lifting goes slower than the cap, bunched rivals hold about the cap', async () => {
  const { SAFETY_CAR, PLAYER } = await configP;
  assert.ok(SAFETY_CAR.liftFloor < 1 && SAFETY_CAR.liftFloor > 0.4);
  assert.ok(SAFETY_CAR.bunchSpread[0] > SAFETY_CAR.liftFloor, 'a full lift always drops you behind the slowest bunched rival');
  assert.ok(SAFETY_CAR.bunchSpread[1] >= 1, 'some rivals pull away rather than fall back into you');
  assert.ok(PLAYER.throttleRange.min < 1);
});
