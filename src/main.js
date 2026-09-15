// Bootstrap: wires input, world, renderer, audio and the DOM screens together.
import { COMPOUNDS, COMPOUND_ORDER, DAMAGE, ERS, GP, SC_GAME, SPEED, STORAGE_KEYS, TYRES, VENUES, WORLD } from './config.js';
import { Input, detectTouch } from './input.js';
import { World } from './world.js';
import { Renderer } from './render.js';
import { AudioEngine, TRACKS } from './audio.js';
import { radioLine } from './radio.js';
import { Leaderboard } from './leaderboard.js';
import { Career, TROPHIES } from './career.js';
import { DRIVERS, OPTIONAL_CLIPS, clipLine, resolveClip } from './grid.js';
import { CARS, STAT_BARS, carById, carQuirks, statBars, teamOfCar } from './cars.js';
import { drawLivery } from './livery.js';
import { clamp, formatDistance, lerp, positionLabel } from './logic.js';

const $ = (sel) => document.querySelector(sel);
const canvas = $('#game');
const screens = { title: $('#titleScreen'), pause: $('#pauseScreen'), over: $('#gameOverScreen') };

const assets = { sheet: new Image(), frames: 8 };
assets.sheet.src = 'assets/ferrari_sheet.png';

// Retirement-screen pictures: a celebration when the run is a new personal best, a crash otherwise.
const PORTRAITS = {
  celebrate: [
    { src: 'assets/celebrate_seb_bow.jpg', alt: 'Vettel kneeling and bowing to his car after a win' },
    { src: 'assets/celebrate_alonso_fly.jpg', alt: 'Alonso leaping off his Renault in celebration' },
    { src: 'assets/celebrate_seb_p2.jpg', alt: 'Vettel swapping the P1 and P2 boards in parc fermé' },
  ],
  crash: [
    { src: 'assets/retire_max_kick.jpg', alt: 'Verstappen kicking his blown rear tyre' },
    { src: 'assets/sadgreg.png', alt: 'A very sad Ferrari driver sitting in the grass' },
  ],
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const input = new Input(canvas);
// Phones and tablets get the touch pad, touch wording on the menus and touch coach tips.
const touch = detectTouch();
if (touch) document.body.classList.add('touch');
const audio = new AudioEngine();
// Which optional meme-pack files exist (empty when opened from disk / no server).
const assetsAvailable = fetch('/api/assets', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  .then((a) => a && Array.isArray(a.clips) ? { engine: [], ...a } : { clips: [], drivers: [], engine: [] });
audio.setAvailable(assetsAvailable);
const renderer = new Renderer(canvas, assets);
renderer.touch = touch;
// The car you drive: remembered between visits, chosen on the title screen.
let car = carById((() => { try { return localStorage.getItem(STORAGE_KEYS.car); } catch { return null; } })());
let career = Career.load();
const hud = { radio: null, toast: null, damage: null, best: Leaderboard.best(), musicOn: audio.musicOn, points: career.points };

let state = 'title'; // title | playing | paused | over
let world = new World(onWorldEvent, car);
let last = performance.now();
let submitted = false;

function fit() {
  const view = renderer.fit(WORLD.height);
  world.resize(view.width, view.height);
}
window.addEventListener('resize', fit);
fit();

// ---------- state machine ----------
function show(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
}
function startGame() {
  audio.init();
  world = new World(onWorldEvent, car);
  fit();
  world.reset();
  fit();
  hud.radio = null;
  hud.toast = null;
  hud.damage = null;
  radioQueue.length = 0;
  submitted = false;
  state = 'playing';
  show(null);
  audio.resume();
  if (touch) goFullscreen();
  // the band waits for the lights; on the grid it is just the engine and the wall
  radio('gridStart');
  $('#gameOverScreen').classList.remove('revealed');
}
function pause() {
  if (state !== 'playing') return;
  state = 'paused';
  input.clear();
  $('#pauseLine').textContent = `Race suspended. ${world.car.name} · ${world.venue.name} · ${positionLabel(world.overtakes)}`;
  show('pause');
  audio.suspend();
}
function resume() {
  if (state !== 'paused') return;
  state = 'playing';
  show(null);
  last = performance.now();
  audio.resume();
}
function gameOver(payload = {}) {
  state = 'over';
  audio.fadeOutMusic(0.7); // the band dies with the car
  audio.crashNoise();
  setTimeout(() => say([Math.random() < 0.5 ? 'nomichaelno' : null, 'gameover'], { volume: 1 }), 250);
  const previousBest = Leaderboard.best();
  hud.best = Leaderboard.recordBest(world.score);
  const newBest = world.score > previousBest && previousBest > 0;
  // portrait: a celebration on a new personal best; otherwise the driver you hit if we have their picture, else a crash picture
  const img = $('#sadGreg');
  assetsAvailable.then((a) => {
    if (newBest) {
      const p = pick(PORTRAITS.celebrate);
      img.src = p.src; img.alt = p.alt;
      return;
    }
    const id = payload.driver ? payload.driver.id : 'you';
    const file = a.drivers.find((f) => f.replace(/\.[^.]+$/, '') === id);
    if (file) {
      img.src = `assets/drivers/${file}`;
      img.alt = payload.driver ? `${payload.driver.name} after you drove into them` : 'You, after the tyre wall';
    } else {
      const p = pick(PORTRAITS.crash);
      img.src = p.src; img.alt = p.alt;
    }
  });
  $('#overKicker').textContent = newBest ? 'Simply lovely' : 'We are checking';
  $('#overTitle').textContent = newBest ? 'New personal best!' : 'Retired';
  screens.over.classList.toggle('newbest', newBest);
  // career + trophies
  const result = Career.record(world.run, GP.points);
  career = result.career;
  hud.points = career.points;
  renderCareer();
  // fill the panel
  $('#finalScore').textContent = String(world.score);
  $('#finalStats').innerHTML = [
    ['Car', world.car.name],
    ['Distance', formatDistance(world.distance)],
    ['Grands Prix', `${world.gps} (+${world.gps * GP.points} pts)`],
    ['Overtakes', world.overtakes],
    ['Close calls', world.closeCalls],
    ['Pit stops', world.pit.stops],
    ['Penalties', world.run.penalties],
    ['Top speed', `${Math.round(world.stats.maxSpeed * SPEED.kmhPerPx)} km/h`],
    ['Best', hud.best],
  ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  $('#unlocked').innerHTML = result.unlocked.length
    ? `<p class="kicker">Trophies unlocked</p>${result.unlocked.map((t) => `<div class="trophy new"><b>🏆 ${t.name}</b><span>${t.desc}</span></div>`).join('')}`
    : '';
  $('#nameInput').value = Leaderboard.playerName();
  $('#submitStatus').textContent = '';
  $('#submitScore').disabled = false;
  // reveal after the crash animation has played
  setTimeout(() => {
    show('over');
    requestAnimationFrame(() => screens.over.classList.add('revealed'));
    ($('#nameInput').value ? $('#submitScore') : $('#nameInput')).focus();
    refreshLeaderboard();
  }, 1300);
}

// ---------- world events → presentation ----------
// Radio messages queue instead of stomping each other: reactions to a moment
// (crash, penalty, wheel gun...) preempt whatever is showing; ambient chatter
// (milestones, weather, the tow) waits its turn so every line can be read.
const RADIO_PREEMPT = new Set([
  'crash', 'puncture', 'penalty', 'oil', 'debris', 'scDeployed', 'scRestart', 'scClean', 'scNeutral', 'scCold', 'scWarm', 'scJump',
  'pitDenied', 'pitRequested', 'pitIn', 'pitGame', 'pitMiss', 'pitLate',
  'pitRecord', 'pitSlow', 'pitOut', 'teammate', 'teammateClose',
]);
const radioQueue = [];
/** Wrong tyres for the weather: slicks on a wet track or wets on a dry one. */
function wrongTyres() {
  const c = COMPOUNDS[world.tyre.compound];
  return (world.rain > 0.35 && c.wet === undefined) || (world.rain < 0.1 && c.wet !== undefined);
}
/** Does the car actually need the next stop (wear, puncture, damage, weather)? */
function carNeedsStop() {
  return world.tyre.punctured || world.tyre.wear > TYRES.cliffStart || world.damage >= DAMAGE.needsStop || wrongTyres();
}
function radio(kind, ctx = {}) {
  // give the pit wall eyes: the line picker can react to the car's actual state
  const c = COMPOUNDS[world.tyre.compound];
  const text = radioLine(kind, {
    ...ctx,
    wear: world.tyre.wear,
    onSlicks: c.wet === undefined,
    onWets: c.wet !== undefined,
    position: positionLabel(world.overtakes),
    urgent: carNeedsStop(),
  });
  if (!text) return;
  const msg = { kind, text, age: 0, dur: clamp(2.2 + text.length * 0.04, 2.6, 4.6) };
  const live = hud.radio && hud.radio.age < hud.radio.dur;
  const speaking = live && hud.radio.kind === 'clip'; // a subtitled clip is on air: never talk over it
  if (!live || (RADIO_PREEMPT.has(kind) && !speaking)) {
    hud.radio = msg;
    radioQueue.length = 0;
    audio.radioClick();
  } else if (RADIO_PREEMPT.has(kind)) {
    radioQueue.unshift(msg);
    radioQueue.length = Math.min(radioQueue.length, 2);
  } else {
    // one message per kind in the queue; keep it short so nothing arrives stale
    const i = radioQueue.findIndex((m) => m.kind === kind);
    if (i >= 0) radioQueue[i] = msg;
    else radioQueue.push(msg);
    if (radioQueue.length > 2) radioQueue.shift();
  }
}
/**
 * Subtitle for a clip, shown the instant the clip starts (audio.play's onStart) so the
 * strip always reads what the speaker is saying. A wall line that had barely been on
 * screen goes back to the front of the queue instead of being lost.
 */
function subtitle(name) {
  const line = clipLine(name);
  if (!line) return;
  if (hud.radio && hud.radio.kind !== 'clip' && hud.radio.age < 1.2 && hud.radio.age < hud.radio.dur) radioQueue.unshift({ ...hud.radio, age: 0 });
  hud.radio = { kind: 'clip', who: line.who, text: line.say, age: 0, dur: clamp(audio.duration(name) + 1.0, 2.6, 6) };
}
/**
 * Voice first: plays the first loaded clip in `names` with its subtitle. Returns the clip
 * name (or false). When `kind` is given and no clip with words played, the pit wall says
 * its own line instead — so every event gets exactly one voice.
 */
function say(names, opts = {}, kind = null, ctx) {
  const played = audio.playAny(names, { ...opts, onStart: subtitle });
  if (kind && !clipLine(played)) radio(kind, ctx);
  return played;
}
function toast(text, color, sub) {
  hud.toast = { text, color, sub, age: 0, dur: sub ? 2.2 : 1.6 };
}
const WHEEL_NAMES = { FL: 'front left', FR: 'front right', RL: 'rear left', RR: 'rear right' };
function onWorldEvent(evt, payload = {}) {
  switch (evt) {
    case 'radio': radio(payload.kind, payload.ctx); break;
    case 'crash': radio('crash', { driver: payload.driver }); gameOver(payload); break;
    case 'closeCall': {
      // the driver's own reaction if we have it (subtitled), else the scream, else tyre squeal
      const v = say([payload.driver?.clip?.close, 'scream'], { volume: 0.7, minGap: 2.5 });
      if (!v) audio.skid(0.25);
      if (!clipLine(v) && (payload.count % 3 === 0 || payload.driver?.legend)) radio('closeCall', { driver: payload.driver });
      break;
    }
    case 'overtake': {
      audio.overtake();
      const v = say([payload.driver?.clip?.overtake], { volume: 0.9, minGap: 6 });
      if (!clipLine(v) && (payload.count % 4 === 1 || payload.driver?.legend)) radio('overtake', { driver: payload.driver });
      break;
    }
    case 'oil': say(['iamstupid', 'sonotright'], { volume: 0.9, minGap: 3 }); audio.skid(0.4); radio('oil'); break;
    // --- the start ---
    case 'light': audio.blip(392, 0.14, 'square', 0.13); break;
    case 'lightsOut':
      audio.startMusic();
      audio.blip(784, 0.25, 'square', 0.16);
      toast('LIGHTS OUT', '#2ecc71', payload.jumped ? 'jump start — no bonus' : 'go go go');
      // Crofty if the clip is loaded (subtitled), otherwise the pit wall
      if (!clipLine(say(['lightsout'], { volume: 1 }))) radio('start');
      break;
    case 'jumpStart': audio.blip(220, 0.15, 'sawtooth', 0.14); radio('jumpStart'); break;
    case 'greatStart': audio.overtake(); toast('GREAT START', '#2ecc71', `${Math.round(payload.reaction * 1000)} ms reaction · +50`); radio('greatStart'); break;
    case 'slowStart': radio('slowStart'); break;
    // --- damage ---
    case 'contact':
      hud.damage = { age: 0, part: payload.part, lost: payload.lost };
      if (payload.cause === 'debris') { audio.skid(0.2); radio('debris'); break; }
      audio.crunch(0.3 + payload.amount / 100);
      audio.skid(0.3);
      if (payload.lost) toast(payload.part === 'wing' ? 'FRONT WING GONE' : 'FLOOR DESTROYED', '#ff3b3b', 'one more hit retires the car — box for repairs');
      radio('contact', { part: payload.part, lost: payload.lost, driver: payload.driver });
      break;
    case 'drs': audio.drs(); toast('DRS', '#2ecc71', `+${ERS.drsRefill} battery`); break;
    case 'pushing': say([Math.random() < 0.4 ? 'hammertime' : null, 'pushing'], { volume: 1, minGap: 10 }, 'pushing'); break;
    case 'milestone':
      toast(`${payload.km} km`, '#ffd400');
      // "pushing like an animal" only when you actually are — not while lifting and coasting
      if (payload.km % 2 === 0 && world.player.throttle > 1.08 && !world.sc.active) say(['pushing'], { volume: 1, minGap: 10 });
      radio('milestone', { km: payload.km });
      break;
    case 'tyresHot': toast('TYRE CLIFF', '#ffd400', 'grip falling away — box soon'); say(['bono'], { volume: 0.9, minGap: 20 }); radio('tyresHot'); break;
    case 'puncture': toast('PUNCTURE', '#ff3b3b', 'limp to the pits'); say(['bono', 'sonotright'], { volume: 0.9, minGap: 3 }); radio('puncture'); break;
    case 'pitOpen':
      // "Box box" is a call, not a notice: only when the car actually needs the stop
      if (carNeedsStop()) say(['boxbox'], { volume: 0.8, minGap: 20 });
      else audio.blip(1046, 0.09, 'sine', 0.12);
      radio('pitOpen');
      break;
    case 'pitIn': radio('pitIn'); break;
    case 'pitRequested': audio.blip(880, 0.08, 'square', 0.15); radio('pitRequested'); break;
    case 'pitDenied': audio.blip(220, 0.12, 'sawtooth', 0.15); radio('pitDenied'); break;
    case 'pitStop': radio('pitGame'); break;
    case 'pitWheel':
      if (payload.result === 'miss') {
        audio.wheelGun(3); audio.skid(0.2);
        say(['wearechecking', 'sonotright'], { volume: 0.9, minGap: 2 });
        radio(payload.timedOut ? 'pitLate' : 'pitMiss', { wheel: WHEEL_NAMES[payload.wheel] });
      } else {
        audio.wheelGun(1);
        if (payload.result === 'perfect') audio.blip(1320, 0.07, 'square', 0.18);
      }
      break;
    case 'pitOut': {
      const c = COMPOUNDS[payload.compound];
      if (payload.record) { audio.fanfare(); toast(`${payload.time.toFixed(2)}s RECORD STOP`, '#7df9ff', `${c.label} fitted`); radio('pitRecord'); }
      else if (payload.clean) { audio.drs(); toast(`${payload.time.toFixed(2)}s`, '#2ecc71', `${c.label} fitted · clean stop`); radio('pitOut'); }
      else { toast(`${payload.time.toFixed(2)}s`, '#ff3b3b', `${c.label} fitted · ${payload.misses} wheel gun problem${payload.misses > 1 ? 's' : ''}`); radio('pitSlow'); }
      break;
    }
    case 'rainStart': {
      const c = COMPOUNDS[world.tyre.compound];
      toast('RAIN', '#7fb2ff', c.wet === undefined ? `on ${c.label.toLowerCase()}s — think about inters` : `${c.label.toLowerCase()}s like it`);
      say(['isthatglock'], { volume: 0.9, minGap: 30 });
      radio('rainStart');
      break;
    }
    case 'rainStop': radio('rainStop'); break;
    case 'compound': {
      const c = COMPOUNDS[payload.compound];
      toast(`${c.label} NEXT`, c.color, 'selected for the next stop');
      radio('compound', { compound: c.label.toLowerCase() + 's' });
      break;
    }
    // --- expansion ---
    case 'chequered': audio.fanfare(); say([Math.random() < 0.5 ? 'getinthere' : 'simplylovely', 'getinthere', 'simplylovely'], { volume: 1, minGap: 5 }); toast('CHEQUERED FLAG', '#fff', `${payload.venue} · +${payload.bonus} · ${GP.points} pts`); radio('chequered', { venue: payload.venue }); break;
    case 'venue': setTimeout(() => radio('venue', { venue: payload.venue.name }), 1800); break; // the renderer shows the round card
    case 'night': setTimeout(() => radio('night'), 4500); break;
    case 'scDeployed': audio.siren(); say(['safetycar', 'wearechecking'], { volume: 0.9 }); toast('SAFETY CAR', '#ffd400', 'no overtaking · lift to hold station'); radio('scDeployed'); break;
    case 'scNeutral': audio.radioClick(); toast('RACE NEUTRALISED', '#ffd400', touch ? 'wiggle your thumb up and down to keep the tyres warm' : '▲▼ weave to keep the tyres warm'); radio('scNeutral'); break;
    case 'scEnding': audio.scEnding(); toast('SC IN THIS LAP', '#ffd400', 'restart coming — overtakes pay double'); radio('scEnding'); break;
    case 'scCount': audio.blip(payload.n === 1 ? 784 : 660, 0.1, 'square', 0.16); break;
    case 'weave': audio.blip(payload.zone === 'hot' ? 300 : 440 + payload.heat * 300, 0.04, 'triangle', 0.08); break;
    case 'scJump': audio.overtake(); toast('JUMP', '#2ecc71', `+${SC_GAME.jumpBonus} on the restart`); radio('scJump'); break;
    case 'scRestart': {
      audio.drs();
      say(['leavemealone'], { volume: 0.9, minGap: 30 });
      const sub = payload.warm === null ? 'overtakes pay double' : payload.warm ? `tyres in the window · overtakes pay double` : 'tyres cold — careful · overtakes pay double';
      toast('GREEN FLAG', payload.warm === false ? '#7df9ff' : '#2ecc71', sub);
      radio(payload.warm === false ? 'scCold' : payload.warm ? 'scWarm' : payload.clean ? 'scClean' : 'scRestart');
      break;
    }
    case 'penalty': audio.penalty(); audio.play('penalty', { volume: 0.9, minGap: 5 }); toast('5s PENALTY', '#ff3b3b', 'overtaking under safety car'); radio('penalty'); break;
    case 'teammate': {
      audio.overtake();
      const v = say(['multi21', payload.driver?.clip?.overtake, 'itsjames'], { volume: 0.9, minGap: 6 });
      toast('MULTI 21', '#e10600');
      if (!clipLine(v)) radio('teammate', { driver: payload.driver });
      break;
    }
    case 'teammateClose': {
      const v = say([payload.driver?.clip?.close, 'scream'], { volume: 0.7, minGap: 2.5 });
      if (!v) audio.skid(0.25);
      if (!clipLine(v)) radio('teammateClose', { driver: payload.driver });
      break;
    }
    case 'tow': radio('tow'); break;
    case 'thunder': audio.play('thunder', { volume: 0.8, minGap: 4 }) || audio.thunder(); if (Math.random() < 0.5) radio('thunder'); break;
    case 'coldTyres': radio('coldTyres'); break;
    default: break;
  }
}

// ---------- input wiring ----------
input.on('confirm', () => {
  if (state === 'title') startGame();
  else if (state === 'paused') resume();
  else if (state === 'over') startGame();
});
input.on('tap', () => { if (state === 'title') startGame(); else if (state === 'paused') resume(); });
input.on('restart', () => { if (state === 'over' || state === 'paused') startGame(); });
input.on('pause', () => { if (state === 'playing') pause(); else if (state === 'paused') resume(); });
input.on('pit', () => { if (state === 'playing' && world.pit.phase !== 'stop') world.requestPit(); });
input.on('action', () => { if (state === 'playing') world.pitAction(); });
input.on('tap', () => { if (state === 'playing') world.pitAction(); });
const boxBtn = $('#boxBtn');
boxBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); if (state === 'playing') world.requestPit(); });
boxBtn.addEventListener('click', (e) => e.preventDefault());
/** Shows the on-screen BOX button while racing; lit only when the window is open. */
let boxBtnKey = '';
function syncBoxButton() {
  const racing = state === 'playing' && !world.gameOver;
  const hidden = !racing || world.pit.inLane;
  const nc = COMPOUNDS[world.nextCompound];
  const label = !racing ? '' : world.pit.requested ? 'BOXING…' : world.pit.open ? 'BOX BOX' : 'BOX';
  const sub = !racing ? '' : world.pit.open ? `fit ${nc.label.toLowerCase()}s · B`
    : world.pit.cooldown > 0 ? 'fresh tyres — stay out' : `window in ${Math.ceil(world.pitCountdown())}s`;
  // this runs every frame: only touch the DOM when something actually changed
  const key = `${hidden}|${world.pit.open}|${world.pit.requested}|${label}|${sub}`;
  if (key === boxBtnKey) return;
  boxBtnKey = key;
  boxBtn.hidden = hidden;
  if (!racing) return;
  boxBtn.classList.toggle('open', world.pit.open);
  boxBtn.classList.toggle('requested', world.pit.requested);
  boxBtn.querySelector('b').textContent = label;
  boxBtn.querySelector('span').textContent = sub;
}
input.on('nav', (dir) => { if (state === 'title') selectCar(CARS[(CARS.indexOf(car) + dir + CARS.length) % CARS.length].id); });
input.on('music', () => { audio.init(); hud.musicOn = audio.toggleMusic(); syncToggles(); });
input.on('sfx', () => { audio.init(); audio.toggleSfx(); syncToggles(); });
input.on('compound', (i) => { if (state === 'playing') world.setNextCompound(COMPOUND_ORDER[i]); });
input.on('compound-next', () => { if (state === 'playing') world.cycleCompound(); });

