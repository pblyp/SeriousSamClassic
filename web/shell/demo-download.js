'use strict';

// Downloads the demo's game files.
//
// With WebTorrent: from other players who have the page open, and from this site,
// which serves the same files (demo/...) as the torrent's web seed. The pieces are
// kept in IndexedDB, so the next visit doesn't download anything, and the page
// keeps sharing them with other players while the game runs.
//
// Without WebTorrent (it can't load, or nothing arrives): the files one by one.

(() => {
  // where downloaded pieces are kept: one IndexedDB database per version of the demo data
  const DB_PREFIX = 'sam-demo-';
  // how long the download may make no progress before falling back to plain HTTP
  const STALL_MS = 20000;
  // how fast this page shares the demo with other players while the game runs
  const UPLOAD_LIMIT = 1024 * 1024;

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

  // SHA-1 of bytes (for browsers without crypto.subtle, see provideSha1())
  function sha1(bytes) {
    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const w = new Int32Array(80);
    const block = (data, offset) => {
      for (let i = 0; i < 16; i++) {
        const o = offset + 4 * i;
        w[i] = (data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3];
      }
      for (let i = 16; i < 80; i++) {
        const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        w[i] = (x << 1) | (x >>> 31);
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        let f, k;
        if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    };
    const n = bytes.length;
    const whole = n - (n % 64);
    for (let offset = 0; offset < whole; offset += 64) block(bytes, offset);
    // the rest, a 1 bit, zeros, and the length in bits
    const tail = new Uint8Array(n % 64 < 56 ? 64 : 128);
    tail.set(bytes.subarray(whole));
    tail[n - whole] = 0x80;
    const tailView = new DataView(tail.buffer);
    tailView.setUint32(tail.length - 8, Math.floor(n / 0x20000000));
    tailView.setUint32(tail.length - 4, (n * 8) >>> 0);
    for (let offset = 0; offset < tail.length; offset += 64) block(tail, offset);
    const out = new DataView(new ArrayBuffer(20));
    [h0, h1, h2, h3, h4].forEach((h, i) => out.setUint32(4 * i, h));
    return out.buffer;
  }

  // browsers only have crypto.subtle on https and localhost; on other http addresses
  // (e.g. a computer on the local network) WebTorrent gets the SHA-1 it needs from here
  function provideSha1() {
    if (!window.crypto || crypto.subtle) return;
    const digest = async (algorithm, data) => {
      const name = (algorithm.name || algorithm).toUpperCase();
      if (name !== 'SHA-1') {
        throw new Error(`${name} is not available on this address (http)`);
      }
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      return sha1(bytes);
    };
    Object.defineProperty(crypto, 'subtle', { configurable: true, value: { digest } });
  }

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

  async function downloadWithWebTorrent(info, { p2p, trackers, onProgress, log }) {
    provideSha1();
    const WebTorrent = await importWebTorrent();
    const torrentFile = new Uint8Array(await (await fetchOk('demo-page.torrent')).arrayBuffer());
    const client = new WebTorrent({ tracker: p2p ? {} : false, dht: false, lsd: false, utPex: p2p });
    const seed = new URL('.', location.href).href;

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
      torrent.once('metadata', () => torrent.addWebSeed(seed));

      let lastActivity = -1;
      let lastProgressTime = performance.now();
      timer = setInterval(() => {
        const peers = torrent.wires.filter((wire) => wire.type !== 'webSeed').length;
        onProgress(torrent.progress || 0, peers);
        // (pieces arriving, or being verified from IndexedDB on a later visit)
        const activity = torrent.received + torrent.downloaded;
        if (activity !== lastActivity || torrent.progress === 1) {
          lastActivity = activity;
          lastProgressTime = performance.now();
        } else if (performance.now() - lastProgressTime > STALL_MS) {
          fail(new Error('the download stalled'));
        }
      }, 250);

      torrent.once('done', () => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        onProgress(1, 0);
        // received from other players vs. this site (a fresh visit; on later ones nothing is downloaded)
        const fromSite = torrent.wires.filter((wire) => wire.type === 'webSeed')
          .reduce((sum, wire) => sum + wire.downloaded, 0);
        log(`Demo data ready (${(torrent.received / 1048576).toFixed(1)} MB downloaded, `
          + `${(fromSite / 1048576).toFixed(1)} MB of it from the site)`);
        client.throttleUpload(UPLOAD_LIMIT);
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

  async function downloadWithHttp(info, { onProgress }) {
    const total = info.files.reduce((sum, file) => sum + file.length, 0);
    let done = 0;
    const files = [];
    for (const file of info.files) {
      const response = await fetchOk(`demo/${file.path.split('/').map(encodeURIComponent).join('/')}`);
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
  //   onProgress: called with (fraction done, number of other players connected)
  async function download({ p2p = true, trackers = null, onProgress = () => {}, log = () => {} } = {}) {
    const info = await (await fetchOk('demo-torrent.json')).json();
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    try {
      return await downloadWithWebTorrent(info, { p2p, trackers: trackers || info.trackers, onProgress, log });
    } catch (e) {
      log(`Downloading with WebTorrent failed (${e.message || e}), downloading the files directly`);
      return downloadWithHttp(info, { onProgress });
    }
  }

  window.DemoDownload = { download, client: null, sha1 };
})();
