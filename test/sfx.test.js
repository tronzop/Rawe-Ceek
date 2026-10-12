// The F1 sound hooks the world feeds: each moment is reported once (never every frame) with what
// the sound needs (the side a car went by, how fast it closed, how hard the wing drags), and the
// launch is timed for the career's best reaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { carById } from '../src/cars.js';
import { COMPOUNDS, PLAYER, SPEED, START, WORLD } from '../src/config.js';
import { applyRun, bestReaction, EMPTY_CAREER, EMPTY_RUN } from '../src/career.js';
import { radioLine } from '../src/radio.js';

const DT = 1 / 60;
const idle = () => ({ up: false, down: false, left: false, right: false, boost: false, pointerY: null, pointerBoost: false });
const count = (events, name) => events.filter(([e]) => e === name).length;

function gridWorld(events) {
  const w = new World((e, p) => events.push([e, p]), carById('ferrari'));
  w.resize(1280, 720);
  w.reset();
  w.sc.cooldown = 1e9;
  w.dryTimer = 1e9;
  return w;
}
function racingWorld(events = []) {
  const w = gridWorld(events);
  w.start.phase = 'go';
  w.start.lit = 5;
  w.start.sinceGo = 20;
  w.start.launch = 0;
  w.start.reaction = 0.2;
  w.hazards = [];
  w.spawnTimer = 1e9;
  return w;
}
const rival = (x, y, rel, extra = {}) => ({
  id: 90000 + Math.floor(Math.random() * 1e6), type: 'rival', x, y, w: PLAYER.width * 0.92, h: PLAYER.height * 0.92, rel, pace: 0, vy: 0, scPace: 0,
  team: { name: 'Test' }, driver: null, teammate: false, fromBehind: false, weave: false, weavePhase: 0, passed: false, frame: 0, defend: false, brake: 0, ...extra,
});

/** Sits on the grid until lights out, then holds → after `pressAfter` s. */
function runStart(events, { jump = false, pressAfter = 0.25 } = {}) {
  const w = gridWorld(events);
  for (let i = 0; i < 60 * 12; i++) {
    const inp = idle();
    if (jump && w.start.lit >= 2 && !w.racing) inp.right = true;
    if (w.racing && w.start.sinceGo >= pressAfter) inp.right = true;
    w.update(DT, inp);
    if (w.racing && w.start.sinceGo > 2) break;
  }
  return w;
}

test('start: five lights, one lights out, one timed reaction stored in the run', () => {
  const events = [];
  const w = runStart(events, { pressAfter: 0.25 });
  assert.equal(count(events, 'light'), START.lights, 'a tick per light');
  assert.deepEqual(events.filter(([e]) => e === 'light').map(([, p]) => p.n), [1, 2, 3, 4, 5]);
  assert.equal(count(events, 'lightsOut'), 1);
  assert.equal(count(events, 'reaction'), 1, 'the reaction is reported once');
  const r = events.find(([e]) => e === 'reaction')[1];
  assert.ok(Math.abs(r.reaction - 0.25) < 0.05, `about 0.25 s (${r.reaction})`);
  assert.equal(r.jumped, false);
  assert.equal(r.great, true);
  assert.equal(w.run.reaction, r.reaction);
  // reaction before the great-start toast, so the lights-out toast can carry the time first
  const order = events.map(([e]) => e);
  assert.ok(order.indexOf('reaction') < order.indexOf('greatStart'));
});

test('start: a jump start fires its tone once and is never timed into the career', () => {
  const events = [];
  const w = runStart(events, { jump: true });
  assert.equal(count(events, 'jumpStart'), 1);
  const r = events.find(([e]) => e === 'reaction');
  assert.ok(r && r[1].jumped, 'still reported, marked jumped');
  assert.equal(w.run.reaction, 0, 'not a reaction time');
});

test('start: a press on the first frame after lights out is a guess, not a 0.017 s reaction', () => {
  const events = [];
  const w = runStart(events, { pressAfter: 0 });
  const r = events.find(([e]) => e === 'reaction')[1];
  assert.ok(r.reaction < START.reactionFloor);
  assert.equal(r.jumped, true);
  assert.equal(r.great, false);
  assert.equal(count(events, 'greatStart'), 0);
  assert.equal(w.run.reaction, 0);
  assert.equal(bestReaction(0.3, 0.017), 0.3, 'never a career best');
  assert.equal(bestReaction(0.017, 0.3), 0.3, 'an old save\'s impossible best gives way');
});

test('start: a slow start (never pressed) records no reaction', () => {
  const events = [];
  const w = runStart(events, { pressAfter: 99 });
  assert.equal(count(events, 'reaction'), 0);
  assert.equal(count(events, 'slowStart'), 1);
  assert.equal(w.run.reaction, 0);
});

