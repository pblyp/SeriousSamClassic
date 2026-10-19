'use strict';

// Service worker of the web build: lets the page start offline, and makes it installable
// as an app (with manifest.webmanifest).
//
// Network first: the page, its scripts and the engine come from the site whenever it can
// be reached, and a copy of each goes into the cache, which answers when it can't. So the
// cache holds what the last visit used, all of one version.
//
// Not handled here (straight to the network, never cached): the demo's files (demo/...,
// asked in parts by WebTorrent, whose pieces are kept in IndexedDB), the game data
// packages (*.data, kept by Emscripten in IndexedDB), lan-signal.json (what the page's
// server offers right now), requests for parts of files, and other sites.

const CACHE = 'sam-app';
// what the page needs to start, kept from the start: the first visit loads it before this
// worker takes over (the rest is kept as it is used)
const SHELL = [
  './', 'index.html', 'style.css', 'main.js', 'fullscreen.js', 'demo-download.js', 'zip.js',
  'netplay.js', 'touch.js', 'gamepad.js', 'webtorrent.min.js', 'netplay-signal.js', 'base-data.js',
  'demo-torrent.json', 'demo-page.torrent', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-256.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];
// and the engine build this browser uses (as main.js picks it)
const BUILD = (typeof WebAssembly.Suspending === 'function') ? 'jspi' : 'asyncify';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    // (one by one: a file missing from the site must not keep the others out)
    .then((cache) => Promise.allSettled([...SHELL, `${BUILD}/serioussam.js`, `${BUILD}/serioussam.wasm`]
      .map((path) => cache.add(path))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function handled(request) {
  if (request.method !== 'GET' || request.headers.has('range')) return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  return !path.startsWith('demo/') && !path.endsWith('.data') && path !== 'lan-signal.json';
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!handled(request)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) {
        // (the page is kept without its query: ?join=..., ?webrtc=true are the same page)
        const key = request.mode === 'navigate' ? new URL(request.url).pathname : request;
        cache.put(key, response.clone()).catch(() => {});
      }
      return response;
    } catch (e) {
      const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
      if (cached) return cached;
      throw e;
    }
  })());
});