// ---------- touch pad ----------
const touchPad = $('#touchPad');
const steerHint = $('#steerHint');
const rotateHint = $('#rotateHint');
const tyreBtn = touchPad.querySelector('[data-pad="tyre"]');
const ersBtn = touchPad.querySelector('[data-pad="boost"]');
/** Where the car was (0..1 of the view) when the steering finger came down: touch steering is relative to it. */
let steerAnchor = 0.5;
let steered = false;
input.on('steer-start', () => { steerAnchor = world.player.y / world.height; if (state === 'playing') steered = true; });
if (touch) {
  touchPad.querySelector('[data-slot="box"]').replaceWith(boxBtn);
  input.bindPadButton(touchPad.querySelector('[data-pad="pause"]'), { press: 'pause' });
  input.bindPadButton(tyreBtn, { press: 'compound-next' });
  input.bindPadButton(touchPad.querySelector('[data-pad="left"]'), { hold: 'left' });
  input.bindPadButton(touchPad.querySelector('[data-pad="right"]'), { hold: 'right' });
  input.bindPadButton(ersBtn, { hold: 'boost', press: 'action' }); // doubles as the wheel gun in the box
  touchPad.addEventListener('contextmenu', (e) => e.preventDefault());
}
/** Full screen and landscape where the browser allows it (Android; iOS only via "add to home screen"). */
function goFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (req && !document.fullscreenElement) {
    try { Promise.resolve(req.call(el, { navigationUI: 'hide' })).catch(() => {}); } catch { /* ignore */ }
  }
  try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch { /* not supported */ }
}
let padKey = '';
function syncTouchPad() {
  if (!touch) return;
  const racing = state === 'playing' && !world.gameOver;
  touchPad.hidden = !racing;
  steerHint.hidden = !(racing && !steered && world.racing && world.start.sinceGo < 8);
  const nc = COMPOUNDS[world.nextCompound];
  const empty = world.ers.charge < ERS.minToEngage;
  const key = `${nc.id}|${empty}`;
  if (key === padKey) return;
  padKey = key;
  tyreBtn.style.setProperty('--tyre', nc.color);
  tyreBtn.querySelector('b').textContent = nc.short;
  ersBtn.classList.toggle('empty', empty);
}
// Portrait phone: the track is a landscape thing. Red-flag the race until the phone turns back.
const portrait = matchMedia('(orientation: portrait)');
let pausedByRotation = false;
function syncRotate() {
  const show = touch && portrait.matches && (state === 'playing' || state === 'paused');
  rotateHint.hidden = !show;
  if (show && state === 'playing') { pause(); pausedByRotation = true; }
  else if (!portrait.matches && pausedByRotation) { pausedByRotation = false; if (state === 'paused') resume(); }
}
portrait.addEventListener('change', syncRotate);

