'use strict';

// Downloads the demo's game files.
//
// With WebTorrent: from other players who have the page open (with WebRTC only), from
// mirrors (other web sites with a copy of demo/..., as the torrent's web seeds), and from
// this site, which serves the same files. The site is only asked when the others can't
// do it (nothing within PEER_WAIT_MS or MIRROR_WAIT_MS, or too slow), which keeps the
// site's bandwidth (GitHub Pages: 100 GB a month) for those who need it. The pieces are
// kept in IndexedDB, so the next visit doesn't download anything, and with WebRTC the
// page keeps sharing them with other players while the game runs.
//
// Without WebTorrent (it can't load, or nothing arrives): the files one by one, from a
// mirror or else this site.

(() => {
  // where downloaded pieces are kept: one IndexedDB database per version of the demo data
  const DB_PREFIX = 'sam-demo-';
  // how long the download may make no progress before falling back to plain HTTP
  const STALL_MS = 20000;
  // how fast this page shares the demo with other players while the game runs
  const UPLOAD_LIMIT = 1024 * 1024;
  // how long to look for other players before the site is asked too, and how fast they
  // must be (and for how long they may be slower) for the site not to be asked
  const PEER_WAIT_MS = 15000;
  const PEER_SPEED_ENOUGH = 1024 * 1024;
  const PEER_SLOW_MS = 5000;
  // the same without other players, when there are mirrors (they answer right away)
  const MIRROR_WAIT_MS = 5000;

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // torrent pieces in IndexedDB (an abstract-chunk-store, as WebTorrent wants:
  // WebTorrent's own store needs file system access that Safari lacks)
  class IdbChunkStore {
    constructor(chunkLength, opts = {}) {
      this.chunkLength = Number(chunkLength);
      this.closed = false;
      this.name = DB_PREFIX + (opts.torrent ? opts.torrent.infoHash : opts.name);
      const open = indexedDB.open(this.name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('chunks');
      this.db = request(open);
    }

    // one write at a time, and once more if one fails (not as Blobs: private windows
    // of Safari can't keep them)
    put(index, buf, cb = () => {}) {
      // only the piece itself, not a bigger buffer it may be part of
      const data = (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength)
        ? new Uint8Array(buf.buffer)
        : new Uint8Array(buf);
      const write = (db) => new Promise((resolve, reject) => {
        const tx = db.transaction('chunks', 'readwrite');
        tx.objectStore('chunks').put(data, index);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => { e.preventDefault(); reject(tx.error); };
        tx.onabort = () => reject(tx.error);
      });
      this.writes = (this.writes || Promise.resolve())
        .then(() => this.db)
        .then((db) => write(db).catch(() => write(db)))
        .then(() => cb(null), (err) => cb(err));
    }

    get(index, opts, cb) {
      if (typeof opts === 'function') {
        cb = opts;
        opts = null;
      }
      this.db.then((db) => request(db.transaction('chunks').objectStore('chunks').get(index)))
        .then((data) => {
          if (!data) {
            cb(new Error('Chunk not found'));
            return;
          }
          const offset = (opts && opts.offset) || 0;
          const length = (opts && opts.length) || (data.length - offset);
          cb(null, offset === 0 && length === data.length ? data : data.subarray(offset, offset + length));
        }, cb);
    }

    close(cb = () => {}) {
      this.closed = true;
      this.db.then((db) => { db.close(); cb(null); }, () => cb(null));
    }

    destroy(cb = () => {}) {
      this.close(() => {
        const req = indexedDB.deleteDatabase(this.name);
        req.onsuccess = () => cb(null);
        req.onerror = () => cb(req.error);
      });
    }
  }

  // other versions of the demo data are not needed any more
  async function deleteOtherVersions(infoHash) {
    if (!indexedDB.databases) return;
    for (const { name } of await indexedDB.databases()) {
      if (name.startsWith(DB_PREFIX) && name !== DB_PREFIX + infoHash) {
        indexedDB.deleteDatabase(name);
      }
    }
  }

  async function fetchOk(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${url}`);
    }
    return response;
  }

  const stripRoot = (path) => path.replace(/^demo\//, '');

  // WebTorrent's module asks for the origin's private file system when it loads, and
  // doesn't handle that failing (in private windows); it isn't used here (pieces go to
  // IndexedDB), so such a failure is kept from becoming an error on the page
  async function importWebTorrent() {
    const storage = navigator.storage;
    const getDirectory = storage && storage.getDirectory;
    if (getDirectory) {
      // (shadows StorageManager.prototype.getDirectory until the module has loaded)
      storage.getDirectory = () => getDirectory.call(storage).catch(() => new Promise(() => {}));
    }
    try {
      return (await import('./webtorrent.min.js')).default;
    } finally {
      if (getDirectory) delete storage.getDirectory;
    }
  }

  // where a web seed's files are (a folder with demo/... in it), ending in a slash
  const seedUrl = (url) => new URL('.', new URL(url.replace(/\/?$/, '/'), location.href)).href;

  async function downloadWithWebTorrent(info, { p2p, trackers, mirrors, onProgress, log }) {
    // (WebTorrent checks pieces with crypto.subtle, which browsers only have on https and localhost)
    if (!window.crypto.subtle) {
      throw new Error('it needs this page on https');
    }
    const WebTorrent = await importWebTorrent();
    const torrentFile = new Uint8Array(await (await fetchOk('demo-page.torrent')).arrayBuffer());
    const client = new WebTorrent({ tracker: p2p ? {} : false, dht: false, lsd: false, utPex: p2p });
    const seed = seedUrl('.');

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = 0;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        client.destroy();
        reject(err);
      };
      client.on('error', fail);

      const torrent = client.add(torrentFile, { announce: p2p ? trackers : [], store: IdbChunkStore });
      torrent.on('error', fail);
      torrent.on('warning', (err) => log(`WebTorrent: ${err.message || err}`));

      let lastActivity = -1;
      let lastProgressTime = performance.now();

      // the site as a source: right away without other players or mirrors, else when they
      // don't do
      let haveMetadata = false;
      let siteAsked = false;
      let slowSince = 0;
      const lookingSince = performance.now();
      const waitMs = p2p ? PEER_WAIT_MS : MIRROR_WAIT_MS;
      const askSite = (why) => {
        if (siteAsked || settled || !haveMetadata) return;
        siteAsked = true;
        log(`Demo download: from the site too (${why})`);
        torrent.addWebSeed(seed);
        // (the stall check starts now)
        lastProgressTime = performance.now();
      };
      torrent.once('metadata', () => {
        haveMetadata = true;
        for (const mirror of mirrors) {
          log(`Demo download: from the mirror ${mirror}`);
          torrent.addWebSeed(mirror);
        }
        if (!p2p && mirrors.length === 0) askSite('not from other players');
      });

      timer = setInterval(() => {
        const now = performance.now();
        const peers = torrent.wires.filter((wire) => wire.type !== 'webSeed').length;
        // (seconds left before the site is asked, while looking for other players)
        const waitLeft = siteAsked || !p2p ? null : Math.max(0, Math.ceil((waitMs - (now - lookingSince)) / 1000));
        onProgress(torrent.progress || 0, peers, waitLeft);
        if (!siteAsked && torrent.progress < 1) {
          if (torrent.downloadSpeed >= PEER_SPEED_ENOUGH) {
            slowSince = 0;
          } else if (!slowSince) {
            slowSince = now;
          }
          if (now - lookingSince >= waitMs && slowSince && now - slowSince >= Math.min(PEER_SLOW_MS, now - lookingSince)) {
            const others = [p2p && 'other players', mirrors.length && 'mirrors'].filter((x) => x).join(' and ');
            askSite(torrent.downloaded > 0 ? `${others} are too slow` : `nothing from ${others}`);
          }
        }
        // (pieces verified: arriving, or from IndexedDB on a later visit; not just bytes
        // received, as pieces that keep failing are received again and again; while
        // only other players are asked, waiting for them isn't a stall)
        const activity = torrent.downloaded;
        if (activity !== lastActivity || torrent.progress === 1 || !siteAsked) {
          lastActivity = activity;
          lastProgressTime = now;
        } else if (now - lastProgressTime > STALL_MS) {
          fail(new Error('the download stalled'));
        }
      }, 250);

      torrent.once('done', () => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        onProgress(1, 0);
        // received from other players, mirrors and this site (a fresh visit; on later ones
        // nothing is downloaded)
        const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
        // (a web seed's wire doesn't say which one it is: WebTorrent's peers, by URL, do)
        const fromSeed = (url) => {
          const peer = torrent._peers && torrent._peers.get(url);
          return (peer && peer.wire && peer.wire.downloaded) || 0;
        };
        const fromSite = fromSeed(seed);
        const fromMirrors = mirrors.reduce((sum, url) => sum + fromSeed(url), 0);
        log(`Demo data ready (${mb(torrent.received)} downloaded, ${mb(fromMirrors)} of it from mirrors, `
          + `${mb(fromSite)} from the site)`);
        // (without WebRTC there is no one to share them with)
        if (p2p) client.throttleUpload(UPLOAD_LIMIT);
        DemoDownload.client = client;
        deleteOtherVersions(torrent.infoHash).catch(() => {});
        resolve(torrent.files.map((file) => ({
          path: stripRoot(file.path),
          size: file.length,
          read: () => file.arrayBuffer(),
        })));
      });
    });
  }

  // a file from the first of the sites that has it
  async function fetchFromAny(bases, path) {
    let error = null;
    for (const base of bases) {
      try {
        return await fetchOk(new URL(path, base).href);
      } catch (e) {
        error = e;
      }
    }
    throw error;
  }

  async function downloadWithHttp(info, { mirrors, onProgress }) {
    const total = info.files.reduce((sum, file) => sum + file.length, 0);
    const bases = [...mirrors, seedUrl('.')];
    let done = 0;
    const files = [];
    for (const file of info.files) {
      const response = await fetchFromAny(bases, `demo/${file.path.split('/').map(encodeURIComponent).join('/')}`);
      const reader = response.body.getReader();
      const chunks = [];
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        chunks.push(value);
        done += value.length;
        onProgress(done / total, 0);
      }
      const data = new Blob(chunks);
      files.push({ path: file.path, size: data.size, read: () => data.arrayBuffer() });
    }
    return files;
  }

  // the demo's files as [{ path, size, read() -> Promise<ArrayBuffer> }]
  //   p2p:        also get them from (and share them with) other players
  //   trackers:   trackers to find other players with (default: the ones the build lists)
  //   mirrors:    more web sites with the files, besides the ones the build lists
  //   onProgress: called with (fraction done, number of other players connected, seconds
  //               left before the site is asked too, or null once it is)
  async function download({ p2p = true, trackers = null, mirrors = [], onProgress = () => {}, log = () => {} } = {}) {
    const info = await (await fetchOk('demo-torrent.json')).json();
    const site = seedUrl('.');
    mirrors = [...new Set([...(info.webSeeds || []), ...mirrors].map(seedUrl))].filter((url) => url !== site);
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    try {
      return await downloadWithWebTorrent(info, { p2p, trackers: trackers || info.trackers, mirrors, onProgress, log });
    } catch (e) {
      log(`Downloading with WebTorrent failed (${e.message || e}), downloading the files directly`);
      return downloadWithHttp(info, { mirrors, onProgress });
    }
  }

  window.DemoDownload = { download, client: null };
})();
