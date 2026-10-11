// Presentation helpers that run without a DOM: toast priority (A15), the phone HUD scale (B10),
// the just-in-time coach cards (B11) and the fictional sponsor boards (A19).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COACH, COACH_CARDS, COACH_CARD_DUR, hudScale, offerToast } from '../src/render.js';

const toast = (text, prio, age = 0, dur = 2.2) => ({ text, prio, age, dur });
/** Plays `offers` ([time, toast]) through offerToast, ageing the live toast like main's frame loop. */
function play(offers, until, dt = 1 / 60) {
  let cur = null;
  const seen = [];
  let i = 0;
  for (let t = 0; t <= until; t += dt) {
    while (i < offers.length && offers[i][0] <= t + 1e-9) cur = offerToast(cur, { ...offers[i++][1] });
    if (cur && cur.age < cur.dur) seen.push([t, cur.text]);
    if (cur) cur.age += dt;
  }
  return seen;
}

test('A15: a lower-priority toast never replaces a live higher one', () => {
  // wing lost, then a km milestone half a second later: the wing toast keeps its full 2.2 s
  const seen = play([[0, toast('FRONT WING GONE', 2)], [0.5, toast('3 km', 0, 0, 1.6)]], 3);
  const wing = seen.filter(([, s]) => s === 'FRONT WING GONE');
  assert.ok(wing.at(-1)[0] >= 2.15, `wing toast cut short at ${wing.at(-1)[0]}`);
  assert.ok(!seen.some(([, s]) => s === '3 km'), 'the milestone stays out of the way');
});

test('A15: equal or higher priority takes over; an expired toast is replaced by anything', () => {
  assert.equal(offerToast(toast('RAIN', 1, 0.3), toast('PUNCTURE', 2)).text, 'PUNCTURE');
  assert.equal(offerToast(toast('RAIN', 1, 0.3), toast('GREEN FLAG', 1)).text, 'GREEN FLAG');
  assert.equal(offerToast(toast('SAFETY CAR', 2, 2.3), toast('3 km', 0)).text, '3 km');
  assert.equal(offerToast(null, toast('3 km', 0)).text, '3 km');
});

test('A14: there is no DRS toast any more (the ERS bar shows the gain)', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.ok(!/toast\([^)]*DRS/.test(main));
});

test('B10: the HUD grows on a phone so 11 px text reaches 10 CSS px, and stays 1 on a desktop', () => {
  assert.equal(hudScale(720), 1);
  assert.equal(hudScale(1080, { touch: true }), 1);
  const ui = hudScale(390, { touch: true });
  assert.ok(ui > 1.6 && ui <= 1.8, `ui ${ui}`);
  assert.ok(11 * ui * (390 / 720) >= 10, 'smallest card text is at least 10 CSS px');
  assert.ok(13 * hudScale(390, { touch: true, minPx: 13 }) * (390 / 720) >= 10);
  assert.equal(hudScale(200, { touch: true }), 1.8, 'capped');
  assert.ok(hudScale(450) > 1, 'a short desktop window scales too');
  assert.equal(hudScale(720, { override: 1.5 }), 1.5, '?hudscale= wins');
});

test('B11: every coach card names an anchor and both wordings; the timed tips are down to tip 1', () => {
  assert.deepEqual(Object.keys(COACH_CARDS).sort(), ['cliff', 'contact', 'pit', 'rain', 'sc', 'tow']);
  for (const [id, c] of Object.entries(COACH_CARDS)) {
    assert.ok(c.at && c.keys && c.touch && c.accent, id);
  }
  const anchors = new Set(['pitChip', 'ers', 'tyre', 'damage', 'nextTyre', 'banner']);
  for (const c of Object.values(COACH_CARDS)) assert.ok(anchors.has(c.at), c.at);
  assert.equal(COACH.tips.length, 1);
  assert.equal(COACH.touchTips.length, 1);
  assert.ok(COACH_CARD_DUR >= 3);
});

test('B11: the seen list is in localStorage under rc.coachSeen, guarded, with a reset link', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(main.includes("'rc.coachSeen'"));
  for (const m of main.matchAll(/localStorage\.(get|set|remove)Item\(COACH_KEY/g)) {
    const before = main.slice(Math.max(0, m.index - 80), m.index);
    assert.ok(/try \{/.test(before), 'every coachSeen access is inside try');
  }
  assert.ok(html.includes('id="resetTutorial"'));
});

test('A19: the trackside boards carry no real sponsors', () => {
  const src = readFileSync(new URL('../src/render.js', import.meta.url), 'utf8');
  for (const word of ['PIRELLI', 'DHL', 'ROLEX', 'ARAMCO', 'HEINEKEN']) assert.ok(!src.includes(`'${word}'`), word);
});

test('A16: startGame cancels the last run (timers, clips, music) and gameOver callbacks check the run', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const start = main.slice(main.indexOf('function startGame()'), main.indexOf('function pause()'));
  for (const call of ['clearRunTimers()', 'audio.stopClips()', 'audio.stopMusic()', 'syncRotate()', 'blur']) assert.ok(start.includes(call), call);
  assert.ok(!/\bsetTimeout\(/.test(main.replace(/const id = setTimeout/, '')), 'every delay goes through later()');
  const over = main.slice(main.indexOf('function gameOver('), main.indexOf('// ---------- world events'));
  assert.ok((over.match(/still\(\)/g) || []).length >= 3);
});
