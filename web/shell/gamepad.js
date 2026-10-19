'use strict';

// Gamepads for the web build, with the browser's Gamepad API.
//
// The game polls the pad once per frame (Web_PollGamepad() in the engine calls poll()).
// While playing, the pad's state goes to Module.webPad, which the engine reads as a fixed
// layout like the console version's (see CControls::CreateAction()): the left stick moves,
// the right stick looks, the buttons are the controls' actions. Start opens the menu.
//
// In menus, the console, NETRICSA and demos the pad presses keys: the D-pad or the left
// stick the arrows, A Enter, B Escape, LB/RB Page Up/Down. The right stick moves the mouse,
// and RT/LT click with its left/right button.
//
// A pad shows up only once a button on it is pressed (browsers hide pads until then).

(() => {
  // buttons in the browser's standard mapping (the same order as the engine's WebPadButton)
  const A = 0, B = 1, LB = 4, RB = 5, LT = 6, RT = 7, BACK = 8, START = 9;
  const UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;
  // SDL key codes, as the engine takes them from Module.webKeyPresses
  const KEY = {
    escape: 27, enter: 13,
    up: 1073741906, down: 1073741905, left: 1073741904, right: 1073741903,
    pageUp: 1073741899, pageDown: 1073741902,
  };
  // the part of a stick's travel that does nothing (worn sticks don't center exactly)
  const DEAD_ZONE = 0.15;
  // how far a trigger is pulled to count as pressed
  const TRIGGER_PRESSED = 0.3;
  // the left stick as arrow keys: how far it is pushed, and how keys held down repeat
  const STICK_KEY = 0.5;
  const REPEAT_DELAY_MS = 400;
  const REPEAT_MS = 120;
  // how fast the right stick moves the mouse in menus (CSS pixels per second at full tilt)
  const MOUSE_SPEED = 900;

  let lastButtons = 0;
  // buttons held when the game went from menus to playing or back: they do nothing until
  // released (the A that started the game must not also jump)
  let ignored = 0;
  let wasPlaying = null;
  // the direction held in menus, when its key was pressed last, and whether it repeats yet
  let heldDirection = null;
  let directionTime = 0;
  let repeating = false;
  // the mouse moved by the right stick (in client coordinates), and when it last moved
  let mouse = null;
  let lastPollTime = 0;

  // the first pad in the standard layout, else the first one that could be
  function findPad() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((p) => p && p.connected) : [];
    return pads.find((p) => p.mapping === 'standard')
      || pads.find((p) => p.axes.length >= 4 && p.buttons.length >= 10) || null;
  }

  function buttonBits(pad) {
    let bits = 0;
    pad.buttons.forEach((button, i) => {
      if (i >= 16) return;
      const down = (i === LT || i === RT) ? button.pressed || button.value > TRIGGER_PRESSED : button.pressed;
      if (down) bits |= 1 << i;
    });
    return bits >>> 0;
  }

  // a stick with the dead zone taken out: x and y -1..1, 0 in the middle
  function stick(x, y) {
    const length = Math.hypot(x, y);
    if (length <= DEAD_ZONE) return [0, 0];
    const scale = Math.min(1, (length - DEAD_ZONE) / (1 - DEAD_ZONE)) / length;
    return [x * scale, y * scale];
  }

  function pushKey(Module, key) {
    Module.webKeyPresses = Module.webKeyPresses || [];
    Module.webKeyPresses.push(key);
  }

  function mouseEvent(Module, type, button) {
    const canvas = Module.canvas;
    canvas.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window, button, buttons: type === 'mousedown' ? (button === 2 ? 2 : 1) : 0,
      clientX: mouse.x, clientY: mouse.y, screenX: mouse.x, screenY: mouse.y,
    }));
  }

  // the arrow key the D-pad or the left stick points to, if any
  function direction(bits, x, y) {
    if (bits & (1 << UP)) return 'up';
    if (bits & (1 << DOWN)) return 'down';
    if (bits & (1 << LEFT)) return 'left';
    if (bits & (1 << RIGHT)) return 'right';
    if (Math.max(Math.abs(x), Math.abs(y)) < STICK_KEY) return null;
    return Math.abs(x) > Math.abs(y) ? (x < 0 ? 'left' : 'right') : (y < 0 ? 'up' : 'down');
  }

  function pollMenus(Module, pad, bits, pressed, now, dt) {
    const [x, y] = stick(pad.axes[0], pad.axes[1]);
    const held = direction(bits & ~ignored, x, y);
    if (held !== heldDirection) {
      heldDirection = held;
      directionTime = now;
      repeating = false;
      if (held) pushKey(Module, KEY[held]);
    } else if (held && now - directionTime >= (repeating ? REPEAT_MS : REPEAT_DELAY_MS)) {
      directionTime = now;
      repeating = true;
      pushKey(Module, KEY[held]);
    }
    if (pressed & (1 << A)) pushKey(Module, KEY.enter);
    if (pressed & ((1 << B) | (1 << BACK) | (1 << START))) pushKey(Module, KEY.escape);
    if (pressed & (1 << LB)) pushKey(Module, KEY.pageUp);
    if (pressed & (1 << RB)) pushKey(Module, KEY.pageDown);

    // the mouse
    const [mx, my] = stick(pad.axes[2], pad.axes[3]);
    const rect = Module.canvas.getBoundingClientRect();
    if (mx || my) {
      if (!mouse) mouse = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const speed = MOUSE_SPEED * dt / 1000;
      mouse.x = Math.min(rect.right - 1, Math.max(rect.left, mouse.x + mx * Math.abs(mx) * speed));
      mouse.y = Math.min(rect.bottom - 1, Math.max(rect.top, mouse.y + my * Math.abs(my) * speed));
      mouseEvent(Module, 'mousemove', 0);
    }
    if (mouse) {
      const released = lastButtons & ~bits;
      for (const [index, button] of [[RT, 0], [LT, 2]]) {
        if (pressed & (1 << index)) mouseEvent(Module, 'mousedown', button);
        if (released & (1 << index)) mouseEvent(Module, 'mouseup', button);
      }
    }
  }

  function poll(Module, playing) {
    const now = performance.now();
    const dt = lastPollTime ? Math.min(100, now - lastPollTime) : 0;
    lastPollTime = now;
    const pad = findPad();
    Module.webPadConnected = !!pad;
    if (!pad) {
      Module.webPad = null;
      lastButtons = ignored = 0;
      heldDirection = null;
      return;
    }
    const bits = buttonBits(pad);
    if (playing !== wasPlaying) {
      ignored = bits;
      heldDirection = null;
      wasPlaying = playing;
    }
    ignored &= bits;
    const pressed = bits & ~lastButtons & ~ignored;

    if (playing) {
      const [moveX, moveY] = stick(pad.axes[0], pad.axes[1]);
      const [lookX, lookY] = stick(pad.axes[2], pad.axes[3]);
      Module.webPad = { buttons: (bits & ~ignored) >>> 0, moveX, moveY, lookX, lookY };
      if (pressed & (1 << START)) pushKey(Module, KEY.escape);
    } else {
      Module.webPad = null;
      pollMenus(Module, pad, bits, pressed, now, dt);
    }
    lastButtons = bits;
  }

  // whether a pad is there, and tell when one comes or goes (for the start page)
  const connected = () => !!findPad();
  const listeners = [];
  const onChange = (fn) => listeners.push(fn);
  for (const type of ['gamepadconnected', 'gamepaddisconnected']) {
    window.addEventListener(type, () => {
      if (window.Module) Module.webPadConnected = connected();
      for (const fn of listeners) fn(connected());
    });
  }

  window.GamePad = { poll, connected, onChange };
})();