$('#startBtn').addEventListener('click', startGame);
$('#resumeBtn').addEventListener('click', resume);
$('#restartBtn').addEventListener('click', startGame);
$('#playAgainBtn').addEventListener('click', startGame);
for (const btn of document.querySelectorAll('[data-music]')) btn.addEventListener('click', () => { audio.init(); hud.musicOn = audio.toggleMusic(); syncToggles(); });
for (const btn of document.querySelectorAll('[data-sfx]')) btn.addEventListener('click', () => { audio.init(); audio.toggleSfx(); syncToggles(); });
const TRACK_LABEL = { mariachi: '🎺 Mariachi', jarabe: '💃 Jarabe', synth: '🎹 Synth' };
for (const sel of document.querySelectorAll('[data-track]')) {
  sel.innerHTML = TRACKS.map((t) => `<option value="${t}">${TRACK_LABEL[t]}</option>`).join('');
  sel.addEventListener('change', () => { audio.init(); audio.setTrack(sel.value); syncToggles(); });
}
input.on('track', () => { audio.init(); audio.toggleTrack(); syncToggles(); toast(TRACK_LABEL[audio.track].toUpperCase(), '#ffd400', 'soundtrack'); });
function syncToggles() {
  for (const b of document.querySelectorAll('[data-music]')) b.textContent = `Music: ${audio.musicOn ? 'on' : 'off'}`;
  for (const b of document.querySelectorAll('[data-sfx]')) b.textContent = `SFX: ${audio.sfxOn ? 'on' : 'off'}`;
  for (const s of document.querySelectorAll('[data-track]')) s.value = audio.track;
}
syncToggles();
$('#titleBest').textContent = hud.best ? `Personal best: ${hud.best}` : '';

