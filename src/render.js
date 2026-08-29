// Canvas renderer. Reads the World and draws the whole scene + HUD.
// The world is in logical units (height = WORLD.height); `view.scale` maps to device px.
import { COMPOUNDS, ERS, PLAYER, SPEED } from './config.js';
import { clamp, formatDistance, formatTime, lerp } from './logic.js';

const FONT = '"Segoe UI", system-ui, Roboto, sans-serif';
const MONO = '"Cascadia Mono", Consolas, "Roboto Mono", monospace';

export class Renderer {
  constructor(canvas, assets) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.assets = assets;
    this.view = { width: 1280, height: 720, scale: 1 };
    this.time = 0;
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
    this.drawBackdrop(world, W, H);
    this.drawPitLane(world, W);
    this.drawTrack(world, W);
    this.drawGrassBottom(world, W, H);
    for (const hz of world.hazards) if (hz.type === 'oil' || hz.type === 'drs') this.drawHazard(hz, world);
    this.drawParticles(world, ['spray', 'smoke']);
    for (const hz of world.hazards) if (hz.type !== 'oil' && hz.type !== 'drs') this.drawHazard(hz, world);
    this.drawPlayer(world);
    this.drawParticles(world, ['flame', 'spark']);
    this.drawWeather(world, W, H);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (hud) this.drawHud(world, hud, W, H);
  }

  // ---------- scenery ----------
  drawBackdrop(world, W, H) {
    const { ctx } = this;
    const dusk = clamp(world.elapsed / 240, 0, 1); // the sky slowly turns to evening
    const sky = ctx.createLinearGradient(0, 0, 0, world.pitTop);
    sky.addColorStop(0, lerpColor('#8fc7ff', '#1b1d4a', dusk));
    sky.addColorStop(1, lerpColor('#d9ecff', '#7a3b6a', dusk));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, world.pitTop);
    // grandstand: repeating blocks with a crowd noise texture
    const gsTop = world.pitTop * 0.42;
    const gsH = world.pitTop - gsTop;
    const off = (world.scroll * 0.25) % 220;
    for (let x = -off - 220; x < W + 220; x += 220) {
      ctx.fillStyle = '#2b2f3a';
      ctx.fillRect(x, gsTop, 214, gsH);
      ctx.fillStyle = '#3c4150';
      ctx.fillRect(x, gsTop, 214, 8);
      // crowd dots
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 22; c++) {
          const seed = ((x / 220) * 97 + r * 13 + c * 7) | 0;
          const hue = (seed * 47) % 360;
          ctx.fillStyle = `hsl(${hue} 35% ${30 + (seed % 3) * 7}%)`;
          ctx.fillRect(x + 6 + c * 9.4, gsTop + 14 + r * ((gsH - 18) / 4), 5, 6);
        }
      }
      // red banner
      ctx.fillStyle = '#c8102e';
      ctx.fillRect(x, world.pitTop - 10, 214, 10);
    }
  }

  drawPitLane(world, W) {
    const { ctx } = this;
    const top = world.pitTop;
    const bottom = world.pitBottom;
    ctx.fillStyle = '#4f535c';
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
      ctx.fillStyle = '#23252b';
      ctx.fillRect(x + 8, top + 12, garageW - 24, 10);
    }
    // pit box marks
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    for (let x = -(world.scroll % 130); x < W; x += 130) {
      ctx.strokeRect(x, top + 26, 110, bottom - top - 32);
    }
    // stationary car indicator when stopped: mechanics
    if (world.pit.inLane && world.pit.phase === 'stop') {
      const p = world.player;
      // mechanics crouched at each wheel
      for (const [dx, dy] of [[-58, -26], [-58, 26], [54, -26], [54, 26]]) {
        ctx.fillStyle = '#e10600';
        ctx.beginPath(); ctx.arc(p.x + dx, p.y + dy, 9, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffd400';
        ctx.beginPath(); ctx.arc(p.x + dx, p.y + dy - 3, 4, 0, Math.PI * 2); ctx.fill();
      }
      if (world.pit.slow) {
        ctx.fillStyle = '#fff';
        ctx.font = `bold 14px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText('WHEEL GUN PROBLEM', p.x, p.y - 40 + Math.sin(this.time * 20) * 2);
      }
    }
    // pit wall between lane and track, with the entry gap when open
    const wallTop = bottom;
    const wallH = world.trackTop - bottom;
    ctx.fillStyle = '#9aa0ad';
    ctx.fillRect(0, wallTop, W, wallH);
    ctx.fillStyle = '#e6e8ee';
    ctx.fillRect(0, wallTop, W, 3);
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
    ctx.fillStyle = lerpColor('#3a3d44', '#23262d', wet);
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
    // kerbs
    this.drawKerb(top - 12, W, world.scroll);
    this.drawKerb(bottom, W, world.scroll);
    // DRS activation line and sector boards flash past
    const boardX = W - ((world.scroll * 1) % (W + 1400));
    ctx.fillStyle = '#fff';
    ctx.fillRect(boardX, top, 4, bottom - top);
  }
  drawKerb(y, W, scroll) {
    const { ctx } = this;
    const off = scroll % 64;
    for (let x = -off - 64; x < W + 64; x += 64) ctx.drawImage(this.kerb, x, y, 64, 12);
  }

  drawGrassBottom(world, W, H) {
    const { ctx } = this;
    const top = world.trackBottom + 12;
    ctx.fillStyle = '#2f7d32';
    ctx.fillRect(0, top, W, H - top);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let x = -(world.scroll * 0.9 % 160); x < W; x += 160) ctx.fillRect(x, top, 80, H - top);
    // gravel strip
    ctx.fillStyle = '#b9a77a';
    ctx.fillRect(0, top, W, 10);
    // ad boards
    const boards = ['RAWE CEEK', 'PIRELLI', 'BOX BOX', 'PLAN C', 'WE ARE CHECKING', 'DRS', 'SO NOT RIGHT', 'PUSHING'];
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

  // ---------- entities ----------
  drawPlayer(world) {
    const { ctx } = this;
    const p = world.player;
    const { sheet, frames } = this.assets;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.tilt + p.angle);
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
    // damage sparks flag
    if (p.damage > 0) {
      ctx.fillStyle = '#222';
      ctx.fillRect(PLAYER.width * 0.35, -PLAYER.height * 0.25, 10, 4);
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
        drawVectorCar(ctx, hz.w, hz.h, hz.team, hz.frame);
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
        ctx.strokeStyle = 'rgba(150,120,255,0.35)';
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
    ctx.fillStyle = c.color;
    ctx.font = `bold 18px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(c.short, 0, 1);
    ctx.restore();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText(world.tyre.punctured ? 'PUNCTURE' : c.label, tx + 80, H - 88);
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
      ctx.fillText(world.pit.phase === 'stop' ? `IN THE BOX ${world.pit.timer.toFixed(1)}s` : 'PIT LANE', tx + tw - 12, H - 104);
    } else if (world.pit.open) {
      ctx.fillStyle = '#2ecc71';
      ctx.fillText('PIT OPEN — hold ▲', tx + tw - 12, H - 104);
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
    ctx.fillText(`P${Math.max(1, 20 - world.overtakes)}`, pad + 286, pad + 26);
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = '#c9ced9';
    ctx.fillText(`${world.overtakes} overtakes`, pad + 286, pad + 42);
    ctx.fillText(`${world.closeCalls} close calls`, pad + 286, pad + 56);

    // weather + flags (top right)
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(8,10,16,0.82)';
    roundRect(ctx, W - pad - 190, pad, 190, 40, 10);
    ctx.fill();
    ctx.font = `bold 14px ${FONT}`;
    ctx.fillStyle = world.raining ? '#7fb2ff' : '#ffd400';
    ctx.fillText(world.raining ? '🌧 RAIN' : world.rain > 0.1 ? '☁ DRYING' : '☀ DRY', W - pad - 12, pad + 26);
    ctx.fillStyle = hud.musicOn ? '#c9ced9' : '#666';
    ctx.font = `11px ${FONT}`;
    ctx.fillText(hud.musicOn ? '♪ on (M)' : '♪ off (M)', W - pad - 100, pad + 26);

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
      ctx.globalAlpha = 1;
    }

    // controls hint for the first seconds
    if (world.elapsed < 8 && !world.gameOver) {
      ctx.globalAlpha = clamp(1 - (world.elapsed - 6) / 2, 0, 1) * 0.9;
      ctx.textAlign = 'center';
      ctx.font = `13px ${FONT}`;
      ctx.fillStyle = '#fff';
      ctx.fillText('▲▼ steer   ▶ push / ◀ lift   SPACE boost   ▲ into the green gap to pit', W / 2, world.trackBottom - 22);
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
  const pa = hex(a), pb = hex(b);
  const c = pa.map((v, i) => Math.round(lerp(v, pb[i], t)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function hex(h) {
  const s = h.replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((ch) => ch + ch).join('') : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Side-view F1 car facing right, drawn centred at the origin inside w×h. */
export function drawVectorCar(ctx, w, h, team, frame = 0) {
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
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(-hw * 0.92, wy + wr * 0.25, w * 0.95, wr * 0.2);
  // halo + helmet
  ctx.strokeStyle = '#111';
  ctx.lineWidth = Math.max(2, h * 0.06);
  ctx.beginPath();
  ctx.arc(-hw * 0.06, wy - wr * 0.9, hh * 0.42, Math.PI, 0);
  ctx.stroke();
  ctx.fillStyle = team.accent;
  ctx.beginPath();
  ctx.arc(-hw * 0.06, wy - wr * 0.95, hh * 0.26, 0, Math.PI * 2);
  ctx.fill();
  // rear wing
  ctx.fillStyle = '#111';
  ctx.fillRect(-hw, -hh * 0.75, w * 0.14, h * 0.13);
  ctx.fillRect(-hw * 0.9, -hh * 0.75, Math.max(2, w * 0.02), hh + wy * 0.2);
  // front wing
  ctx.fillRect(hw * 0.55, wy + wr * 0.35, w * 0.22, h * 0.12);
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
