'use strict';

// Touch screen controls for the web build.
//
// While playing: a joystick that appears where the left thumb touches (move),
// dragging anywhere on the right (look), and buttons. The game reads their
// state every frame from Module.webTouch (see Web_GetTouchInput() in the engine);
// the joystick moves like an analog stick, the rest act like the keys and mouse
// of the default controls.
//
// In menus, NETRICSA and demos: taps and drags on the game are turned into the
// mouse, and the Esc button presses Escape.

(() => {
  // indices into webTouch.buttons, in the order of the engine's WebTouchButton
  // (the joystick sets webTouch.moveX/moveY instead of the movement buttons 0-3)
  const JUMP = 4, CROUCH = 5, FIRE = 6, USE = 7;
  const KEY_ESCAPE = 27;

  // how far (in CSS pixels) the joystick moves, and the part of that which doesn't move the player
  const STICK_RADIUS = 56;
  const STICK_DEAD = 0.15;
  // look speed relative to mouse movement
  const LOOK_SPEED = 1.6;
  // the menus react to the mouse a frame after it moves, so clicks are delayed a bit
  const CLICK_DELAY_MS = 60;

  function element(tag, className, parent, text) {
    const el = document.createElement(tag);
    el.className = className;
    if (text) el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  // follow pointers from pointerdown until they are released; reset() forgets them
  // (a hidden element may never get its pointerup)
  function trackPointer(el, { down, move, up }) {
    const active = new Map();  // pointerId -> last position
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (down) down(e);
    });
    el.addEventListener('pointermove', (e) => {
      const last = active.get(e.pointerId);
      if (!last) return;
      if (move) move(e, e.clientX - last.x, e.clientY - last.y);
      last.x = e.clientX;
      last.y = e.clientY;
    });
    const end = (e) => {
      if (!active.delete(e.pointerId)) return;
      if (up) up(e);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    return { reset: () => active.clear() };
  }

  // a box listing what the controls receive, for finding problems on devices (?touchdebug)
  function createDebugView(container, state) {
    const box = element('pre', 'tc-debug', container);
    const events = [];
    let lookX = 0, lookY = 0;
    const note = (text) => {
      events.push(text);
      if (events.length > 8) events.shift();
    };
    const describe = (e) => `${e.type} ${e.pointerType || ''} ${(e.target.className || e.target.id || e.target.tagName)}`.trim();
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel', 'contextmenu']) {
      window.addEventListener(type, (e) => note(describe(e)), { capture: true, passive: true });
    }
    window.addEventListener('error', (e) => note(`error: ${e.message}`));
    const update = () => {
      lookX += state.lookX;
      lookY += state.lookY;
      box.textContent = [
        `playing: ${Module.webGameInput}  buttons: ${Array.from(state.buttons).join('')}  move: ${state.moveX.toFixed(2)}, ${state.moveY.toFixed(2)}`,
        `look total: ${lookX.toFixed(0)}, ${lookY.toFixed(0)}  (pending ${state.lookX.toFixed(0)}, ${state.lookY.toFixed(0)})`,
        ...events,
      ].join('\n');
      requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  }

  function create(Module, canvas, container, { debug = false } = {}) {
    const state = { buttons: new Uint8Array(8), lookX: 0, lookY: 0, wheel: 0, moveX: 0, moveY: 0 };
    Module.webTouch = state;
    Module.webKeyPresses = Module.webKeyPresses || [];

    const root = element('div', 'touch-controls menu-mode', container);

    // the browser must not turn touches into its own gestures: a long press would
    // open a context menu or select text, and cancel the touch
    for (const type of ['contextmenu', 'selectstart', 'gesturestart']) {
      document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }
    root.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    root.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    const look = element('div', 'tc-zone tc-look', root);
    const moveZone = element('div', 'tc-zone tc-move', root);
    const stickBase = element('div', 'tc-stick-base', root);
    const stickKnob = element('div', 'tc-stick-knob', stickBase);
    element('div', 'tc-rotate', root, 'Turn your device sideways to play');

    const aim = (e, dx, dy) => {
      state.lookX += dx * LOOK_SPEED;
      state.lookY += dy * LOOK_SPEED;
    };

    // moving: an analog stick that appears under the thumb, and stays where the thumb first
    // touched until it lets go
    let stickOrigin = null;
    const releaseStick = () => {
      stickOrigin = null;
      stickBase.classList.remove('active');
      state.moveX = state.moveY = 0;
    };
    const placeStick = (x, y) => {
      stickOrigin = { x, y };
      stickBase.style.left = `${x}px`;
      stickBase.style.top = `${y}px`;
    };
    const moveTracker = trackPointer(moveZone, {
      down(e) {
        placeStick(e.clientX, e.clientY);
        stickBase.classList.add('active');
        stickKnob.style.transform = '';
      },
      move(e) {
        if (!stickOrigin) return;
        let dx = e.clientX - stickOrigin.x;
        let dy = e.clientY - stickOrigin.y;
        const len = Math.hypot(dx, dy);
        if (len > STICK_RADIUS) {
          // (the knob stops at the rim)
          dx *= STICK_RADIUS / len;
          dy *= STICK_RADIUS / len;
        }
        stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
        // full speed at the rim, nothing in the middle
        const r = Math.min(len, STICK_RADIUS) / STICK_RADIUS;
        const speed = r <= STICK_DEAD ? 0 : (r - STICK_DEAD) / (1 - STICK_DEAD);
        const n = len > 0 ? speed / Math.hypot(dx, dy) : 0;
        state.moveX = dx * n;
        state.moveY = dy * n;
      },
      up: releaseStick,
    });

    // looking around
    const trackers = [moveTracker, trackPointer(look, { move: aim })];

    // buttons held down; the fire button can also be dragged to aim while shooting
    function holdButton(className, label, index, aims) {
      const el = element('div', `tc-button ${className}`, root, label);
      trackers.push(trackPointer(el, {
        down() { state.buttons[index] = 1; el.classList.add('pressed'); },
        move: aims ? aim : null,
        up() { state.buttons[index] = 0; el.classList.remove('pressed'); },
      }));
      return el;
    }
    holdButton('tc-fire', 'Fire', FIRE, true);
    holdButton('tc-jump', 'Jump', JUMP, false);
    holdButton('tc-crouch', 'Duck', CROUCH, false);
    holdButton('tc-use', 'Use', USE, false);

    // buttons that do one thing per tap
    function tapButton(className, label, action) {
      const el = element('div', `tc-button ${className}`, root, label);
      trackers.push(trackPointer(el, {
        down() { el.classList.add('pressed'); action(); },
        up() { el.classList.remove('pressed'); },
      }));
      return el;
    }
    tapButton('tc-escape', 'Esc', () => Module.webKeyPresses.push(KEY_ESCAPE));
    // (fullscreen.js may have been blocked, see main.js)
    if (window.PageFullscreen && PageFullscreen.supported) {
      tapButton('tc-fullscreen', '\u26F6', () => PageFullscreen.toggle());
    }
    tapButton('tc-weapon-prev', '▲', () => { state.wheel += 1; });
    tapButton('tc-weapon-next', '▼', () => { state.wheel -= 1; });

    // the game tells when it is being played; otherwise touches on the game are the mouse
    let playing = false;
    Module.onWebGameInput = (gameInput) => {
      if (gameInput === playing) return;
      playing = gameInput;
      root.classList.toggle('menu-mode', !gameInput);
      // whatever was held belongs to the other mode now
      finishMouseTouch(true);
      state.buttons.fill(0);
      releaseStick();
      for (const tracker of trackers) tracker.reset();
      for (const el of root.querySelectorAll('.pressed')) el.classList.remove('pressed');
    };

    function mouseEvent(type, touch) {
      canvas.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window, button: 0, buttons: type === 'mouseup' ? 0 : 1,
        clientX: touch.clientX, clientY: touch.clientY, screenX: touch.screenX, screenY: touch.screenY,
      }));
    }
    // one touch acts as the mouse: move there, then press the button a little later
    let mouseTouch = null;
    // the touch acting as the mouse has ended: release the button (or click, if it wasn't
    // pressed yet); when cancelling, a click that is still to come is dropped
    function finishMouseTouch(cancel = false) {
      if (!mouseTouch) return;
      const t = mouseTouch;
      mouseTouch = null;
      t.released = true;
      t.cancelled = cancel && !t.pressed;
      if (t.pressed) mouseEvent('mouseup', t.last);
    }
    function onCanvasTouch(e) {
      if (e.target !== canvas) return;
      // keep the browser (scrolling, zooming) and SDL's own touch handling out of it
      e.preventDefault();
      e.stopImmediatePropagation();
      const touch = e.changedTouches[0];
      if (e.type === 'touchstart') {
        if (playing) return;
        // a touch whose end was never seen must not block the mouse forever
        if (mouseTouch && ![...e.touches].some((t) => t.identifier === mouseTouch.id)) {
          finishMouseTouch(true);
        }
        if (mouseTouch) return;
        mouseTouch = { id: touch.identifier, pressed: false, released: false, last: touch };
        mouseEvent('mousemove', touch);
        const t = mouseTouch;
        setTimeout(() => {
          if (t.cancelled) return;
          t.pressed = true;
          mouseEvent('mousedown', t.last);
          if (t.released) setTimeout(() => mouseEvent('mouseup', t.last), CLICK_DELAY_MS);
        }, CLICK_DELAY_MS);
        return;
      }
      // (a tap that starts the game ends while playing: it must still release the mouse)
      if (!mouseTouch || touch.identifier !== mouseTouch.id) return;
      mouseTouch.last = touch;
      if (e.type === 'touchmove') {
        if (!playing) mouseEvent('mousemove', touch);
      } else {
        finishMouseTouch();
      }
    }
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      window.addEventListener(type, onCanvasTouch, { capture: true, passive: false });
    }

    if (debug) {
      createDebugView(container, state);
    }
    return root;
  }

  // touch controls are used when chosen on the page, or automatically on touch screens
  function wanted(mode) {
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;
  }

  window.TouchControls = { create, wanted };
})();
