// Canvas renderer. Reads the World and draws the whole scene + HUD.
// The world is in logical units (height = WORLD.height); `view.scale` maps to device px.
import { COMPOUNDS, DAMAGE, ERS, FLOW, PIT, PITGAME, PLAYER, SAFETY_CAR_TEAM, SC_GAME, SPEED, START, TYRES, WARN } from './config.js';
import {
  FORECAST_LABEL, clamp, engineState, foldY, formatDistance, formatTime, gpProgress, lerp, pointsFor, positionLabel, sweepPos, wheelZones, wrongForWeather,
} from './logic.js';
import { drawLivery } from './livery.js';

const FONT = '"Segoe UI", system-ui, Roboto, sans-serif';
const MONO = '"Cascadia Mono", Consolas, "Roboto Mono", monospace';
/** Damage card size (top-left, under the score); the radio strip keeps clear of it on narrow screens. */
const DAMAGE_CARD = { w: 176, h: 58 };
/** Seconds of a bouncing tyre's path drawn ahead of it (drawTyrePath). */
const TYRE_PATH = 0.6;
/**
 * Tutorial: the grid card, then one tip for `each` seconds after the lights. `[KEY]` draws a keycap.
 * Everything else is taught just in time by the COACH_CARDS, once per browser.
 */
export const COACH = {
  each: 3.2,
  tips: ['[▲] [▼] steer · [▶] push · [◀] lift and save the tyres'],
  // the same lesson for a thumb on the touch pad
  touchTips: ['Drag on the track to steer · hold [PUSH] to go faster · [LIFT] saves the tyres'],
  grid: ['Hold for the lights · [▶] or [SPACE] the instant they go out for a GREAT START', 'A touch in the pack costs bodywork, not the race'],
  touchGrid: ['Hold for the lights · tap [PUSH] or [ERS] the instant they go out for a GREAT START', 'A touch in the pack costs bodywork, not the race'],
};

/**
 * Just-in-time coach cards (B11): each shows once per browser, the first time the moment it explains
 * happens, pointing at the HUD widget it is about. `at` names the anchor drawHud records.
 */
export const COACH_CARDS = {
  pit: { at: 'pitChip', accent: '#2ecc71', keys: '[B] box now · the green chip counts the window down', touch: 'Tap [BOX] now · the green chip counts the window down' },
  tow: { at: 'ers', accent: '#7df9ff', keys: 'In the tow: free speed and the battery charges · [SPACE] spends it', touch: 'In the tow: free speed and the battery charges · hold [ERS] to spend it' },
  cliff: { at: 'tyre', accent: '#ffd400', keys: 'Tyres over the cliff: grip is going · box at the next window', touch: 'Tyres over the cliff: grip is going · box at the next window' },
  contact: { at: 'damage', accent: '#ff3b3b', keys: 'A part at 100% means the next hit retires you · the pit crew fixes it', touch: 'A part at 100% means the next hit retires you · the pit crew fixes it' },
  rain: { at: 'nextTyre', accent: '#7fb2ff', keys: 'Slicks in the wet: no grip · [1]–[5] pick inters or wets, then box', touch: 'Slicks in the wet: no grip · [TYRE] picks inters or wets, then box' },
  sc: { at: 'banner', accent: '#ffd400', keys: 'Safety car: no overtaking · [◀] lift and drop back behind the pack', touch: 'Safety car: no overtaking · hold [LIFT] and drop back behind the pack' },
};
/** Seconds a coach card stays up. */
export const COACH_CARD_DUR = 5;

/**
 * HUD scale for phones (B10): on touch, or any window under 500 CSS px tall, the HUD grows until its
 * smallest `minPx` text renders at 10 CSS px (the world is drawn at cssH/720 of a logical px),
 * capped at 1.8. `override` (?hudscale=) wins when given.
 */
export function hudScale(cssH, { touch = false, override = null, minPx = 11, logicalHeight = 720 } = {}) {
  if (override > 0) return Math.max(1, override * 11 / minPx);
  if (!touch && cssH >= 500) return 1;
  return Math.max(1, Math.min(1.8, 10.1 / (minPx * cssH / logicalHeight)));
}

/**
 * Toast priority (A15): returns the toast that should be on screen when `next` is offered while
 * `cur` is up. A lower priority never replaces a live higher one; equal or higher takes over.
 */
