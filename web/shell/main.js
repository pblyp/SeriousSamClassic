'use strict';

// Page logic for the web build of Serious Sam: The First Encounter.
//
// Query parameters:
//   autostart  play the demo without waiting for clicks (for automated tests)
//   log        show the engine's console output on the page
//   args=...   extra command line, e.g. args=+level%20Levels/KarnakDemo.wld
//   exec=...   console commands to run after startup, e.g. exec=snd_iFormat=1;
//   build=jspi|asyncify  force a build instead of picking one by browser support
//   touch=auto|on|off    touch screen controls (otherwise as chosen on the page)
//   touchdebug           show what the touch controls receive

(() => {
  const params = new URLSearchParams(location.search);

  const canvas = document.getElementById('canvas');
  const overlay = document.getElementById('overlay');
  const chooseEl = document.getElementById('choose');
  const loadingEl = document.getElementById('loading');
  const statusEl = document.getElementById('status');
  const progressEl = document.getElementById('progress');
  const playDemoButton = document.getElementById('play-demo');
  const folderInput = document.getElementById('folder');
  const ownFilesLabel = document.getElementById('own-files');
  const startButton = document.getElementById('start');
  const fullscreenCheckbox = document.getElementById('fullscreen');
  const logEl = document.getElementById('log');
  const touchSelect = document.getElementById('touch-mode');
  const helpKeyboard = document.getElementById('help-keyboard');
  const helpTouch = document.getElementById('help-touch');

  const showLog = params.has('log');
  logEl.hidden = !showLog;

  // all engine output, also read by the automated tests
  const engineLog = [];
  window.engineLog = engineLog;

  function log(text) {
    engineLog.push(text);
    console.log(text);
    if (showLog) {
      logEl.textContent += text + '\n';
      if (logEl.textContent.length > 200000) {
        logEl.textContent = logEl.textContent.slice(-100000);
      }
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function setStatus(text, progress) {
    statusEl.textContent = text;
    if (progress !== undefined) {
      progressEl.hidden = false;
      progressEl.value = progress;
    }
  }

  function showError(text) {
    PageFullscreen.exit();
    overlay.hidden = false;
    chooseEl.hidden = true;
    loadingEl.hidden = false;
    progressEl.hidden = true;
    startButton.hidden = true;
    setStatus(text);
  }

  // JSPI lets the engine yield to the browser cheaply; other browsers get the Asyncify build
  function pickBuild() {
    const forced = params.get('build');
    if (forced === 'jspi' || forced === 'asyncify') {
      return forced;
    }
    return (typeof WebAssembly.Suspending === 'function') ? 'jspi' : 'asyncify';
  }

  // ---------------------------------------------------------------- touch controls

  // options are remembered in this browser (storage may be unavailable, e.g. in private windows)
  function loadOption(name) {
    try {
      return localStorage.getItem(name);
    } catch (e) {
      return null;
    }
  }
  function saveOption(name, value) {
    try {
      localStorage.setItem(name, value);
    } catch (e) {
      // not remembered, fine
    }
  }

  function loadTouchMode() {
    const forced = params.get('touch');
    if (forced === 'on' || forced === 'off' || forced === 'auto') {
      return forced;
    }
    return loadOption('touchControls') || 'auto';
  }

  function updateTouchHelp() {
    const touch = TouchControls.wanted(touchSelect.value);
    helpKeyboard.hidden = touch;
    helpTouch.hidden = !touch;
  }

  touchSelect.value = loadTouchMode();
  updateTouchHelp();
  touchSelect.addEventListener('change', () => {
    saveOption('touchControls', touchSelect.value);
    updateTouchHelp();
  });

  // fullscreen when starting; by default on touch screens, where the browser's bars take a lot of room
  const savedFullscreen = loadOption('fullscreen');
  fullscreenCheckbox.checked = savedFullscreen !== null
    ? savedFullscreen === 'true'
    : TouchControls.wanted('auto');
  fullscreenCheckbox.addEventListener('change', () => saveOption('fullscreen', fullscreenCheckbox.checked));
  document.getElementById('fullscreen-option').hidden = !PageFullscreen.supported;

  // ---------------------------------------------------------------- player's files

  // files of the player's installation: [{ path: 'Levels/...', file: File }]
  let userFiles = null;

  // things in an installation the web version doesn't need
  function isNeeded(path) {
    const lower = path.toLowerCase();
    return !/^(bin|tools\.win32|temp|savegame|players|help)\//.test(lower)
      && !/\.(exe|dll|ex_|cab|hdr|bin|log)$/.test(lower)
      // the engine needs this repository's video settings
      && !lower.startsWith('scripts/glsettings/');
  }

  // find the installation's directory (the one with the .gro files) and make paths relative to it
  function selectGameFiles(entries) {
    let root = null;
    for (const { path } of entries) {
      if (/\.gro$/i.test(path)) {
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
        if (root === null || dir.length < root.length) {
          root = dir;
        }
      }
    }
    if (root === null) {
      throw new Error('No game files (*.gro) were found in that folder.');
    }
    const files = entries
      .filter(({ path }) => path.startsWith(root))
      .map(({ path, file }) => ({ path: path.slice(root.length), file }))
      .filter(({ path }) => isNeeded(path));
    const groups = files.filter(({ path }) => /^[^/]+\.gro$/i.test(path)).map(({ path }) => path.toLowerCase());
    if (!groups.some((name) => name.startsWith('1_00c'))) {
      if (groups.some((name) => name.startsWith('se1_00'))) {
        throw new Error('That is The Second Encounter. This page plays The First Encounter.');
      }
      throw new Error('That folder doesn\'t look like a Serious Sam: The First Encounter installation.');
    }
    return files;
  }

  // read the files of a dropped folder
  async function entriesFromDrop(dataTransfer) {
    const entries = [];
    async function walk(entry) {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        entries.push({ path: entry.fullPath.replace(/^\//, ''), file });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (batch.length === 0) {
            break;
          }
          for (const child of batch) {
            await walk(child);
          }
        }
      }
    }
    const roots = [...dataTransfer.items].map((item) => item.webkitGetAsEntry()).filter((e) => e);
    for (const entry of roots) {
      await walk(entry);
    }
    return entries;
  }

  // copy the player's files into the game's file system, over the base files
  async function writeUserFiles() {
    const FS = Module.FS;
    const totalBytes = userFiles.reduce((sum, { file }) => sum + file.size, 0);
    let doneBytes = 0;
    for (const { path, file } of userFiles) {
      setStatus(`Reading your game files… ${Math.round(100 * doneBytes / totalBytes)}%`, doneBytes / totalBytes);
      const fullPath = `/data/${path}`;
      FS.mkdirTree(fullPath.slice(0, fullPath.lastIndexOf('/')));
      FS.writeFile(fullPath, new Uint8Array(await file.arrayBuffer()));
      doneBytes += file.size;
    }
    log(`Copied ${userFiles.length} game files (${Math.round(totalBytes / 1048576)} MB)`);
  }

  // ---------------------------------------------------------------- engine

  // the engine keeps settings, saved games and controls in /user, persisted in IndexedDB
  function mountUserDir() {
    const FS = Module.FS;
    FS.mkdir('/user');
    FS.mount(Module.IDBFS, { autoPersist: true }, '/user');
    Module.addRunDependency('syncfs');
    FS.syncfs(true, (err) => {
      if (err) {
        log(`Cannot load saved data: ${err}`);
      }
      Module.removeRunDependency('syncfs');
    });
  }

  function engineArguments() {
    const args = params.get('args');
    const list = args ? args.split(' ').filter((a) => a !== '') : [];
    // console commands are run from a script file
    const commands = params.get('exec');
    if (commands) {
      Module.FS.writeFile('/data/Scripts/WebExec.ini', commands + '\n');
      list.push('+script', 'Scripts/WebExec.ini');
    }
    return list;
  }

  let started = false;

  function start() {
    if (started) {
      return;
    }
    started = true;
    overlay.hidden = true;
    // (the browser only allows this while handling a click)
    if (fullscreenCheckbox.checked && !params.has('autostart')) {
      PageFullscreen.enter();
    }
    if (TouchControls.wanted(touchSelect.value)) {
      document.documentElement.classList.add('touch');
      TouchControls.create(Module, canvas, document.getElementById('game'), { debug: params.has('touchdebug') });
      log('Touch controls on');
    }
    canvas.focus();
    const args = engineArguments();
    log(`Starting with arguments: ${args.join(' ')}`);
    try {
      Module.callMain(args);
    } catch (e) {
      // the engine exiting is reported through onExit
      if (!(e instanceof Module.ExitStatus) && e !== 'unwind') {
        throw e;
      }
    }
  }

  async function ready() {
    try {
      if (userFiles) {
        await writeUserFiles();
      }
    } catch (e) {
      showError(`Cannot read your game files: ${e.message}`);
      return;
    }
    setStatus('Ready', 1);
    if (params.has('autostart')) {
      start();
      return;
    }
    // starting needs a click, browsers only allow sound after one
    startButton.hidden = false;
    startButton.focus();
  }

  window.Module = {
    canvas,
    print: log,
    printErr: log,
    preRun: [mountUserDir],
    locateFile(path, prefix) {
      return prefix + path;
    },
    setStatus(text) {
      // "Downloading data... (123/456)"
      const m = text.match(/\((\d+(?:\.\d+)?)\/(\d+)\)/);
      if (m) {
        const fraction = Number(m[1]) / Number(m[2]);
        setStatus(`Downloading game data… ${Math.round(fraction * 100)}%`, fraction);
      } else if (text) {
        setStatus(text);
      }
    },
    onRuntimeInitialized() {
      ready();
    },
    onExit() {
      // a fatal error is printed to the console before the game exits
      const iError = engineLog.lastIndexOf('FatalError:');
      if (iError >= 0) {
        showError(`The game stopped: ${engineLog.slice(iError + 1).join(' ')}`);
      } else {
        showError('Thanks for playing! Reload the page to play again.');
      }
    },
    onAbort(what) {
      showError(`The game crashed: ${what}`);
    },
  };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Cannot load ${src}`));
      document.body.appendChild(script);
    });
  }

  let loading = false;

  // load a data package and the engine
  async function load(dataScript) {
    if (loading) {
      return;
    }
    loading = true;
    chooseEl.hidden = true;
    loadingEl.hidden = false;
    setStatus('Loading…', 0);
    const build = pickBuild();
    log(`Using the ${build} build`);
    try {
      // the data package registers itself with Module before the engine starts
      await loadScript(dataScript);
      await loadScript(`${build}/serioussam.js`);
    } catch (e) {
      showError(e.message);
    }
  }

  function useFiles(entries) {
    try {
      userFiles = selectGameFiles(entries);
    } catch (e) {
      chooseEl.querySelector('.note:last-of-type').textContent = e.message;
      return;
    }
    load('base-data.js');
  }

  // ---------------------------------------------------------------- page events

  playDemoButton.addEventListener('click', () => load('demo-data.js'));
  startButton.addEventListener('click', start);

  ownFilesLabel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      folderInput.click();
    }
  });
  folderInput.addEventListener('change', () => {
    const entries = [...folderInput.files].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
    if (entries.length) {
      useFiles(entries);
    }
  });

  overlay.addEventListener('dragover', (e) => {
    if (loading) return;
    e.preventDefault();
    overlay.classList.add('dragging');
  });
  overlay.addEventListener('dragleave', () => overlay.classList.remove('dragging'));
  overlay.addEventListener('drop', async (e) => {
    overlay.classList.remove('dragging');
    if (loading) return;
    e.preventDefault();
    useFiles(await entriesFromDrop(e.dataTransfer));
  });

  // the game saves its settings when the page is hidden (it may be closed without warning)
  function requestSave() {
    if (!started) {
      return;
    }
    Module.webSaveRequested = true;
    if (Module.webWakeUp) {
      Module.webWakeUp();
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      requestSave();
    }
  });
  window.addEventListener('pagehide', requestSave);

  // browsers only let audio start after user input; SDL creates its audio context
  // while handling the Start click, but resume it on any input just in case
  function resumeAudio() {
    const ctx = Module.SDL2 && Module.SDL2.audioContext;
    if (ctx && ctx.state === 'suspended') {
      ctx.resume();
    }
  }
  document.addEventListener('pointerdown', resumeAudio, true);
  document.addEventListener('keydown', resumeAudio, true);

  // requestPointerLock() returns a promise that rejects when the browser refuses
  // (e.g. right after the user pressed Escape); the game just asks again later.
  // With touch controls the mouse is never captured: there may be none, and it
  // could take the touches away from the controls.
  const browserRequestPointerLock = Element.prototype.requestPointerLock;
  if (browserRequestPointerLock) {
    Element.prototype.requestPointerLock = function (...args) {
      if (document.documentElement.classList.contains('touch')) {
        return Promise.resolve();
      }
      const result = browserRequestPointerLock.apply(this, args);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
      return result;
    };
  }

  if (params.has('autostart')) {
    load('demo-data.js');
  }
})();
