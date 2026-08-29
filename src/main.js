// Bootstrap: wires input, world, renderer, audio and the DOM screens together.
import { COMPOUNDS, COMPOUND_ORDER, GP, SPEED, VENUES, WORLD } from './config.js';
import { Input } from './input.js';
import { World } from './world.js';
import { Renderer } from './render.js';
import { AudioEngine } from './audio.js';
import { radioLine } from './radio.js';
import { Leaderboard } from './leaderboard.js';
import { Career, TROPHIES } from './career.js';
import { DRIVERS, OPTIONAL_CLIPS, resolveClip } from './grid.js';
import { clamp, formatDistance, lerp } from './logic.js';

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
const audio = new AudioEngine();
// Which optional meme-pack files exist (empty when opened from disk / no server).
const assetsAvailable = fetch('/api/assets', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  .then((a) => a && Array.isArray(a.clips) ? { engine: [], ...a } : { clips: [], drivers: [], engine: [] });
audio.setAvailable(assetsAvailable);
const renderer = new Renderer(canvas, assets);
let career = Career.load();
const hud = { radio: null, toast: null, best: Leaderboard.best(), musicOn: audio.musicOn, points: career.points };

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
  audio.play('lightsout', { volume: 1 });
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
function gameOver(payload = {}) {
  state = 'over';
  audio.stopMusic();
  audio.crashNoise();
  setTimeout(() => audio.playAny([Math.random() < 0.5 ? 'nomichaelno' : null, 'gameover'], { volume: 1 }), 250);
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
function radio(kind, ctx) {
  const text = radioLine(kind, ctx);
  if (text) { hud.radio = { text, age: 0 }; audio.radioClick(); }
}
function toast(text, color, sub) {
  hud.toast = { text, color, sub, age: 0 };
}
function onWorldEvent(evt, payload = {}) {
  switch (evt) {
    case 'radio': radio(payload.kind, payload.ctx); break;
    case 'crash': radio('crash', { driver: payload.driver }); gameOver(payload); break;
    case 'closeCall':
      audio.playAny([payload.driver?.clip?.close, 'scream'], { volume: 0.7, minGap: 2.5 }) || audio.skid(0.25);
      if (payload.count % 3 === 0 || payload.driver?.legend) radio('closeCall', { driver: payload.driver });
      break;
    case 'overtake':
      audio.overtake();
      if (payload.driver?.clip?.overtake && audio.play(payload.driver.clip.overtake, { volume: 0.9, minGap: 6 })) radio('overtake', { driver: payload.driver });
      else if (payload.count % 4 === 1 || payload.driver?.legend) radio('overtake', { driver: payload.driver });
      break;
    case 'oil': audio.playAny(['iamstupid', 'sonotright'], { volume: 0.9, minGap: 3 }); audio.skid(0.4); radio('oil'); break;
    case 'debris': audio.skid(0.2); radio('debris'); break;
    case 'drs': audio.drs(); toast('DRS', '#2ecc71'); break;
    case 'pushing': audio.playAny([Math.random() < 0.4 ? 'hammertime' : null, 'pushing'], { volume: 1, minGap: 10 }); radio('pushing'); break;
    case 'milestone':
      toast(`${payload.km} km`, '#ffd400');
      radio('milestone');
      if (payload.km % 2 === 0) audio.play('pushing', { volume: 1, minGap: 10 });
      break;
    case 'tyresHot': radio('tyresHot'); audio.play('bono', { volume: 0.9, minGap: 20 }); break;
    case 'puncture': toast('PUNCTURE', '#ff3b3b'); radio('puncture'); audio.playAny(['bono', 'sonotright'], { volume: 0.9, minGap: 3 }); break;
    case 'pitOpen': radio('pitOpen'); audio.play('boxbox', { volume: 0.8, minGap: 20 }); break;
    case 'pitIn': radio('pitIn'); break;
    case 'pitRequested': audio.blip(880, 0.08, 'square', 0.15); radio('pitRequested'); break;
    case 'pitDenied': audio.blip(220, 0.12, 'sawtooth', 0.15); radio('pitDenied'); break;
    case 'pitStop': radio('pitGame'); break;
    case 'pitWheel':
      if (payload.result === 'miss') {
        audio.wheelGun(3); audio.skid(0.2);
        audio.playAny(['wearechecking', 'sonotright'], { volume: 0.9, minGap: 2 });
        radio(payload.timedOut ? 'pitLate' : 'pitMiss');
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
    case 'rainStart': radio('rainStart'); toast('RAIN', '#7fb2ff'); audio.play('isthatglock', { volume: 0.9, minGap: 30 }); break;
    case 'rainStop': radio('rainStop'); break;
    case 'compound': radio('compound', { compound: COMPOUNDS[payload.compound].label.toLowerCase() + 's' }); break;
    // --- expansion ---
    case 'chequered': audio.fanfare(); audio.playAny([Math.random() < 0.5 ? 'getinthere' : 'simplylovely', 'getinthere', 'simplylovely'], { volume: 1, minGap: 5 }); toast('CHEQUERED FLAG', '#fff', `${payload.venue} · +${payload.bonus} · ${GP.points} pts`); radio('chequered'); break;
    case 'venue': setTimeout(() => { toast(`${payload.venue.flag} ${payload.venue.name.toUpperCase()}`, '#ffd400', `Round ${payload.index + 1} of ${VENUES.length}`); radio('venue', { venue: payload.venue.name }); }, 1800); break;
    case 'night': setTimeout(() => radio('night'), 4500); break;
    case 'scDeployed': audio.siren(); audio.playAny(['safetycar', 'wearechecking'], { volume: 0.9 }); toast('SAFETY CAR', '#ffd400', 'no overtaking'); radio('scDeployed'); break;
    case 'scEnding': radio('scEnding'); break;
    case 'scRestart': audio.drs(); audio.play('leavemealone', { volume: 0.9, minGap: 30 }); toast('GREEN FLAG', '#2ecc71', 'overtakes pay double'); radio(payload.clean ? 'scClean' : 'scRestart'); break;
    case 'penalty': audio.penalty(); audio.play('penalty', { volume: 0.9, minGap: 5 }); toast('5s PENALTY', '#ff3b3b', 'overtaking under safety car'); radio('penalty'); break;
    case 'teammate': audio.overtake(); audio.playAny(['multi21', payload.driver?.clip?.overtake, 'itsjames'], { volume: 0.9, minGap: 6 }); toast('MULTI 21', '#e10600'); radio('teammate', { driver: payload.driver }); break;
    case 'teammateClose': audio.playAny([payload.driver?.clip?.close, 'scream'], { volume: 0.7, minGap: 2.5 }) || audio.skid(0.25); radio('teammateClose', { driver: payload.driver }); break;
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
function syncBoxButton() {
  const racing = state === 'playing' && !world.gameOver;
  boxBtn.hidden = !racing || world.pit.inLane;
  if (!racing) return;
  boxBtn.classList.toggle('open', world.pit.open);
  boxBtn.classList.toggle('requested', world.pit.requested);
  const nc = COMPOUNDS[world.nextCompound];
  boxBtn.querySelector('b').textContent = world.pit.requested ? 'BOXING…' : world.pit.open ? 'BOX BOX' : 'BOX';
  boxBtn.querySelector('span').textContent = world.pit.open ? `fit ${nc.label.toLowerCase()}s · B`
    : world.pit.cooldown > 0 ? 'fresh tyres — stay out' : `window in ${Math.ceil(world.pitCountdown())}s`;
}
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
const TRACK_LABEL = { mariachi: '🎺 Mariachi', synth: '🎹 Synth' };
for (const btn of document.querySelectorAll('[data-track]')) btn.addEventListener('click', () => { audio.init(); audio.toggleTrack(); syncToggles(); });
input.on('track', () => { audio.init(); audio.toggleTrack(); syncToggles(); toast(TRACK_LABEL[audio.track].toUpperCase(), '#ffd400', 'soundtrack'); });
function syncToggles() {
  for (const b of document.querySelectorAll('[data-music]')) b.textContent = `Music: ${audio.musicOn ? 'on' : 'off'}`;
  for (const b of document.querySelectorAll('[data-sfx]')) b.textContent = `SFX: ${audio.sfxOn ? 'on' : 'off'}`;
  for (const b of document.querySelectorAll('[data-track]')) b.textContent = `Soundtrack: ${TRACK_LABEL[audio.track]}`;
}
syncToggles();
$('#titleBest').textContent = hud.best ? `Personal best: ${hud.best}` : '';

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
    boxBtn.hidden = true;
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
    syncBoxButton();
    // audio follows the sim
    const ratio = clamp(world.speed / SPEED.max, 0, 1);
    const engineOn = state === 'playing' && !(world.pit.inLane && world.pit.phase === 'stop');
    const throttleNorm = clamp((world.player.throttle - 0.72) / (1.22 - 0.72), 0, 1);
    audio.updateEngine(dt, world.pit.inLane ? 0.04 : ratio, engineOn, world.pit.inLane ? 0.2 : throttleNorm, world.ers.boosting);
    audio.setMusicState(lerp(96, 172, world.intensity), clamp(world.intensity * 1.15 + (world.raining ? 0.1 : 0) + (world.sc.restartTimer > 0 ? 0.2 : 0) - (world.sc.active ? 0.3 : 0), 0, 1));
    audio.updateTow(state === 'playing' ? world.tow : 0);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame((t) => { last = t; frame(t); });

// Pause when the tab is hidden so nobody dies in the background.
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'playing') pause(); });

// Debug hook (used by the smoke test): window.raweCeek.world etc.
window.raweCeek = { get world() { return world; }, get state() { return state; }, startGame, pause, resume };