export function offerToast(cur, next) {
  if (cur && cur.age < cur.dur && (cur.prio || 0) > (next.prio || 0)) return cur;
  return next;
}

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
    this.touch = false; // set by main on phones: coach tips name the touch-pad buttons
    this.time = 0;
    this.zoom = 1;
    this.debugHitbox = false; // ?hitbox=1: stroke every hit part (main sets it)
    this.vis = { x0: 0, x1: 1280, y0: 0, y1: 720 }; // the world rect on screen this frame (wider than the view while zoomed out)
    // phone-readable HUD (see fit): ui scales the corner cards, k is the scale of the panel being drawn
    this.ui = 1;
    this.k = 1;
    this.cssPerUnit = 1; // CSS px per logical px
    this.hudOverride = null; // ?hudscale= (main sets it)
    this.padReserve = 0; // CSS px of touch pad along the bottom centre (main sets it on touch); the bottom cards stay clear
    this.anchors = {}; // HUD widget rects (screen-logical) recorded by drawHud, for the coach cards' pointers
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
    this.cssH = cssH;
    this.cssPerUnit = cssH / logicalHeight || 1;
    this.ui = hudScale(cssH, { touch: this.touch, override: this.hudOverride, logicalHeight });
    return this.view;
  }
  /** HUD scale for a panel whose smallest text is `minPx` (13 px text needs less growth than 11 px). */
  uiFor(minPx) {
    return hudScale(this.cssH || 720, { touch: this.touch, override: this.hudOverride, minPx, logicalHeight: this.view.height });
  }
  /** A font size no smaller than 10 CSS px at the current panel scale `this.k`. */
  px(n) {
    return Math.max(n, Math.ceil(10 / (this.cssPerUnit * this.k)));
  }
  /** Scales what follows by k about the screen point (ax, ay): existing absolute coordinates keep working. */
  scaleAbout(ax, ay, k) {
    this.k = k;
    if (k === 1) return;
    this.ctx.translate(ax, ay);
    this.ctx.scale(k, k);
    this.ctx.translate(-ax, -ay);
  }
  /** Records a HUD widget's on-screen rect for the coach cards: local rect (x, y, w, h) under scale k about (ax, ay). */
  anchor(name, x, y, w, h, ax, ay, k) {
    this.anchors[name] = { x: ax + (x - ax) * k, y: ay + (y - ay) * k, w: w * k, h: h * k };
  }

  /** Blend a venue palette key between the previous and current venue. */
  vcolor(world, key, i = null) {
    const a = i === null ? world.prevVenue[key] : world.prevVenue[key][i];
    const b = i === null ? world.venue[key] : world.venue[key][i];
    return lerpColor(a, b, world.venueBlend);
  }

  /**
   * Where the HUD goes this frame (B10). Every corner card is drawn under scale(k) about its corner;
   * on a phone they grow (this.ui) but never past what fits: the score + damage stack stays above the
   * track, the bottom cards stay clear of the touch pad. Toasts and the round card live in the band
   * between the top cards and the track (over the pit lane), never over the racing lanes.
   */
  hudLayout(world, W, H) {
    const pad = 18;
    const ui = this.ui;
    const kTop = Math.max(0.6, Math.min(ui, (world.trackTop - 4 - pad) / (64 + 8 + DAMAGE_CARD.h)));
    const freeW = this.padReserve > 0 ? ((this.canvas.clientWidth || 0) - this.padReserve) / 2 / this.cssPerUnit - pad - 6 : Infinity;
    const kBot = Math.max(0.6, Math.min(ui, freeW / 250));
    const kR = this.uiFor(13);
    // radio strip: in the gap between the top cards; under them when the gap is too small
    const gap = (W - pad - 250 * kTop) - (pad + 300 * kTop) - 24;
    const narrow = gap < 380 * kR;
    const radioMaxW = (narrow ? W - pad * 2 - 2 * (DAMAGE_CARD.w * kTop + 10) : Math.min(gap, 620 * kR)) / kR;
    const radioY = narrow ? pad + 64 * kTop + 10 : pad + 6;
    const bannerY = radioY + 68 * kR; // SC / penalty banners and toasts stack under the strip's tallest form
    this.L = { pad, ui, kTop, kBot, kR, gap, narrow, radioMaxW, radioY, bannerY };
    return this.L;
  }

  render(world, hud, dt) {
    this.time += dt;
    this.dt = dt;
    const { ctx } = this;
    const { width: W, height: H, scale } = this.view;
    this.hudLayout(world, W, H);
    this.anchors = {};
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // camera shake
    if (world.shake > 0) {
      const s = world.shake * 6;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }
    // boost zooms out a touch so you see more of what is coming at that speed; the tow pushes in
    // a little, and the pit-entry cinematic pushes in harder. Centred on the car.
    const targetZoom = (world.ers.boosting ? 0.96 : 1 + world.tow * 0.015) + world.cine * 0.08;
    this.zoom += (targetZoom - this.zoom) * Math.min(1, dt * 6);
    const px = world.player.x, py = world.player.y, z = this.zoom;
    if (Math.abs(z - 1) > 0.001) {
      ctx.translate(px, py);
      ctx.scale(z, z);
      ctx.translate(-px, -py);
    }
    // zoomed out, the scenery has to cover more than the view: draw it over the visible world rect
    const out = z < 1;
    const vis = out ? { x0: px - px / z, x1: px + (W - px) / z, y0: py - py / z, y1: py + (H - py) / z } : { x0: 0, x1: W, y0: 0, y1: H };
    this.vis = vis;
    const VW = vis.x1 - vis.x0;
    if (out) {
      ctx.fillStyle = this.vcolor(world, 'sky', 0);
      ctx.fillRect(vis.x0, vis.y0, VW, -vis.y0 + 1);
    }
    ctx.save();
    if (out) ctx.translate(vis.x0, 0);
    this.drawBackdrop(world, VW, H);
    this.drawPitLane(world, VW);
    this.drawTrack(world, VW);
    ctx.restore();
    this.drawGrid(world, W);
    ctx.save();
    if (out) ctx.translate(vis.x0, 0);
    this.drawGrassBottom(world, VW, Math.max(H, vis.y1));
    ctx.restore();
    for (const hz of world.hazards) if (hz.type === 'oil' || hz.type === 'drs') this.drawHazard(hz, world);
    this.drawParticles(world, ['spray', 'smoke', 'streak']);
    for (const hz of world.hazards) if (hz.type !== 'oil' && hz.type !== 'drs') this.drawHazard(hz, world);
    if (world.sc.car) this.drawSafetyCar(world);
    if (world.cine > 0.02) this.drawPitApproach(world, W);
    if (world.player.grace > 0 && world.cine <= 0.02) this.drawGraceRing(world);
    this.drawPlayer(world);
    if (world.player.alive && Math.max(world.player.parts.wing, world.player.parts.floor) >= 100) this.drawTerminalRing(world);
    if (world.scrapeFlash > 0 && world.player.alive) this.drawScrapeRim(world);
    // stationary car: mechanics at each wheel + the wheel-gun mini-game (drawn late so nothing paints over it)
    if (world.pit.inLane && world.pit.phase === 'stop' && world.pit.game) this.drawPitGame(world);
    this.drawParticles(world, ['flame', 'spark', 'carbon']);
    this.drawMarshals(world, W);
    this.drawNight(world, W, H);
    this.drawWeather(world, W, H);
    this.drawHazardRims(world);
    if (this.debugHitbox) this.drawHitboxes(world);
    if (world.gameOver && world.crashShapes) this.drawCrashShapes(world);
    this.drawSpeedLines(world, W, H);
    this.drawPopups(world);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (hud && hud.damage && hud.damage.age < 0.4 && !world.gameOver) this.drawHitVignette(W, H, 1 - hud.damage.age / 0.4);
    if (hud && !world.gameOver) this.drawIncoming(world, W);
    if (world.cine > 0.02) this.drawLetterbox(world, W, H);
    if (world.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${0.75 * world.flash})`;
      ctx.fillRect(0, 0, W, H);
    }
    this.drawVenueCard(world, W, H, hud);
    this.drawLights(world, W);
    if (hud) this.drawHud(world, hud, W, H);
  }

  /** Grid boxes and the start line, painted on the asphalt; they scroll away with the track. */
  drawGrid(world, W) {
    const slots = world.start.slots;
    if (!slots.length) return;
    const { ctx } = this;
    const w = PLAYER.width * 0.92;
    const h = PLAYER.height * 0.92;
    const last = slots[slots.length - 1];
    const lineX = last.x + w * 0.5 + 40 - world.scroll;
    if (lineX < -60) return; // long gone
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < slots.length; i++) {
      const x = slots[i].x - world.scroll;
      if (x < -w || x > W + w) continue;
      // the box: a bar across the front and a short tail down the inside edge
      const y = slots[i].y;
      ctx.fillRect(x + w * 0.5 + 6, y - h * 0.5 - 6, 4, h + 12);
      ctx.fillRect(x + w * 0.5 - 30, y - h * 0.5 - 6, 36, 4);
      ctx.fillRect(x + w * 0.5 - 30, y + h * 0.5 + 2, 36, 4);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = `bold 11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(`P${20 - i}`, x, y - h * 0.5 - 10); // you are P20 at the back; the field counts down ahead of you
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
    }
    // start / finish line: chequers across the track just ahead of pole
    if (lineX < W + 20) {
      const top = world.trackTop, bottom = world.trackBottom;
      const sq = 10;
      for (let r = 0; r * sq < bottom - top; r++) {
        for (let c = 0; c < 3; c++) {
          ctx.fillStyle = (r + c) % 2 ? '#f4f4f4' : '#111';
          ctx.fillRect(lineX + c * sq, top + r * sq, sq, Math.min(sq, bottom - top - r * sq));
        }
      }
    }
    ctx.textAlign = 'left';
  }

  /** The start gantry: five red lights over the pit wall, then out. Fades a moment after the launch. */
  drawLights(world, W) {
    const s = world.start;
    const sinceGo = s.phase === 'go' ? s.sinceGo : -1;
    if (sinceGo > 2.5) return;
    const { ctx } = this;
    const a = sinceGo < 0 ? 1 : clamp(1 - (sinceGo - 1.5), 0, 1);
    const cx = W / 2, cy = world.pitTop + (world.pitBottom - world.pitTop) / 2;
    const gap = 34;
    ctx.save();
    this.scaleAbout(cx, cy, this.uiFor(12)); // readable on a phone
    ctx.globalAlpha = a;
    ctx.fillStyle = '#0b0d12';
    roundRect(ctx, cx - gap * 2.5 - 14, cy - 22, gap * 5 + 28, 44, 8);
    ctx.fill();
    ctx.fillStyle = '#2a2f3a';
    ctx.fillRect(cx - gap * 2.5 - 14, cy - 34, gap * 5 + 28, 6); // the beam
    for (let i = 0; i < START.lights; i++) {
      const lit = sinceGo < 0 && i < s.lit;
      const x = cx - gap * 2 + i * gap;
      if (lit) {
        ctx.fillStyle = 'rgba(255,42,42,0.35)';
        ctx.beginPath(); ctx.arc(x, cy, 19, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = lit ? '#ff2a2a' : '#3a1212';
      ctx.beginPath(); ctx.arc(x, cy, 12, 0, Math.PI * 2); ctx.fill();
    }
    if (sinceGo < 0 && s.lit === 0) {
      ctx.fillStyle = '#c9ced9';
      ctx.font = `bold 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('FORMATION', cx, cy + 40);
      ctx.textAlign = 'left';
    }
    ctx.restore();
    this.k = 1;
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

    // skyline: the new venue wipes in from the right (the direction the scenery arrives from)
    const y0 = world.pitTop * 0.06;
    const y1 = world.pitTop * 0.62;
    if (world.venueBlend < 1) {
      const wipe = easeInOut(clamp01(world.venueBlend / 0.7)); // the wipe finishes early; the palettes keep blending
      const wx = W * (1 - wipe);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, wx, world.pitTop); ctx.clip();
      this.drawSkyline(world.prevVenue, world, W, y0, y1);
      ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(wx, 0, W - wx, world.pitTop); ctx.clip();
      this.drawSkyline(world.venue, world, W, y0, y1);
      ctx.restore();
      // glowing leading edge
      if (wipe > 0 && wipe < 1) {
        const g = ctx.createLinearGradient(wx - 40, 0, wx + 6, 0);
        g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,0.85)');
        ctx.fillStyle = g; ctx.fillRect(wx - 40, 0, 46, world.pitTop);
        ctx.fillStyle = '#ffd400'; ctx.fillRect(wx, 0, 4, world.pitTop);
      }
    } else {
      this.drawSkyline(world.venue, world, W, y0, y1);
    }

    // grandstand: repeating blocks with a crowd noise texture. The crowd is
    // hundreds of rects, so it is pre-rendered into a strip and only rebuilt
    // when the day/night blend moves a step.
    const gsTop = world.pitTop * 0.56;
    const gsH = world.pitTop - gsTop;
    const lit = world.night;
    const strip = this.grandstandStrip(gsH, lit);
    const soff = (world.scroll * 0.25) % strip.width;
    for (let x = -soff; x < W; x += strip.width) ctx.drawImage(strip.canvas, x, gsTop, strip.width, gsH);
    // floodlight masts at night venues (fade with the blend, so kept live)
    if (lit > 0.05) {
      const off = (world.scroll * 0.25) % 220;
      ctx.globalAlpha = lit;
      for (let x = -off - 220; x < W + 220; x += 220) {
        ctx.fillStyle = '#4a4f5c';
        ctx.fillRect(x + 100, y0, 4, gsTop - y0);
        ctx.fillStyle = '#e8ecf5';
        ctx.fillRect(x + 84, y0 - 6, 36, 8);
      }
      ctx.globalAlpha = 1;
    }
  }

  /** Six grandstand blocks pre-rendered at 2× into one strip, cached per night step. */
  grandstandStrip(gsH, lit) {
    const litQ = Math.round(lit * 8);
    if (this.stand && this.stand.litQ === litQ && this.stand.gsH === gsH) return this.stand;
    const blocks = 6, bw = 220, res = 2;
    const canvas = this.stand?.canvas || document.createElement('canvas');
    canvas.width = blocks * bw * res;
    canvas.height = Math.max(1, Math.ceil(gsH * res));
    const k = canvas.getContext('2d');
    k.setTransform(res, 0, 0, res, 0, 0);
    const l = litQ / 8;
    for (let i = 0; i < blocks; i++) {
      const x = i * bw;
      k.fillStyle = lerpColor('#2b2f3a', '#161923', l);
      k.fillRect(x, 0, 214, gsH);
      k.fillStyle = lerpColor('#3c4150', '#22262f', l);
      k.fillRect(x, 0, 214, 8);
      // crowd dots (phone torches come out at night)
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 22; c++) {
          const seed = i * 97 + r * 13 + c * 7;
          const hue = (seed * 47) % 360;
          const torch = l > 0.3 && hash(seed) > 0.86;
          k.fillStyle = torch ? `rgba(255,255,230,${l})` : `hsl(${hue} 35% ${30 + (seed % 3) * 7 - l * 12}%)`;
          k.fillRect(x + 6 + c * 9.4, 14 + r * ((gsH - 18) / 4), 5, 6);
        }
      }
      // banner along the bottom edge
      k.fillStyle = '#c8102e';
      k.fillRect(x, gsH - 10, 214, 10);
    }
    this.stand = { canvas, litQ, gsH, width: blocks * bw };
    return this.stand;
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
      case 'dunes': // Zandvoort: sand dunes, beach grass, an orange grandstand and a windmill
        tile(380, (x, i) => {
          ctx.fillStyle = `hsl(42 45% ${62 + hash(i) * 12}%)`;
          ctx.beginPath(); ctx.ellipse(x + 190, y1 - h * 0.05, 240, h * 0.5 + hash(i + 1) * h * 0.15, 0, Math.PI, 0); ctx.fill();
        });
        tile(34, (x, i) => {
          ctx.strokeStyle = `hsl(80 30% ${40 + hash(i) * 15}%)`; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x, y1 - h * 0.2); ctx.lineTo(x + 4 + hash(i + 1) * 6, y1 - h * 0.2 - 10 - hash(i + 2) * 12); ctx.stroke();
        });
        tile(760, (x) => {
          // orange army stand
          ctx.fillStyle = '#e07b1a'; ctx.fillRect(x + 80, y1 - h * 0.55, 220, h * 0.32);
          ctx.fillStyle = '#2b2f3a'; ctx.fillRect(x + 80, y1 - h * 0.6, 220, 8);
          ctx.fillStyle = '#ffd68a'; for (let c = 0; c < 18; c++) for (let r = 0; r < 3; r++) if (hash(c * 7 + r) > 0.3) ctx.fillRect(x + 88 + c * 12, y1 - h * 0.52 + r * 14, 6, 8);
          // windmill
          const mx = x + 560, my = y1 - h * 0.62;
          ctx.fillStyle = '#5c4a3a'; ctx.beginPath(); ctx.moveTo(mx - 26, y1 - h * 0.18); ctx.lineTo(mx + 26, y1 - h * 0.18); ctx.lineTo(mx + 14, my); ctx.lineTo(mx - 14, my); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = '#efe6d2'; ctx.lineWidth = 3;
          for (let b = 0; b < 4; b++) { const a = this.time * 0.9 + (b * Math.PI) / 2; ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx + Math.cos(a) * h * 0.34, my + Math.sin(a) * h * 0.34); ctx.stroke(); }
        });
        break;
      case 'oldcity': // Baku: the old city walls and Maiden Tower, Flame Towers behind
        tile(900, (x, i) => {
          for (let f = 0; f < 3; f++) {
            const fx = x + 500 + f * 70, fh = h * (0.85 - f * 0.08);
            ctx.fillStyle = `hsl(${205 + hash(i + f) * 10} 35% 62%)`;
            ctx.beginPath(); ctx.moveTo(fx, y1 - h * 0.15); ctx.quadraticCurveTo(fx + 8, y1 - h * 0.15 - fh, fx + 30, y1 - h * 0.15 - fh);
            ctx.quadraticCurveTo(fx + 44, y1 - h * 0.15 - fh * 0.6, fx + 46, y1 - h * 0.15); ctx.closePath(); ctx.fill();
          }
        });
        tile(320, (x, i) => {
          ctx.fillStyle = `hsl(38 30% ${64 + hash(i) * 8}%)`;
          ctx.fillRect(x, y1 - h * 0.42, 320, h * 0.28);
          for (let c = 0; c < 10; c++) ctx.fillRect(x + c * 32, y1 - h * 0.48, 18, h * 0.07);
          if (hash(i + 3) > 0.5) { ctx.fillRect(x + 120, y1 - h * 0.8, 44, h * 0.4); for (let c = 0; c < 3; c++) ctx.fillRect(x + 118 + c * 16, y1 - h * 0.85, 10, h * 0.06); }
          ctx.fillStyle = 'rgba(70,50,30,0.5)';
          for (let c = 0; c < 6; c++) ctx.fillRect(x + 20 + c * 50, y1 - h * 0.34, 10, 14);
        });
        break;
      case 'tower': // Austin: hill country and the red-and-white observation tower
        tile(640, (x, i) => {
          ctx.fillStyle = `hsl(75 30% ${36 + hash(i) * 10}%)`;
          ctx.beginPath(); ctx.ellipse(x + 320, y1 - h * 0.08, 360, h * 0.42, 0, Math.PI, 0); ctx.fill();
        });
        tile(980, (x) => {
          const tx = x + 420, base = y1 - h * 0.14, top = y1 - h * 1.05;
          ctx.fillStyle = '#d8dbe2';
          ctx.beginPath(); ctx.moveTo(tx - 10, base); ctx.lineTo(tx + 10, base); ctx.lineTo(tx + 4, top); ctx.lineTo(tx - 4, top); ctx.closePath(); ctx.fill();
          for (let k = 0; k < 9; k++) { ctx.fillStyle = k % 2 ? '#c02c2c' : '#f2f2f2'; ctx.fillRect(tx - 9 + k * 0.6, top + k * (base - top) / 9, 18 - k * 1.2, (base - top) / 9); }
          // the swooping veil ramps
          ctx.strokeStyle = '#c02c2c'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(tx - 4, top + 18); ctx.bezierCurveTo(tx - 120, top + 40, tx - 160, base - 40, tx - 200, base); ctx.stroke();
          ctx.fillStyle = '#f2f2f2'; ctx.fillRect(tx - 30, top - 4, 60, 10);
          ctx.fillStyle = '#c02c2c'; ctx.fillRect(tx - 2, top - 30, 4, 26);
        });
        break;
      case 'stadium': // Mexico City: the Foro Sol bowl full of fans, volcanoes behind
        tile(1100, (x, i) => {
          for (const [ox, vh] of [[240, 0.95], [700, 0.8]]) {
            ctx.fillStyle = `hsl(240 15% ${52 + hash(i + ox) * 8}%)`;
            ctx.beginPath(); ctx.moveTo(x + ox - 260, y1 - h * 0.15); ctx.lineTo(x + ox, y1 - h * 0.15 - h * vh); ctx.lineTo(x + ox + 260, y1 - h * 0.15); ctx.closePath(); ctx.fill();
            ctx.fillStyle = '#f4f4f8';
            ctx.beginPath(); ctx.moveTo(x + ox - 40, y1 - h * 0.15 - h * vh * 0.85); ctx.lineTo(x + ox, y1 - h * 0.15 - h * vh); ctx.lineTo(x + ox + 40, y1 - h * 0.15 - h * vh * 0.85); ctx.closePath(); ctx.fill();
          }
        });
        tile(520, (x, i) => {
          // the bowl: a grey shell with tiers of green/white/red fans stacked inside it
          ctx.fillStyle = '#6b6f76';
          ctx.beginPath(); ctx.ellipse(x + 260, y1 - h * 0.12, 240, h * 0.5, 0, Math.PI, 0); ctx.fill();
          for (let r = 0; r < 5; r++) {
            const rx = 232 - r * 30, ry = h * (0.47 - r * 0.07);
            for (let c = 0; c < 26 - r * 2; c++) {
              const seed = i * 131 + r * 29 + c;
              ctx.fillStyle = hash(seed) > 0.5 ? '#1f8a4c' : hash(seed + 1) > 0.5 ? '#f4f4f4' : '#d3282e';
              const ang = Math.PI + ((c + 0.5) / (26 - r * 2)) * Math.PI;
              ctx.fillRect(x + 260 + Math.cos(ang) * rx - 2, y1 - h * 0.12 + Math.sin(ang) * ry, 4, 4);
            }
          }
        });
        break;
      case 'neon': { // Las Vegas: the Sphere, hotel towers and blinking neon
        tile(140, (x, i) => {
          const bh = h * (0.45 + hash(i) * 0.6);
          ctx.fillStyle = `hsl(${260 + hash(i + 1) * 40} 25% ${14 + hash(i + 2) * 8}%)`;
          ctx.fillRect(x + 6, y1 - h * 0.15 - bh, 110, bh);
          for (let r = 0; r < bh / 11; r++) for (let c = 0; c < 6; c++) if (hash(i * 17 + r * 5 + c) > 0.5) { ctx.fillStyle = `hsl(${(i * 47 + c * 60) % 360} 90% 65%)`; ctx.fillRect(x + 14 + c * 16, y1 - h * 0.15 - bh + 5 + r * 11, 8, 5); }
          // neon sign strip, blinking
          ctx.fillStyle = `hsl(${(i * 83) % 360} 100% 60%)`;
          const ga = ctx.globalAlpha; ctx.globalAlpha = ga * (0.5 + 0.5 * Math.sin(this.time * 4 + i * 1.7) > 0.7 ? 1 : 0.35);
          ctx.fillRect(x + 6, y1 - h * 0.15 - bh + 14, 110, 5);
          ctx.globalAlpha = ga;
        });
        tile(1200, (x) => {
          const cx = x + 640, cy = y1 - h * 0.5, r = h * 0.36;
          const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
          const hue = (this.time * 40) % 360;
          g.addColorStop(0, `hsl(${hue} 90% 70%)`); g.addColorStop(1, `hsl(${(hue + 120) % 360} 80% 35%)`);
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        });
        break;
      }
      case 'lake': // Melbourne: Albert Park lake with the CBD towers behind
        tile(160, (x, i) => {
          const bh = h * (0.4 + hash(i) * 0.65);
          ctx.fillStyle = `hsl(210 20% ${45 + hash(i + 1) * 25}%)`;
          ctx.fillRect(x + 10, y1 - h * 0.3 - bh, 60 + hash(i + 2) * 60, bh);
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          for (let r = 0; r < bh / 14; r++) ctx.fillRect(x + 16, y1 - h * 0.3 - bh + 6 + r * 14, 40 + hash(i + 2) * 50, 3);
          if (hash(i + 4) > 0.75) { ctx.fillStyle = '#d8dbe2'; ctx.fillRect(x + 36, y1 - h * 0.3 - bh - 26, 3, 26); }
        });
        ctx.fillStyle = '#4b90c9';
        ctx.fillRect(0, y1 - h * 0.32, W, h * 0.34);
        tile(260, (x, i) => {
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.fillRect(x + 30 + hash(i) * 120, y1 - h * 0.24 + hash(i + 1) * h * 0.14, 40 + hash(i + 2) * 50, 2);
          ctx.fillStyle = '#2f7d32';
          ctx.beginPath(); ctx.arc(x + 200, y1 - h * 0.02, 26 + hash(i + 3) * 14, Math.PI, 0); ctx.fill();
        });
        break;
      default:
        break;
    }
  }

  /**
   * Round card: slides in from the right during the venue morph — the flag you just took, round
   * number, name — with chequered edges. It sits in the band above the track (with the toasts),
   * bottom edge just over the kerb, so it never covers the racing lanes.
   */
  drawVenueCard(world, W, H, hud) {
    const b = world.venueBlend;
    if (b >= 1 || world.gps === 0) return;
    const { ctx } = this;
    const k = this.uiFor(13);
    const L = this.L;
    const inT = easeOut(clamp01(b / 0.22)); // slide in
    const outT = easeInOut(clamp01((b - 0.72) / 0.28)); // slide out to the left
    const flag = hud && hud.flag;
    // between the top cards when they leave room, else as wide as it needs
    const room = L ? L.gap / k : 640;
    const cw = clamp(room, 380, Math.min(640, (W * 0.9) / k));
    // a phone has no room under the radio strip for the tall card: one row instead (name left, lines right)
    const fullH = flag ? 108 : 92;
    const compact = L && fullH * k > world.trackTop - 14 - (L.radioY + 60 * L.kR);
    const ch = compact ? 64 : fullH;
    const cx = W / 2 + (1 - inT) * (W * 0.6 + cw * k) - outT * (W * 0.6 + cw * k);
    const cy = world.trackTop - 14 - (ch / 2) * k;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(k, k);
    this.k = k;
    ctx.fillStyle = 'rgba(8,10,16,0.88)';
    roundRect(ctx, -cw / 2, -ch / 2, cw, ch, 12); ctx.fill();
    // chequered end caps
    for (const side of [-1, 1]) for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) {
      ctx.fillStyle = (r + c) % 2 ? '#fff' : '#111';
      ctx.fillRect(side * (cw / 2 - 26) + (side < 0 ? c * 12 : -12 - c * 12), -ch / 2 + 10 + r * ((ch - 20) / 4), 12, (ch - 20) / 4);
    }
    ctx.fillStyle = world.venue.barrier; ctx.fillRect(-cw / 2 + 30, ch / 2 - 8, cw - 60, 4);
    ctx.fillStyle = '#ffd400'; ctx.fillRect(-cw / 2 + 30, ch / 2 - 8, (cw - 60) * clamp01(b / 0.72), 4);
    ctx.textBaseline = 'middle';
    const roundLine = `ROUND ${world.gps + 1}  ·  ${world.venue.night ? 'NIGHT RACE' : world.venue.rainBias > 1.5 ? 'RAIN LIKELY' : 'GRAND PRIX'}`;
    // the flag you just took: where you finished and what it paid (the chequered toast used to say this over the card)
    const flagLine = flag ? `🏁 ${flag.venue.toUpperCase()} · P${flag.position} · ${flag.points ? `+${flag.points} PTS` : 'NO POINTS'}` : null;
    if (compact) {
      ctx.textAlign = 'left';
      ctx.fillStyle = '#fff'; ctx.font = `900 28px ${FONT}`;
      ctx.fillText(`${world.venue.flag} ${world.venue.name.toUpperCase()}`, -cw / 2 + 58, -2);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#c9ced9'; ctx.font = `bold ${this.px(13)}px ${FONT}`;
      ctx.fillText(roundLine, cw / 2 - 58, flagLine ? 8 : -2);
      if (flagLine) {
        ctx.fillStyle = flag.points ? '#ffd400' : '#c9ced9'; ctx.font = `900 ${this.px(13)}px ${FONT}`;
        ctx.fillText(flagLine, cw / 2 - 58, -12);
      }
    } else {
      ctx.textAlign = 'center';
      let y = -ch / 2 + 22;
      if (flagLine) {
        ctx.fillStyle = flag.points ? '#ffd400' : '#c9ced9'; ctx.font = `900 ${this.px(13)}px ${FONT}`;
        ctx.fillText(flagLine, 0, y);
        y += 18;
      }
      ctx.fillStyle = '#c9ced9'; ctx.font = `bold ${this.px(13)}px ${FONT}`;
      ctx.fillText(roundLine, 0, y);
      ctx.fillStyle = '#fff'; ctx.font = `900 34px ${FONT}`;
      ctx.fillText(`${world.venue.flag}  ${world.venue.name.toUpperCase()}`, 0, ch / 2 - 34);
    }
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
    this.k = 1;
  }

  drawPitLane(world, W) {
    const { ctx } = this;
    const top = world.pitTop;
    const bottom = world.pitBottom;
    ctx.fillStyle = lerpColor('#4f535c', '#2f323a', world.night);
    ctx.fillRect(0, top, W, bottom - top);
    // garages scroll along the back of the lane; every fourth one is your team's
    const garageW = 260;
    const off = world.scroll % (garageW * 4);
    const own = world.team ? world.team.primary : '#d40000';
    const neighbours = ['#0b2a6f', '#c0c0c0', '#ff8a00'].filter((c) => c !== own);
    for (let i = -1; i < W / garageW + 5; i++) {
      const x = i * garageW - off;
      const idx = ((i + Math.floor(world.scroll / (garageW * 4)) * 4) % 4 + 4) % 4;
      const color = idx === 0 ? own : neighbours[(idx - 1) % neighbours.length];
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
    const words = [world.venue.name.toUpperCase(), 'RAWE CEEK', 'BOX BOX', 'TYRE MANAGEMENT'];
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
      const fs = Math.min(wallH - 2, Math.max(13, Math.ceil(10 / this.cssPerUnit))); // readable on a phone, inside the wall
      ctx.font = `bold ${fs}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('▲ PIT ENTRY ▲', px, wallTop + wallH / 2 + fs * 0.38);
      // the window draining away, along the bottom of the glow
      if (world.pit.reason === 'window') {
        const f = clamp(world.pit.left / PIT.openFor, 0, 1);
        ctx.fillStyle = world.pit.left <= 2 && Math.sin(this.time * 16) > 0 ? '#ffffff' : '#7ff0b0';
        ctx.fillRect(px - 140, wallTop + wallH - 3, 280 * f, 3);
      }
    }
  }

  drawTrack(world, W) {
    const { ctx } = this;
    const top = world.trackTop;
    const bottom = world.trackBottom;
    const wet = world.rain;
    ctx.fillStyle = lerpColor(lerpColor(this.vcolor(world, 'asphalt'), '#23262d', wet), '#1c1e25', world.night * 0.5);
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
    const boards = ['RAWE CEEK', 'GRAINING', 'BOX BOX', 'PLAN C', 'WE ARE CHECKING', 'DRS', 'SO NOT RIGHT', 'PUSHING', world.venue.name.toUpperCase(), 'MULTI 21'];
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
    const exiting = world.pit.phase === 'merge';
    // dim everything that can no longer hurt you
    ctx.fillStyle = `rgba(4,6,14,${0.35 * a})`;
    ctx.fillRect(0, world.trackTop - 12, W, world.trackBottom - world.trackTop + 24);
    // lit corridor: up to the pit gap on the way in, down the blend line on the way out
    const gapX = p.x + 60;
    const color = exiting ? '255,212,0' : '46,204,113';
    const g = ctx.createLinearGradient(0, world.trackBottom, 0, world.pitBottom);
    g.addColorStop(0, `rgba(${color},${exiting ? 0.22 * a : 0})`);
    g.addColorStop(1, `rgba(${color},${exiting ? 0 : 0.28 * a})`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(p.x - 140, world.trackBottom);
    ctx.lineTo(p.x + 140 + (exiting ? 260 : 0), world.trackBottom);
    ctx.lineTo(gapX + 140, world.pitBottom);
    ctx.lineTo(gapX - 140, world.pitBottom);
    ctx.closePath();
    ctx.fill();
    // chevrons marching along the corridor
    const n = 5;
    for (let i = 0; i < n; i++) {
      const t = ((i / n) + (this.time * 0.9) % 1) % 1;
      const tt = exiting ? 1 - t : t;
      const y = lerp(world.trackBottom - 20, world.trackTop + 10, tt);
      const x = lerp(p.x, gapX, tt) + (exiting ? (1 - tt) * 220 : 0);
      ctx.globalAlpha = a * (0.25 + 0.75 * Math.sin(t * Math.PI));
      ctx.strokeStyle = `rgb(${color})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      if (exiting) { ctx.moveTo(x - 18, y - 10); ctx.lineTo(x + 6, y + 4); ctx.lineTo(x + 18, y - 14); }
      else { ctx.moveTo(x - 18, y + 10); ctx.lineTo(x, y - 4); ctx.lineTo(x + 18, y + 10); }
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

  /** Fading ghost outline for the grace moment after rejoining the track. */
  drawGraceRing(world) {
    const { ctx } = this;
    const p = world.player;
    const a = clamp(p.grace / 0.8, 0, 1);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.tilt);
    ctx.strokeStyle = `rgba(255,212,0,${0.7 * a * (0.6 + 0.4 * Math.sin(this.time * 10))})`;
    ctx.lineWidth = 3;
    roundRect(ctx, -PLAYER.width / 2 - 8, -PLAYER.height / 2 - 8, PLAYER.width + 16, PLAYER.height + 16, 14);
    ctx.stroke();
    ctx.restore();
  }

  /** A scrape: a bright white rim round the car for a moment (the close call that touched paint). */
  drawScrapeRim(world) {
    const { ctx } = this;
    const p = world.player;
    const a = world.scrapeFlash;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.tilt + p.angle);
    ctx.strokeStyle = `rgba(255,255,255,${a})`;
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 14 * a;
    ctx.lineWidth = 2 + 3 * a;
    roundRect(ctx, -PLAYER.width / 2 - 5 - 6 * (1 - a), -PLAYER.height / 2 - 5 - 6 * (1 - a), PLAYER.width + 10 + 12 * (1 - a), PLAYER.height + 10 + 12 * (1 - a), 14);
    ctx.stroke();
    ctx.restore();
  }

  /** Part at 100 %: a pulsing red outline round the car (the grace-ring shape). The next hit is the race. */
  drawTerminalRing(world) {
    const { ctx } = this;
    const p = world.player;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.tilt);
    ctx.strokeStyle = `rgba(255,59,59,${0.45 + 0.4 * Math.sin(this.time * 9)})`;
    ctx.lineWidth = 3;
    roundRect(ctx, -PLAYER.width / 2 - 8, -PLAYER.height / 2 - 8, PLAYER.width + 16, PLAYER.height + 16, 14);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Hazards stay readable at night and in the rain: a bright rim pass drawn over the darkness and
   * the spray. Debris glints red/white, oil gets a sheen ring at its full size, tyres a compound ring.
   */
  drawHazardRims(world) {
    const a = Math.max(world.night, world.rain * 0.7);
    if (a <= 0.03) return;
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a;
    const glint = Math.sin(this.time * Math.PI * 2 * 6) > 0; // 6 Hz
    for (const hz of world.hazards) {
      if (hz.type === 'tyre') {
        ctx.strokeStyle = hz.compound.color;
        ctx.lineWidth = Math.max(2.5, hz.r * 0.18);
        ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.r + 2, 0, Math.PI * 2); ctx.stroke();
      } else if (hz.type === 'debris') {
        ctx.strokeStyle = glint ? '#ff3b3b' : '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.r + 4, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = glint ? 'rgba(255,255,255,0.9)' : 'rgba(255,59,59,0.9)';
        ctx.beginPath(); ctx.arc(hz.x + Math.cos(hz.spin) * hz.r * 0.5, hz.y + Math.sin(hz.spin) * hz.r * 0.5, 2.5, 0, Math.PI * 2); ctx.fill();
      } else if (hz.type === 'oil') {
        ctx.strokeStyle = `hsla(${(this.time * 90) % 360} 90% 65% / 0.8)`;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.ellipse(hz.x, hz.y, hz.w / 2, hz.h / 2, 0, 0, Math.PI * 2); ctx.stroke();
      } else if (hz.type === 'stranded') {
        ctx.strokeStyle = Math.sin(this.time * 8) > 0 ? '#ffd400' : 'rgba(255,212,0,0.3)';
        ctx.lineWidth = 2.5;
        roundRect(ctx, hz.x - hz.w / 2 - 4, hz.y - hz.h / 2 - 4, hz.w + 8, hz.h + 8, 10);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** ?hitbox=1: every hit part on screen, the car's body and cockpit blocks included. */
  drawHitboxes(world) {
    const { ctx } = this;
    ctx.save();
    ctx.lineWidth = 1.5;
    const rects = (list, color) => { ctx.strokeStyle = color; for (const r of list) ctx.strokeRect(r.x, r.y, r.w, r.h); };
    if (world.player.alive) rects(world.playerParts, '#00ff88');
    for (const hz of world.hazards) {
      if (hz.type === 'rival' || hz.type === 'stranded') rects(world.hazardParts(hz), hz.fromBehind ? '#ff66ff' : '#ffd400');
      else if (hz.type === 'tyre' || hz.type === 'debris') {
        ctx.strokeStyle = '#ff3b3b';
        ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.r, 0, Math.PI * 2); ctx.stroke();
      } else if (hz.type === 'oil') {
        ctx.strokeStyle = '#b266ff';
        ctx.beginPath(); ctx.ellipse(hz.x, hz.y, hz.w * 0.42, hz.h * 0.42, 0, 0, Math.PI * 2); ctx.stroke();
      } else if (hz.type === 'drs') rects([{ x: hz.x - hz.w / 2, y: hz.y - hz.h / 2, w: hz.w, h: hz.h }], '#2ecc71');
    }
    ctx.restore();
  }

  /** The crash freeze-frame: both hitboxes outlined in red where they met, fading once the tumble starts. */
  drawCrashShapes(world) {
    const a = clamp(1.4 - world.gameOverTime / 0.6, 0, 1);
    if (a <= 0) return;
    const { ctx } = this;
    const c = world.crashShapes;
    ctx.save();
    ctx.strokeStyle = `rgba(255,59,59,${a})`;
    ctx.shadowColor = 'rgba(255,0,0,0.8)';
    ctx.shadowBlur = 8;
    ctx.lineWidth = 2.5;
    for (const r of [...c.player, ...c.rects]) ctx.strokeRect(r.x, r.y, r.w, r.h);
    if (c.circle) { ctx.beginPath(); ctx.arc(c.circle.x, c.circle.y, c.circle.r, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
  }

  /** A hit: the screen edges flash red for a moment. */
  drawHitVignette(W, H, a) {
    const { ctx } = this;
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.65);
    g.addColorStop(0, 'rgba(255,0,0,0)');
    g.addColorStop(1, `rgba(255,30,30,${0.45 * a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /**
   * Edge warnings (world.warnings): a chevron on the right edge for each hazard about to come on,
   * at the height it will arrive, in its colour (tyre: compound, rival: team, oil: purple, debris:
   * red, stranded car: flashing yellow), growing and pulsing as it gets close; a ◀◀ mirror chevron
   * on the left edge and a pip on your car's tail for a car coming from behind. Screen space.
   */
  drawIncoming(world, W) {
    const list = world.warnings;
    if (!list || !list.length) return;
    const { ctx } = this;
    // zoomed out, the view reaches a little further right than the world's width: skip what is already visible
    const visRight = this.vis.x1;
    const mapY = (y) => world.player.y + (y - world.player.y) * this.zoom;
    ctx.save();
    for (const wn of list) {
      const hz = wn.hz;
      let color;
      switch (hz.type) {
        case 'tyre': color = hz.compound.color; break;
        case 'rival': color = hz.team.primary; break;
        case 'oil': color = '#b266ff'; break;
        case 'debris': color = '#ff3b3b'; break;
        case 'stranded': color = Math.sin(this.time * 10) > 0 ? '#ffd400' : '#6b5a00'; break;
        default: color = '#fff';
      }
      // (kept clear of the tyre card that overlaps the bottom of the track in the right corner)
      const y = clamp(mapY(wn.y), world.trackTop + 10, wn.side === 'right' ? Math.min(world.trackBottom - 10, world.height - 136) : world.trackBottom - 10);
      if (wn.side === 'right') {
        if (hz.x - (hz.r ?? hz.w / 2) < visRight) continue;
        const k = 1 - clamp(wn.eta / WARN.lead, 0, 1); // 0 far .. 1 arriving
        const s = (hz.big ? 18 : 14) + 8 * k;
        const pulse = 0.65 + 0.35 * Math.sin(this.time * (8 + 10 * k));
        const x = W - 6 - s; // the tip, pointing in at the track
        ctx.globalAlpha = clamp(0.35 + 0.65 * k, 0, 1) * pulse + 0.15;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        this.chevron(x + 2, y + 2, s, -1);
        ctx.fillStyle = color;
        this.chevron(x, y, s, -1);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (hz.big || hz.type === 'stranded') {
          ctx.font = `900 ${Math.max(10 * this.ui, Math.ceil(10 / this.cssPerUnit))}px ${FONT}`;
          ctx.textAlign = 'right';
          ctx.fillStyle = color;
          ctx.fillText(hz.big ? 'BIG' : 'STOPPED', x - 4, y + 4);
        }
      } else {
        // mirrors: ◀◀ on the left edge while it is still off screen, then a pip on your tail as it comes up
        const k = 1 - clamp(wn.eta / WARN.mirrorLead, 0, 1);
        const pulse = 0.65 + 0.35 * Math.sin(this.time * 12);
        ctx.globalAlpha = (0.5 + 0.5 * k) * pulse;
        if (hz.x + hz.w / 2 < 0) {
          for (const dx of [6, 21]) {
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            this.chevron(dx + 1.5, y + 1.5, 13, -1);
            ctx.fillStyle = color;
            this.chevron(dx, y, 13, -1);
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = 1.2;
            ctx.stroke();
          }
        }
        const p = world.player;
        const tailX = p.x - (PLAYER.width / 2) * this.zoom - 8;
        const pipY = mapY(p.y) + clamp(y - mapY(p.y), -PLAYER.height * 0.5, PLAYER.height * 0.5);
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(tailX, pipY, 5 + 2 * k, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  /** A filled chevron with its tip at (x, y) pointing `dir` (-1 left, 1 right); leaves the path for a stroke. */
  chevron(x, y, s, dir) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x + dir * s * 0.1, y);
    ctx.lineTo(x - dir * s * 0.9, y - s);
    ctx.lineTo(x - dir * s * 0.45, y);
    ctx.lineTo(x - dir * s * 0.9, y + s);
    ctx.closePath();
    ctx.fill();
  }

  /** Cinematic letterbox + caption while boxing. */
  drawLetterbox(world, W, H) {
    const { ctx } = this;
    const a = world.cine;
    const k = this.uiFor(12); // bars and captions grow on a phone
    const bar = 44 * a * k;
    ctx.fillStyle = '#04060e';
    ctx.fillRect(0, 0, W, bar);
    ctx.fillRect(0, H - bar, W, bar);
    ctx.globalAlpha = a;
    ctx.fillStyle = '#ffd400';
    ctx.font = `900 ${(18 + 6 * a) * k}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const exiting = world.pit.phase === 'merge';
    if (exiting) {
      // where the stop put you, next to the GO: "GO GO GO  REJOINED P14 (−4)"
      const lost = world.pit.placesLost;
      const go = 'GO GO GO   ';
      const pos = `REJOINED ${positionLabel(world.position)} (${lost ? `−${lost}` : '±0'})`;
      const big = ctx.font;
      const gw = ctx.measureText(go).width;
      ctx.font = `900 ${(12 + 4 * a) * k}px ${FONT}`;
      const pw = ctx.measureText(pos).width;
      ctx.textAlign = 'left';
      ctx.fillStyle = lost ? '#ff8a00' : '#2ecc71';
      ctx.fillText(pos, W / 2 - (gw + pw) / 2 + gw, H - bar / 2);
      ctx.font = big;
      ctx.fillStyle = '#ffd400';
      ctx.fillText(go, W / 2 - (gw + pw) / 2, H - bar / 2);
      ctx.textAlign = 'center';
    } else ctx.fillText('BOX BOX', W / 2, H - bar / 2);
    ctx.fillStyle = '#c9ced9';
    ctx.font = `bold ${12 * k}px ${FONT}`;
    ctx.fillText(exiting ? `${COMPOUNDS[world.tyre.compound].label} fitted · rejoining, tyres cold` : `${COMPOUNDS[world.nextCompound].label} · get ready on the wheel gun`, W / 2, bar / 2);
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
    ctx.save();
    this.scaleAbout(p.x, y, this.ui);
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
      if (g.jammed[i] && !res) { ctx.fillStyle = '#ff8a00'; ctx.font = `bold ${this.px(10)}px ${FONT}`; ctx.fillText('JAM', cx + 19, y + 10); }
    });
    // sweep bar
    const bx = x + 14, by = y + 60, bw = W - 28, bh = 16;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, bx, by, bw, bh, 4); ctx.fill();
    if (!done) {
      const z = wheelZones(g.jammed[g.wheel], g.crew ?? 1);
      ctx.fillStyle = 'rgba(46,204,113,0.55)';
      ctx.fillRect(bx + bw * (0.5 - z.good), by, bw * z.good * 2, bh);
      ctx.fillStyle = 'rgba(125,249,255,0.9)';
      ctx.fillRect(bx + bw * (0.5 - z.perfect), by, bw * z.perfect * 2, bh);
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
      ctx.fillText(g.hold > 0 ? (g.lastResult === 'miss' ? 'CROSS-THREADED…' : g.lastResult === 'perfect' ? 'PERFECT' : 'GOOD') : (this.touch ? 'FIRE  ·  ERS / tap' : 'FIRE  ·  SPACE / B / tap'), x + W - 14, y + 48);
    } else {
      ctx.fillStyle = '#2ecc71';
      ctx.font = `bold 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(g.hold > 0 ? 'JACK DOWN — GO GO GO' : '', x + W / 2, by + 12);
    }
    ctx.textAlign = 'left';
    ctx.restore();
    this.k = 1;
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
    const v = this.vis;
    ctx.fillStyle = `rgba(6,9,28,${0.5 * n})`;
    ctx.fillRect(v.x0, world.pitTop * 0.56, v.x1 - v.x0, Math.max(H, v.y1) - world.pitTop * 0.56);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = n;
    // floodlight pools on the track (one shared gradient; it is x-independent)
    const pool = ctx.createLinearGradient(0, world.pitTop, 0, world.trackBottom);
    pool.addColorStop(0, 'rgba(255,245,210,0.1)');
    pool.addColorStop(1, 'rgba(255,245,210,0)');
    ctx.fillStyle = pool;
    for (let x = -(world.scroll * 0.25 % 220) + 100; x < W + 220; x += 220) {
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
    // the forecast shower announces itself with a few spots of drizzle, thickening as it nears
    const fc = world.forecast;
    const drizzle = fc && fc.kind === 'rain' ? 0.08 * clamp(1 - fc.in / 12, 0.25, 1) : 0;
    const wet = Math.max(world.rain, drizzle);
    if (wet <= 0.02) return;
    const { ctx } = this;
    const n = Math.floor(220 * wet);
    ctx.strokeStyle = `rgba(210,228,255,${0.55 * Math.max(wet, drizzle ? 0.5 : 0)})`;
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
    const v = this.vis;
    ctx.fillStyle = `rgba(90,110,150,${0.16 * wet})`;
    ctx.fillRect(v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0);
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

  /** Floating labels. Score popups read "+31 CLOSE", bigger the more they pay, and pop in with a little overshoot. */
  drawPopups(world) {
    const { ctx } = this;
    ctx.textAlign = 'center';
    for (const pp of world.popups) {
      const a = clamp(1 - pp.age / pp.life, 0, 1);
      const size = (pp.value ? 16 + Math.min(14, pp.value / 10) : 18) * this.uiFor(16);
      const pop = 1 + 0.35 * Math.max(0, 1 - pp.age / 0.15) * Math.sin(Math.min(1, pp.age / 0.15) * Math.PI);
      const text = pp.value ? `+${pp.value} ${pp.text}` : pp.text;
      ctx.globalAlpha = a;
      ctx.save();
      ctx.translate(pp.x, pp.y);
      ctx.scale(pop, pop);
      ctx.font = `900 ${Math.round(size)}px ${FONT}`;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 4;
      ctx.strokeText(text, 0, 0);
      ctx.fillStyle = pp.color;
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- entities ----------
  drawPlayer(world) {
    const { ctx } = this;
    const p = world.player;
    const { sheet, frames } = this.assets;
    const car = world.car;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.tilt + p.angle);
    if (world.pit.requested || world.pit.phase === 'merge' || p.grace > 0) ctx.globalAlpha = 0.72 + 0.2 * Math.sin(this.time * 14); // ghosted in, out and just after
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, PLAYER.height * 0.45, PLAYER.width * 0.48, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    // the sprite sheet recoloured to the team you drive for (the vector car until it has loaded)
    drawLivery(ctx, sheet, frames, car, PLAYER.width, PLAYER.height, p.frame);
    // brake light when lifting (the FIA rain light doubles as one)
    if (p.throttle < 0.95 || world.rain > 0.3) {
      const on = world.rain > 0.3 ? Math.sin(this.time * 12) > 0 : true;
      ctx.fillStyle = on ? '#ff2a2a' : '#5a0000';
      ctx.fillRect(-PLAYER.width * 0.5, -PLAYER.height * 0.12, 5, PLAYER.height * 0.24);
    }
    // damage: a flap of front wing hanging off the nose (gone entirely at 100), a torn floor strake under the sidepod
    const { wing, floor } = p.parts;
    if (wing >= 100) {
      ctx.fillStyle = '#1a1c22';
      ctx.fillRect(PLAYER.width * 0.36, PLAYER.height * 0.22, PLAYER.width * 0.16, 5); // bare nose stub where the wing was
    } else if (wing >= 30) {
      ctx.save();
      ctx.translate(PLAYER.width * 0.44, PLAYER.height * 0.3);
      ctx.rotate(0.5 + Math.sin(this.time * 18) * 0.12 * (wing / 100));
      ctx.fillStyle = '#1a1c22';
      ctx.fillRect(-3, 0, 6 + wing * 0.1, 4);
      ctx.restore();
    }
    if (floor >= 30) {
      ctx.save();
      ctx.translate(-PLAYER.width * 0.1, PLAYER.height * 0.42);
      ctx.rotate(-0.35 - Math.sin(this.time * 22) * 0.1);
      ctx.fillStyle = '#1a1c22';
      ctx.fillRect(0, 0, 8 + floor * 0.12, 3);
      ctx.restore();
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
      case 'tyre': return this.drawTyre(hz, world);
      case 'rival': {
        ctx.save();
        ctx.translate(hz.x, hz.y);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(0, hz.h * 0.45, hz.w * 0.48, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        // a defender showing its move: the rain light flashes and an arrow points at the lane it is about to take
        const telling = hz.tell > 0;
        drawVectorCar(ctx, hz.w, hz.h, hz.team, hz.frame, { brake: telling ? Math.sin(this.time * 30) > 0 : hz.brake > 0, glow: telling ? 1 : hz.brake, driver: hz.driver });
        if (telling && hz.commitY !== undefined && Math.abs(hz.commitY - hz.y) > 4) {
          const dir = Math.sign(hz.commitY - hz.y);
          const a = 0.6 + 0.4 * Math.sin(this.time * 30);
          ctx.fillStyle = `rgba(255,59,59,${a})`;
          ctx.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx.lineWidth = 2;
          const ay = dir * (hz.h * 0.6);
          ctx.beginPath();
          ctx.moveTo(0, ay + dir * 20);
          ctx.lineTo(-15, ay);
          ctx.lineTo(-6, ay);
          ctx.lineTo(-6, ay - dir * 8);
          ctx.lineTo(6, ay - dir * 8);
          ctx.lineTo(6, ay);
          ctx.lineTo(15, ay);
          ctx.closePath();
          ctx.stroke();
          ctx.fill();
        }
        if (hz.teammate || hz.driver?.legend) {
          ctx.fillStyle = hz.driver?.legend ? '#d4af37' : '#fff';
          ctx.font = `bold ${Math.max(11, Math.ceil(10 / this.cssPerUnit))}px ${FONT}`; // readable on a phone
          ctx.textAlign = 'center';
          ctx.fillText(hz.teammate ? `TEAM-MATE · ${hz.driver.short}` : `${hz.driver.name.toUpperCase()} · ${hz.team.classic}`, 0, -hz.h * 0.75);
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

  /**
   * A loose tyre telegraphs where it is going: a dashed line along the next TYRE_PATH seconds of its
   * path on screen, folded off the kerbs the way it will bounce, so a bounce never comes as a surprise.
   */
  drawTyrePath(hz, world) {
    if (!hz.bounce || !hz.vy || world.gameOver) return;
    const { ctx } = this;
    const lo = world.trackTop + hz.r, hi = world.trackBottom - hz.r;
    const vx = hz.vx - world.speed;
    ctx.save();
    ctx.strokeStyle = hz.compound.color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 6]);
    ctx.lineDashOffset = -this.time * 40;
    ctx.beginPath();
    const n = 18;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * TYRE_PATH;
      const x = hz.x + vx * t, y = foldY(hz.y, hz.vy, t, lo, hi);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawTyre(hz, world) {
    const { ctx } = this;
    const r = hz.r;
    if (world) this.drawTyrePath(hz, world);
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
    const L = this.L || this.hudLayout(world, W, H);
    const { pad, kTop, kBot } = L;
    const touch = this.touch;
    // speedo (bottom-left): km/h, the gear you can hear, rev bars that saw with the engine, ERS
    ctx.save();
    this.scaleAbout(pad, H - pad, kBot);
    const kmh = world.kmh;
    const ratio = clamp(world.speed / SPEED.max, 0, 1);
    const eng = engineState(ratio);
    const stopped = world.pit.inLane && world.pit.phase === 'stop';
    const redline = eng.rpmNorm > 0.95 && !stopped && !world.gameOver;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(8,10,16,0.82)';
    roundRect(ctx, pad, H - 118, 250, 100, 10);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold 46px ${MONO}`;
    ctx.fillText(String(kmh).padStart(3, ' '), pad + 14, H - 66);
    ctx.font = `${this.px(14)}px ${FONT}`;
    ctx.fillStyle = '#c9ced9';
    ctx.fillText('km/h', pad + 108, H - 66);
    // gear: flashes red at the redline, right before the upshift you hear
    ctx.textAlign = 'right';
    ctx.font = `bold 40px ${MONO}`;
    ctx.fillStyle = redline && Math.sin(this.time * 40) > 0 ? '#ff3b3b' : '#ffd400';
    ctx.fillText(stopped || world.gameOver ? 'N' : String(eng.gear), pad + 236, H - 66);
    ctx.font = `bold ${this.px(10)}px ${FONT}`;
    ctx.fillStyle = '#8a91a0';
    ctx.fillText('GEAR', pad + 236, H - 100);
    // status chip on the card's top edge: whatever is capping or boosting the speed right now
    let chip = null;
    if (world.penalty > 0) chip = [`PENALTY ${world.penalty.toFixed(1)}s`, '#ff3b3b', '#fff'];
    else if (world.neutralised) chip = ['NEUTRALISED — weave', '#ffd400', '#111'];
    else if (world.sc.active) chip = ['SC DELTA — hold station', '#ffd400', '#111'];
    else if (world.sc.restartTimer > 0) chip = [`RESTART ×2 · ${world.sc.restartTimer.toFixed(1)}s`, '#2ecc71', '#111'];
    else if (world.tyre.punctured) chip = ['LIMPING — box', '#ff3b3b', '#fff'];
    else if (world.player.spin > 0) chip = ['SPIN', '#ff8a00', '#111'];
    else if (world.tow > 0.15) chip = [`TOW ${Math.round(world.tow * 100)}% · battery charging`, `rgba(125,249,255,${0.6 + world.tow * 0.4})`, '#111'];
    if (chip) this.drawChip(chip[0], pad + 14, H - 118, chip[1], chip[2], 'left');
    ctx.textAlign = 'left';
    // rev bars: rpm within the gear (they climb, the gear shifts, they drop — in step with the engine note)
    const revs = stopped || world.gameOver ? 0 : eng.rpmNorm;
    for (let i = 0; i < 14; i++) {
      const on = i / 14 < revs;
      ctx.fillStyle = on ? (i > 10 ? '#ff3b3b' : i > 7 ? '#ffd400' : '#2ecc71') : 'rgba(255,255,255,0.12)';
      ctx.fillRect(pad + 14 + i * 16, H - 52, 12, 10);
    }
    // ERS: the label says what the battery is doing (the whine you hear while boosting)
    const ersLow = world.ers.charge <= ERS.minToEngage && !world.ers.boosting;
    ctx.fillStyle = world.ers.boosting ? '#7df9ff' : ersLow ? '#ff8a00' : '#c9ced9';
    ctx.font = `bold ${this.px(11)}px ${FONT}`;
    const ersLabel = world.ers.boosting ? 'BOOST' : ersLow ? 'ERS LOW' : 'ERS';
    ctx.fillText(ersLabel, pad + 14, H - 28);
    // the bar starts after the label (which grows on a phone)
    const ex = Math.max(pad + 66, pad + 14 + ctx.measureText(ersLabel).width + 8), ew = pad + 234 - ex;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(ex, H - 37, ew, 10);
    ctx.fillStyle = world.ers.boosting ? '#7df9ff' : world.ers.charge > ERS.minToEngage ? '#2ee6a6' : '#666';
    ctx.fillRect(ex, H - 37, ew * (world.ers.charge / ERS.max), 10);
    this.anchor('ers', pad, H - 118, 250, 100, pad, H - pad, kBot);
    // a DRS gate: the bar flashes cyan and says what the battery actually got
    if (hud.drs && hud.drs.age < 1.2) {
      const f = 1 - hud.drs.age / 1.2;
      ctx.strokeStyle = `rgba(125,249,255,${f})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(ex - 1, H - 38, ew + 2, 12);
      ctx.fillStyle = `rgba(125,249,255,${0.35 * f * (Math.sin(this.time * 30) > 0 ? 1 : 0.4)})`;
      ctx.fillRect(ex, H - 37, ew, 10);
      ctx.globalAlpha = Math.min(1, f * 1.5);
      ctx.font = `900 ${this.px(12)}px ${FONT}`;
      ctx.fillStyle = '#7df9ff';
      ctx.textAlign = 'right';
      ctx.fillText(`DRS +${hud.drs.gain}`, pad + 234, H - 42);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // tyre widget (bottom-right)
    ctx.save();
    this.scaleAbout(W - pad, H - pad, kBot);
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
    // tyre state line: puncture and the cliff blink, because both mean "box"
    const wear = world.tyre.wear;
    const cliff = wear > TYRES.cliffStart && !world.tyre.punctured;
    const blink = Math.sin(this.time * 8) > 0;
    ctx.fillStyle = world.tyre.punctured ? (blink ? '#ff3b3b' : '#fff') : cliff && blink ? '#ffd400' : '#fff';
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText(world.tyre.punctured ? 'PUNCTURE — BOX' : cliff ? `${c.label} · CLIFF` : world.tyre.temp < 0.6 ? `${c.label} · COLD` : c.label, tx + 80, H - 88);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(tx + 80, H - 78, 150, 10);
    ctx.fillStyle = wear > 85 ? '#ff3b3b' : wear > TYRES.cliffStart ? '#ffd400' : '#2ecc71';
    ctx.fillRect(tx + 80, H - 78, 150 * (1 - wear / 100), 10);
    // cliff marker on the wear bar so you can see it coming
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(tx + 80 + 150 * (1 - TYRES.cliffStart / 100) - 1, H - 80, 2, 14);
    // the forecast: where the wear will be when the next window you could still use closes, and the verdict
    const fc = world.racing ? world.wearForecast : null;
    const FC_COLOR = { makesIt: '#2ecc71', marginal: '#ffd400', wontLast: '#ff3b3b' };
    if (fc) {
      const fx = tx + 80 + 150 * (1 - fc.wear / 100);
      ctx.fillStyle = FC_COLOR[fc.verdict];
      ctx.beginPath(); ctx.moveTo(fx, H - 81); ctx.lineTo(fx - 4, H - 87); ctx.lineTo(fx + 4, H - 87); ctx.closePath(); ctx.fill();
      ctx.fillRect(fx - 1, H - 80, 2, 14);
    }
    ctx.fillStyle = '#c9ced9';
    ctx.font = `${this.px(12)}px ${FONT}`;
    ctx.fillText(`grip ${Math.round(world.grip * 100)}%`, tx + 80, H - 58);
    if (fc) {
      ctx.textAlign = 'right';
      ctx.font = `bold ${this.px(11)}px ${FONT}`;
      ctx.fillStyle = FC_COLOR[fc.verdict];
      ctx.fillText(FORECAST_LABEL[fc.verdict], tx + 230, H - 58);
      ctx.textAlign = 'left';
    }
    const nc = COMPOUNDS[world.nextCompound];
    ctx.fillStyle = '#c9ced9';
    ctx.font = `${this.px(12)}px ${FONT}`;
    ctx.fillText('Next stop:', tx + 80, H - 36);
    const nx = Math.max(tx + 150, tx + 80 + ctx.measureText('Next stop:').width + 6);
    ctx.fillStyle = nc.color;
    ctx.font = `bold ${this.px(12)}px ${FONT}`;
    ctx.fillText(nc.label, nx, H - 36);
    this.anchor('nextTyre', tx + 76, H - 50, 160, 20, W - pad, H - pad, kBot);
    // a red ✕ when the planned tyre is wrong for the weather that is coming
    if (wrongForWeather(nc.id, world.expectedRain)) {
      const xx = nx + ctx.measureText(nc.label).width + 8;
      ctx.strokeStyle = '#ff3b3b';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(xx, H - 45); ctx.lineTo(xx + 9, H - 36); ctx.moveTo(xx + 9, H - 45); ctx.lineTo(xx, H - 36); ctx.stroke();
    }
    if (!touch) {
      ctx.fillStyle = '#8a91a0';
      ctx.font = `${this.px(11)}px ${FONT}`;
      ctx.fillText('[1-5 / Tab]', tx + 80, H - 22);
    }
    this.anchor('tyre', tx, H - 118, tw, 100, W - pad, H - pad, kBot);
    // pit status: a chip on the card's edge (it used to float over the grass), urgent when the car needs the stop
    const pitIn = world.pitCountdown();
    const needsStop = world.tyre.punctured || cliff || world.damage >= DAMAGE.needsStop
      || wrongForWeather(c.id, world.rain) || fc?.verdict === 'wontLast';
    const pit = world.pit;
    const key = this.touch ? 'BOX' : 'B';
    let pitChip;
    if (pit.inLane) pitChip = [pit.phase === 'stop' ? 'IN THE BOX — fire the guns!' : 'PIT LANE', '#ffd400', '#111'];
    else if (pit.requested) pitChip = ['BOXING — copy', '#2ecc71', '#111'];
    else if (pit.reason === 'puncture' || pit.reason === 'damage') pitChip = [`PIT OPEN — ${pit.reason === 'puncture' ? 'PUNCTURE' : 'REPAIRS'} (${key})`, blink ? '#ff3b3b' : '#ff7a7a', '#fff'];
    else if (pit.reason === 'sc') pitChip = [`SC CHEAP STOP ≈ −${Math.round(world.pitEstimate())} m (${key})`, needsStop && blink ? '#ffe680' : '#ffd400', '#111'];
    else if (pit.open) {
      const last = pit.left <= 2;
      pitChip = [`${needsStop ? 'PIT OPEN — BOX NOW' : 'PIT OPEN'} · ${Math.ceil(pit.left)}s (${key})`, (needsStop || last) && blink ? '#7ff0b0' : '#2ecc71', '#111'];
    } else if (pit.cooldown > 0) pitChip = ['fresh tyres — stay out', 'rgba(52,56,66,0.96)', '#c9ced9'];
    else pitChip = [`${needsStop ? 'BOX in' : 'pit window in'} ${Math.ceil(pitIn)}s`, needsStop ? 'rgba(255,212,0,0.92)' : 'rgba(52,56,66,0.96)', needsStop ? '#111' : '#c9ced9'];
    const chipW = this.drawChip(pitChip[0], tx + tw - 12, H - 118, pitChip[1], pitChip[2], 'right');
    this.anchor('pitChip', tx + tw - 12 - chipW, H - 129, chipW, 22, W - pad, H - pad, kBot);
    // the window draining away: a green bar under the chip (blinking white in the last two seconds)
    if (!pit.inLane && pit.reason === 'window') {
      const f = clamp(pit.left / PIT.openFor, 0, 1);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(tx + tw - 12 - chipW + 8, H - 105, chipW - 16, 3);
      ctx.fillStyle = pit.left <= 2 && blink ? '#fff' : '#2ecc71';
      ctx.fillRect(tx + tw - 12 - chipW + 8, H - 105, (chipW - 16) * f, 3);
    }
    ctx.restore();

    // top strip: score, distance, time, overtakes, weather
    ctx.save();
    this.scaleAbout(pad, pad, kTop);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(8,10,16,0.82)';
    roundRect(ctx, pad, pad, 300, 64, 10);
    ctx.fill();
    // bonus points count up into the score (and it glows yellow while they do) instead of jumping;
    // distance ticks over as it always did
    const bonus = world.bonus;
    if (this.shownWorld !== world || this.shownBonus > bonus) { this.shownWorld = world; this.shownBonus = bonus; }
    const owed = bonus - this.shownBonus;
    const fdt = this.dt || 1 / 60;
    if (owed > 0) { this.scoreGlow = 1; this.shownBonus = Math.min(bonus, this.shownBonus + Math.max(owed * 6, 80) * fdt); }
    this.scoreGlow = Math.max(0, (this.scoreGlow || 0) - fdt * 2.5);
    const shown = world.gameOver ? world.score : world.score - bonus + Math.floor(this.shownBonus);
    ctx.fillStyle = this.scoreGlow > 0 ? lerpColor('#ffffff', '#ffd400', Math.min(1, this.scoreGlow * 1.4)) : '#fff';
    ctx.font = `bold 30px ${MONO}`;
    ctx.fillText(String(shown).padStart(6, '0'), pad + 14, pad + 36);
    this.drawFlow(world, pad + 132, pad + 10);
    // on touch the card keeps what matters at a glance: no best, no close-call tally
    ctx.font = `${this.px(12)}px ${FONT}`;
    ctx.fillStyle = '#c9ced9';
    ctx.fillText(`${formatDistance(world.distance)}   ·   ${formatTime(world.elapsed)}${touch ? '' : `   ·   best ${hud.best}`}`, pad + 14, pad + 54);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff';
    ctx.font = `bold 16px ${FONT}`;
    ctx.fillText(positionLabel(world.position), pad + 286, pad + 26);
    ctx.font = `${this.px(11)}px ${FONT}`;
    ctx.fillStyle = '#c9ced9';
    ctx.fillText(`${world.overtakes} overtakes`, pad + 286, touch ? pad + 50 : pad + 42);
    if (!touch) ctx.fillText(`${world.closeCalls} close calls`, pad + 286, pad + 56);
    ctx.restore();

    // venue + GP progress + weather (top right)
    ctx.save();
    this.scaleAbout(W - pad, pad, kTop);
    const vw = 250;
    const vx = W - pad - vw;
    ctx.fillStyle = 'rgba(8,10,16,0.82)';
    roundRect(ctx, vx, pad, vw, 64, 10);
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText(`${world.venue.flag} ${world.venue.name}`, vx + 12, pad + 24);
    ctx.font = `${this.px(11)}px ${FONT}`;
    ctx.fillStyle = '#c9ced9';
    // live: what the current position would pay at the flag
    const roundTxt = `Round ${world.gps + 1}  ·  `;
    ctx.fillText(roundTxt, vx + 12, pad + 40);
    const pts = pointsFor(world.position);
    ctx.font = `bold ${this.px(11)}px ${FONT}`;
    ctx.fillStyle = pts > 0 ? '#ffd400' : '#8a91a0';
    ctx.fillText(`${positionLabel(world.position)} → ${pts} pts`, vx + 12 + ctx.measureText(roundTxt).width, pad + 40);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(vx + 12, pad + 48, vw - 24, 6);
    ctx.fillStyle = '#ffd400';
    ctx.fillRect(vx + 12, pad + 48, (vw - 24) * gpProgress(world.distance), 6);
    ctx.textAlign = 'right';
    ctx.font = `bold 13px ${FONT}`;
    // the radar: rain (or the end of it) counted down before it arrives
    const wf = world.forecast;
    const fcBlink = Math.sin(this.time * 7) > -0.2;
    if (wf && wf.kind === 'rain') {
      ctx.fillStyle = fcBlink ? '#7fb2ff' : '#c9d9ff';
      ctx.fillText(`🌧 RAIN IN ${Math.ceil(wf.in)}s`, vx + vw - 12, pad + 24);
    } else if (wf && wf.kind === 'dry') {
      ctx.fillStyle = fcBlink ? '#ffd400' : '#fff0a0';
      ctx.fillText(`☀ DRYING IN ${Math.ceil(wf.in)}s`, vx + vw - 12, pad + 24);
    } else {
      ctx.fillStyle = world.raining ? '#7fb2ff' : '#ffd400';
      ctx.fillText(world.raining ? (world.rainPeak < 1 ? '🌦 DAMP' : '🌧 RAIN') : world.rain > 0.1 ? '☁ DRYING' : world.night > 0.5 ? '🌙 NIGHT' : '☀ DRY', vx + vw - 12, pad + 24);
    }
    // the music key is a keyboard thing
    if (!touch) {
      ctx.fillStyle = hud.musicOn ? '#c9ced9' : '#666';
      ctx.font = `${this.px(11)}px ${FONT}`;
      ctx.fillText(hud.musicOn ? '♪ on (M)' : '♪ off (M)', vx + vw - 12, pad + 40);
    }
    ctx.restore();

    // Radio strip. Wide screens: in the gap between the two top cards. Narrow ones (near-square
    // windows): under the cards, so it never covers the score or the venue. Long lines wrap
    // instead of running off; a subtitled clip names who is talking. Scaled about its top centre.
    const { kR, radioMaxW, radioY, bannerY } = L;
    if (hud.radio && hud.radio.age < (hud.radio.dur ?? 4.5)) {
      ctx.save();
      this.scaleAbout(W / 2, radioY, kR);
      const dur = hud.radio.dur ?? 4.5;
      const a = Math.min(1, hud.radio.age / 0.12) * clamp((dur - hud.radio.age) / 0.6, 0, 1);
      const who = hud.radio.who;
      ctx.globalAlpha = a;
      ctx.textAlign = 'left';
      ctx.font = `bold 16px ${FONT}`;
      const lines = wrapText(ctx, who ? hud.radio.text : `📻 ${hud.radio.text}`, radioMaxW - 34, 3);
      ctx.font = `bold 13px ${FONT}`;
      const whoW = who ? ctx.measureText(`🔊 ${who.toUpperCase()}`).width : 0;
      ctx.font = `bold 16px ${FONT}`;
      const bw = Math.min(radioMaxW, Math.max(whoW, ...lines.map((l) => ctx.measureText(l).width)) + 34);
      const bh = 12 + (who ? 15 : 0) + lines.length * 21;
      const rx = W / 2 - bw / 2;
      ctx.fillStyle = 'rgba(10,10,14,0.82)';
      roundRect(ctx, rx, radioY, bw, bh, 8);
      ctx.fill();
      ctx.fillStyle = who ? '#ffd400' : '#e10600';
      ctx.fillRect(rx, radioY + 4, 6, bh - 8);
      let ty = radioY + 8;
      if (who) {
        ctx.font = `bold 13px ${FONT}`;
        ctx.fillStyle = '#ffd400';
        ctx.fillText(`🔊 ${who.toUpperCase()}`, rx + 16, ty + 12);
        ty += 15;
        ctx.font = `bold 16px ${FONT}`;
      }
      ctx.fillStyle = '#fff';
      lines.forEach((l, i) => ctx.fillText(l, rx + 16, ty + 17 + i * 21));
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // toast (big text: milestones, damage, flags...) in the band between the top cards and the track,
    // where the SC / penalty banners live: while a toast is up it takes their place (it says the same
    // thing when they appear). Under the round card only a priority-2 toast shows.
    const toast = hud.toast && hud.toast.age < (hud.toast.dur ?? 1.6) ? hud.toast : null;
    const venueCard = world.venueBlend < 1 && world.gps > 0;
    const showToast = toast && (!venueCard || (toast.prio || 0) >= 2);

    ctx.save();
    this.scaleAbout(W / 2, bannerY, kR);
    this.anchor('banner', W / 2 - 150, bannerY, 300, world.sc.active && world.penalty > 0 ? 66 : 30, W / 2, bannerY, kR); // the whole banner stack
    // safety car banner
    if (world.sc.active && !showToast) {
      const on = Math.sin(this.time * 6) > 0;
      const text = world.sc.phase === 'ending' ? 'SAFETY CAR IN THIS LAP' : world.sc.neutral ? 'SAFETY CAR — RACE NEUTRALISED' : 'SAFETY CAR — NO OVERTAKING';
      ctx.font = `900 16px ${FONT}`;
      const bw = Math.max(260, ctx.measureText(text).width + 40);
      ctx.textAlign = 'center';
      ctx.fillStyle = on ? '#ffd400' : '#ffb000';
      roundRect(ctx, W / 2 - bw / 2, bannerY, bw, 30, 6);
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.fillText(text, W / 2, bannerY + 21);
    }

    // penalty banner: a served penalty should be unmissable, not a corner note
    if (world.penalty > 0 && !showToast) {
      const py = bannerY + (world.sc.active ? 36 : 0);
      ctx.textAlign = 'center';
      ctx.font = `900 14px ${FONT}`;
      const ptxt = `SERVING PENALTY — ${world.penalty.toFixed(1)}s — NO SCORING`;
      const pw = Math.max(300, ctx.measureText(ptxt).width + 30);
      ctx.fillStyle = '#e10600';
      roundRect(ctx, W / 2 - pw / 2, py, pw, 30, 6);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(`SERVING PENALTY — ${world.penalty.toFixed(1)}s — NO SCORING`, W / 2, py + 20);
    }
    ctx.restore();

    if (showToast) {
      const t = toast.age;
      const dur = toast.dur ?? 1.6;
      const a = t < 0.2 ? t / 0.2 : t > dur - 0.4 ? (dur - t) / 0.4 : 1;
      const k = this.uiFor(13);
      // title + pill are 63 units tall; keep the pill's bottom above the kerb
      const top = Math.min(bannerY, world.trackTop - 14 - 63 * k);
      ctx.save();
      this.scaleAbout(W / 2, top, k);
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.textAlign = 'center';
      ctx.font = `900 ${26 + Math.min(1, t * 4) * 4}px ${FONT}`;
      ctx.fillStyle = toast.color || '#ffd400';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 6;
      ctx.strokeText(toast.text, W / 2, top + 28);
      ctx.fillText(toast.text, W / 2, top + 28);
      if (toast.sub) this.drawPill(toast.sub, W / 2, top + 50);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // damage meter under the score card (top-left stays clear of the track), flashes on a hit
    ctx.save();
    this.scaleAbout(pad, pad, kTop);
    this.drawDamage(world, hud, pad);
    this.anchor('damage', pad, pad + 72, DAMAGE_CARD.w, DAMAGE_CARD.h, pad, pad, kTop);
    ctx.restore();
    this.k = 1;

    // coach card: what to do on the grid (in the empty middle lane), then one short tip at a time for the opening seconds
    this.drawCoach(world, W, H, hud);

    // behind the safety car: the weave gauge, then the countdown back to green
    this.drawWeave(world, W);
    this.drawCountdown(world, W);
  }

  /**
   * The safety-car weave. A card ahead of the car with the tyre-temperature gauge: blue below
   * the window, green inside it, red (blistering) above. Sits in the lane the car weaves in,
   * ahead of it, so eyes stay on the car.
   */
  drawWeave(world, W) {
    const w = world.sc.weave;
    if (!world.neutralised || !w || world.gameOver) return;
    const { ctx } = this;
    const cx = W / 2;
    const mid = (world.trackTop + world.trackBottom) / 2;
    // between the toast line (H * 0.36 and its pill) and the top of the weave band
    const cardW = 380, cardH = 64;
    const x0 = cx - cardW / 2;
    const y0 = mid - SC_GAME.weaveAmplitude - cardH - 24;
    ctx.save();
    this.scaleAbout(cx, y0 + cardH, this.ui);
    ctx.globalAlpha = 0.94;
    ctx.fillStyle = 'rgba(8,10,16,0.86)';
    roundRect(ctx, x0, y0, cardW, cardH, 10);
    ctx.fill();
    const zoneColor = w.zone === 'warm' ? '#2ecc71' : w.zone === 'hot' ? '#ff3b3b' : '#7df9ff';
    ctx.fillStyle = zoneColor;
    ctx.fillRect(x0, y0 + 8, 3, cardH - 16);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    ctx.font = `900 13px ${FONT}`;
    ctx.fillText('KEEP THE TYRES WARM', x0 + 16, y0 + 20);
    ctx.textAlign = 'right';
    ctx.fillStyle = zoneColor;
    ctx.font = `bold 12px ${FONT}`;
    ctx.fillText(w.zone === 'warm' ? 'IN THE WINDOW' : w.zone === 'hot' ? 'BLISTERING' : 'COLD', x0 + cardW - 16, y0 + 20);
    // the gauge: track, the window, the fill, the needle
    const gx = x0 + 16, gy = y0 + 27, gw = cardW - 32, gh = 10;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    roundRect(ctx, gx, gy, gw, gh, 6);
    ctx.fill();
    ctx.fillStyle = 'rgba(46,204,113,0.28)';
    ctx.fillRect(gx + gw * SC_GAME.band.lo, gy, gw * (SC_GAME.band.hi - SC_GAME.band.lo), gh);
    const grad = ctx.createLinearGradient(gx, 0, gx + gw, 0);
    grad.addColorStop(0, '#2f80ff'); grad.addColorStop(0.5, '#2ecc71'); grad.addColorStop(0.88, '#ffd400'); grad.addColorStop(1, '#ff3b3b');
    ctx.fillStyle = grad;
    ctx.save();
    roundRect(ctx, gx, gy, gw, gh, 6);
    ctx.clip();
    ctx.fillRect(gx, gy, gw * w.heat, gh);
    ctx.restore();
    ctx.fillStyle = '#fff';
    ctx.fillRect(gx + gw * w.heat - 1.5, gy - 3, 3, gh + 6);
    // the instruction and the tally
    ctx.textAlign = 'left';
    const runs = this.coachRuns(this.touch ? 'Wiggle up and down to weave' : '[▲] [▼] weave · one swing each way');
    let x = gx;
    const ty = y0 + cardH - 11;
    for (const seg of runs) {
      if (seg.key) {
        ctx.fillStyle = '#1c2029';
        roundRect(ctx, x, ty - 13, seg.w - 6, 18, 4);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = `700 11px ${MONO}`;
        ctx.fillText(seg.text, x + 7, ty);
      } else {
        ctx.fillStyle = seg.sep ? '#6b7280' : '#c9ced9';
        ctx.font = `600 13px ${FONT}`;
        ctx.fillText(seg.text, x, ty);
      }
      x += seg.w;
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffd400';
    ctx.font = `bold 12px ${MONO}`;
    ctx.fillText(`${w.weaves} weaves`, x0 + cardW - 16, ty);
    ctx.restore();
    this.k = 1;
  }

  /** 3 · 2 · 1 in the middle of the track while the safety car peels off; the green flag toast takes over. */
  drawCountdown(world, W) {
    const sc = world.sc;
    if (!sc.active || sc.phase !== 'ending' || sc.countdown < 0 || world.gameOver) return;
    const { ctx } = this;
    const n = Math.ceil(sc.countdown);
    const frac = sc.countdown - (n - 1); // 1 → 0 within this second
    const pop = 1 + 0.25 * clamp((frac - 0.75) / 0.25, 0, 1); // lands big, settles
    // in the middle lane ahead of the car, where the safety car was until it peeled off
    const y = (world.trackTop + world.trackBottom) / 2 + 4;
    ctx.save();
    ctx.translate(W / 2, y);
    ctx.scale(pop * this.uiFor(13), pop * this.uiFor(13));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 72px ${FONT}`;
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(String(n), 0, 0);
    ctx.fillStyle = n === 1 ? '#2ecc71' : '#ffd400';
    ctx.fillText(String(n), 0, 0);
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 4;
    ctx.strokeText('RESTART — READY ON THE THROTTLE', 0, 52);
    ctx.fillText('RESTART — READY ON THE THROTTLE', 0, 52);
    ctx.restore();
  }

  /**
   * Tutorial pop-ups. On the grid a two-line card sits in the empty middle lane; after the
   * lights each tip gets a few seconds on its own in the same spot, so nothing has to be
   * read off a wall of text while the field is launching. Same card as the rest of the HUD;
   * keys are drawn as keycaps.
   */
  drawCoach(world, W, H, hud = null) {
    if (world.gameOver) return;
    const { ctx } = this;
    const k = this.ui;
    const mid = (world.trackTop + world.trackBottom) / 2;
    const sinceGo = world.racing ? world.start.sinceGo : -1;
    if (sinceGo < 0) {
      ctx.save();
      this.scaleAbout(W / 2, mid, k);
      this.drawCoachCard(this.touch ? COACH.touchGrid : COACH.grid, W / 2, mid, { accent: '#ff3b3b', alpha: 0.95, anchor: 'middle' });
      ctx.restore();
      this.k = 1;
      return;
    }
    const tips = this.touch ? COACH.touchTips : COACH.tips;
    const i = Math.floor(sinceGo / COACH.each);
    if (i < tips.length) {
      const t = sinceGo - i * COACH.each;
      const alpha = clamp(Math.min(t / 0.25, (COACH.each - t) / 0.35), 0, 1) * 0.95;
      // the middle lane again: nothing spawns during the launch, and the pack sits in the outer lanes
      ctx.save();
      this.scaleAbout(W / 2, mid, k);
      this.drawCoachCard([tips[i]], W / 2, mid, { accent: '#ffd400', alpha, anchor: 'middle', step: tips.length > 1 ? `${i + 1}/${tips.length}` : null });
      ctx.restore();
      this.k = 1;
    }
    // a just-in-time card, pointing at the widget it is about
    const c = hud && hud.coach;
    const card = c && COACH_CARDS[c.id];
    const a = card && this.anchors[card.at];
    if (!a || c.age >= COACH_CARD_DUR) return;
    const alpha = clamp(Math.min(c.age / 0.25, (COACH_CARD_DUR - c.age) / 0.4), 0, 1) * 0.97;
    const below = a.y + a.h / 2 < H / 2; // top widgets get the card under them, bottom ones above
    const tx = clamp(a.x + a.w / 2, 30, W - 30), ty = below ? a.y + a.h : a.y;
    const lines = [this.touch ? card.touch : card.keys];
    ctx.save();
    this.scaleAbout(tx, ty, k);
    const { width } = this.measureCoachCard(lines);
    // keep the whole card on screen: in local units the screen spans tx - (tx - pad) / k .. tx + (W - pad - tx) / k
    const lo = tx - (tx - 12) / k + width / 2, hi = tx + (W - 12 - tx) / k - width / 2;
    const cx = lo > hi ? tx : clamp(tx, lo, hi);
    const gapY = 6;
    this.drawCoachCard(lines, cx, below ? ty + gapY : ty - gapY, { accent: card.accent, alpha, anchor: below ? 'top' : 'bottom' });
    // the 6 px pointer from the card to the widget
    ctx.globalAlpha = alpha;
    ctx.fillStyle = card.accent;
    ctx.beginPath();
    ctx.moveTo(tx - 6, below ? ty + gapY : ty - gapY);
    ctx.lineTo(tx + 6, below ? ty + gapY : ty - gapY);
    ctx.lineTo(tx, ty);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    this.k = 1;
  }
  /** Width and height a coach card needs for these lines. */
  measureCoachCard(lines, step = null) {
    const runs = lines.map((l) => this.coachRuns(l));
    return {
      width: Math.max(...runs.map((r) => r.reduce((w, seg) => w + seg.w, 0))) + 32 + (step ? 34 : 0),
      height: lines.length * 24 + 18,
    };
  }

  /**
   * A dark rounded card with a coloured edge and centred lines of text; `[KEY]` becomes a
   * keycap and ` · ` a muted separator. `anchor` says what `y` is: top, middle or bottom.
   */
  drawCoachCard(lines, cx, y, { accent = '#ffd400', alpha = 1, anchor = 'top', step = null } = {}) {
    const { ctx } = this;
    const lineH = 24, padX = 16, padY = 9;
    const runs = lines.map((l) => this.coachRuns(l));
    const width = Math.max(...runs.map((r) => r.reduce((w, seg) => w + seg.w, 0))) + padX * 2 + (step ? 34 : 0);
    const height = lines.length * lineH + padY * 2;
    const x0 = cx - width / 2;
    const y0 = anchor === 'top' ? y : anchor === 'middle' ? y - height / 2 : y - height;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(8,10,16,0.86)';
    roundRect(ctx, x0, y0, width, height, 10);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.fillRect(x0, y0 + 6, 4, height - 12);
    if (step) {
      ctx.font = `bold ${this.px(10)}px ${MONO}`;
      ctx.fillStyle = '#8a91a0';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(step, x0 + width - 12, y0 + height / 2);
    }
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    runs.forEach((segs, li) => {
      const total = segs.reduce((w, seg) => w + seg.w, 0);
      let x = cx - total / 2 - (step ? 17 : 0);
      const cy = y0 + padY + lineH * (li + 0.5);
      for (const seg of segs) {
        if (seg.key) {
          const kw = seg.w - 6, kh = 18;
          ctx.fillStyle = '#1c2029';
          roundRect(ctx, x + 3, cy - kh / 2, kw, kh, 5);
          ctx.fill();
          ctx.strokeStyle = '#3a4152';
          ctx.lineWidth = 1;
          roundRect(ctx, x + 3, cy - kh / 2, kw, kh, 5);
          ctx.stroke();
          ctx.fillStyle = '#39404f';
          ctx.fillRect(x + 4, cy + kh / 2 - 2, kw - 2, 2); // keycap lip
          ctx.font = `700 11px ${MONO}`;
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.fillText(seg.text, x + 3 + kw / 2, cy);
          ctx.textAlign = 'left';
        } else {
          ctx.font = `600 13px ${FONT}`;
          ctx.fillStyle = seg.sep ? '#6d7482' : '#f4f5f8';
          ctx.fillText(seg.text, x, cy + 1);
        }
        x += seg.w;
      }
    });
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
    return height;
  }
  /** Splits a coach line into measured runs: plain text, ` · ` separators and `[KEY]` keycaps. */
  coachRuns(line) {
    const { ctx } = this;
    const segs = [];
    for (const part of line.split(/(\[[^\]]+\]| · )/)) {
      if (!part) continue;
      if (part.startsWith('[') && part.endsWith(']')) {
        const text = part.slice(1, -1);
        ctx.font = `700 11px ${MONO}`;
        segs.push({ key: true, text, w: Math.max(22, ctx.measureText(text).width + 14) + 6 });
      } else {
        ctx.font = `600 13px ${FONT}`;
        segs.push({ text: part, sep: part === ' · ', w: ctx.measureText(part).width });
      }
    }
    return segs;
  }
  /** Small centred pill for a toast's second line: readable over anything, same family as the HUD chips. */
  drawPill(text, cx, cy) {
    const { ctx } = this;
    ctx.font = `600 13px ${FONT}`;
    const w = ctx.measureText(text).width + 26;
    ctx.fillStyle = 'rgba(8,10,16,0.86)';
    roundRect(ctx, cx - w / 2, cy - 13, w, 26, 13);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + 1);
    ctx.textBaseline = 'alphabetic';
  }

  /** Damage card: front wing and floor bars. Empty bars are good; a full red bar means the next hit retires you. */
  drawDamage(world, hud, pad) {
    const { ctx } = this;
    const { wing, floor } = world.player.parts;
    const flash = hud.damage && hud.damage.age < 0.9 ? 1 - hud.damage.age / 0.9 : 0;
    const x = pad, y = pad + 64 + 8, { w, h } = DAMAGE_CARD;
    ctx.fillStyle = 'rgba(8,10,16,0.82)';
    roundRect(ctx, x, y, w, h, 10);
    ctx.fill();
    if (flash > 0) {
      ctx.strokeStyle = `rgba(255,59,59,${flash})`;
      ctx.lineWidth = 2;
      roundRect(ctx, x, y, w, h, 10);
      ctx.stroke();
    }
    const total = world.damage;
    ctx.textAlign = 'left';
    ctx.font = `bold ${this.px(10)}px ${FONT}`;
    const terminal = total >= 100;
    ctx.fillStyle = terminal ? (Math.sin(this.time * 9) > -0.3 ? '#ff3b3b' : '#7a1010') : total >= DAMAGE.needsStop ? '#ffd400' : '#c9ced9';
    if (terminal) ctx.font = `900 ${this.px(11)}px ${FONT}`;
    ctx.fillText(terminal ? 'NEXT HIT = OUT' : total >= DAMAGE.needsStop ? 'DAMAGE · BOX' : 'DAMAGE', x + 12, y + 15);
    ctx.font = `bold ${this.px(10)}px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = terminal ? '#ff3b3b' : '#c9ced9';
    ctx.fillText(terminal ? 'BOX' : `${Math.round(total)}%`, x + w - 12, y + 15);
    ctx.textAlign = 'left';
    const bars = [['F WING', wing, 'wing'], ['FLOOR', floor, 'floor']];
    bars.forEach(([label, v, part], i) => {
      const by = y + 24 + i * 15;
      const hot = hud.damage && hud.damage.part === part && flash > 0;
      ctx.font = `bold ${this.px(11)}px ${FONT}`;
      ctx.fillStyle = hot ? '#fff' : v >= 100 ? '#ff3b3b' : '#8a91a0';
      ctx.fillText(label, x + 12, by + 9);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x + 62, by, w - 74, 9);
      ctx.fillStyle = v >= 100 ? '#ff3b3b' : v >= 60 ? '#ff8a00' : v > 0 ? '#ffd400' : '#2ecc71';
      ctx.fillRect(x + 62, by, (w - 74) * (v / 100), 9);
    });
  }

  /**
   * The flow badge in the score card: the multiplier on a pill whose colour climbs with the tier,
   * with the window draining along its bottom edge. Hidden at ×1.
   */
  drawFlow(world, x, y) {
    const f = world.flow;
    if (!f || f.mult <= 1) return;
    const { ctx } = this;
    const label = `FLOW ×${f.mult % 1 ? f.mult.toFixed(2).replace(/0$/, '') : f.mult}`;
    ctx.font = `900 12px ${FONT}`;
    const w = Math.ceil(ctx.measureText(label).width) + 18, h = 24;
    const colors = ['#7df9ff', '#7df9ff', '#2ecc71', '#ffd400', '#ff8a00'];
    const col = colors[Math.min(colors.length - 1, f.tier)];
    const fade = clamp(f.timer / 0.6, 0, 1); // fades out over the last moment of the window
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.65 * fade;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(ctx, x, y, w, h, 12);
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, w, h, 12);
    ctx.stroke();
    // the window, draining
    ctx.fillStyle = col;
    ctx.fillRect(x + 10, y + h - 4, (w - 20) * clamp(f.timer / FLOW.window, 0, 1), 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 12px ${FONT}`;
    ctx.fillStyle = col;
    ctx.fillText(label, x + w / 2, y + h / 2 - 1);
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
  }

  /** Small status pill centred on y, growing left or right from x. */
  drawChip(text, x, y, bg, fg = '#111', align = 'left') {
    const { ctx } = this;
    ctx.font = `bold ${this.px(11)}px ${FONT}`;
    const w = ctx.measureText(text).width + 20;
    const x0 = align === 'right' ? x - w : x;
    ctx.fillStyle = bg;
    roundRect(ctx, x0, y - 11, w, 22, 11);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x0 + 10, y + 1);
    ctx.textBaseline = 'alphabetic';
    return w;
  }
}

// ---------- helpers ----------
/** Greedy word wrap for the current ctx.font; the last permitted line gets an ellipsis if it overflows. */
function wrapText(ctx, text, maxWidth, maxLines = 3) {
  const lines = [];
  let cur = '';
  for (const word of text.split(' ')) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && ctx.measureText(next).width > maxWidth) { lines.push(cur); cur = word; } else cur = next;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] += '…'; }
  return lines;
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Blends run over a few seconds but are sampled every frame for every palette
// key, so results are memoised on a lightly quantised t (invisible at 200 steps).
const colorCache = new Map();
function lerpColor(a, b, t) {
  if (a === b || t <= 0) return a.startsWith('#') ? rgbString(hex(a)) : a;
  const q = Math.min(200, Math.round(t * 200));
  const key = `${a}|${b}|${q}`;
  let out = colorCache.get(key);
  if (!out) {
    const pa = hex(a), pb = hex(b);
    out = rgbString(pa.map((v, i) => Math.round(lerp(v, pb[i], q / 200))));
    if (colorCache.size > 4000) colorCache.clear();
    colorCache.set(key, out);
  }
  return out;
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
  // brake / rain light: big enough to read at a glance, with a glow while it is lit
  const glow = opts.glow ?? (opts.brake ? 1 : 0);
  if (glow > 0.05) {
    const gx = -hw * 0.96, gy = wy - wr * 0.05;
    const g = ctx.createRadialGradient(gx, gy, 1, gx, gy, h * 0.55);
    g.addColorStop(0, `rgba(255,40,40,${0.55 * glow})`);
    g.addColorStop(1, 'rgba(255,40,40,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(gx, gy, h * 0.55, 0, Math.PI * 2); ctx.fill();
  }
  if (opts.brake) {
    ctx.fillStyle = '#ff2a2a';
    ctx.fillRect(-hw * 0.98, wy - wr * 0.3, 7, wr * 0.75);
    ctx.fillStyle = '#ffd0d0';
    ctx.fillRect(-hw * 0.98 + 2, wy - wr * 0.18, 3, wr * 0.4);
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