// ---------- the garage: pick your car ----------
const carList = $('#carList');
const BAR_SHORT = { speed: 'SPD', accel: 'LAU', handling: 'HDL', tyres: 'TYR', ers: 'ERS' };
carList.innerHTML = CARS.map((c) => `<button type="button" class="car" role="option" data-car="${c.id}" aria-selected="false" style="--team:${teamOfCar(c).primary}" title="${escapeHtml(c.tag)}">
  <canvas width="300" height="92" aria-hidden="true"></canvas><b>${escapeHtml(c.name)}</b>
  <span class="bars">${STAT_BARS.map((b) => { const v = statBars(b.value(c)); return `<small title="${b.label} ${v}/5">${BAR_SHORT[b.key]}</small><i style="--v:${v}"></i>`; }).join('')}</span>
</button>`).join('');
for (const btn of carList.querySelectorAll('[data-car]')) btn.addEventListener('click', () => selectCar(btn.dataset.car));
// the global key handler ignores keys typed on buttons, so a focused card steps through the garage itself
carList.addEventListener('keydown', (e) => {
  const dir = e.code === 'ArrowLeft' || e.code === 'KeyA' ? -1 : e.code === 'ArrowRight' || e.code === 'KeyD' ? 1 : 0;
  if (!dir) return;
  e.preventDefault();
  selectCar(CARS[(CARS.indexOf(car) + dir + CARS.length) % CARS.length].id);
});
/** Paints every card's thumbnail in its livery (the vector car until the sprite sheet has loaded, then again with it). */
function drawCarThumbs() {
  for (const btn of carList.querySelectorAll('[data-car]')) {
    const c = carById(btn.dataset.car);
    const cv = btn.querySelector('canvas');
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.translate(cv.width / 2, cv.height / 2 + 4);
    drawLivery(ctx, assets.sheet, assets.frames, c, 280, 86, 0);
  }
}
function selectCar(id) {
  const next = carById(id);
  const changed = next !== car;
  car = next;
  try { localStorage.setItem(STORAGE_KEYS.car, car.id); } catch { /* ignore */ }
  for (const btn of carList.querySelectorAll('[data-car]')) {
    const on = btn.dataset.car === car.id;
    btn.setAttribute('aria-selected', String(on));
    if (on) btn.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: changed ? 'smooth' : 'instant' });
  }
  const quirks = carQuirks(car);
  $('#carTag').textContent = `${car.name} — ${car.tag}${quirks ? ` (${quirks})` : ''}`;
  if (changed && state === 'title') demoWorld = newDemoWorld(); // the attract mode drives your car
}
drawCarThumbs();
assets.sheet.addEventListener('load', drawCarThumbs);

