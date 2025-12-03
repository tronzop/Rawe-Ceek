const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const restartBtn = document.getElementById('restart');
const pauseBtn = document.getElementById('pause');
const musicToggle = document.getElementById('musicToggle');
const uploadSfxBtn = document.getElementById('uploadSfx');
const gameoverFileInput = document.getElementById('gameoverFile');
const sfxStatusEl = document.getElementById('sfxStatus');
const skinStatusEl = document.getElementById('skinStatus');

// Keep canvas pixel ratio sharp
function fitCanvas() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

// Player config - now rendered as an animated Formula 1 car (visual only).
const player = {
  x: canvas.width / 2 / (window.devicePixelRatio || 1),
  y: canvas.height / 2 / (window.devicePixelRatio || 1),
  r: 14,            // collision radius (keeps simpler circle collision)
  speed: 240,       // px/s movement speed
  angle: 0,         // current facing angle (radians)
  targetAngle: 0,   // where the car should rotate to (based on movement)
  w: 46,            // visual width of car body (CSS px)
  h: 18,            // visual height of car body (CSS px)
  wheelRotation: 0, // used for wheel animation
  livery: '#e21b1b', // primary color - editable for skins
  accent: '#ffd700', // accent color
  exhaustIntensity: 0, // 0..1 -> more when moving fast
};

// Input state
const keys = { up: false, down: false, left: false, right: false };

window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'w') keys.up = true;
  if (e.key === 'ArrowDown' || e.key === 's') keys.down = true;
  if (e.key === 'ArrowLeft' || e.key === 'a') keys.left = true;
  if (e.key === 'ArrowRight' || e.key === 'd') keys.right = true;
  if (e.key === 'p') togglePause();
  if (e.key === 'm') toggleMusic();
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'w') keys.up = false;
  if (e.key === 'ArrowDown' || e.key === 's') keys.down = false;
  if (e.key === 'ArrowLeft' || e.key === 'a') keys.left = false;
  if (e.key === 'ArrowRight' || e.key === 'd') keys.right = false;
});

// Enemies (circles) list and spawn config
let enemies = [];
let spawnTimer = 0; // seconds
let spawnInterval = 1.6; // how frequently enemies spawn
let elapsed = 0; // seconds survived
let lastTime = performance.now();
let running = true;
let highScore = 0;

// Audio / tempo
let audioCtx = null;
let isMusicOn = false;
let beatTimer = null; // id for scheduled beat
const baseBpm = 90; // starting bpm

function getBpm() {
  // tie bpm to time survived (elapsed increases only while running)
  // grows gradually and caps so it doesn't get out of control
  return baseBpm + Math.min(150, elapsed * 1.8);
}

function createAudio() {
  if (audioCtx) return audioCtx;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // when the audio context is created (user gesture), attempt to pre-load and decode
  // an in-repo fallback asset at /assets/gameover.mp3 so it plays reliably at game over
  loadAudioBufferFromUrl('/assets/gameover.mp3').then(buf => {
    if (buf) {
      gameOverBuffer = buf;
      console.info('Loaded /assets/gameover.mp3 into AudioBuffer (game-over SFX).');
      if (sfxStatusEl) sfxStatusEl.textContent = 'SFX ready: gameover.mp3';
    }
  }).catch(() => {});
  return audioCtx;
}

