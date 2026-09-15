// Keyboard + pointer + touch-pad input. Exposes a polled state object and an event
// emitter for one-shot actions (pause, start, compound select...).

/** True on phones and tablets: a coarse pointer with no hover. `?touch=1|0` in the URL forces it either way. */
export function detectTouch() {
  try {
    const q = new URLSearchParams(location.search).get('touch');
    if (q === '1' || q === 'on') return true;
    if (q === '0' || q === 'off') return false;
    const coarse = matchMedia('(pointer: coarse)').matches;
    const noHover = matchMedia('(hover: none)').matches;
    return (coarse && noHover) || (coarse && navigator.maxTouchPoints > 1);
  } catch {
    return false;
  }
}

export class Input {
  constructor(canvas) {
    this.state = { up: false, down: false, left: false, right: false, boost: false };
    // held state from the on-screen touch pad; OR-ed with the keyboard in `held`
    this.pad = { up: false, down: false, left: false, right: false, boost: false };
    // y0 = where the steering finger came down (0..1 of the canvas), y = where it is now
    this.pointer = { active: false, id: null, y: null, y0: null, boost: false };
    this.handlers = new Map();
    this.canvas = canvas;

    const keyMap = {
      ArrowUp: 'up', KeyW: 'up',
      ArrowDown: 'down', KeyS: 'down',
      ArrowLeft: 'left', KeyA: 'left',
      ArrowRight: 'right', KeyD: 'right',
      Space: 'boost', ShiftLeft: 'boost', ShiftRight: 'boost',
    };
    window.addEventListener('keydown', (e) => {
      if (e.target && /^(INPUT|TEXTAREA|BUTTON)$/.test(e.target.tagName) && e.code !== 'Escape') return;
      const k = keyMap[e.code];
      if (k) { this.state[k] = true; e.preventDefault(); }
      if (e.repeat) return;
      // one-shot "fire" for the pit-stop mini-game (boost keys double up as the wheel gun)
      if (k === 'boost' || e.code === 'KeyB') this.emit('action');
      // left / right also step through menus (the car picker on the title screen)
      if (k === 'left') this.emit('nav', -1);
      if (k === 'right') this.emit('nav', 1);
      switch (e.code) {
        case 'KeyP': case 'Escape': this.emit('pause'); break;
        case 'Enter': this.emit('confirm'); break;
        case 'KeyR': this.emit('restart'); break;
        case 'KeyM': this.emit('music'); break;
        case 'KeyB': this.emit('pit'); break;
        case 'KeyT': this.emit('track'); break;
        case 'KeyN': this.emit('sfx'); break;
        case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5':
          this.emit('compound', Number(e.code.slice(-1)) - 1); break;
        case 'Tab': this.emit('compound-next'); e.preventDefault(); break;
        default: break;
      }
    });
    window.addEventListener('keyup', (e) => {
      const k = keyMap[e.code];
      if (k) this.state[k] = false;
    });
    window.addEventListener('blur', () => this.clear());

    // Pointer: drag anywhere to steer vertically; touching the right quarter also boosts.
    // Only the first finger down steers, so a second thumb on the pad never yanks the car.
    const onPointer = (e) => {
      if (e.pointerType === 'mouse' && e.buttons === 0) return;
      if (this.pointer.active && e.pointerId !== this.pointer.id) return;
      const rect = canvas.getBoundingClientRect();
      const y = (e.clientY - rect.top) / rect.height;
      if (!this.pointer.active) { this.pointer.id = e.pointerId; this.pointer.y0 = y; }
      this.pointer.active = true;
      this.pointer.y = y;
      this.pointer.boost = e.clientX - rect.left > rect.width * 0.75;
    };
    canvas.addEventListener('pointerdown', (e) => {
      const first = !this.pointer.active;
      onPointer(e);
      if (first) this.emit('steer-start');
      this.emit('tap');
    });
    canvas.addEventListener('pointermove', onPointer);
    const off = (e) => {
      if (e && e.pointerId !== this.pointer.id) return;
      this.pointer.active = false; this.pointer.id = null; this.pointer.y = null; this.pointer.y0 = null; this.pointer.boost = false;
    };
    canvas.addEventListener('pointerup', off);
    canvas.addEventListener('pointercancel', off);
    canvas.addEventListener('pointerleave', off);
    window.addEventListener('blur', () => off());
  }

  /** Keyboard state OR-ed with the touch pad, in the shape the world polls. */
  get held() {
    const s = this.state, p = this.pad;
    return { up: s.up || p.up, down: s.down || p.down, left: s.left || p.left, right: s.right || p.right, boost: s.boost || p.boost };
  }

  /**
   * Wires a touch-pad button. `hold` names a pad axis held while the finger is down;
   * `press` is an event emitted on every press (and `payload` goes with it). Fingers
   * that slide off are released, and a second finger on the same button is ignored.
   */
  bindPadButton(el, { hold = null, press = null, payload } = {}) {
    let id = null;
    const down = (e) => {
      if (id !== null) return;
      id = e.pointerId;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* not all browsers */ }
      el.classList.add('held');
      if (hold) this.pad[hold] = true;
      if (press) this.emit(press, payload);
    };
    const up = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      el.classList.remove('held');
      if (hold) this.pad[hold] = false;
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('click', (e) => e.preventDefault());
  }

  clear() {
    for (const k of Object.keys(this.state)) this.state[k] = false;
    for (const k of Object.keys(this.pad)) this.pad[k] = false;
  }
  on(evt, fn) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, []);
    this.handlers.get(evt).push(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) {
    const list = this.handlers.get(evt);
    if (list) this.handlers.set(evt, list.filter((f) => f !== fn));
  }
  emit(evt, payload) {
    for (const fn of this.handlers.get(evt) || []) fn(payload);
  }
}
