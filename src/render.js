// Canvas renderer. Reads the World and draws the whole scene + HUD.
// The world is in logical units (height = WORLD.height); `view.scale` maps to device px.
import { COMPOUNDS, ERS, PITGAME, PLAYER, SAFETY_CAR_TEAM, SPEED } from './config.js';
import { clamp, formatDistance, formatTime, gpProgress, lerp, positionLabel, sweepPos } from './logic.js';

const FONT = '"Segoe UI", system-ui, Roboto, sans-serif';
const MONO = '"Cascadia Mono", Consolas, "Roboto Mono", monospace';

/** Deterministic 0..1 noise from an integer seed (for scenery that must not flicker). */
const hash = (n) => {
  let x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export class Renderer {
  constructor(canvas, assets) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.assets = assets;
    this.view = { width: 1280, height: 720, scale: 1 };
    this.time = 0;
    this.zoom = 1;
    this.hudFlash = {};
    // pre-render the kerb strip as a pattern-ish tile for cheapness
    this.kerb = document.createElement('canvas');
    this.kerb.width = 64;
    this.kerb.height = 12;
    const k = this.kerb.getContext('2d');
    k.fillStyle = '#d7263d'; k.fillRect(0, 0, 32, 12);
    k.fillStyle = '#f4f4f4'; k.fillRect(32, 0, 32, 12);
  }

  /** Resize the backing store; returns the logical size for the world. */
  fit(logicalHeight) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    const scale = (cssH * dpr) / logicalHeight;
    this.view = { width: (cssW * dpr) / scale, height: logicalHeight, scale };
    return this.view;
  }

  /** Blend a venue palette key between the previous and current venue. */
  vcolor(world, key, i = null) {
    const a = i === null ? world.prevVenue[key] : world.prevVenue[key][i];
    const b = i === null ? world.venue[key] : world.venue[key][i];
    return lerpColor(a, b, world.venueBlend);
  }

  render(world, hud, dt) {
    this.time += dt;
    const { ctx } = this;
    const { width: W, height: H, scale } = this.view;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // camera shake
    if (world.shake > 0) {
      const s = world.shake * 6;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }
    // boost / tow zoom: a subtle push-in centred on the car; the pit-entry cinematic pushes in harder
    const targetZoom = (world.ers.boosting ? 1.045 : 1 + world.tow * 0.015) + world.cine * 0.08;
    this.zoom += (targetZoom - this.zoom) * Math.min(1, dt * 6);
    if (Math.abs(this.zoom - 1) > 0.001) {
      ctx.translate(world.player.x, world.player.y);
      ctx.scale(this.zoom, this.zoom);
      ctx.translate(-world.player.x, -world.player.y);
    }
    this.drawBackdrop(world, W, H);
    this.drawPitLane(world, W);
    this.drawTrack(world, W);
    this.drawGrassBottom(world, W, H);
    for (const hz of world.hazards) if (hz.type === 'oil' || hz.type === 'drs') this.drawHazard(hz, world);
    this.drawParticles(world, ['spray', 'smoke', 'streak']);
    for (const hz of world.hazards) if (hz.type !== 'oil' && hz.type !== 'drs') this.drawHazard(hz, world);
    if (world.sc.car) this.drawSafetyCar(world);
    if (world.cine > 0.02) this.drawPitApproach(world, W);
    this.drawPlayer(world);
    // stationary car: mechanics at each wheel + the wheel-gun mini-game (drawn late so nothing paints over it)
    if (world.pit.inLane && world.pit.phase === 'stop' && world.pit.game) this.drawPitGame(world);
    this.drawParticles(world, ['flame', 'spark', 'carbon']);
    this.drawMarshals(world, W);
    this.drawNight(world, W, H);
    this.drawWeather(world, W, H);
    this.drawSpeedLines(world, W, H);
    this.drawPopups(world);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (world.cine > 0.02) this.drawLetterbox(world, W, H);
    if (world.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${0.75 * world.flash})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (hud) this.drawHud(world, hud, W, H);
  }

  // ---------- scenery ----------
  drawBackdrop(world, W, H) {
    const { ctx } = this;
    const skyTop = this.vcolor(world, 'sky', 0);
    const skyBot = this.vcolor(world, 'sky', 1);
    const sky = ctx.createLinearGradient(0, 0, 0, world.pitTop);
    sky.addColorStop(0, skyTop);
    sky.addColorStop(1, skyBot);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, world.pitTop);

    // stars + moon at night
    if (world.night > 0.05) {
      ctx.fillStyle = `rgba(255,255,255,${0.9 * world.night})`;
      for (let i = 0; i < 70; i++) {
        const x = ((hash(i) * 2400 - world.scroll * 0.01) % (W + 40) + W + 40) % (W + 40) - 20;
        const y = hash(i + 99) * world.pitTop * 0.45;
        const tw = 0.6 + 0.4 * Math.sin(this.time * 2 + i);
        ctx.globalAlpha = world.night * tw;
        ctx.fillRect(x, y, 2, 2);
      }
      ctx.globalAlpha = world.night;
      ctx.fillStyle = '#f4f1dc';
      ctx.beginPath(); ctx.arc(W * 0.78, world.pitTop * 0.2, 18, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = skyTop;
      ctx.beginPath(); ctx.arc(W * 0.78 - 9, world.pitTop * 0.2 - 5, 15, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      // sun
      const sunA = 1 - world.night;
      const g = ctx.createRadialGradient(W * 0.8, world.pitTop * 0.22, 4, W * 0.8, world.pitTop * 0.22, 70);
      g.addColorStop(0, `rgba(255,250,220,${0.95 * sunA})`);
      g.addColorStop(0.3, `rgba(255,240,180,${0.5 * sunA})`);
      g.addColorStop(1, 'rgba(255,240,180,0)');
      ctx.fillStyle = g;
      ctx.fillRect(W * 0.8 - 70, world.pitTop * 0.22 - 70, 140, 140);
    }

    // clouds: two parallax layers
    const cloudA = 0.75 - world.night * 0.55;
    for (const [k, count, yBase, size] of [[0.06, 5, 0.05, 1], [0.12, 4, 0.16, 0.7]]) {
      for (let i = 0; i < count; i++) {
        const span = W + 400;
        const x = ((hash(i * 7 + k * 100) * span - world.scroll * k) % span + span) % span - 200;
        const y = world.pitTop * (yBase + hash(i + 31 + k) * 0.1);
        ctx.fillStyle = `rgba(255,255,255,${cloudA * (0.5 + hash(i) * 0.4)})`;
        for (let b = 0; b < 4; b++) {
          const r = (18 + hash(i * 3 + b) * 16) * size;
          ctx.beginPath(); ctx.arc(x + b * r * 1.2, y - (b % 2) * r * 0.4, r, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    // skyline: cross-fade previous → current venue
    const y0 = world.pitTop * 0.06;
    const y1 = world.pitTop * 0.62;
    if (world.venueBlend < 1) {
      ctx.globalAlpha = 1 - world.venueBlend;
      this.drawSkyline(world.prevVenue, world, W, y0, y1);
    }
    ctx.globalAlpha = Math.min(1, world.venueBlend);
    this.drawSkyline(world.venue, world, W, y0, y1);
    ctx.globalAlpha = 1;

    // grandstand: repeating blocks with a crowd noise texture
    const gsTop = world.pitTop * 0.56;
    const gsH = world.pitTop - gsTop;
    const off = (world.scroll * 0.25) % 220;
    const lit = world.night;
    for (let x = -off - 220; x < W + 220; x += 220) {
      ctx.fillStyle = lerpColor('#2b2f3a', '#161923', lit);
      ctx.fillRect(x, gsTop, 214, gsH);
      ctx.fillStyle = lerpColor('#3c4150', '#22262f', lit);
      ctx.fillRect(x, gsTop, 214, 8);
      // crowd dots (phone torches come out at night)
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 22; c++) {
          const seed = ((x / 220) * 97 + r * 13 + c * 7) | 0;
          const hue = (seed * 47) % 360;
          const torch = lit > 0.3 && hash(seed) > 0.86;
          ctx.fillStyle = torch ? `rgba(255,255,230,${lit})` : `hsl(${hue} 35% ${30 + (seed % 3) * 7 - lit * 12}%)`;
          ctx.fillRect(x + 6 + c * 9.4, gsTop + 14 + r * ((gsH - 18) / 4), 5, 6);
        }
      }
      // banner in the venue accent
      ctx.fillStyle = '#c8102e';
      ctx.fillRect(x, world.pitTop - 10, 214, 10);
      // floodlight masts at night venues
      if (lit > 0.05) {
        ctx.globalAlpha = lit;
        ctx.fillStyle = '#4a4f5c';
        ctx.fillRect(x + 100, y0, 4, gsTop - y0);
        ctx.fillStyle = '#e8ecf5';
        ctx.fillRect(x + 84, y0 - 6, 36, 8);
        ctx.globalAlpha = 1;
      }
    }
  }

  /** Far backdrop painters, one per venue.skyline. Strip is [y0, y1], scrolls slowly. */
  drawSkyline(venue, world, W, y0, y1) {
    const { ctx } = this;
    const h = y1 - y0;
    const k = 0.08;
    const off = (world.scroll * k);
    const horizon = venue.horizon;
    const night = venue.night ? 1 : 0;
    // ground/horizon band shared by all
    ctx.fillStyle = horizon;
    ctx.fillRect(0, y1 - h * 0.18, W, h * 0.2);
    const tile = (period, fn) => {
      const o = off % period;
      for (let x = -o - period; x < W + period; x += period) fn(x, Math.round((x + o) / period));
    };
    switch (venue.skyline) {
      case 'trees': // Monza's royal park: big deciduous canopies
        tile(150, (x, i) => {
          ctx.fillStyle = `hsl(${105 + hash(i) * 20} 40% ${28 + hash(i + 1) * 12}%)`;
          ctx.fillRect(x + 70, y1 - h * 0.5, 8, h * 0.4);
          ctx.beginPath(); ctx.arc(x + 74, y1 - h * 0.55, 34 + hash(i + 2) * 22, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(x + 40, y1 - h * 0.42, 24 + hash(i + 3) * 14, 0, Math.PI * 2); ctx.fill();
        });
        break;
      case 'harbour': { // Monaco: sea, yachts, stacked apartment blocks
        ctx.fillStyle = '#2f79c9';
        ctx.fillRect(0, y1 - h * 0.35, W, h * 0.4);
        tile(190, (x, i) => {
          ctx.fillStyle = '#f4f2ea';
          const yw = y1 - h * 0.28 + hash(i) * 10;
          ctx.fillRect(x + 20, yw, 60 + hash(i + 1) * 40, 10);
          ctx.fillRect(x + 40, yw - 12, 30, 12);
          ctx.fillStyle = '#111';
          ctx.fillRect(x + 60, yw - 30, 2, 30);
        });
        tile(120, (x, i) => {
          const bh = h * (0.45 + hash(i) * 0.5);
          ctx.fillStyle = `hsl(${30 + hash(i + 5) * 20} 30% ${70 + hash(i + 6) * 15}%)`;
          ctx.fillRect(x, y1 - h * 0.3 - bh, 100, bh);
          ctx.fillStyle = 'rgba(60,70,90,0.6)';
          for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) ctx.fillRect(x + 10 + c * 22, y1 - h * 0.3 - bh + 8 + r * (bh / 4.5), 10, 8);
        });
        break;
      }
      case 'stands': // Silverstone: the wing + big open grandstand roofs
        tile(340, (x, i) => {
          ctx.fillStyle = '#c9d1dc';
          ctx.beginPath();
          ctx.moveTo(x, y1 - h * 0.2);
          ctx.quadraticCurveTo(x + 170, y1 - h * 1.1, x + 340, y1 - h * 0.2);
          ctx.lineTo(x + 340, y1 - h * 0.1);
          ctx.quadraticCurveTo(x + 170, y1 - h * 0.9, x, y1 - h * 0.1);
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#70798a';
          for (let c = 0; c < 6; c++) ctx.fillRect(x + 30 + c * 52, y1 - h * 0.6 + Math.abs(c - 2.5) * 12, 6, h * 0.5 - Math.abs(c - 2.5) * 12);
          ctx.fillStyle = '#00594c';
          ctx.fillRect(x + 20, y1 - h * 0.34, 300, 6);
        });
        break;
      case 'forest': // Spa: misty hills and pines
        tile(420, (x, i) => {
          ctx.fillStyle = `hsl(140 25% ${22 + hash(i) * 10}%)`;
          ctx.beginPath(); ctx.ellipse(x + 210, y1 - h * 0.1, 260, h * 0.75, 0, Math.PI, 0); ctx.fill();
        });
        tile(46, (x, i) => {
          const th = h * (0.35 + hash(i) * 0.4);
          ctx.fillStyle = `hsl(135 35% ${16 + hash(i + 2) * 12}%)`;
          ctx.beginPath(); ctx.moveTo(x, y1 - h * 0.15); ctx.lineTo(x + 20, y1 - h * 0.15 - th); ctx.lineTo(x + 40, y1 - h * 0.15); ctx.closePath(); ctx.fill();
        });
        ctx.fillStyle = 'rgba(230,240,250,0.25)';
        ctx.fillRect(0, y1 - h * 0.4, W, h * 0.25);
        break;
      case 'wheel': // Suzuka: hills and the ferris wheel
        tile(520, (x, i) => {
          ctx.fillStyle = `hsl(110 30% ${30 + hash(i) * 10}%)`;
          ctx.beginPath(); ctx.ellipse(x + 260, y1 - h * 0.1, 300, h * 0.55, 0, Math.PI, 0); ctx.fill();
        });
        tile(700, (x) => {
          const cx = x + 350, cy = y1 - h * 0.62, r = h * 0.42;
          ctx.strokeStyle = '#e8e8f0'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          for (let s = 0; s < 12; s++) { const a = (s / 12) * Math.PI * 2 + this.time * 0.15; ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
          ctx.stroke();
          for (let s = 0; s < 12; s++) { const a = (s / 12) * Math.PI * 2 + this.time * 0.15; ctx.fillStyle = `hsl(${s * 30} 80% 60%)`; ctx.fillRect(cx + Math.cos(a) * r - 4, cy + Math.sin(a) * r - 2, 8, 8); }
          ctx.strokeStyle = '#c8ccd6'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(cx - r * 0.5, y1 - h * 0.15); ctx.lineTo(cx, cy); ctx.lineTo(cx + r * 0.5, y1 - h * 0.15); ctx.stroke();
        });
        break;
      case 'city': // Singapore: skyscrapers with lit windows
        tile(90, (x, i) => {
          const bh = h * (0.5 + hash(i) * 0.7);
          ctx.fillStyle = `hsl(230 20% ${12 + hash(i + 1) * 8}%)`;
          ctx.fillRect(x + 4, y1 - h * 0.15 - bh, 74, bh);
          for (let r = 0; r < bh / 12; r++) for (let c = 0; c < 4; c++) {
            const on = hash(i * 31 + r * 7 + c) > 0.45;
            ctx.fillStyle = on ? `rgba(255,${210 + hash(c) * 40},150,${0.6 + night * 0.4})` : 'rgba(30,35,60,0.6)';
            ctx.fillRect(x + 12 + c * 16, y1 - h * 0.15 - bh + 6 + r * 12, 8, 6);
          }
          if (hash(i + 9) > 0.8) {
            const ga = ctx.globalAlpha;
            ctx.fillStyle = '#ff5a5a';
            ctx.globalAlpha = ga * (0.6 + 0.4 * Math.sin(this.time * 3 + i));
            ctx.fillRect(x + 40, y1 - h * 0.15 - bh - 6, 3, 6);
            ctx.globalAlpha = ga;
          }
        });
        break;
      case 'hills': // Interlagos: rolling hills stacked with houses
        tile(600, (x, i) => {
          ctx.fillStyle = `hsl(95 35% ${32 + hash(i) * 10}%)`;
          ctx.beginPath(); ctx.ellipse(x + 300, y1 - h * 0.05, 340, h * 0.6, 0, Math.PI, 0); ctx.fill();
        });
        tile(28, (x, i) => {
          const hy = y1 - h * 0.3 - hash(i) * h * 0.3;
          ctx.fillStyle = `hsl(${20 + hash(i + 2) * 30} 50% ${55 + hash(i + 3) * 25}%)`;
          ctx.fillRect(x, hy, 22, 12 + hash(i + 4) * 10);
          ctx.fillStyle = '#7a3b2a';
          ctx.fillRect(x, hy - 4, 22, 4);
        });
        break;
      case 'desert': // Bahrain: dunes, palms and lighting towers
        ctx.fillStyle = '#b89968';
        tile(480, (x, i) => {
          ctx.fillStyle = `hsl(35 40% ${45 + hash(i) * 12}%)`;
          ctx.beginPath(); ctx.ellipse(x + 240, y1 - h * 0.05, 300, h * 0.45, 0, Math.PI, 0); ctx.fill();
        });
        tile(210, (x, i) => {
          const px = x + 60 + hash(i) * 80;
          ctx.strokeStyle = '#5a4a2a'; ctx.lineWidth = 4;
          ctx.beginPath(); ctx.moveTo(px, y1 - h * 0.1); ctx.quadraticCurveTo(px + 8, y1 - h * 0.4, px + 4, y1 - h * 0.6); ctx.stroke();
          ctx.strokeStyle = '#2f7a3a'; ctx.lineWidth = 3;
          for (let f = 0; f < 6; f++) { const a = -Math.PI * 0.15 - f * 0.3; ctx.beginPath(); ctx.moveTo(px + 4, y1 - h * 0.6); ctx.quadraticCurveTo(px + 4 + Math.cos(a) * 22, y1 - h * 0.6 + Math.sin(a) * 22 - 10, px + 4 + Math.cos(a) * 34, y1 - h * 0.6 + Math.sin(a) * 34 + 6); ctx.stroke(); }
        });
        break;
      default:
        break;
    }
  }

  drawPitLane(world, W) {
    const { ctx } = this;
    const top = world.pitTop;
    const bottom = world.pitBottom;
    ctx.fillStyle = lerpColor('#4f535c', '#2f323a', world.night);
    ctx.fillRect(0, top, W, bottom - top);
    // garages scroll along the back of the lane; the Ferrari garage is where the stop happens
    const garageW = 260;
    const off = world.scroll % (garageW * 4);
    for (let i = -1; i < W / garageW + 5; i++) {
      const x = i * garageW - off;
      const idx = ((i + Math.floor(world.scroll / (garageW * 4)) * 4) % 4 + 4) % 4;
      const color = idx === 0 ? '#d40000' : idx === 1 ? '#0b2a6f' : idx === 2 ? '#c0c0c0' : '#ff8a00';
      ctx.fillStyle = color;
      ctx.fillRect(x, top, garageW - 8, 12);
      ctx.fillStyle = lerpColor('#23252b', '#ffe9a8', world.night * 0.8);
      ctx.fillRect(x + 8, top + 12, garageW - 24, 10);
    }
    // pit box marks
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    for (let x = -(world.scroll % 130); x < W; x += 130) {
      ctx.strokeRect(x, top + 26, 110, bottom - top - 32);
    }
    // pit wall between lane and track, with the entry gap when open
    const wallTop = bottom;
    const wallH = world.trackTop - bottom;
    ctx.fillStyle = this.vcolor(world, 'barrier');
    ctx.fillRect(0, wallTop, W, wallH);
    ctx.fillStyle = '#e6e8ee';
    ctx.fillRect(0, wallTop, W, 3);
    // sponsor lettering along the wall
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.font = `bold ${Math.max(8, wallH - 6)}px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const words = [world.venue.name.toUpperCase(), 'RAWE CEEK', 'PIRELLI', 'DHL'];
    for (let i = -1; i < 6; i++) {
      const x = i * 480 - (world.scroll % 480);
      ctx.fillText(words[((i + Math.floor(world.scroll / 480)) % 4 + 4) % 4], x + 20, wallTop + wallH / 2 + 1);
    }
    ctx.textBaseline = 'alphabetic';
    const px = world.player.x;
    if (world.pit.open && !world.pit.inLane) {
      const glow = 0.5 + 0.5 * Math.sin(this.time * 6);
      ctx.fillStyle = `rgba(46,204,113,${0.35 + glow * 0.45})`;
      ctx.fillRect(px - 140, wallTop, 280, wallH);
      ctx.fillStyle = '#fff';
      ctx.font = `bold 13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('▲ PIT ENTRY ▲', px, wallTop + wallH / 2 + 5);
    }
  }

  drawTrack(world, W) {
    const { ctx } = this;
    const top = world.trackTop;
    const bottom = world.trackBottom;
    const wet = world.rain;
    ctx.fillStyle = lerpColor(lerpColor('#3a3d44', '#23262d', wet), '#1c1e25', world.night * 0.5);
    ctx.fillRect(0, top, W, bottom - top);
    // subtle asphalt banding for motion feel
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    for (let x = -(world.scroll % 400); x < W; x += 400) ctx.fillRect(x, top, 200, bottom - top);
    // wet reflections
    if (wet > 0.05) {
      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, `rgba(160,190,255,${0.05 * wet})`);
      g.addColorStop(0.5, `rgba(200,220,255,${0.16 * wet})`);
      g.addColorStop(1, `rgba(160,190,255,${0.05 * wet})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, top, W, bottom - top);
      // standing water off the racing line
      const skyRef = this.vcolor(world, 'sky', 1);
      for (let i = 0; i < 9; i++) {
        const period = W + 600;
        const x = ((hash(i * 13) * period - world.scroll) % period + period) % period - 300;
        const y = lerp(top + 20, bottom - 20, hash(i * 17 + 3));
        const rw = 60 + hash(i + 5) * 90;
        ctx.globalAlpha = 0.35 * clamp((wet - 0.3) / 0.7, 0, 1);
        ctx.fillStyle = skyRef;
        ctx.beginPath(); ctx.ellipse(x, y, rw, 6 + hash(i + 7) * 6, 0, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    // racing line / dashed centre markers
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 3;
    ctx.setLineDash([60, 90]);
    ctx.lineDashOffset = -world.scroll;
    const mid = (top + bottom) / 2;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(W, mid);
    ctx.stroke();
    ctx.setLineDash([]);
    // tyre marks
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 6;
    for (const yy of [0.3, 0.72]) {
      const y = lerp(top, bottom, yy);
      ctx.beginPath();
      for (let x = -(world.scroll % 900) - 900; x < W + 900; x += 900) {
        ctx.moveTo(x, y);
        ctx.bezierCurveTo(x + 200, y - 25, x + 400, y + 25, x + 600, y);
      }
      ctx.stroke();
    }
    // marbles: rubber pellets collect off-line near the edges
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (let i = 0; i < 40; i++) {
      const period = W + 200;
      const x = ((hash(i * 3 + 1) * period - world.scroll) % period + period) % period - 100;
      const edge = i % 2 ? top + 6 + hash(i) * 22 : bottom - 6 - hash(i) * 22;
      ctx.fillRect(x, edge, 3, 2);
    }
    // kerbs
    this.drawKerb(top - 12, W, world.scroll);
    this.drawKerb(bottom, W, world.scroll);
    // start/finish line with the venue board once per GP length is impractical; a
    // chequered strip flashes past every so often instead
    const period = W + 2600;
    const boardX = W - (world.scroll % period);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 2; c++) {
        ctx.fillStyle = (r + c) % 2 ? '#fff' : '#111';
        ctx.fillRect(boardX + c * 8, top + (r * (bottom - top)) / 4, 8, (bottom - top) / 4);
      }
    }
  }
  drawKerb(y, W, scroll) {
    const { ctx } = this;
    const off = scroll % 64;
    for (let x = -off - 64; x < W + 64; x += 64) ctx.drawImage(this.kerb, x, y, 64, 12);
  }

  drawGrassBottom(world, W, H) {
    const { ctx } = this;
    const top = world.trackBottom + 12;
    ctx.fillStyle = this.vcolor(world, 'ground');
    ctx.fillRect(0, top, W, H - top);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let x = -(world.scroll * 0.9 % 160); x < W; x += 160) ctx.fillRect(x, top, 80, H - top);
    // gravel strip
    ctx.fillStyle = '#b9a77a';
    ctx.fillRect(0, top, W, 10);
    // ad boards
    const boards = ['RAWE CEEK', 'PIRELLI', 'BOX BOX', 'PLAN C', 'WE ARE CHECKING', 'DRS', 'SO NOT RIGHT', 'PUSHING', world.venue.name.toUpperCase(), 'MULTI 21'];
    const bw = 330;
    const off = (world.scroll * 0.9) % (bw * boards.length);
    const by = top + 24;
    const bh = Math.min(46, H - by - 8);
    if (bh > 18) {
      for (let i = 0; i < boards.length + 2; i++) {
        const x = i * bw - off;
        const idx = i % boards.length;
        ctx.fillStyle = idx % 2 ? '#111' : '#e10600';
        ctx.fillRect(x, by, bw - 12, bh);
        ctx.fillStyle = idx % 2 ? '#ffd400' : '#fff';
        ctx.font = `bold ${Math.min(26, bh * 0.6)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(boards[idx], x + (bw - 12) / 2, by + bh / 2 + 1);
      }
    }
    ctx.textBaseline = 'alphabetic';
  }

  /** Pit-entry cinematic on the track: dimmed field, lit path and chevrons up to the gap. */
  drawPitApproach(world, W) {
    const { ctx } = this;
    const a = world.cine;
    const p = world.player;
    // dim everything that can no longer hurt you
    ctx.fillStyle = `rgba(4,6,14,${0.35 * a})`;
    ctx.fillRect(0, world.trackTop - 12, W, world.trackBottom - world.trackTop + 24);
    // lit corridor from the car up to the pit gap
    const gapX = p.x + 60;
    const g = ctx.createLinearGradient(0, world.trackBottom, 0, world.pitBottom);
    g.addColorStop(0, 'rgba(46,204,113,0)');
    g.addColorStop(1, `rgba(46,204,113,${0.28 * a})`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(p.x - 140, world.trackBottom);
    ctx.lineTo(p.x + 140, world.trackBottom);
    ctx.lineTo(gapX + 140, world.pitBottom);
    ctx.lineTo(gapX - 140, world.pitBottom);
    ctx.closePath();
    ctx.fill();
    // chevrons marching up the corridor
    const n = 5;
    for (let i = 0; i < n; i++) {
      const t = ((i / n) + (this.time * 0.9) % 1) % 1;
      const y = lerp(world.trackBottom - 20, world.trackTop + 10, t);
      const x = lerp(p.x, gapX, t);
      ctx.globalAlpha = a * (0.25 + 0.75 * Math.sin(t * Math.PI));
      ctx.strokeStyle = '#2ecc71';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x - 18, y + 10); ctx.lineTo(x, y - 4); ctx.lineTo(x + 18, y + 10);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // ghost outline around the car so the invulnerability reads
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.tilt);
    ctx.strokeStyle = `rgba(125,249,255,${0.75 * a * (0.6 + 0.4 * Math.sin(this.time * 10))})`;
    ctx.lineWidth = 3;
    roundRect(ctx, -PLAYER.width / 2 - 8, -PLAYER.height / 2 - 8, PLAYER.width + 16, PLAYER.height + 16, 14);
    ctx.stroke();
    ctx.restore();
  }

  /** Cinematic letterbox + caption while boxing. */
  drawLetterbox(world, W, H) {
    const { ctx } = this;
    const a = world.cine;
    const bar = 44 * a;
    ctx.fillStyle = '#04060e';
    ctx.fillRect(0, 0, W, bar);
    ctx.fillRect(0, H - bar, W, bar);
    ctx.globalAlpha = a;
    ctx.fillStyle = '#ffd400';
    ctx.font = `900 ${18 + 6 * a}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BOX BOX', W / 2, H - bar / 2);
    ctx.fillStyle = '#c9ced9';
    ctx.font = `bold 12px ${FONT}`;
    ctx.fillText(`${COMPOUNDS[world.nextCompound].label} · get ready on the wheel gun`, W / 2, bar / 2);
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 1;
  }

  /** The pit-stop mini-game: mechanics, per-wheel status, sweeping marker, stop clock. */
  drawPitGame(world) {
    const { ctx } = this;
    const p = world.player;
    const g = world.pit.game;
    const n = PITGAME.wheels.length;
    const done = g.wheel >= n;
    // mechanics crouched at each wheel; the active one raises the gun
    const spots = [[54, -26], [54, 26], [-58, -26], [-58, 26]]; // FL FR RL RR (car faces right)
    spots.forEach(([dx, dy], i) => {
      const active = i === g.wheel && !done;
      const res = g.results[i];
      ctx.fillStyle = '#e10600';
      ctx.beginPath(); ctx.arc(p.x + dx, p.y + dy, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffd400';
      ctx.beginPath(); ctx.arc(p.x + dx, p.y + dy - 3, 4, 0, Math.PI * 2); ctx.fill();
      // gun
      ctx.fillStyle = active ? '#fff' : '#555a66';
      ctx.fillRect(p.x + dx + (dx > 0 ? -16 : 8), p.y + dy - 2, 8, 4);
      // status dot
      if (res) {
        ctx.fillStyle = res === 'perfect' ? '#7df9ff' : res === 'good' ? '#2ecc71' : '#ff3b3b';
        ctx.beginPath(); ctx.arc(p.x + dx, p.y + dy + 14, 4, 0, Math.PI * 2); ctx.fill();
      }
    });
    // gun flash on the wheel just done
    if (g.flash > 0 && g.lastResult) {
      const i = g.wheel - 1;
      const [dx, dy] = spots[i] || [0, 0];
      ctx.fillStyle = g.lastResult === 'miss' ? `rgba(255,59,59,${g.flash})` : `rgba(255,255,220,${g.flash})`;
      ctx.beginPath(); ctx.arc(p.x + dx, p.y + dy, 10 + (1 - g.flash) * 14, 0, Math.PI * 2); ctx.fill();
    }

    // panel above the car
    const W = 340, H = 96;
    const x = p.x - W / 2;
    const y = p.y + 46; // below the car, over the empty top of the track
    ctx.fillStyle = 'rgba(8,10,16,0.88)';
    roundRect(ctx, x, y, W, H, 10);
    ctx.fill();
    // stop clock
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    ctx.font = `bold 28px ${MONO}`;
    ctx.fillText(g.total.toFixed(2), x + 14, y + 34);
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = '#c9ced9';
    ctx.fillText('stop time', x + 14, y + 48);
    // wheel chips
    PITGAME.wheels.forEach((w, i) => {
      const cx = x + 132 + i * 50;
      const res = g.results[i];
      const active = i === g.wheel && !done;
      ctx.fillStyle = res === 'perfect' ? '#7df9ff' : res === 'good' ? '#2ecc71' : res === 'miss' ? '#ff3b3b' : active ? '#ffd400' : 'rgba(255,255,255,0.14)';
      roundRect(ctx, cx, y + 12, 38, 22, 5);
      ctx.fill();
      ctx.fillStyle = res || active ? '#111' : '#c9ced9';
      ctx.font = `bold 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(res === 'miss' ? '✕' : res === 'perfect' ? '★' : w, cx + 19, y + 28);
      if (g.jammed[i] && !res) { ctx.fillStyle = '#ff8a00'; ctx.font = `bold 9px ${FONT}`; ctx.fillText('JAM', cx + 19, y + 44); }
    });
    // sweep bar
    const bx = x + 14, by = y + 60, bw = W - 28, bh = 16;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, bx, by, bw, bh, 4); ctx.fill();
    if (!done) {
      const half = g.jammed[g.wheel] ? PITGAME.jamZoneHalf : PITGAME.zoneHalf;
      ctx.fillStyle = 'rgba(46,204,113,0.55)';
      ctx.fillRect(bx + bw * (0.5 - half), by, bw * half * 2, bh);
      ctx.fillStyle = 'rgba(125,249,255,0.9)';
      ctx.fillRect(bx + bw * (0.5 - PITGAME.perfectHalf), by, bw * PITGAME.perfectHalf * 2, bh);
      if (g.hold <= 0) {
        const pos = sweepPos(g.t);
        ctx.fillStyle = '#fff';
        ctx.fillRect(bx + bw * pos - 2, by - 4, 4, bh + 8);
        // time left on this wheel
        ctx.fillStyle = 'rgba(255,212,0,0.8)';
        ctx.fillRect(bx, by + bh + 3, bw * (1 - g.t / PITGAME.window), 3);
      }
      ctx.fillStyle = '#fff';
      ctx.font = `bold 11px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(g.hold > 0 ? (g.lastResult === 'miss' ? 'CROSS-THREADED…' : g.lastResult === 'perfect' ? 'PERFECT' : 'GOOD') : `FIRE  ·  SPACE / B / tap`, x + W - 14, y + 48);
    } else {
      ctx.fillStyle = '#2ecc71';
      ctx.font = `bold 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(g.hold > 0 ? 'JACK DOWN — GO GO GO' : '', x + W / 2, by + 12);
    }
    ctx.textAlign = 'left';
  }

  /** Yellow-flag marshals along the pit wall while the safety car is out. */
  drawMarshals(world, W) {
    if (!world.sc.active) return;
    const { ctx } = this;
    const y = world.pitBottom + (world.trackTop - world.pitBottom) / 2;
    for (let x = -(world.scroll % 300); x < W; x += 300) {
      ctx.fillStyle = '#ff8a00';
      ctx.fillRect(x - 5, y - 8, 10, 16);
      ctx.fillStyle = '#ffd7a8';
      ctx.beginPath(); ctx.arc(x, y - 12, 5, 0, Math.PI * 2); ctx.fill();
      const wave = Math.sin(this.time * 9 + x) * 0.5;
      ctx.save();
      ctx.translate(x + 6, y - 10);
      ctx.rotate(-0.8 + wave);
      ctx.fillStyle = '#333';
      ctx.fillRect(0, -22, 2, 22);
      ctx.fillStyle = '#ffd400';
      ctx.fillRect(2, -22, 16, 11);
      ctx.restore();
    }
  }

  /** Darkens the scene and paints light sources with additive blending. */
  drawNight(world, W, H) {
    const n = world.night;
    if (n <= 0.02) return;
    const { ctx } = this;
    ctx.fillStyle = `rgba(6,9,28,${0.5 * n})`;
    ctx.fillRect(0, world.pitTop * 0.56, W, H - world.pitTop * 0.56);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = n;
    // floodlight pools on the track
    for (let x = -(world.scroll * 0.25 % 220) + 100; x < W + 220; x += 220) {
      const g = ctx.createLinearGradient(0, world.pitTop, 0, world.trackBottom);
      g.addColorStop(0, 'rgba(255,245,210,0.1)');
      g.addColorStop(1, 'rgba(255,245,210,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x, world.pitTop * 0.56);
      ctx.lineTo(x - 260, world.trackBottom);
      ctx.lineTo(x + 260, world.trackBottom);
      ctx.closePath();
      ctx.fill();
    }
    // headlights + brake lights
    const beam = (x, y, w, h, strength) => {
      const g = ctx.createLinearGradient(x, y, x + w, y);
      g.addColorStop(0, `rgba(255,250,220,${0.55 * strength})`);
      g.addColorStop(1, 'rgba(255,250,220,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x, y - h * 0.15);
      ctx.lineTo(x + w, y - h);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h * 0.15);
      ctx.closePath();
      ctx.fill();
    };
    const tail = (x, y, strength) => {
      const g = ctx.createRadialGradient(x, y, 1, x, y, 26);
      g.addColorStop(0, `rgba(255,40,40,${0.9 * strength})`);
      g.addColorStop(1, 'rgba(255,40,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, 26, 0, Math.PI * 2); ctx.fill();
    };
    const p = world.player;
    if (p.alive) {
      beam(p.x + PLAYER.width * 0.45, p.y + 4, 300, 40, 1);
      tail(p.x - PLAYER.width * 0.48, p.y - 2, p.throttle < 0.95 ? 1 : 0.35 + 0.65 * (world.rain > 0.3 ? (Math.sin(this.time * 12) > 0 ? 1 : 0) : 0));
    }
    for (const hz of world.hazards) {
      if (hz.type === 'rival') {
        beam(hz.x + hz.w * 0.45, hz.y + 4, 220, 30, 0.8);
        tail(hz.x - hz.w * 0.48, hz.y - 2, hz.brake > 0 ? 1 : 0.3);
      } else if (hz.type === 'stranded') {
        const blink = Math.sin(this.time * 8) > 0 ? 1 : 0.1;
        tail(hz.x - hz.w * 0.4, hz.y, blink);
        tail(hz.x + hz.w * 0.4, hz.y, blink);
      }
    }
    if (world.sc.car) {
      beam(world.sc.car.x + PLAYER.width * 0.45, world.sc.car.y + 4, 260, 34, 0.9);
    }
    // flames and sparks glow a little more at night
    ctx.restore();
  }

  drawWeather(world, W, H) {
    if (world.rain <= 0.02) return;
    const { ctx } = this;
    const n = Math.floor(220 * world.rain);
    ctx.strokeStyle = `rgba(210,228,255,${0.55 * world.rain})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const t = this.time * 900;
    for (let i = 0; i < n; i++) {
      const x = ((i * 733 + t * (1 + (i % 3) * 0.2)) % (W + 200)) - 100;
      const y = (i * 977 + t * 1.3) % H;
      ctx.moveTo(x, y);
      ctx.lineTo(x - 14, y + 18);
    }
    ctx.stroke();
    ctx.fillStyle = `rgba(90,110,150,${0.16 * world.rain})`;
    ctx.fillRect(0, 0, W, H);
  }

  /** Motion streaks at the screen edges when the speed gets silly. */
  drawSpeedLines(world, W, H) {
    const s = clamp((world.intensity - 0.45) / 0.55, 0, 1) + (world.ers.boosting ? 0.5 : 0);
    if (s <= 0 || world.gameOver) return;
    const { ctx } = this;
    ctx.strokeStyle = world.ers.boosting ? `rgba(125,249,255,${0.5 * s})` : `rgba(255,255,255,${0.3 * s})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const t = this.time * 2400;
    const n = Math.floor(18 * Math.min(1, s));
    for (let i = 0; i < n; i++) {
      const len = 80 + hash(i) * 220;
      const x = W - (((hash(i + 40) * 3000) + t * (1 + hash(i) * 0.5)) % (W + len)) + len;
      const edge = i % 2 ? hash(i + 3) * H * 0.22 : H - hash(i + 3) * H * 0.22;
      ctx.moveTo(x, edge);
      ctx.lineTo(x - len, edge);
    }
    ctx.stroke();
  }

  drawPopups(world) {
    const { ctx } = this;
    ctx.textAlign = 'center';
    ctx.font = `900 18px ${FONT}`;
    for (const pp of world.popups) {
      const a = clamp(1 - pp.age / pp.life, 0, 1);
      ctx.globalAlpha = a;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 4;
      ctx.strokeText(pp.text, pp.x, pp.y);
      ctx.fillStyle = pp.color;
      ctx.fillText(pp.text, pp.x, pp.y);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- entities ----------
  drawPlayer(world) {
    const { ctx } = this;
    const p = world.player;
    const { sheet, frames } = this.assets;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.tilt + p.angle);
    if (world.pit.requested) ctx.globalAlpha = 0.72 + 0.2 * Math.sin(this.time * 14); // ghosted on the way in
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, PLAYER.height * 0.45, PLAYER.width * 0.48, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    if (sheet && sheet.complete && sheet.naturalWidth) {
      const fw = sheet.naturalWidth;
      const fh = sheet.naturalHeight / frames;
      const fi = Math.floor(p.frame) % frames;
      ctx.scale(-1, 1); // sprite faces left; we drive right
      ctx.drawImage(sheet, 0, fi * fh, fw, fh, -PLAYER.width / 2, -PLAYER.height / 2, PLAYER.width, PLAYER.height);
      ctx.scale(-1, 1);
    } else {
      drawVectorCar(ctx, PLAYER.width, PLAYER.height, { primary: '#e10600', accent: '#fff' }, p.frame);
    }
    // brake light when lifting (the FIA rain light doubles as one)
    if (p.throttle < 0.95 || world.rain > 0.3) {
      const on = world.rain > 0.3 ? Math.sin(this.time * 12) > 0 : true;
      ctx.fillStyle = on ? '#ff2a2a' : '#5a0000';
      ctx.fillRect(-PLAYER.width * 0.5, -PLAYER.height * 0.12, 5, PLAYER.height * 0.24);
    }
    // damage sparks flag
    if (p.damage > 0) {
      ctx.fillStyle = '#222';
      ctx.fillRect(PLAYER.width * 0.35, -PLAYER.height * 0.25, 10, 4);
    }
    ctx.restore();
  }

  drawSafetyCar(world) {
    const { ctx } = this;
    const car = world.sc.car;
    const w = PLAYER.width * 0.9;
    const h = PLAYER.height * 0.95;
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(0, h * 0.45, w * 0.48, 7, 0, 0, Math.PI * 2); ctx.fill();
    // a GT-shaped silhouette: taller cabin than the single-seaters
    ctx.fillStyle = SAFETY_CAR_TEAM.primary;
    ctx.beginPath();
    ctx.moveTo(-w * 0.48, h * 0.1);
    ctx.lineTo(-w * 0.44, -h * 0.15);
    ctx.lineTo(-w * 0.2, -h * 0.42);
    ctx.lineTo(w * 0.12, -h * 0.42);
    ctx.lineTo(w * 0.4, -h * 0.12);
    ctx.lineTo(w * 0.5, h * 0.05);
    ctx.lineTo(w * 0.5, h * 0.3);
    ctx.lineTo(-w * 0.48, h * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#1b2230';
    ctx.beginPath();
    ctx.moveTo(-w * 0.16, -h * 0.38); ctx.lineTo(w * 0.08, -h * 0.38); ctx.lineTo(w * 0.3, -h * 0.12); ctx.lineTo(-w * 0.3, -h * 0.12); ctx.closePath(); ctx.fill();
    ctx.fillStyle = SAFETY_CAR_TEAM.accent;
    ctx.fillRect(-w * 0.48, h * 0.02, w * 0.98, h * 0.08);
    // light bar
    const phase = Math.sin(this.time * 10) > 0;
    ctx.fillStyle = phase ? '#ffb000' : '#3a2a00';
    ctx.fillRect(-w * 0.18, -h * 0.52, w * 0.14, h * 0.1);
    ctx.fillStyle = phase ? '#3a2a00' : '#ffb000';
    ctx.fillRect(-w * 0.02, -h * 0.52, w * 0.14, h * 0.1);
    ctx.fillStyle = '#111';
    ctx.font = `bold ${h * 0.24}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('SAFETY CAR', 0, -h * 0.02);
    ctx.textBaseline = 'alphabetic';
    for (const wx of [-w * 0.3, w * 0.3]) {
      ctx.fillStyle = '#0b0b0d';
      ctx.beginPath(); ctx.arc(wx, h * 0.28, h * 0.22, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#9aa0ad';
      ctx.beginPath(); ctx.arc(wx, h * 0.28, h * 0.1, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  drawHazard(hz, world) {
    const { ctx } = this;
    switch (hz.type) {
      case 'tyre': return this.drawTyre(hz);
      case 'rival': {
        ctx.save();
        ctx.translate(hz.x, hz.y);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(0, hz.h * 0.45, hz.w * 0.48, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        drawVectorCar(ctx, hz.w, hz.h, hz.team, hz.frame, { brake: hz.brake > 0, driver: hz.driver });
        if (hz.team.teammate || hz.driver?.legend) {
          ctx.fillStyle = hz.driver?.legend ? '#d4af37' : '#fff';
          ctx.font = `bold 11px ${FONT}`;
          ctx.textAlign = 'center';
          ctx.fillText(hz.team.teammate ? `TEAM-MATE · ${hz.driver.short}` : `${hz.driver.name.toUpperCase()} · ${hz.team.classic}`, 0, -hz.h * 0.75);
        }
        // tow indicator when you are in this car's slipstream
        if (world.towRival === hz && world.tow > 0.15) {
          ctx.strokeStyle = `rgba(125,249,255,${0.5 * world.tow})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let i = -2; i <= 2; i++) { ctx.moveTo(-hz.w * 0.55, i * 9); ctx.lineTo(-hz.w * 0.55 - 40 - world.tow * 60, i * 9 * (1 + world.tow)); }
          ctx.stroke();
        }
        ctx.restore();
        return;
      }
      case 'stranded': {
        ctx.save();
        ctx.translate(hz.x, hz.y);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath(); ctx.ellipse(0, hz.h * 0.45, hz.w * 0.48, 7, 0, 0, Math.PI * 2); ctx.fill();
        ctx.rotate(hz.angle);
        drawVectorCar(ctx, hz.w, hz.h, hz.team, 0, { broken: true, driver: hz.driver });
        ctx.restore();
        // a marshal with a yellow flag beside it and a warning board
        ctx.save();
        ctx.translate(hz.x + hz.w * 0.7, hz.y - hz.h * 0.2);
        ctx.fillStyle = '#ff8a00'; ctx.fillRect(-5, -8, 10, 18);
        ctx.fillStyle = '#ffd7a8'; ctx.beginPath(); ctx.arc(0, -13, 5, 0, Math.PI * 2); ctx.fill();
        ctx.rotate(-0.6 + Math.sin(this.time * 9) * 0.5);
        ctx.fillStyle = '#333'; ctx.fillRect(4, -34, 2, 24);
        ctx.fillStyle = '#ffd400'; ctx.fillRect(6, -34, 16, 11);
        ctx.restore();
        return;
      }
      case 'oil': {
        ctx.save();
        ctx.translate(hz.x, hz.y);
        const g = ctx.createRadialGradient(0, 0, 2, 0, 0, hz.w / 2);
        g.addColorStop(0, 'rgba(20,20,30,0.95)');
        g.addColorStop(0.7, 'rgba(30,20,50,0.85)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(0, 0, hz.w / 2, hz.h / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        // oily rainbow sheen
        ctx.strokeStyle = `hsla(${(this.time * 60) % 360} 80% 60% / 0.35)`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(-hz.w * 0.1, -hz.h * 0.15, hz.w * 0.25, hz.h * 0.2, 0.3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        return;
      }
      case 'debris': {
        ctx.save();
        ctx.translate(hz.x, hz.y);
        ctx.rotate(hz.spin);
        ctx.fillStyle = '#1d1f26';
        ctx.beginPath();
        ctx.moveTo(-hz.r, -hz.r * 0.4);
        ctx.lineTo(hz.r * 0.9, -hz.r * 0.8);
        ctx.lineTo(hz.r, hz.r * 0.5);
        ctx.lineTo(-hz.r * 0.5, hz.r * 0.9);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#e10600';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
        return;
      }
      case 'drs': {
        ctx.save();
        ctx.translate(hz.x, hz.y);
        const pulse = 0.6 + 0.4 * Math.sin(this.time * 8);
        ctx.fillStyle = `rgba(46,204,113,${0.25 * pulse})`;
        ctx.fillRect(-hz.w * 2, -hz.h / 2, hz.w * 4, hz.h);
        ctx.fillStyle = '#2ecc71';
        ctx.fillRect(-hz.w / 2, -hz.h / 2, hz.w, hz.h);
        ctx.fillStyle = '#072';
        ctx.font = `bold 14px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.save();
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('DRS', 0, 0);
        ctx.restore();
        ctx.textBaseline = 'alphabetic';
        ctx.restore();
        return;
      }
      default:
    }
  }

  drawTyre(hz) {
    const { ctx } = this;
    const r = hz.r;
    ctx.save();
    ctx.translate(hz.x, hz.y);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(4, r * 0.9, r * 0.9, r * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(hz.spin);
    ctx.fillStyle = '#0c0c0e';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = hz.compound.color;
    ctx.lineWidth = Math.max(2, r * 0.16);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.78, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#2a2d33';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#9aa0ad';
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * r * 0.45, Math.sin(a) * r * 0.45);
    }
    ctx.stroke();
    ctx.fillStyle = hz.compound.color;
    ctx.font = `bold ${Math.max(7, r * 0.45)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('P', 0, -r * 0.89);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  drawParticles(world, kinds) {
    const { ctx } = this;
    for (const pt of world.particles) {
      if (!kinds.includes(pt.kind)) continue;
      const t = 1 - pt.age / pt.life;
      switch (pt.kind) {
        case 'smoke':
          ctx.fillStyle = `rgba(150,150,160,${0.35 * t})`;
          break;
        case 'spray':
          ctx.fillStyle = `rgba(210,225,255,${0.45 * t})`;
          break;
        case 'flame':
          ctx.fillStyle = `rgba(${255},${120 + 120 * t},${40},${0.9 * t})`;
          break;
        case 'spark':
          ctx.fillStyle = `rgba(255,${180 + 60 * t},80,${t})`;
          break;
        case 'streak':
          ctx.strokeStyle = `rgba(125,249,255,${0.35 * t})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(pt.x, pt.y); ctx.lineTo(pt.x - pt.r, pt.y); ctx.stroke();
          continue;
        case 'carbon':
          ctx.save();
          ctx.translate(pt.x, pt.y);
          ctx.rotate(pt.spin);
          ctx.fillStyle = `rgba(25,27,34,${t})`;
          ctx.fillRect(-pt.r, -pt.r * 0.4, pt.r * 2, pt.r * 0.8);
          ctx.fillStyle = `rgba(225,6,0,${t})`;
          ctx.fillRect(-pt.r, -pt.r * 0.4, pt.r * 0.7, pt.r * 0.8);
          ctx.restore();
          continue;
        default:
          ctx.fillStyle = '#fff';
      }
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------- HUD ----------
  drawHud(world, hud, W, H) {
    const { ctx } = this;
    const pad = 18;
    // speedo (bottom-left)
    const kmh = world.kmh;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(8,10,16,0.82)';
    roundRect(ctx, pad, H - 118, 250, 100, 10);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold 46px ${MONO}`;
    ctx.fillText(String(kmh).padStart(3, ' '), pad + 14, H - 66);
    ctx.font = `14px ${FONT}`;
    ctx.fillStyle = '#c9ced9';
    ctx.fillText('km/h', pad + 108, H - 66);
    // tow / penalty status beside the speed
    ctx.textAlign = 'right';
    ctx.font = `bold 12px ${FONT}`;
    if (world.penalty > 0) {
      ctx.fillStyle = '#ff3b3b';
      ctx.fillText(`PENALTY ${world.penalty.toFixed(1)}s`, pad + 238, H - 96);
    } else if (world.sc.active) {
      ctx.fillStyle = '#ffd400';
      ctx.fillText('SC DELTA', pad + 238, H - 96);
    } else if (world.sc.restartTimer > 0) {
      ctx.fillStyle = '#2ecc71';
      ctx.fillText(`RESTART x2 ${world.sc.restartTimer.toFixed(1)}s`, pad + 238, H - 96);
    } else if (world.tow > 0.15) {
      ctx.fillStyle = `rgba(125,249,255,${0.5 + world.tow * 0.5})`;
      ctx.fillText(`TOW ${Math.round(world.tow * 100)}%`, pad + 238, H - 96);
    }
    ctx.textAlign = 'left';
    // gear bars
    const ratio = clamp(world.speed / SPEED.max, 0, 1);
    for (let i = 0; i < 14; i++) {
      const on = i / 14 < ratio;
      ctx.fillStyle = on ? (i > 10 ? '#ff3b3b' : i > 7 ? '#ffd400' : '#2ecc71') : 'rgba(255,255,255,0.12)';
      ctx.fillRect(pad + 14 + i * 16, H - 52, 12, 10);
    }
    // ERS
    ctx.fillStyle = '#c9ced9';
    ctx.font = `bold 11px ${FONT}`;
    ctx.fillText('ERS', pad + 14, H - 28);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(pad + 44, H - 37, 190, 10);
    ctx.fillStyle = world.ers.boosting ? '#7df9ff' : world.ers.charge > ERS.minToEngage ? '#2ee6a6' : '#666';
    ctx.fillRect(pad + 44, H - 37, 190 * (world.ers.charge / ERS.max), 10);

    // tyre widget (bottom-right)
    const tw = 250;
    const tx = W - pad - tw;
    ctx.fillStyle = 'rgba(8,10,16,0.82)';
    roundRect(ctx, tx, H - 118, tw, 100, 10);
    ctx.fill();
    const c = COMPOUNDS[world.tyre.compound];
    ctx.save();
    ctx.translate(tx + 40, H - 68);
    ctx.fillStyle = '#0c0c0e';
    ctx.beginPath(); ctx.arc(0, 0, 26, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = c.color; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(0, 0, 19, 0, Math.PI * 2); ctx.stroke();
    // temperature ring: blue when cold, fades out when up to temp
    if (world.tyre.temp < 0.98) {
      ctx.strokeStyle = `rgba(90,160,255,${1 - world.tyre.temp})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, 24, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - world.tyre.temp)); ctx.stroke();
    }
    ctx.fillStyle = c.color;
    ctx.font = `bold 18px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(c.short, 0, 1);
    ctx.restore();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText(world.tyre.punctured ? 'PUNCTURE' : world.tyre.temp < 0.6 ? `${c.label} · COLD` : c.label, tx + 80, H - 88);
    const wear = world.tyre.wear;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(tx + 80, H - 78, 150, 10);
    ctx.fillStyle = wear > 85 ? '#ff3b3b' : wear > 65 ? '#ffd400' : '#2ecc71';
    ctx.fillRect(tx + 80, H - 78, 150 * (1 - wear / 100), 10);
    ctx.fillStyle = '#c9ced9';
    ctx.font = `12px ${FONT}`;
    ctx.fillText(`grip ${Math.round(world.grip * 100)}%`, tx + 80, H - 58);
    const nc = COMPOUNDS[world.nextCompound];
    ctx.fillStyle = '#c9ced9';
    ctx.fillText('Next stop:', tx + 80, H - 36);
    ctx.fillStyle = nc.color;
    ctx.font = `bold 12px ${FONT}`;
    ctx.fillText(nc.label, tx + 150, H - 36);
    ctx.fillStyle = '#8a91a0';
    ctx.font = `11px ${FONT}`;
    ctx.fillText('[1-5 / Tab]', tx + 80, H - 22);
    // pit status
    const pitIn = world.pitCountdown();
    ctx.textAlign = 'right';
    ctx.font = `bold 12px ${FONT}`;
    if (world.pit.inLane) {
      ctx.fillStyle = '#ffd400';
      ctx.fillText(world.pit.phase === 'stop' ? 'IN THE BOX — fire the guns!' : 'PIT LANE', tx + tw - 12, H - 104);
    } else if (world.pit.open) {
      ctx.fillStyle = '#2ecc71';
      ctx.fillText(world.pit.requested ? 'BOXING — copy' : 'PIT OPEN — press B', tx + tw - 12, H - 104);
    } else if (world.pit.cooldown > 0) {
      ctx.fillStyle = '#8a91a0';
      ctx.fillText('fresh tyres — stay out', tx + tw - 12, H - 104);
    } else {
      ctx.fillStyle = '#8a91a0';
      ctx.fillText(`pit window in ${Math.ceil(pitIn)}s`, tx + tw - 12, H - 104);
    }

    // top strip: score, distance, time, overtakes, weather
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(8,10,16,0.82)';
    roundRect(ctx, pad, pad, 300, 64, 10);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold 30px ${MONO}`;
    ctx.fillText(String(world.score).padStart(6, '0'), pad + 14, pad + 36);
    ctx.font = `12px ${FONT}`;
    ctx.fillStyle = '#c9ced9';
    ctx.fillText(`${formatDistance(world.distance)}   ·   ${formatTime(world.elapsed)}   ·   best ${hud.best}`, pad + 14, pad + 54);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff';
    ctx.font = `bold 16px ${FONT}`;
    ctx.fillText(positionLabel(world.overtakes), pad + 286, pad + 26);
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = '#c9ced9';
    ctx.fillText(`${world.overtakes} overtakes`, pad + 286, pad + 42);
    ctx.fillText(`${world.closeCalls} close calls`, pad + 286, pad + 56);

    // venue + GP progress + weather (top right)
    const vw = 250;
    const vx = W - pad - vw;
    ctx.fillStyle = 'rgba(8,10,16,0.82)';
    roundRect(ctx, vx, pad, vw, 64, 10);
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText(`${world.venue.flag} ${world.venue.name}`, vx + 12, pad + 24);
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = '#c9ced9';
    ctx.fillText(`Round ${world.gps + 1}  ·  ${hud.points ?? 0} pts`, vx + 12, pad + 40);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(vx + 12, pad + 48, vw - 24, 6);
    ctx.fillStyle = '#ffd400';
    ctx.fillRect(vx + 12, pad + 48, (vw - 24) * gpProgress(world.distance), 6);
    ctx.textAlign = 'right';
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillStyle = world.raining ? '#7fb2ff' : '#ffd400';
    ctx.fillText(world.raining ? '🌧 RAIN' : world.rain > 0.1 ? '☁ DRYING' : world.night > 0.5 ? '🌙 NIGHT' : '☀ DRY', vx + vw - 12, pad + 24);
    ctx.fillStyle = hud.musicOn ? '#c9ced9' : '#666';
    ctx.font = `11px ${FONT}`;
    ctx.fillText(hud.musicOn ? '♪ on (M)' : '♪ off (M)', vx + vw - 12, pad + 40);

    // safety car banner
    if (world.sc.active) {
      const on = Math.sin(this.time * 6) > 0;
      ctx.textAlign = 'center';
      ctx.fillStyle = on ? '#ffd400' : '#ffb000';
      roundRect(ctx, W / 2 - 130, pad + 56, 260, 30, 6);
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.font = `900 16px ${FONT}`;
      ctx.fillText(world.sc.phase === 'ending' ? 'SAFETY CAR IN THIS LAP' : 'SAFETY CAR — NO OVERTAKING', W / 2, pad + 77);
    }

    // radio message
    if (hud.radio && hud.radio.age < 4.5) {
      const a = clamp(1 - (hud.radio.age - 3.5), 0, 1);
      ctx.globalAlpha = a;
      ctx.textAlign = 'left';
      ctx.font = `bold 16px ${FONT}`;
      const text = `📻 ${hud.radio.text}`;
      const tw2 = ctx.measureText(text).width + 30;
      const rx = W / 2 - tw2 / 2;
      const ry = pad + 10;
      ctx.fillStyle = 'rgba(10,10,14,0.75)';
      roundRect(ctx, rx, ry, tw2, 38, 8);
      ctx.fill();
      ctx.fillStyle = '#e10600';
      ctx.fillRect(rx, ry, 6, 38);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, rx + 16, ry + 25);
      ctx.globalAlpha = 1;
    }

    // toast (big centre text: milestones etc.)
    if (hud.toast && hud.toast.age < 1.6) {
      const t = hud.toast.age;
      const a = t < 0.2 ? t / 0.2 : t > 1.2 ? 1 - (t - 1.2) / 0.4 : 1;
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.textAlign = 'center';
      ctx.font = `900 ${34 + Math.min(1, t * 4) * 6}px ${FONT}`;
      ctx.fillStyle = hud.toast.color || '#ffd400';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 6;
      ctx.strokeText(hud.toast.text, W / 2, H * 0.36);
      ctx.fillText(hud.toast.text, W / 2, H * 0.36);
      if (hud.toast.sub) {
        ctx.font = `bold 16px ${FONT}`;
        ctx.lineWidth = 4;
        ctx.strokeText(hud.toast.sub, W / 2, H * 0.36 + 28);
        ctx.fillStyle = '#fff';
        ctx.fillText(hud.toast.sub, W / 2, H * 0.36 + 28);
      }
      ctx.globalAlpha = 1;
    }

    // controls hint for the first seconds
    if (world.elapsed < 8 && !world.gameOver) {
      ctx.globalAlpha = clamp(1 - (world.elapsed - 6) / 2, 0, 1) * 0.9;
      ctx.textAlign = 'center';
      ctx.font = `13px ${FONT}`;
      ctx.fillStyle = '#fff';
      ctx.fillText('▲▼ steer   ▶ push / ◀ lift   SPACE boost   B to box when the window opens   ·   sit behind a rival for the tow', W / 2, world.trackBottom - 22);
      ctx.globalAlpha = 1;
    }
  }
}

// ---------- helpers ----------
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function lerpColor(a, b, t) {
  if (a === b || t <= 0) return a.startsWith('#') ? rgbString(hex(a)) : a;
  const pa = hex(a), pb = hex(b);
  const c = pa.map((v, i) => Math.round(lerp(v, pb[i], t)));
  return rgbString(c);
}
const rgbString = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
function hex(h) {
  if (h.startsWith('rgb')) return h.match(/\d+/g).slice(0, 3).map(Number);
  const s = h.replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((ch) => ch + ch).join('') : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Side-view F1 car facing right, drawn centred at the origin inside w×h. */
export function drawVectorCar(ctx, w, h, team, frame = 0, opts = {}) {
  const hw = w / 2, hh = h / 2;
  ctx.save();
  const wr = h * 0.36; // wheel radius
  const wy = hh - wr; // wheel centre y
  const wheels = [-hw * 0.6, hw * 0.52];
  // floor / body: long low wedge sitting between the wheels
  ctx.fillStyle = team.primary;
  ctx.beginPath();
  ctx.moveTo(-hw * 0.92, wy - wr * 0.2); // rear
  ctx.lineTo(-hw * 0.7, wy - wr * 0.9);
  ctx.lineTo(-hw * 0.32, wy - wr * 0.9); // engine cover
  ctx.lineTo(-hw * 0.22, -hh * 0.9); // airbox
  ctx.lineTo(-hw * 0.02, -hh * 0.9);
  ctx.lineTo(hw * 0.1, wy - wr * 0.9); // cockpit front
  ctx.lineTo(hw * 0.78, wy - wr * 0.35); // nose
  ctx.lineTo(hw * 0.98, wy + wr * 0.1);
  ctx.lineTo(hw * 0.98, wy + wr * 0.45);
  ctx.lineTo(-hw * 0.92, wy + wr * 0.45);
  ctx.closePath();
  ctx.fill();
  // sidepod / stripe
  ctx.fillStyle = team.accent;
  ctx.fillRect(-hw * 0.62, wy - wr * 0.35, hw * 0.75, wr * 0.5);
  if (team.stripe) {
    ctx.fillStyle = team.stripe;
    ctx.fillRect(-hw * 0.62, wy - wr * 0.35, hw * 0.75, wr * 0.14);
    ctx.fillRect(-hw * 0.3, -hh * 0.9, hw * 0.28, hh * 0.25); // airbox flash
  }
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(-hw * 0.92, wy + wr * 0.25, w * 0.95, wr * 0.2);
  // race number on the nose
  const driver = opts.driver;
  if (driver) {
    ctx.fillStyle = team.primary === '#111' || team.primary === '#101010' ? '#fff' : '#111';
    ctx.font = `900 ${Math.max(7, h * 0.3)}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(driver.number), hw * 0.42, wy - wr * 0.05);
    ctx.textBaseline = 'alphabetic';
  }
  // halo + helmet (driver's own colours)
  ctx.strokeStyle = '#111';
  ctx.lineWidth = Math.max(2, h * 0.06);
  ctx.beginPath();
  ctx.arc(-hw * 0.06, wy - wr * 0.9, hh * 0.42, Math.PI, 0);
  ctx.stroke();
  const helmet = driver ? driver.helmet : [team.accent, team.primary];
  ctx.fillStyle = helmet[0];
  ctx.beginPath();
  ctx.arc(-hw * 0.06, wy - wr * 0.95, hh * 0.26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = helmet[1];
  ctx.beginPath();
  ctx.arc(-hw * 0.06, wy - wr * 0.95, hh * 0.26, Math.PI * 1.15, Math.PI * 1.85);
  ctx.lineTo(-hw * 0.06, wy - wr * 0.95);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(20,24,40,0.8)'; // visor
  ctx.fillRect(-hw * 0.06 + hh * 0.02, wy - wr * 0.95 - hh * 0.08, hh * 0.24, hh * 0.12);
  // rear wing (hangs off when broken)
  ctx.fillStyle = '#111';
  if (opts.broken) {
    ctx.save(); ctx.translate(-hw, -hh * 0.5); ctx.rotate(0.5); ctx.fillRect(0, 0, w * 0.14, h * 0.13); ctx.restore();
  } else {
    ctx.fillRect(-hw, -hh * 0.75, w * 0.14, h * 0.13);
    ctx.fillRect(-hw * 0.9, -hh * 0.75, Math.max(2, w * 0.02), hh + wy * 0.2);
  }
  // front wing
  ctx.fillRect(hw * 0.55, wy + wr * 0.35, w * 0.22, h * 0.12);
  // brake / rain light
  if (opts.brake) {
    ctx.fillStyle = '#ff2a2a';
    ctx.fillRect(-hw * 0.96, wy - wr * 0.1, 4, wr * 0.5);
  }
  // wheels on top so they read as wheels
  for (const wx of wheels) {
    ctx.fillStyle = '#0b0b0d';
    ctx.beginPath(); ctx.arc(wx, wy, wr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2a2d33';
    ctx.beginPath(); ctx.arc(wx, wy, wr * 0.55, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#9aa0ad';
    ctx.lineWidth = Math.max(1, wr * 0.12);
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + frame * 0.8;
      ctx.moveTo(wx, wy);
      ctx.lineTo(wx + Math.cos(a) * wr * 0.5, wy + Math.sin(a) * wr * 0.5);
    }
    ctx.stroke();
  }
  ctx.restore();
}
