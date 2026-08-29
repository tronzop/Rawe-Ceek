// Keyboard + pointer input. Exposes a polled state object and an event emitter
// for one-shot actions (pause, start, compound select...).

export class Input {
  constructor(canvas) {
    this.state = { up: false, down: false, left: false, right: false, boost: false };
    this.pointer = { active: false, y: null, boost: false };
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
      switch (e.code) {
        case 'KeyP': case 'Escape': this.emit('pause'); break;
        case 'Enter': this.emit('confirm'); break;
        case 'KeyR': this.emit('restart'); break;
        case 'KeyM': this.emit('music'); break;
        case 'KeyB': this.emit('pit'); break;
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
    const onPointer = (e) => {
      if (e.pointerType === 'mouse' && e.buttons === 0) return;
      const rect = canvas.getBoundingClientRect();
      this.pointer.active = true;
      this.pointer.y = (e.clientY - rect.top) / rect.height;
      this.pointer.boost = e.clientX - rect.left > rect.width * 0.75;
    };
    canvas.addEventListener('pointerdown', (e) => { onPointer(e); this.emit('tap'); });
    canvas.addEventListener('pointermove', onPointer);
    const off = () => { this.pointer.active = false; this.pointer.y = null; this.pointer.boost = false; };
    canvas.addEventListener('pointerup', off);
    canvas.addEventListener('pointercancel', off);
    canvas.addEventListener('pointerleave', off);
  }

  clear() {
    for (const k of Object.keys(this.state)) this.state[k] = false;
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