test('career keeps the best reaction; 0 means none and jump starts never count', () => {
  assert.equal(bestReaction(0, 0.4), 0.4);
  assert.equal(bestReaction(0.3, 0.4), 0.3);
  assert.equal(bestReaction(0.3, 0), 0.3);
  assert.equal(bestReaction(undefined, undefined), 0);
  let c = EMPTY_CAREER();
  assert.equal(c.bestReaction, 0);
  c = applyRun(c, { ...EMPTY_RUN(), reaction: 0.41 });
  assert.equal(c.bestReaction, 0.41);
  c = applyRun(c, { ...EMPTY_RUN(), reaction: 0 });
  assert.equal(c.bestReaction, 0.41);
  c = applyRun(c, { ...EMPTY_RUN(), reaction: 0.29 });
  assert.equal(c.bestReaction, 0.29);
  // an old save without the field
  const old = EMPTY_CAREER(); delete old.bestReaction;
  assert.equal(applyRun(old, { ...EMPTY_RUN(), reaction: 0.5 }).bestReaction, 0.5);
});

test('close calls and scrapes say which side the car went by (up = the car\'s left)', () => {
  const events = [];
  const w = racingWorld(events);
  const p = w.player;
  const top = w.playerParts[1].y;
  const t = { id: 1, type: 'tyre', x: p.x - 20, y: top - 10 - 10, r: 10, vx: 0, vy: 0, spin: 0, compound: COMPOUNDS.medium, bounce: false };
  w.collide(t, w.playerRect, w.player);
  t.y += 7;
  w.collide(t, w.playerRect, w.player);
  t.y -= 50; // gone by
  w.collide(t, w.playerRect, w.player);
  w.collide(t, w.playerRect, w.player); // same tyre again: not a second close call
  assert.equal(count(events, 'closeCall'), 1);
  assert.equal(events.find(([e]) => e === 'closeCall')[1].side, 'up');
  assert.equal(count(events, 'scrape'), 1);
  assert.equal(events.find(([e]) => e === 'scrape')[1].side, 'up');
  // and one below
  const bottom = Math.max(...w.playerParts.map((r) => r.y + r.h));
  const t2 = { id: 2, type: 'tyre', x: p.x - 20, y: bottom + 10 + 10, r: 10, vx: 0, vy: 0, spin: 0, compound: COMPOUNDS.medium, bounce: false };
  w.collide(t2, w.playerRect, w.player);
  t2.y += 50;
  w.collide(t2, w.playerRect, w.player);
  assert.equal(events.filter(([e]) => e === 'closeCall').at(-1)[1].side, 'down');
});

test('passes carry the closing speed in m/s for the Doppler, each way', () => {
  const events = [];
  const w = racingWorld(events);
  w.speed = 600;
  w.onOvertake(rival(w.player.x - 100, w.player.y - 80, 350));
  const o = events.find(([e]) => e === 'overtake')[1];
  assert.ok(Math.abs(o.closing - 250 * WORLD.metresPerPx) < 1e-9);
  assert.equal(o.grid, false);
  w.onOvertake(rival(w.player.x - 100, w.player.y - 80, 500, { teammate: true, grid: true }));
  const tm = events.find(([e]) => e === 'teammate')[1];
  assert.ok(tm.closing > 0 && tm.grid === true);
  // a car from behind clearing your nose
  const behind = rival(w.player.x + PLAYER.width / 2 + PLAYER.width * 0.46 + 2, w.player.y + 90, 0, { fromBehind: true });
  w.hazards = [behind];
  w.update(DT, idle());
  const pb = events.filter(([e]) => e === 'passedBy');
  assert.equal(pb.length, 1);
  assert.ok(pb[0][1].closing > 0, 'it was quicker than you');
  w.update(DT, idle());
  assert.equal(count(events, 'passedBy'), 1, 'once per car');
});

test('the damage scrape follows the wing (≥ 50) and the floor, and stops in the pit lane', () => {
  const w = racingWorld();
  w.speed = SPEED.base;
  const at = (wing, floor, inLane = false) => {
    w.player.parts = { wing, floor };
    w.pit.inLane = inLane;
    w.updatePlayer(DT, idle());
    return w.scrape;
  };
  assert.equal(at(0, 0), 0);
  assert.equal(at(45, 0), 0, 'a scuffed wing does not drag');
  const half = at(50, 0);
  const gone = at(100, 0);
  assert.ok(half > 0 && gone > half && gone <= 1);
  assert.ok(at(0, 40) > 0, 'a damaged floor scrapes');
  assert.equal(at(100, 100, true), 0, 'silent in the lane');
});

test('the wall has a "car behind" line for the first car in the mirrors', () => {
  const line = radioLine('carBehind');
  assert.ok(typeof line === 'string' && /behind/i.test(line));
});
