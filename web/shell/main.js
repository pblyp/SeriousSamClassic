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
//   webrtc=true          use WebRTC (only on https/localhost): the demo also from other players
//                        (and shared with them), network games directly between browsers.
//                        Without it, the demo comes from its web seeds (mirrors, this site) and
//                        network games go through this page's server
//   seed=https://...     more demo mirrors (comma separated), besides the ones the build lists
//   trackers=wss://...   trackers (comma separated) for finding other players
//   join=K7Q2MX          join the network game in that room (a link the host shares)
//   quickjoin            join right away, without the join menu (for tests)
//   net=local            network games between tabs of this browser (for tests)
//   nethub=ws://...      network games through this WebSocket hub instead of the page server's
//                        (nethub=off: not through a hub, only with WebRTC)
//   signal=wss://...     Trystero WebSocket relays (comma separated) for finding other
//                        players (by default: this page's server, if it relays, else the
//                        public trackers and Nostr relays; signal=public for those)
//   turn=turn:user:password@host:port  a TURN server, for networks that need one
//   netdebug             log how network game connections are tried (with log)

(() => {
  const params = new URLSearchParams(location.search);
  // fullscreen.js, or nothing if it couldn't be loaded (content blockers may block a
  // script with "fullscreen" in its name): the game works without it
  const PageFullscreen = window.PageFullscreen
    || { supported: false, active: () => false, enter() {}, exit() {}, toggle() {} };

  const canvas = document.getElementById('canvas');
  const overlay = document.getElementById('overlay');
  const chooseEl = document.getElementById('choose');
  const loadingEl = document.getElementById('loading');
  const statusEl = document.getElementById('status');
  const progressEl = document.getElementById('progress');
  const playDemoButton = document.getElementById('play-demo');
  const playOwnButton = document.getElementById('play-own');
  const playOwnNote = document.getElementById('play-own-note');
  const zipInput = document.getElementById('game-zip');
  const ownFilesLabel = document.getElementById('own-files');
  const ownFilesNote = document.getElementById('own-files-note');
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

  // the game can't go on: say what happened, what to do about it, and offer to start
  // over (the page has to be loaded again for that) or to clear what is stored
  function showError(text, { hint = '', details = '' } = {}) {
    PageFullscreen.exit();
    document.exitPointerLock?.();
    overlay.hidden = false;
    chooseEl.hidden = true;
    loadingEl.hidden = false;
    progressEl.hidden = true;
    startButton.hidden = true;
    setStatus(text);
    document.getElementById('error').hidden = false;
    document.getElementById('error-hint').textContent = hint;
    document.getElementById('error-hint').hidden = !hint;
    document.getElementById('error-text').textContent = details;
    document.getElementById('error-details').hidden = !details;
    document.getElementById('start-over').focus();
  }

  // what may help when the game doesn't start
  function startupHint() {
    if (usingOwnFiles && ownFilesFromStore) {
      return 'The game files kept in this browser may be damaged or gone: pick the .zip again '
        + '(or clear the assets first). If that doesn\'t help, clear your data: settings saved earlier '
        + 'can keep the game from starting.';
    }
    if (usingOwnFiles) {
      return 'Check that the .zip is of the folder where Serious Sam: The First Encounter is installed '
        + '(with its .gro files), and that it is complete: zip the folder again, or pick another .zip. '
        + 'If that doesn\'t help, clear your data: settings saved by an earlier attempt can keep the game from starting.';
    }
    return 'Try again. If it keeps happening, clear the assets (the download may be damaged), '
      + 'or your data (settings saved earlier can keep the game from starting).';
  }

  // ---------------------------------------------------------------- stored data

  // what the page keeps in this browser (only its own: a github.io address is shared with
  // other sites), in two kinds that are cleared separately:
  // - assets: the demo's pieces, the base game files package, the player's game files;
  // - the player's data: settings and saved games (/user), and the start page's options
  // ('p2pMode' was the Connection type option, which earlier versions kept)
  const OPTION_KEYS = ['touchControls', 'fullscreen', 'p2pMode'];
  const OWN_FILES_DB = 'sam-own-files';

  function deleteDatabase(name) {
    return new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = resolve;
      // (still open somewhere: it goes when that closes, e.g. when the page is loaded again)
      request.onblocked = resolve;
    });
  }

  // a transaction on one object store; resolves with what fn's request got once it is done
  function transaction(db, storeName, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    });
  }

  // the player's game files, kept in IndexedDB so the next visit can play them without
  // picking the .zip again. The set counts only once the game has started with it (its
  // 'meta' record, with the list of files, is written then), so files that are cut short or
  // don't work aren't offered. (ArrayBuffers, not Blobs: WebKit doesn't store Blobs in some
  // contexts; each file is read on its own when it is needed.)
  const OwnFiles = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(OWN_FILES_DB, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('files', { keyPath: 'path' });
          request.result.createObjectStore('meta');
        };
        request.onsuccess = () => {
          this.db = request.result;
          this.db.onversionchange = () => this.close();
          resolve(this.db);
        };
        request.onerror = () => reject(request.error || new Error('Cannot open IndexedDB'));
        request.onblocked = () => reject(new Error('IndexedDB is blocked'));
      });
    },
    close() {
      if (this.db) {
        this.db.close();
        this.db = null;
      }
    },
    // { files: [{ path, size }], bytes, savedAt } of a complete set, or null
    async stored() {
      // (without creating the database just to look)
      if (indexedDB.databases && !(await indexedDB.databases()).some(({ name }) => name === OWN_FILES_DB)) {
        return null;
      }
      const db = await this.open();
      return (await transaction(db, 'meta', 'readonly', (store) => store.get('meta'))) || null;
    },
    async read(path) {
      const record = await transaction(await this.open(), 'files', 'readonly', (store) => store.get(path));
      if (!record) throw new Error(`${path} is missing from the game files kept in this browser.`);
      return record.data;
    },
    // start a new set in place of the kept one
    async begin() {
      await this.remove();
      // (so the browser is less likely to delete them when space runs low)
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
      }
      await this.open();
    },
    async put(path, buffer) {
      await transaction(this.db, 'files', 'readwrite', (store) => store.put({ path, data: buffer }));
    },
    async finish(files, bytes) {
      await transaction(await this.open(), 'meta', 'readwrite', (store) => store.put({ files, bytes, savedAt: Date.now() }, 'meta'));
    },
    async remove() {
      this.close();
      await deleteDatabase(OWN_FILES_DB);
    },
  };

  async function clearAssets() {
    const ok = confirm('Delete the game files this page keeps in this browser?\n\n'
      + 'The downloaded demo and your game files kept here will be deleted (the demo is downloaded '
      + 'again, and your .zip picked again, the next time). Your settings and saved games are kept.');
    if (!ok) return false;
    // close what this page has open, so the databases can go
    try {
      if (DemoDownload.client) DemoDownload.client.destroy();
    } catch (e) {
      // gone already
    }
    const names = ['EM_PRELOAD_CACHE', OWN_FILES_DB];
    if (indexedDB.databases) {
      for (const { name } of await indexedDB.databases()) {
        if (name && name.startsWith('sam-demo-')) names.push(name);
      }
    }
    await Promise.all([OwnFiles.remove(), ...names.map(deleteDatabase)]);
    log('Assets cleared');
    return true;
  }

  async function clearMyData() {
    const ok = confirm('Delete your saved games and settings?\n\n'
      + 'Your saved games, the game\'s settings and controls, and the options on this page will be deleted. '
      + 'The game files kept in this browser (the demo, your own) are kept.');
    if (!ok) return false;
    const openDatabases = (window.Module && Module.IDBFS && Module.IDBFS.dbs) || {};
    for (const db of Object.values(openDatabases)) db.close();
    await deleteDatabase('/user');
    for (const key of OPTION_KEYS) {
      try {
        localStorage.removeItem(key);
      } catch (e) {
        // not stored then
      }
    }
    log('Player data cleared');
    return true;
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

  // gamepads (gamepad.js) show up once a button on them is pressed
  const helpGamepad = document.getElementById('help-gamepad');
  helpGamepad.hidden = !GamePad.connected();
  GamePad.onChange((connected) => { helpGamepad.hidden = !connected; });
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

  // WebRTC only when asked for (?webrtc=true): the demo from other players too, and network
  // games directly between browsers (see demo-download.js and netplay.js)
  const webrtc = ['true', '1'].includes(params.get('webrtc'));
  if (webrtc) {
    document.getElementById('webrtc-note').hidden = false;
    // (browsers only offer the cryptography it needs on https and localhost)
    document.getElementById('webrtc-insecure').hidden = !!window.crypto.subtle;
  }

  // ---------------------------------------------------------------- player's files

  // game files to copy into /data before the game starts (the demo's, or the player's):
  // [{ path: 'Levels/...', size, read() -> Promise<ArrayBuffer> }]
  let dataFiles = null;
  let usingOwnFiles = false;
  // the player's files came from those kept in this browser (not picked just now)
  let ownFilesFromStore = false;
  // { files: [{ path, size }], bytes } of the player's files just stored, to be marked complete once the game runs
  let ownFilesKept = null;
  // whether the game got through starting up (its main loop reports to the page every frame)
  const gameRunning = () => window.Module !== undefined && Module.webGameInput !== undefined;

  // things in an installation the web version doesn't need
  function isNeeded(path) {
    const lower = path.toLowerCase();
    return !/^(bin|tools\.win32|temp|savegame|players|help)\//.test(lower)
      && !/\.(exe|dll|ex_|cab|hdr|bin|log)$/.test(lower)
      // the engine needs this repository's video settings
      && !lower.startsWith('scripts/glsettings/');
  }

  // what macOS adds to archives and folders
  const isMacJunk = (path) => /(^|\/)(__MACOSX\/|\._|\.DS_Store$)/.test(path);

  // find the installation's directory (the one with the .gro files) and make paths relative to it
  function selectGameFiles(entries) {
    entries = entries.filter(({ path }) => !isMacJunk(path));
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
      throw new Error('No game files (*.gro) were found in there.');
    }
    const files = entries
      .filter(({ path }) => path.startsWith(root))
      .map((entry) => ({ ...entry, path: entry.path.slice(root.length) }))
      .filter(({ path }) => isNeeded(path));
    const groups = files.filter(({ path }) => /^[^/]+\.gro$/i.test(path)).map(({ path }) => path.toLowerCase());
    if (!groups.some((name) => name.startsWith('1_00c'))) {
      if (groups.some((name) => name.startsWith('se1_00'))) {
        throw new Error('That is The Second Encounter. This page plays The First Encounter.');
      }
      throw new Error('That doesn\'t look like a Serious Sam: The First Encounter installation.');
    }
    return files;
  }

  // a file of the player's: { path, size, read() -> Promise<ArrayBuffer>, file }
  const fileEntry = (path, file) => ({ path, size: file.size, read: () => file.arrayBuffer(), file });

  // read the files of a dropped folder (or the dropped .zip)
  async function entriesFromDrop(dataTransfer) {
    const entries = [];
    async function walk(entry) {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        entries.push(fileEntry(entry.fullPath.replace(/^\//, ''), file));
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

  // a .gro file is a zip archive; an incomplete one (a download or copy that broke off)
  // lacks the directory at its end, and the game can't start
  function checkGroupFile(path, buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        const directoryEnd = view.getUint32(i + 16, true) + view.getUint32(i + 12, true);
        if (directoryEnd <= i) return;
        break;
      }
    }
    throw new Error(`${path} is damaged or incomplete.`);
  }

  // copy the game files into the game's file system (over the base files, if any)
  // (and keep the player's newly picked files in this browser, if it has room for them)
  async function writeDataFiles() {
    const FS = Module.FS;
    const totalBytes = dataFiles.reduce((sum, { size }) => sum + size, 0);
    let doneBytes = 0;
    let keeping = false;
    const stopKeeping = (e) => {
      keeping = false;
      log(`Your game files can't be kept in this browser: ${e && e.message}`);
      OwnFiles.remove().catch(() => {});
    };
    if (usingOwnFiles && !ownFilesFromStore) {
      try {
        await OwnFiles.begin();
        keeping = true;
      } catch (e) {
        stopKeeping(e);
      }
    }
    for (const { path, size, read } of dataFiles) {
      setStatus(`Preparing the game files… ${Math.round(100 * doneBytes / totalBytes)}%`, doneBytes / totalBytes);
      const fullPath = `/data/${path}`;
      FS.mkdirTree(fullPath.slice(0, fullPath.lastIndexOf('/')));
      const buffer = await read();
      if (/\.gro$/i.test(path)) {
        checkGroupFile(path, buffer);
      }
      FS.writeFile(fullPath, new Uint8Array(buffer));
      if (keeping) {
        try {
          await OwnFiles.put(path, buffer);
        } catch (e) {
          stopKeeping(e);
        }
      }
      doneBytes += size;
    }
    log(`Copied ${dataFiles.length} game files (${Math.round(totalBytes / 1048576)} MB)`);
    if (keeping) {
      ownFilesKept = { files: dataFiles.map(({ path, size }) => ({ path, size })), bytes: totalBytes };
    }
  }

  // the kept files count once the game has started with them (its main loop runs)
  function finishKeepingOwnFiles() {
    if (!ownFilesKept) return;
    const timer = setInterval(() => {
      if (!gameRunning()) return;
      clearInterval(timer);
      OwnFiles.finish(ownFilesKept.files, ownFilesKept.bytes)
        .then(() => log(`Your game files are kept in this browser (${Math.round(ownFilesKept.bytes / 1048576)} MB)`))
        .catch((e) => log(`Your game files can't be kept in this browser: ${e.message}`));
    }, 1000);
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
    // a link to a network game: the join menu opens with its room code
    if (joinCode) {
      list.push('+connect', joinCode);
      if (params.has('quickjoin')) list.push('+quickjoin');
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
    finishKeepingOwnFiles();
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
      if (dataFiles) {
        await writeDataFiles();
      }
    } catch (e) {
      showError(`The game files can't be used: ${e.message}`, { hint: startupHint() });
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

  // ---------------------------------------------------------------- network games

  const joinCode = params.has('join') ? NetPlay.normalizeCode(params.get('join')) : null;
  if (joinCode) {
    const invite = document.getElementById('invite');
    invite.textContent = `You are invited to a network game (room ${NetPlay.showCode(joinCode)}). `
      + 'Start the demo, or use your game files, to join it.';
    invite.hidden = false;
  }

  const netBadge = document.getElementById('net-badge');
  const netBadgeText = document.getElementById('net-badge-text');
  const netShare = document.getElementById('net-share');
  let netBadgeHidden = false;
  let netBadgeTimer = 0;
  // (the others join the way the host plays: with WebRTC or without)
  const roomLink = (code) => `${location.origin}${location.pathname}?join=${code}${webrtc ? '&webrtc=true' : ''}`;

  // what the host shares, and how joining goes
  function updateNetBadge(net) {
    clearTimeout(netBadgeTimer);
    const code = net.code ? NetPlay.showCode(net.code) : '';
    let text = '';
    if (net.state === 'hosting') {
      text = `Room ${code} · ${net.players ? `${net.players} player${net.players > 1 ? 's' : ''} joined` : 'waiting for players'}`;
    } else if (net.state === 'joining') {
      const seconds = Math.floor((Date.now() - net.joinStarted) / 1000);
      text = `Looking for the game in room ${code}…${seconds >= 5 ? ` ${seconds} s` : ''}`;
    } else if (net.state === 'joined') {
      text = `Joined room ${code}${net.via === 'through this page\'s server' ? ', through this page\'s server' : ''}`;
      netBadgeTimer = setTimeout(() => { netBadge.hidden = true; }, 4000);
    } else if (net.state === 'host-left') {
      text = 'The host has left the game';
    } else if (net.state === 'failed') {
      text = net.error;
    }
    netBadgeText.textContent = text;
    document.getElementById('net-copy').hidden = net.state !== 'hosting';
    netShare.hidden = net.state !== 'hosting' || !navigator.share;
    netBadge.hidden = !text || (netBadgeHidden && net.state === 'hosting');
    netBadge.classList.toggle('error', net.state === 'failed');
  }
  document.getElementById('net-hide').addEventListener('click', () => {
    netBadgeHidden = true;
    netBadge.hidden = true;
  });
  document.getElementById('net-copy').addEventListener('click', async () => {
    const link = roomLink(Module.netplay.code);
    try {
      await navigator.clipboard.writeText(link);
      netBadgeText.textContent = 'Link copied';
      setTimeout(() => updateNetBadge(Module.netplay), 1500);
    } catch (e) {
      // (no clipboard on plain http)
      window.prompt('Copy this link and send it to the other players:', link);
    }
  });
  netShare.addEventListener('click', () => {
    navigator.share({ title: 'Serious Sam', text: 'Join my game of Serious Sam', url: roomLink(Module.netplay.code) })
      .catch(() => {});
  });

  // what the server of this page does for network games (web/test/server.mjs does both):
  // relay WebRTC signaling (then players find each other there: games on a local network
  // need no internet), and pass the game's packets on (then games work without WebRTC)
  async function serverServices() {
    try {
      const response = await fetch('lan-signal.json', { cache: 'no-store' });
      if (!response.ok) return {};
      const { path, hub } = await response.json();
      const ws = (where) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${where}`;
      if (path) log(`Network games find each other through this page's server (${ws(path)})`);
      return { relays: path ? [ws(path)] : null, hub: hub ? ws(hub) : null };
    } catch (e) {
      return {};
    }
  }

  function createNetplay() {
    const list = (name) => (params.get(name) ? params.get(name).split(',').filter((u) => u) : null);
    // ?signal=: these relays (public: the public trackers and Nostr relays), not the page server's
    const signal = params.get('signal');
    return NetPlay.create({
      connection: () => (webrtc ? 'webrtc' : 'none'),
      services: serverServices,
      relays: signal ? (signal === 'public' ? [] : list('signal')) : null,
      hub: params.get('nethub') === 'off' ? false : params.get('nethub'),
      transport: params.get('net') === 'local' ? 'local' : null,
      trackers: list('trackers'),
      turn: NetPlay.parseTurn(params.get('turn')),
      debug: params.has('netdebug'),
      log,
      onChange: updateNetBadge,
    });
  }

  window.Module = {
    canvas,
    netplay: createNetplay(),
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
        const details = engineLog.slice(iError + 1).join('\n');
        if (gameRunning()) {
          showError('The game stopped because of an error.', { details });
        } else {
          showError(usingOwnFiles ? 'The game couldn\'t start with your game files.' : 'The game couldn\'t start.',
            { hint: startupHint(), details });
        }
      } else {
        showError('Thanks for playing!');
      }
    },
    onAbort(what) {
      showError('The game crashed.', { hint: gameRunning() ? '' : startupHint(), details: String(what) });
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

  // get the game data ready, then load the engine
  async function load(prepareData) {
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
      await prepareData();
      await loadScript(`${build}/serioussam.js`);
    } catch (e) {
      showError(e.message);
    }
  }

  // the demo comes from other players and this site (see demo-download.js)
  function loadDemo() {
    load(async () => {
      const list = (name) => (params.get(name) ? params.get(name).split(',').filter((u) => u) : null);
      dataFiles = await DemoDownload.download({
        p2p: webrtc,
        trackers: list('trackers'),
        mirrors: list('seed') || [],
        log,
        onProgress(fraction, peers, waitLeft) {
          const from = peers > 0 ? ` (with ${peers} other player${peers > 1 ? 's' : ''})`
            // (the site is only asked when no other players can do it)
            : waitLeft !== null && waitLeft !== undefined && fraction < 1 ? ` (looking for other players: ${waitLeft} s)` : '';
          setStatus(`Downloading game data… ${Math.round(fraction * 100)}%${from}`, fraction);
        },
      });
    });
  }

  // the player's game folder, zipped (or the folder itself, dropped on the page)
  async function useFiles(entries) {
    try {
      if (entries.length === 1 && /\.zip$/i.test(entries[0].path)) {
        ownFilesNote.textContent = 'Reading the .zip…';
        entries = await ZipReader.list(entries[0].file);
      }
      dataFiles = selectGameFiles(entries);
      usingOwnFiles = true;
      ownFilesFromStore = false;
    } catch (e) {
      ownFilesNote.textContent = e.message;
      return;
    }
    // the data package registers itself with Module before the engine starts
    load(() => loadScript('base-data.js'));
  }

  // the player's game files kept in this browser from an earlier visit
  function useStoredFiles() {
    load(async () => {
      const meta = await OwnFiles.stored();
      if (!meta) {
        throw new Error('The game files kept in this browser are gone. Pick the .zip again.');
      }
      dataFiles = meta.files.map(({ path, size }) => ({ path, size, read: () => OwnFiles.read(path) }));
      usingOwnFiles = true;
      ownFilesFromStore = true;
      await loadScript('base-data.js');
    });
  }

  // offer the kept game files, if there are any
  async function showStoredFiles() {
    let meta = null;
    try {
      meta = await OwnFiles.stored();
    } catch (e) {
      // (no IndexedDB, e.g. in some private windows)
    }
    playOwnButton.hidden = playOwnNote.hidden = !meta;
    // the demo is the main choice only when there are no kept files
    playDemoButton.classList.toggle('primary', !meta);
    playDemoButton.classList.toggle('secondary', !!meta);
    if (meta) {
      playOwnNote.textContent = `Kept in this browser · about ${Math.max(1, Math.round(meta.bytes / 1048576))} MB`;
    }
  }
  showStoredFiles();

  // ---------------------------------------------------------------- page events

  playDemoButton.addEventListener('click', loadDemo);
  playOwnButton.addEventListener('click', useStoredFiles);
  startButton.addEventListener('click', start);
  document.getElementById('start-over').addEventListener('click', () => location.reload());
  document.getElementById('error-clear-assets').addEventListener('click', async () => {
    if (await clearAssets()) location.reload();
  });
  document.getElementById('error-clear-data').addEventListener('click', async () => {
    if (await clearMyData()) location.reload();
  });
  const purgeStatus = document.getElementById('purge-status');
  document.getElementById('clear-assets').addEventListener('click', async () => {
    if (await clearAssets()) {
      await showStoredFiles();
      purgeStatus.textContent = 'Assets cleared.';
    }
  });
  document.getElementById('clear-data').addEventListener('click', async () => {
    if (await clearMyData()) {
      // the start page's options are back to their defaults
      touchSelect.value = loadTouchMode();
      fullscreenCheckbox.checked = TouchControls.wanted('auto');
      updateTouchHelp();
      purgeStatus.textContent = 'Your data cleared.';
    }
  });

  ownFilesLabel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      zipInput.click();
    }
  });
  zipInput.addEventListener('change', () => {
    const file = zipInput.files[0];
    if (file) {
      useFiles([fileEntry(file.name, file)]);
    }
    // (so picking the same file again after fixing something is noticed)
    zipInput.value = '';
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

  // the game asks for the mouse when the menu closes; when Escape closed it, the browser
  // would take the mouse right back (Escape ends pointer lock), and the game would take
  // that for Escape pressed while playing. So it is asked for once Escape is left alone.
  const ESCAPE_LOCK_DELAY_MS = 500;
  let lockRetry = 0;
  for (const type of ['keydown', 'keyup']) {
    document.addEventListener(type, (e) => {
      if (e.key === 'Escape' && window.Module) {
        Module.webLastEscape = performance.now();
      }
    }, true);
  }

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
      const sinceEscape = window.Module ? performance.now() - (Module.webLastEscape ?? -Infinity) : Infinity;
      if (sinceEscape < ESCAPE_LOCK_DELAY_MS) {
        clearTimeout(lockRetry);
        lockRetry = setTimeout(() => {
          if (Module.webGameInput && !document.pointerLockElement) {
            this.requestPointerLock(...args);
          }
        }, ESCAPE_LOCK_DELAY_MS - sinceEscape);
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
    loadDemo();
  }
})();