// create a noise buffer for hats/snare
function createNoiseBuffer() {
  const ctx = createAudio();
  const buf = ctx.createBuffer(1, ctx.sampleRate * 1, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

let noiseBuffer = null;
// car sprite support
let carSprite = new Image();
let carSpriteLoaded = false;
carSprite.onload = () => { carSpriteLoaded = true; if (skinStatusEl) skinStatusEl.textContent = 'Skin ready: ferrari f1.png'; processCarSprite(carSprite); };
carSprite.onerror = () => { carSpriteLoaded = false; if (skinStatusEl) skinStatusEl.textContent = 'Skin not found'; };
// start loading (URL contains a space, encode it)
carSprite.src = encodeURI('/assets/ferrari f1.png');

// processed sprite (white background removed) and hit polygon
let carSpriteCanvas = null;       // offscreen canvas for processed sprite
let carHitPolygon = null;         // array of points [{x,y}, ...] in sprite pixel coordinates centered at (0,0)

// particle smoke system for rear of car
const particles = [];
function spawnSmoke(x, y, vx, vy, size, life, alpha) {
  particles.push({ x, y, vx, vy, size, life, age: 0, alpha });
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.age += dt;
    if (p.age >= p.life) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.size += dt * 6;
  }
}

function drawParticles(ctx) {
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const t = 1 - (p.age / p.life);
    ctx.save();
    ctx.globalAlpha = p.alpha * t;
    const g = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, p.size);
    const c = Math.floor(120 + t * 60); // smoke color range
    g.addColorStop(0, `rgba(${c},${c},${c},${0.9 * t})`);
    g.addColorStop(1, `rgba(${c},${c},${c},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(p.x, p.y, p.size, p.size * 0.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

// helper: compute convex hull (monotone chain) for a set of 2D points
function convexHull(points) {
  if (!points || points.length <= 2) return points.slice();
  const pts = points.slice().sort((a,b) => a.x === b.x ? a.y - b.y : a.x - b.x);
  const cross = (o,a,b) => (a.x - o.x)*(b.y - o.y) - (a.y - o.y)*(b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length -1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// helper: sample sprite alpha and build polygon (convex hull) centered at image center
function buildHitPolygonFromImage(img, sampleStep = 3) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const cx = c.getContext('2d'); cx.drawImage(img, 0, 0, w, h);
  const id = cx.getImageData(0, 0, w, h).data;
  const points = [];
  for (let y = 0; y < h; y += sampleStep) {
    for (let x = 0; x < w; x += sampleStep) {
      const idx = (y * w + x) * 4;
      const a = id[idx+3]; // alpha
      if (a > 40) {
        points.push({ x: x - w/2, y: y - h/2 });
      }
    }
  }
  if (points.length === 0) return null;
  return convexHull(points);
}

// process loaded sprite to remove white background and compute hit polygon
function processCarSprite(img) {
  try {
    const w = img.naturalWidth, h = img.naturalHeight;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
    const id = cx.getImageData(0, 0, w, h);
    const data = id.data;
    // remove white / near white background: set alpha=0 for pixels that are close to white
    // Use a more forgiving threshold and also run a small denoise pass to remove speckles
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      // white-ish detection by distance from pure white (0..765 max) — tuned threshold
      const distFromWhite = (255 - r) + (255 - g) + (255 - b);
      if (distFromWhite < 40) {
        data[i+3] = 0; // near-white -> transparent
      }
    }

    // denoise: remove isolated pixels with few opaque neighbors (cleans noisy outline pixels)
    const cw = c.width, ch = c.height;
    const copy = new Uint8ClampedArray(data); // snapshot
    for (let y = 1; y < ch - 1; y++) {
      for (let x = 1; x < cw - 1; x++) {
        const idx = (y * cw + x) * 4 + 3; // alpha index
        if (copy[idx] === 0) continue; // already transparent
        // count opaque neighbors
        let count = 0;
        for (let ny = -1; ny <= 1; ny++) {
          for (let nx = -1; nx <= 1; nx++) {
            if (nx === 0 && ny === 0) continue;
            const nidx = ((y + ny) * cw + (x + nx)) * 4 + 3;
            if (copy[nidx] > 40) count++;
          }
        }
        // if less than 2 opaque neighbors, consider it a speck and remove
        if (count < 2) data[idx] = 0;
      }
    }
    cx.putImageData(id, 0, 0);
    carSpriteCanvas = c;
    // compute hit polygon from alpha mask
    carHitPolygon = buildHitPolygonFromImage(c, 4); // sample every 4px
    if (skinStatusEl) {
      if (carHitPolygon && carHitPolygon.length > 0) skinStatusEl.textContent = 'Skin ready: ferrari f1.png (hitbox computed)';
      else skinStatusEl.textContent = 'Skin ready: ferrari f1.png (no visible pixels found)';
    }
  } catch (e) {
    console.warn('processCarSprite failed', e);
  }
}
let gameOverBuffer = null; // decoded AudioBuffer to play on game over
let gameOverAudioElement = null; // fallback HTMLAudioElement if external asset exists
let gameOverPlayed = false; // ensure we play sound only once per game over

function playKick(time = 0) {
  const ctx = createAudio();
  const t = ctx.currentTime + (time || 0.02);
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.28);
  g.gain.setValueAtTime(1, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
  o.connect(g); g.connect(ctx.destination);
  o.start(t); o.stop(t + 0.35);
}

function playHat(time = 0, vel = 0.25) {
  const ctx = createAudio();
  const t = ctx.currentTime + (time || 0.02);
  const src = ctx.createBufferSource();
  if (!noiseBuffer) noiseBuffer = createNoiseBuffer();
  src.buffer = noiseBuffer;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 7000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vel, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  src.connect(hp); hp.connect(g); g.connect(ctx.destination);
  src.start(t); src.stop(t + 0.08);
}

function playSnare(time = 0, vel = 0.6) {
  const ctx = createAudio();
  const t = ctx.currentTime + (time || 0.02);
  const src = ctx.createBufferSource();
  if (!noiseBuffer) noiseBuffer = createNoiseBuffer();
  src.buffer = noiseBuffer;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800;
  const g = ctx.createGain(); g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
  src.connect(bp); bp.connect(g); g.connect(ctx.destination);
  src.start(t); src.stop(t + 0.3);
}

// optional fallback if an asset exists at /assets/gameover.mp3
function preloadAssetGameOver() {
  try {
    gameOverAudioElement = new Audio('/assets/gameover.mp3');
    if (sfxStatusEl) sfxStatusEl.textContent = 'SFX available: gameover.mp3 (fallback)';
  } catch (e) {
    gameOverAudioElement = null;
  }
}

// decode audio from URL into an AudioBuffer (returns null on failure)
async function loadAudioBufferFromUrl(url) {
  try {
    const ctx = createAudio();
    const res = await fetch(url);
    if (!res.ok) throw new Error('not found');
    const ab = await res.arrayBuffer();
    const decoded = await ctx.decodeAudioData(ab);
    return decoded;
  } catch (err) {
    return null;
  }
}

// allow user to upload a file and decode into gameOverBuffer
gameoverFileInput.addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  // create AudioContext on user gesture and decode
  createAudio();
  const fr = new FileReader();
  fr.onload = async () => {
    try {
      const ab = fr.result;
      const decoded = await audioCtx.decodeAudioData(ab.slice ? ab.slice(0) : ab);
      gameOverBuffer = decoded;
      gameOverAudioElement = null; // prefer buffer
      if (sfxStatusEl) sfxStatusEl.textContent = `SFX uploaded: ${f.name}`;
    } catch (e) {
      console.warn('Failed to decode uploaded SFX', e);
    }
  };
  fr.readAsArrayBuffer(f);
});

uploadSfxBtn.addEventListener('click', () => { gameoverFileInput.click(); });

function rand(min, max) { return Math.random() * (max - min) + min; }

// geometry helpers
function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi + 0.0000001) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function distToSegmentSq(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1, vy = y2 - y1;
  const wx = px - x1, wy = py - y1;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return wx*wx + wy*wy;
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) {
    const dx = px - x2, dy = py - y2; return dx*dx + dy*dy;
  }
  const t = c1 / c2;
  const projx = x1 + vx * t, projy = y1 + vy * t;
  const dx = px - projx, dy = py - projy; return dx*dx + dy*dy;
}

function circleIntersectsPolygon(cx, cy, r, poly) {
  if (!poly || poly.length === 0) return false;
  // if center inside polygon, collision true
  if (pointInPolygon(cx, cy, poly)) return true;
  const r2 = r * r;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i+1) % poly.length];
    if (distToSegmentSq(cx, cy, a.x, a.y, b.x, b.y) <= r2) return true;
  }
  return false;
}

function spawnEnemy() {
  // Spawn along one of the edges outside the canvas
  const edge = Math.floor(rand(0, 4));
  let x, y;
  const vw = canvas.width / (window.devicePixelRatio || 1);
  const vh = canvas.height / (window.devicePixelRatio || 1);
  if (edge === 0) { x = -30; y = rand(0, vh); }
  if (edge === 1) { x = vw + 30; y = rand(0, vh); }
  if (edge === 2) { x = rand(0, vw); y = -30; }
  if (edge === 3) { x = rand(0, vw); y = vh + 30; }

  // choose a Pirelli compound type for visual variety (and optionally tune speed)
  const compounds = [
    { id: 'soft', name: 'Soft', color: '#ff5c5c', rim: '#111', speedMult: 1.15 },
    { id: 'medium', name: 'Medium', color: '#ffd100', rim: '#111', speedMult: 1.0 },
    { id: 'hard', name: 'Hard', color: '#f4f4f4', rim: '#111', speedMult: 0.9 },
    { id: 'inter', name: 'Intermediate', color: '#00a86b', rim: '#111', speedMult: 1.02 },
    { id: 'wet', name: 'Wet', color: '#0080ff', rim: '#111', speedMult: 0.95 },
  ];
  const compound = compounds[Math.floor(rand(0, compounds.length))];

  // target roughly towards player with some variation
  const angleToPlayer = Math.atan2(player.y - y, player.x - x);
  // base speed increases with elapsed, then we scale by tempo so enemies mirror the music intensity
  const baseSpeed = rand(60, 160) + Math.min(200, elapsed * 4);
  const bpm = getBpm();
  const tempoFactor = 1 + Math.min(1.5, (bpm - baseBpm) / baseBpm);
  const speed = baseSpeed * tempoFactor * (compound.speedMult || 1);
  const vx = Math.cos(angleToPlayer + rand(-0.5, 0.5)) * speed;
  const vy = Math.sin(angleToPlayer + rand(-0.5, 0.5)) * speed;
  const r = rand(10, 28) * (1 + Math.min(2, elapsed / 30));

  enemies.push({ x, y, vx, vy, r, compound });
}

function resetGame() {
  const vw = canvas.width / (window.devicePixelRatio || 1);
  const vh = canvas.height / (window.devicePixelRatio || 1);
  player.x = vw / 2;
  player.y = vh / 2;
  enemies = [];
  spawnTimer = 0;
  spawnInterval = 1.6;
  elapsed = 0;
  lastTime = performance.now();
  running = true;
  gameOverPlayed = false;
  hideGameOverPanel();
}

restartBtn.addEventListener('click', () => { resetGame(); });
pauseBtn.addEventListener('click', () => { togglePause(); });
musicToggle.addEventListener('click', () => { toggleMusic(); });

function togglePause() {
  running = !running;
  pauseBtn.textContent = running ? 'Pause' : 'Resume';
  // reset lastTime to avoid big dt when resuming
  lastTime = performance.now();
  // pause or resume audio so music follows gameplay
  if (audioCtx) {
    if (!running && audioCtx.state === 'running') audioCtx.suspend();
    if (running && isMusicOn && audioCtx.state === 'suspended') audioCtx.resume();
  }
}

function toggleMusic() {
  // ensure audio context is created on user gesture
  createAudio();
  if (!isMusicOn) {
    // start music (and resume audio context on some browsers)
    isMusicOn = true;
    musicToggle.classList.add('active');
    if (audioCtx.state === 'suspended') audioCtx.resume();
    startBeatLoop();
  } else {
    isMusicOn = false;
    musicToggle.classList.remove('active');
    stopBeatLoop();
  }
}

function startBeatLoop() {
  stopBeatLoop();
  if (!isMusicOn) return;
  // schedule a simple recursive timeout that recalculates bpm from elapsed
  const tick = () => {
    if (!isMusicOn) return;
    // bpm and interval
    const bpm = getBpm();
    const ms = 60000 / bpm;
    // intensity increases over time — every ~15s add more elements
    const intensity = Math.floor(Math.min(4, elapsed / 15));

    // play main kick
    playKick();

    // add snare/clap on off-beat when intense
    if (intensity >= 2) setTimeout(() => playSnare(), Math.floor(ms / 2));

    // hats — subdivisions increase with intensity
    const hats = 1 + intensity; // 1..5
    for (let i = 0; i < hats; i++) {
      setTimeout(() => playHat(undefined, 0.08 + intensity * 0.04), Math.floor((ms / hats) * i));
    }

    // small random jitter so loop doesn't feel too mechanical
    const jitter = (Math.random() - 0.5) * (ms * 0.02);
    beatTimer = setTimeout(tick, Math.max(30, ms + jitter));
  };
  tick();
}

function stopBeatLoop() {
  if (beatTimer) { clearTimeout(beatTimer); beatTimer = null; }
}

// Play game-over SFX (prefer decoded buffer, fallback to audio element)
function playGameOverSfx() {
  // try to ensure audio context exists
  try {
    createAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    if (gameOverBuffer) {
      const s = audioCtx.createBufferSource();
      s.buffer = gameOverBuffer;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(1, audioCtx.currentTime);
      s.connect(g); g.connect(audioCtx.destination);
      s.start();
      return;
    }
  } catch (e) {
    // ignore, fall back to element
  }

  // fallback to audio element if present
  if (gameOverAudioElement) {
    try { gameOverAudioElement.currentTime = 0; gameOverAudioElement.play().catch(() => {}); } catch (e) {}
    return;
  }

  // last resort: try to load and play /assets/gameover.mp3 using HTMLAudio
  try {
    const a = new Audio('/assets/gameover.mp3');
    a.play().catch(() => {});
  } catch (e) { /* ignore */ }
}

// --- Leaderboard UI and API
const API_LEADERBOARD = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? 'http://localhost:3000/leaderboard' : '/leaderboard';
const gameOverPanel = document.getElementById('gameOverPanel');
const finalScoreEl = document.getElementById('finalScore');
const playerNameInput = document.getElementById('playerName');
const submitScoreBtn = document.getElementById('submitScore');
const leaderboardList = document.getElementById('leaderboardList');
const closeLeaderboardBtn = document.getElementById('closeLeaderboard');
const playAgainBtn = document.getElementById('playAgain');

async function fetchLeaderboard() {
  try {
    const res = await fetch(API_LEADERBOARD);
    if (!res.ok) throw new Error('nope');
    const data = await res.json();
    return data;
  } catch (e) {
    return null;
  }
}

async function submitScore(name, score) {
  try {
    await fetch(API_LEADERBOARD, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, score })
    });
  } catch (e) { /* ignore */ }
}

function renderLeaderboard(list) {
  leaderboardList.innerHTML = '';
  if (!list) {
    const li = document.createElement('li'); li.textContent = 'Leaderboard unavailable'; leaderboardList.appendChild(li); return;
  }
  list.slice(0, 10).forEach(item => {
    const li = document.createElement('li');
    li.textContent = `${item.name || 'anon'} — ${item.score}`;
    leaderboardList.appendChild(li);
  });
}

async function showGameOverPanel(score) {
  if (!gameOverPanel) return;
  finalScoreEl.textContent = Math.floor(score);
  gameOverPanel.classList.remove('hidden');
  // focus the name input so the user can type immediately
  setTimeout(() => { if (playerNameInput) playerNameInput.focus(); }, 150);
  // fetch remote leaderboard
  const lb = await fetchLeaderboard();
  renderLeaderboard(lb);
}

function hideGameOverPanel() { if (gameOverPanel) gameOverPanel.classList.add('hidden'); }

submitScoreBtn.addEventListener('click', async () => {
  submitScoreBtn.disabled = true;
  submitScoreBtn.textContent = 'Submitting...';
  const name = (playerNameInput.value || 'anon').toString().slice(0, 36);
  const score = Math.floor(elapsed);
  try {
    await submitScore(name, score);
    // refresh leaderboard and hide overlay after a short delay so user sees the change
    const lb = await fetchLeaderboard();
    renderLeaderboard(lb);
    setTimeout(() => {
      hideGameOverPanel();
      // reset UI
      submitScoreBtn.disabled = false;
      submitScoreBtn.textContent = 'Submit';
    }, 600);
  } catch (e) {
    // keep the overlay open so the user can retry
    submitScoreBtn.disabled = false;
    submitScoreBtn.textContent = 'Submit';
  }
});

closeLeaderboardBtn.addEventListener('click', () => { hideGameOverPanel(); });
playAgainBtn.addEventListener('click', () => { hideGameOverPanel(); resetGame(); });


function update(dt) {
  // Player movement
  let dx = 0, dy = 0;
  if (keys.left) dx -= 1; if (keys.right) dx += 1;
  if (keys.up) dy -= 1; if (keys.down) dy += 1;
  if (dx !== 0 || dy !== 0) {
    const len = Math.hypot(dx, dy);
    const vx = (dx / len) * player.speed;
    const vy = (dy / len) * player.speed;
    player.x += vx * dt;
    player.y += vy * dt;
    // target angle should point towards movement vector (car forward)
    player.targetAngle = Math.atan2(vy, vx);
    // wheel rotation visual based on forward velocity
    player.wheelRotation += (Math.hypot(vx, vy) * 0.03) * dt * 60;
    // visual exhaust scales with speed (0..1)
    player.exhaustIntensity = Math.min(1, Math.hypot(vx, vy) / 600);
  }

  // keep player inside bounds
  const vw = canvas.width / (window.devicePixelRatio || 1);
  const vh = canvas.height / (window.devicePixelRatio || 1);
  player.x = Math.max(player.r, Math.min(vw - player.r, player.x));
  player.y = Math.max(player.r, Math.min(vh - player.r, player.y));

  // spawn logic
  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawnEnemy();
    const bpm = getBpm();
    const tempoFactor = 1 + Math.min(1.5, (bpm - baseBpm) / baseBpm);
    spawnTimer = Math.max(0.2, (spawnInterval - Math.min(1.1, elapsed / 45)) / tempoFactor);
  }

  // update enemies
  for (const e of enemies) {
    e.x += e.vx * dt;
    e.y += e.vy * dt;
  }

  // increase difficulty slowly
  spawnInterval = Math.max(0.6, 1.6 - elapsed / 60);

  // collision detection — circle overlap OR polygon-based hitbox if a processed sprite exists
  for (const e of enemies) {
    let hit = false;

    if (carHitPolygon && carSpriteCanvas) {
      // compute visual sprite size same as drawCar
      const desiredH = player.h * 3.2;
      const desiredW = desiredH * (carSpriteCanvas.width / carSpriteCanvas.height);
      const scale = desiredW / carSpriteCanvas.width; // uniform scale
      // transform polygon to world coords
      const worldPoly = carHitPolygon.map(pt => {
        const sx = pt.x * scale;
        const sy = pt.y * scale;
        return {
          x: player.x + Math.cos(player.angle) * sx - Math.sin(player.angle) * sy,
          y: player.y + Math.sin(player.angle) * sx + Math.cos(player.angle) * sy,
        };
      });
      // check circle vs polygon collision
      if (circleIntersectsPolygon(e.x, e.y, e.r, worldPoly)) hit = true;
    } else {
      // fallback: circle vs circle
      const dx = e.x - player.x;
      const dy = e.y - player.y;
      if (dx * dx + dy * dy <= (e.r + player.r) * (e.r + player.r)) hit = true;
    }

    if (hit) {
      running = false;
      // Stop the music/beat immediately when the game ends
      stopBeatLoop();
      isMusicOn = false;
      if (musicToggle) musicToggle.classList.remove('active');
      highScore = Math.max(highScore, Math.floor(elapsed));
      if (!gameOverPlayed) {
        // Play the game-over SFX and then suspend audio context after it finishes (if we can detect duration)
        playGameOverSfx();
        gameOverPlayed = true;
        // schedule suspend of audio context after sfx duration or a short fallback
        try {
          if (audioCtx) {
            let wait = 800;
            if (gameOverBuffer && gameOverBuffer.duration) wait = Math.floor(gameOverBuffer.duration * 1000 + 150);
            else if (gameOverAudioElement && !isNaN(gameOverAudioElement.duration) && gameOverAudioElement.duration > 0) wait = Math.floor(gameOverAudioElement.duration * 1000 + 150);
            setTimeout(() => { if (audioCtx && audioCtx.state === 'running') audioCtx.suspend().catch(()=>{}); }, wait);
          }
        } catch (e) { /* ignore */ }
        // show the game over panel (name input + leaderboard)
        try { showGameOverPanel(elapsed); } catch (e) { /* ignore */ }
      }
      break;
    }
  }

  // remove offscreen or very far enemies for memory
  enemies = enemies.filter(e => {
    return e.x > -100 && e.x < vw + 100 && e.y > -100 && e.y < vh + 100;
  });

  elapsed += dt;

  // slowly smooth the facing angle towards targetAngle for a nice animated turn
  const angDiff = ((player.targetAngle - player.angle + Math.PI) % (Math.PI * 2)) - Math.PI;
  // rotate faster when moving more
  player.angle += angDiff * Math.min(1, dt * 6);

  // update particles
  updateParticles(dt);
}

function draw() {
  const vw = canvas.width / (window.devicePixelRatio || 1);
  const vh = canvas.height / (window.devicePixelRatio || 1);

  ctx.clearRect(0, 0, vw, vh);

  // background grid subtle
  ctx.fillStyle = '#071827';
  ctx.fillRect(0, 0, vw, vh);

    // draw smoke particles first (so car sits on top)
    drawParticles(ctx);

    // draw player
    drawCar(ctx, player.x, player.y, player.angle, player);

  // draw enemies (render as Pirelli tyre compounds, with colored sidewall / stripe)
  for (const e of enemies) {
    drawTyre(ctx, e.x, e.y, e.r, e.compound);
  }

  // crosshair for player
  // subtle circular guide around car (collision zone)
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.beginPath();
  ctx.arc(player.x, player.y, player.r + 12, 0, Math.PI * 2);
  ctx.stroke();
}

// small helper - draw a simplified, stylized Formula 1 car
function drawCar(ctx, x, y, angle, p) {
  ctx.save();
  ctx.translate(x, y);
  // When the user asked for "other side be the front when moving", we display the car facing
  // the opposite direction while it is moving. Compute a displayAngle that's flipped by PI
  // when the car is in motion (exhaustIntensity > threshold).
  const isMoving = p.exhaustIntensity > 0.02;
  const displayAngle = isMoving ? (angle + Math.PI) : angle;
  ctx.rotate(displayAngle);

  // if a sprite image is available, draw it (keeps rotation/lean) and return early
  if ((carSpriteCanvas && carSpriteCanvas.width) || (carSpriteLoaded && carSprite.naturalWidth && carSprite.naturalHeight)) {
    const srcImg = (carSpriteCanvas && carSpriteCanvas.width) ? carSpriteCanvas : carSprite;
    // compute size so the sprite looks proportionally larger than the logical collision body
    const desiredH = p.h * 3.2; // taller rendering for clear visual
    const desiredW = desiredH * (srcImg.width / srcImg.height);
    // slight lean based on angle difference; when the sprite is flipped we invert the lean so the
    // visual turns look correct relative to the drawn front of the car.
    let lean = (((p.targetAngle - p.angle + Math.PI) % (Math.PI * 2)) - Math.PI) * 0.15;
    if (isMoving) lean = -lean;
    ctx.rotate(lean);
    // draw main sprite centered
    ctx.drawImage(srcImg, -desiredW / 2, -desiredH / 2, desiredW, desiredH);
    // exhaust effect (draw using radial gradient behind sprite)
    if (p.exhaustIntensity > 0.02) {
      ctx.save();
      ctx.translate(-desiredW * 0.35, 0);
      const e = p.exhaustIntensity;
      const rg = ctx.createRadialGradient(0, 0, 2, 0, 0, desiredW * 0.9);
      rg.addColorStop(0, `rgba(255,210,48,${0.6 * e})`);
      rg.addColorStop(0.5, `rgba(255,80,20,${0.25 * e})`);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.ellipse(-desiredW * 0.25, 0, desiredW * 0.9 * e, p.h * 0.6 * e, -0.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
      // spawn smoke particles from the car's rear based on exhaust intensity
      const rearLocalX = desiredW * 0.35;
      const rearLocalY = 0;
      // compute world position of rear using the display angle (sprite may be flipped)
      const worldRearX = x + Math.cos(displayAngle) * rearLocalX - Math.sin(displayAngle) * rearLocalY;
      const worldRearY = y + Math.sin(displayAngle) * rearLocalX + Math.cos(displayAngle) * rearLocalY;
      // spawn a few particles probabilistically
      if (Math.random() < p.exhaustIntensity * 0.35) {
        const rv = 40 + Math.random() * 60;
        const vx = -Math.cos(displayAngle) * (rv * (0.6 + Math.random() * 0.6)) + (Math.random() - 0.5) * 20;
        const vy = -Math.sin(displayAngle) * (rv * (0.6 + Math.random() * 0.6)) + (Math.random() - 0.5) * 12;
        spawnSmoke(worldRearX, worldRearY + (Math.random()-0.5)*6, vx, vy, 6 + Math.random() * 8 * p.exhaustIntensity, 0.9 + Math.random() * 0.9, 0.85);
      }
      ctx.restore();
    return;
  }

  // motion shadow
  ctx.beginPath();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.ellipse(0, 8, p.w * 0.62, p.h * 0.8, 0.02, 0, Math.PI * 2);
  ctx.fill();

  // main body with gradient (primary livery)
  ctx.beginPath();
  const g = ctx.createLinearGradient(-p.w, -p.h, p.w, p.h);
  g.addColorStop(0, p.livery);
  g.addColorStop(0.7, p.accent);
  g.addColorStop(1, '#222');
  ctx.fillStyle = g;
  // tapered nose and wide rear wing shape
  ctx.moveTo(-p.w * 0.7, 0);
  ctx.quadraticCurveTo(-p.w * 0.18, -p.h * 1.0, p.w * 0.05, -p.h * 0.75);
  ctx.lineTo(p.w * 0.7, -p.h * 0.3);
  ctx.lineTo(p.w * 0.45, p.h * 0.75);
  ctx.quadraticCurveTo(p.w * 0.12, p.h * 0.35, -p.w * 0.7, 0);
  ctx.fill();

  // cockpit canopy - glossy
  ctx.save();
  ctx.beginPath();
  ctx.fillStyle = '#081722';
  ctx.ellipse(0.08 * p.w, -0.15 * p.h, p.w * 0.22, p.h * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  // gloss highlight
  ctx.beginPath(); ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.ellipse(0.05 * p.w, -0.22 * p.h, p.w * 0.12, p.h * 0.06, -0.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // front wing (multi-layered)
  ctx.save();
  ctx.translate(-p.w * 0.5, 0);
  ctx.fillStyle = '#111'; ctx.fillRect(-p.w * 0.2, -p.h * 0.08, p.w * 0.36, p.h * 0.06);
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(-p.w * 0.18, -p.h * 0.14, p.w * 0.28, p.h * 0.04);
  ctx.restore();

  // rear wing - dynamic angle based on target vs current angle
  ctx.save();
  const wingTilt = Math.sin(player.wheelRotation * 0.015) * 0.07;
  ctx.translate(p.w * 0.45, -p.h * 0.44);
  ctx.rotate(wingTilt);
  ctx.fillStyle = '#111'; ctx.fillRect(-p.w * 0.02, -p.h * 0.02, p.w * 0.55, p.h * 0.12);
  ctx.fillStyle = '#333'; ctx.fillRect(-p.w * 0.02, -p.h * 0.06, p.w * 0.3, p.h * 0.04);
  ctx.restore();

  // wheels (4) — detailed with rim and spokes
  const wheelW = p.w * 0.22;
  const wheelH = p.h * 0.5;
  // offsets
  const fx = -p.w * 0.25, bx = p.w * 0.35;
  const wy = p.h * 0.5;

  // front-left
  ctx.save(); ctx.translate(fx, -wy);
  ctx.rotate(Math.sin(p.wheelRotation * 0.02) * 0.18);
  drawWheel(ctx, wheelW, wheelH, p.wheelRotation);
  ctx.restore();
  // front-right
  ctx.save(); ctx.translate(fx, wy);
  ctx.rotate(Math.sin(p.wheelRotation * 0.02) * 0.18);
  drawWheel(ctx, wheelW, wheelH, p.wheelRotation);
  ctx.restore();
  // rear-left
  ctx.save(); ctx.translate(bx, -wy); drawWheel(ctx, wheelW, wheelH, p.wheelRotation); ctx.restore();
  // rear-right
  ctx.save(); ctx.translate(bx, wy); drawWheel(ctx, wheelW, wheelH, p.wheelRotation); ctx.restore();

  // small racing stripe
  ctx.beginPath(); ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 2; ctx.moveTo(-p.w*0.58, -p.h*0.14); ctx.lineTo(p.w*0.58, -p.h*0.14); ctx.stroke();

  // exhaust flame when accelerating
  if (p.exhaustIntensity > 0.02) {
    ctx.save();
    ctx.translate(-p.w * 0.65, 0);
    const e = p.exhaustIntensity;
    const rg = ctx.createRadialGradient(0, 0, 2, 0, 0, p.w * 0.9);
    rg.addColorStop(0, `rgba(255,210,48,${0.6 * e})`);
    rg.addColorStop(0.5, `rgba(255,80,20,${0.25 * e})`);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.ellipse(-p.w * 0.2, 0, p.w * 0.9 * e, p.h * 0.6 * e, -0.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // spawn smoke for vector car representation
    const rearLocalX = p.w * 0.65;
    const worldRearX = x + Math.cos(displayAngle) * rearLocalX - Math.sin(displayAngle) * 0;
    const worldRearY = y + Math.sin(displayAngle) * rearLocalX + Math.cos(displayAngle) * 0;
    if (Math.random() < p.exhaustIntensity * 0.25) {
      const rv = 30 + Math.random() * 50;
      const vx = -Math.cos(displayAngle) * (rv * (0.6 + Math.random() * 0.6)) + (Math.random() - 0.5) * 18;
      const vy = -Math.sin(displayAngle) * (rv * (0.6 + Math.random() * 0.6)) + (Math.random() - 0.5) * 10;
      spawnSmoke(worldRearX, worldRearY + (Math.random()-0.5)*6, vx, vy, 5 + Math.random() * 6 * p.exhaustIntensity, 0.8 + Math.random() * 0.6, 0.9);
    }
  }

  ctx.restore();
}

// draw a stylized wheel with rotating spokes
function drawWheel(ctx, ww, hh, rotation) {
  // wheel outline
  ctx.save();
  ctx.fillStyle = '#0b0b0b';
  ctx.beginPath(); ctx.ellipse(0, 0, ww/2, hh/2, 0, 0, Math.PI*2); ctx.fill();

  // rim
  ctx.beginPath(); ctx.ellipse(0, 0, ww/3.2, hh/3.2, 0, 0, Math.PI*2); ctx.fillStyle = '#555'; ctx.fill();

  // spokes — draw several thin lines that rotate
  const spokes = 6;
  ctx.strokeStyle = 'rgba(20,20,20,0.95)'; ctx.lineWidth = Math.max(1, ww*0.035);
  ctx.beginPath();
  for (let i = 0; i < spokes; i++) {
    const a = rotation * 0.06 + (i / spokes) * Math.PI * 2;
    const x1 = Math.cos(a) * ww * 0.12;
    const y1 = Math.sin(a) * hh * 0.12;
    const x2 = Math.cos(a) * ww * 0.45;
    const y2 = Math.sin(a) * hh * 0.45;
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();

  // small hub
  ctx.beginPath(); ctx.fillStyle = '#222'; ctx.ellipse(0,0, ww*0.09, hh*0.09, 0, 0, Math.PI*2); ctx.fill();
  ctx.restore();
}

// draw a tyre compound (outer rubber, colored sidewall/stripe, inner hub)
function drawTyre(ctx, x, y, r, compound) {
  ctx.save();
  ctx.translate(x, y);
  // main rubber
  ctx.beginPath(); ctx.fillStyle = '#050505'; ctx.arc(0, 0, r, 0, Math.PI*2); ctx.fill();
  // sidewall colored ring (thin)
  ctx.beginPath(); ctx.fillStyle = compound && compound.color ? compound.color : '#ff5c5c'; ctx.arc(0, 0, r * 0.8, 0, Math.PI*2); ctx.globalAlpha = 0.95; ctx.fill(); ctx.globalAlpha = 1;
  // inner hub
  ctx.beginPath(); ctx.fillStyle = '#202225'; ctx.arc(0, 0, r * 0.48, 0, Math.PI*2); ctx.fill();
  // hubcap highlight
  ctx.beginPath(); ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.arc(-r*0.12, -r*0.1, r*0.18, 0, Math.PI*2); ctx.fill();
  // small 'P' mark for Pirelli style
  ctx.fillStyle = compound && compound.rim ? compound.rim : '#111';
  ctx.font = `${Math.max(8, r*0.35)}px system-ui`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('P', 0, 0);
  ctx.restore();
}

function frame() {
  const now = performance.now();
  let dt = (now - lastTime) / 1000; // seconds
  lastTime = now;
  if (!running) dt = 0; // freeze updates when paused/stopped

  // limit dt to avoid big jumps
  if (dt > 0.05) dt = 0.05;

  if (running) update(dt);
  draw();
  scoreEl.textContent = `Score: ${Math.floor(elapsed)}`;

  if (!running) {
    // show a simple game over overlay (use logical canvas size)
    const vw = canvas.width / (window.devicePixelRatio || 1);
    const vh = canvas.height / (window.devicePixelRatio || 1);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, vw, vh);
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.font = '28px system-ui, Arial';
    ctx.fillText('Game Over', vw / 2, vh / 2 - 10);
    ctx.font = '14px system-ui, Arial';
    ctx.fillText(`Score: ${Math.floor(elapsed)} — High: ${highScore}`, vw / 2, vh / 2 + 18);
  }

  requestAnimationFrame(frame);
}

// initial spawn to get things moving
for (let i = 0; i < 3; i++) spawnEnemy();
requestAnimationFrame(frame);

// init player position after we have accurate sizes
resetGame();
// try to preload a default game-over audio if present at /assets/gameover.mp3
preloadAssetGameOver();

// small helper: clicking the canvas moves player to mouse
canvas.addEventListener('mousemove', (e) => {
  // comment out if you want keyboard-only control
  //const rect = canvas.getBoundingClientRect();
  //player.x = (e.clientX - rect.left);
  //player.y = (e.clientY - rect.top);
});

// keep game responsive when the window resizes
window.addEventListener('resize', () => {
  fitCanvas();
  resetGame();
});
