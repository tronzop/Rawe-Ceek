// Bootstrap: wires input, world, renderer, audio and the DOM screens together.
import { COMPOUNDS, COMPOUND_ORDER, SPEED, WORLD } from './config.js';
import { Input } from './input.js';
import { World } from './world.js';
import { Renderer } from './render.js';
import { AudioEngine } from './audio.js';
import { radioLine } from './radio.js';
import { Leaderboard } from './leaderboard.js';
import { clamp, formatDistance, lerp } from './logic.js';

const $ = (sel) => document.querySelector(sel);
const canvas = $('#game');
const screens = { title: $('#titleScreen'), pause: $('#pauseScreen'), over: $('#gameOverScreen') };

const assets = { sheet: new Image(), frames: 8 };
assets.sheet.src = 'assets/ferrari_sheet.png';

const input = new Input(canvas);
const audio = new AudioEngine();
const renderer = new Renderer(canvas, assets);
const hud = { radio: null, toast: null, best: Leaderboard.best(), musicOn: audio.musicOn };

let state = 'title'; // title | playing | paused | over
let world = new World(onWorldEvent);
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
  world = new World(onWorldEvent);
  fit();
  world.reset();
  fit();
  hud.radio = null;
  hud.toast = null;
  submitted = false;
  state = 'playing';
  show(null);
  audio.resume();
  audio.startMusic();
  radio('start');
  $('#gameOverScreen').classList.remove('revealed');
}
function pause() {
  if (state !== 'playing') return;
  state = 'paused';
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
function gameOver() {
  state = 'over';
  audio.stopMusic();
  audio.crashNoise();
  setTimeout(() => audio.play('gameover', { volume: 1 }), 250);
  hud.best = Leaderboard.recordBest(world.score);
  // fill the panel
  $('#finalScore').textContent = String(world.score);
  $('#finalStats').innerHTML = [
    ['Distance', formatDistance(world.distance)],
    ['Overtakes', world.overtakes],
    ['Close calls', world.closeCalls],
    ['Pit stops', world.pit.stops],
    ['Top speed', `${Math.round(world.stats.maxSpeed * SPEED.kmhPerPx)} km/h`],
    ['Best', hud.best],
  ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
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
function radio(kind, ctx) {
  const text = radioLine(kind, ctx);
  if (text) hud.radio = { text, age: 0 };
}
function toast(text, color) {
  hud.toast = { text, color, age: 0 };
}
function onWorldEvent(evt, payload = {}) {
  switch (evt) {
    case 'radio': radio(payload.kind, payload.ctx); break;
    case 'crash': radio('crash'); gameOver(); break;
    case 'closeCall':
      audio.play('scream', { volume: 0.7, minGap: 2.5 }) || audio.skid(0.25);
      if (payload.count % 3 === 0) radio('closeCall');
      break;
    case 'overtake': audio.overtake(); if (payload.count % 4 === 1) radio('overtake'); break;
    case 'oil': audio.play('sonotright', { volume: 0.9, minGap: 3 }); audio.skid(0.4); radio('oil'); break;
    case 'debris': audio.skid(0.2); radio('debris'); break;
    case 'drs': audio.drs(); toast('DRS', '#2ecc71'); break;
    case 'pushing': audio.play('pushing', { volume: 1, minGap: 10 }); radio('pushing'); break;
    case 'milestone':
      toast(`${payload.km} km`, '#ffd400');
      radio('milestone');
      if (payload.km % 2 === 0) audio.play('pushing', { volume: 1, minGap: 10 });
      break;
    case 'tyresHot': radio('tyresHot'); break;
    case 'puncture': toast('PUNCTURE', '#ff3b3b'); radio('puncture'); audio.play('sonotright', { volume: 0.9, minGap: 3 }); break;
    case 'pitOpen': radio('pitOpen'); break;
    case 'pitIn': radio('pitIn'); break;
    case 'pitStop':
      audio.wheelGun(payload.slow ? 9 : 4);
      if (payload.slow) { radio('pitSlow'); toast('SO NOT RIGHT', '#ff3b3b'); audio.play('sonotright', { volume: 0.9 }); }
      break;
    case 'pitOut': radio('pitOut'); toast(`${COMPOUNDS[payload.compound].label} FITTED`, COMPOUNDS[payload.compound].color); break;
    case 'rainStart': radio('rainStart'); toast('RAIN', '#7fb2ff'); break;
    case 'rainStop': radio('rainStop'); break;
    case 'compound': radio('compound', { compound: COMPOUNDS[payload.compound].label.toLowerCase() + 's' }); break;
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
input.on('music', () => { audio.init(); hud.musicOn = audio.toggleMusic(); syncToggles(); });
input.on('sfx', () => { audio.init(); audio.toggleSfx(); syncToggles(); });
input.on('compound', (i) => { if (state === 'playing') world.setNextCompound(COMPOUND_ORDER[i]); });
input.on('compound-next', () => { if (state === 'playing') world.cycleCompound(); });

$('#startBtn').addEventListener('click', startGame);
$('#resumeBtn').addEventListener('click', resume);
$('#restartBtn').addEventListener('click', startGame);
$('#playAgainBtn').addEventListener('click', startGame);
for (const btn of document.querySelectorAll('[data-music]')) btn.addEventListener('click', () => { audio.init(); hud.musicOn = audio.toggleMusic(); syncToggles(); });
for (const btn of document.querySelectorAll('[data-sfx]')) btn.addEventListener('click', () => { audio.init(); audio.toggleSfx(); syncToggles(); });
function syncToggles() {
  for (const b of document.querySelectorAll('[data-music]')) b.textContent = `Music: ${audio.musicOn ? 'on' : 'off'}`;
  for (const b of document.querySelectorAll('[data-sfx]')) b.textContent = `SFX: ${audio.sfxOn ? 'on' : 'off'}`;
}
syncToggles();
$('#titleBest').textContent = hud.best ? `Personal best: ${hud.best}` : '';

$('#scoreForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitted) return;
  submitted = true;
  $('#submitScore').disabled = true;
  $('#submitStatus').textContent = 'Sending…';
  const { online } = await Leaderboard.submit({
    name: $('#nameInput').value, score: world.score, distance: world.distance, overtakes: world.overtakes, stops: world.pit.stops,
  });
  $('#submitStatus').textContent = online ? 'Saved to the global leaderboard.' : 'Saved locally (no server reachable).';
  refreshLeaderboard();
});

async function refreshLeaderboard() {
  const list = $('#leaderboardList');
  const { entries, source } = await Leaderboard.fetch();
  $('#leaderboardSource').textContent = source === 'server' ? 'global' : 'this browser';
  list.innerHTML = entries.length
    ? entries.map((e, i) => `<li><span class="pos">${i + 1}</span><span class="name">${escapeHtml(e.name)}</span><span class="score">${e.score}</span></li>`).join('')
    : '<li class="empty">No times set yet. Rawe ceek starts now.</li>';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Title screen leaderboard preview
refreshLeaderboard();

// ---------- main loop ----------
let demoWorld = new World(() => {});
demoWorld.resize(renderer.view.width, renderer.view.height);
const demoInput = { up: false, down: false, left: false, right: false, boost: false, pointerY: null };

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
    if (demoWorld.gameOver) { demoWorld = new World(() => {}); demoWorld.resize(renderer.view.width, renderer.view.height); }
    renderer.render(demoWorld, null, dt);
  } else {
    const st = {
      ...input.state,
      pointerY: input.pointer.active ? input.pointer.y : null,
      pointerBoost: input.pointer.active && input.pointer.boost,
    };
    if (state === 'playing' || state === 'over') world.update(dt, st);
    if (hud.radio) hud.radio.age += dt;
    if (hud.toast) hud.toast.age += dt;
    hud.musicOn = audio.musicOn;
    renderer.render(world, hud, dt);
    // audio follows the sim
    const ratio = clamp(world.speed / SPEED.max, 0, 1);
    audio.updateEngine(dt, ratio, state === 'playing' && !world.pit.inLane || (state === 'playing' && world.pit.phase !== 'stop'));
    audio.setMusicState(lerp(96, 172, world.intensity), clamp(world.intensity * 1.15 + (world.raining ? 0.1 : 0), 0, 1));
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame((t) => { last = t; frame(t); });

// Pause when the tab is hidden so nobody dies in the background.
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'playing') pause(); });

// Debug hook (used by the smoke test): window.raweCeek.world etc.
window.raweCeek = { get world() { return world; }, get state() { return state; }, startGame, pause, resume };