// ---------- career / trophy cabinet ----------
function renderCareer() {
  const have = new Set(career.trophies);
  $('#careerLine').textContent = career.races
    ? `${career.points} championship pts · ${career.gps} GPs finished · ${(career.metres / 1000).toFixed(1)} km · ${have.size}/${TROPHIES.length} trophies`
    : 'No races yet. Championship starts now.';
  $('#trophyList').innerHTML = TROPHIES.map((t) => `<div class="trophy ${have.has(t.id) ? 'won' : 'locked'}"><b>${have.has(t.id) ? '🏆' : '🔒'} ${t.name}</b><span>${t.desc}</span></div>`).join('');
}
renderCareer();

// ---------- meme pack checklist (which optional clips / portraits are present) ----------
async function renderMemePack() {
  const a = await assetsAvailable;
  const clips = Object.entries(OPTIONAL_CLIPS).map(([id, c]) => { const file = resolveClip(id, a.clips); return { id, ...c, file: file ? `assets/clips/${file}` : `assets/clips/${id}.mp3`, ok: !!file, synth: !!file && file.endsWith('.wav') }; });
  const stems = new Set(a.drivers.map((f) => f.replace(/\.[^.]+$/, '')));
  const drivers = DRIVERS.map((d) => ({ ...d, ok: stems.has(d.id) }));
  const nClips = clips.filter((c) => c.ok).length;
  const nPics = drivers.filter((d) => d.ok).length;
  const nReal = clips.filter((c) => c.ok && !c.synth).length;
  $('#memeSummary').textContent = `${nClips}/${clips.length} clips (${nReal} real, ${nClips - nReal} pit-wall voice) · ${nPics}/${drivers.length} portraits`;
  $('#memeList').innerHTML = clips.map((c) => `<div class="trophy ${c.ok ? (c.synth ? 'locked' : 'won') : 'locked'}"><b>${c.ok ? (c.synth ? '📻' : '🔊') : '🔇'} ${c.desc}</b><span>${c.synth ? `pit-wall voice · replace with assets/clips/${c.id}.mp3` : c.file} — ${c.event}</span></div>`).join('')
    + `<div class="trophy ${nPics ? 'won' : 'locked'}"><b>🖼 Driver portraits</b><span>assets/drivers/&lt;id&gt;.png — shown on the retirement screen when you hit that driver. Present: ${drivers.filter((d) => d.ok).map((d) => d.name).join(', ') || 'none'}</span></div>`;
}
renderMemePack();

