'use strict';

// Fullscreen that works where it exists: unprefixed, older Safari's webkit
// prefix, or not at all (iPhone Safari can't make a page fullscreen).

(() => {
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;

  function current() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  // call an API that may return a promise, without letting failures escape
  function quietly(fn, target) {
    try {
      const result = fn.call(target);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    } catch (e) {
      // not allowed right now
    }
  }

  window.PageFullscreen = {
    supported: typeof request === 'function',
    active: () => current() !== null,
    enter() {
      if (this.supported && !current()) quietly(request, root);
    },
    exit() {
      if (exit && current()) quietly(exit, document);
    },
    toggle() {
      if (current()) this.exit(); else this.enter();
    },
  };
})();