$('#scoreForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitted) return;
  submitted = true;
  $('#submitScore').disabled = true;
  $('#submitStatus').textContent = 'Sending…';
  const { online } = await Leaderboard.submit({
    name: $('#nameInput').value, score: world.score, distance: world.distance, overtakes: world.overtakes, stops: world.pit.stops, car: world.car.id,
  });
  $('#submitStatus').textContent = online ? 'Saved to the global leaderboard.' : 'Saved locally (no server reachable).';
  refreshLeaderboard();
});

async function refreshLeaderboard() {
  const list = $('#leaderboardList');
  const { entries, source } = await Leaderboard.fetch();
  $('#leaderboardSource').textContent = source === 'server' ? 'global' : 'this browser';
  list.innerHTML = entries.length
    ? entries.map((e, i) => {
      const c = e.car ? CARS.find((x) => x.id === e.car) : null;
      const swatch = c ? `<span class="swatch" style="background:${teamOfCar(c).primary}" title="${escapeHtml(c.name)}"></span>` : '<span class="swatch none"></span>';
      return `<li><span class="pos">${i + 1}</span>${swatch}<span class="name">${escapeHtml(e.name)}</span><span class="score">${e.score}</span></li>`;
    }).join('')
    : '<li class="empty">No times set yet. Rawe ceek starts now.</li>';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Title screen leaderboard preview
refreshLeaderboard();

// ---------- main loop ----------
/** Attract-mode world, laid out for the real view size so the grid lines up; it drives the car you have picked. */
function newDemoWorld() {
  const w = new World(() => {}, car);
  w.resize(renderer.view.width, renderer.view.height);
  w.reset();
  return w;
}
let demoWorld = newDemoWorld();
selectCar(car.id); // highlight the remembered car now that everything it touches exists
const demoInput = { up: false, down: false, left: false, right: false, boost: false, pointerY: null };
/** A thumb travels less than the car: 1 view-height of drag moves the car this many view-heights. */
const TOUCH_STEER_GAIN = 1.6;

function frame(now) {
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (state === 'paused') dt = 0;

  if (state === 'title') {
    // attract mode: the car drives itself and hazards never touch it
    demoWorld.resize(renderer.view.width, renderer.view.height);
    demoInput.up = false; demoInput.down = false;
    const nearest = demoWorld.hazards.filter((h) => h.x > demoWorld.player.x && h.x < demoWorld.player.x + 420 && h.type !== 'drs' && h.type !== 'oil').sort((a, b) => a.x - b.x)[0];
    if (nearest) {
      const ty = nearest.y > (demoWorld.trackTop + demoWorld.trackBottom) / 2 ? demoWorld.trackTop + 40 : demoWorld.trackBottom - 40;
      if (Math.abs(ty - demoWorld.player.y) > 10) (ty < demoWorld.player.y ? (demoInput.up = true) : (demoInput.down = true));
    }
    demoWorld.hazards = demoWorld.hazards.filter((h) => !(h.type === 'rival' && h.fromBehind));
    demoWorld.update(dt, demoInput);
    if (demoWorld.gameOver) demoWorld = newDemoWorld();
    renderer.render(demoWorld, null, dt);
    syncBoxButton();
    syncTouchPad();
  } else {
    // touch: the finger drags the car from where it was (relative, so the thumb never hides it);
    // mouse: the car follows the cursor's height
    const ptr = input.pointer;
    const st = {
      ...input.held,
      pointerY: !ptr.active ? null : touch ? clamp(steerAnchor + (ptr.y - ptr.y0) * TOUCH_STEER_GAIN, 0, 1) : ptr.y,
      pointerBoost: !touch && ptr.active && ptr.boost,
    };
    if (state === 'playing' || state === 'over') world.update(dt, st);
    if (hud.radio) {
      hud.radio.age += dt;
      // current message done: bring up the next queued one
      if (hud.radio.age >= hud.radio.dur && radioQueue.length) {
        hud.radio = radioQueue.shift();
        audio.radioClick();
      }
    }
    if (hud.toast) hud.toast.age += dt;
    if (hud.damage) hud.damage.age += dt;
    hud.musicOn = audio.musicOn;
    renderer.render(world, hud, dt);
    syncBoxButton();
    syncTouchPad();
    // audio follows the sim
    const ratio = clamp(world.speed / SPEED.max, 0, 1);
    const engineOn = state === 'playing' && !(world.pit.inLane && world.pit.phase === 'stop');
    const throttleNorm = clamp((world.player.throttle - 0.72) / (1.22 - 0.72), 0, 1);
    audio.updateEngine(dt, world.pit.inLane ? 0.04 : ratio, engineOn, world.pit.inLane ? 0.2 : throttleNorm, world.ers.boosting);
    audio.setMusicState(lerp(96, 172, world.intensity), clamp(world.intensity * 1.15 + (world.raining ? 0.1 : 0) + (world.sc.restartTimer > 0 ? 0.2 : 0) - (world.sc.active ? 0.3 : 0), 0, 1));
    // continuous cues that track what is on screen: the tow streaks, the rain, the ERS flames, the flat tyre's sparks
    const playing = state === 'playing';
    audio.updateTow(playing ? world.tow : 0);
    audio.updateRain(playing ? world.rain : 0);
    audio.updateErs(playing && world.ers.boosting, world.ers.charge / ERS.max);
    audio.updatePuncture(playing && world.tyre.punctured && !world.pit.inLane, ratio);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame((t) => { last = t; frame(t); });

// Pause when the tab is hidden so nobody dies in the background.
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'playing') pause(); });
syncRotate();

// Debug hook (used by the smoke test): window.raweCeek.world etc.
window.raweCeek = { get world() { return world; }, get state() { return state; }, get car() { return car; }, startGame, pause, resume, selectCar };
