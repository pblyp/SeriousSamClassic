// Minimal static file server for web/build/dist.
//
// It also helps network games, for players who open the page from it (announced in
// /lan-signal.json), so that games on a local network need no internet:
//   /signal  relays WebRTC signaling (a Trystero WebSocket relay): players find each other
//   /hub     passes the game's packets on, for players whose browsers can't connect to
//            each other with WebRTC (the page's "No WebRTC", and as a fallback)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../build/dist');
const SIGNAL_PATH = '/signal';
const HUB_PATH = '/hub';

// (only if they are installed: npm install in web/test)
const relayModule = await import('@trystero-p2p/ws-relay/server').catch(() => null);
const wsModule = await import('ws').catch(() => null);

// the hub: in each room (a socket's first message: { room }), every message goes to
// the room's other sockets; when a socket closes, they get { from, type: 'bye' }
// (see hubBus() in shell/netplay.js)
function createHub() {
  const wss = new wsModule.WebSocketServer({ noServer: true });
  const members = new Map();  // socket -> { room, id }
  wss.on('connection', (socket) => {
    const member = { room: null, id: null };
    members.set(socket, member);
    socket.on('message', (message) => {
      let m;
      try {
        m = JSON.parse(message);
      } catch (e) {
        return;
      }
      if (member.room === null) {
        member.room = typeof m.room === 'string' ? m.room : null;
        return;
      }
      member.id = member.id || m.from;
      for (const [other, them] of members) {
        if (other !== socket && them.room === member.room && other.readyState === 1) other.send(String(message));
      }
    });
    socket.on('close', () => {
      members.delete(socket);
      if (!member.id) return;
      const bye = JSON.stringify({ from: member.id, type: 'bye' });
      for (const [other, them] of members) {
        if (them.room === member.room && other.readyState === 1) other.send(bye);
      }
    });
  });
  return wss;
}

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.png': 'image/png',
  '.json': 'application/json',
  '.torrent': 'application/x-bittorrent',
};

export function serve(port = 0, root = DIST, host = '127.0.0.1') {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (urlPath === '/lan-signal.json' && (relay || hub)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' })
        .end(JSON.stringify({ ...(relay ? { path: SIGNAL_PATH } : {}), ...(hub ? { hub: HUB_PATH } : {}) }));
      return;
    }
    const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      const headers = {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Accept-Ranges': 'bytes',
      };
      // parts of files, as WebTorrent asks its web seed for (like GitHub Pages does,
      // which refuses ranges of empty files)
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (req.headers.range && st.size === 0) {
        res.writeHead(416, { 'Content-Range': 'bytes */0' }).end();
        return;
      }
      if (range) {
        let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
        let end = range[1] === '' || range[2] === '' ? st.size - 1 : Math.min(Number(range[2]), st.size - 1);
        start = Math.max(start, 0);
        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
          return;
        }
        res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      fs.createReadStream(file).pipe(res);
    });
  });
  // (both on this server: each upgrade goes to the one for its path)
  // (port: undefined, or the relay sets a default port next to noServer, which ws refuses)
  const relay = relayModule ? relayModule.createWsRelayServer({ noServer: true, port: undefined }) : null;
  const hub = wsModule ? createHub() : null;
  server.on('upgrade', (req, socket, head) => {
    const upgradePath = new URL(req.url, 'http://x').pathname;
    const wss = upgradePath === SIGNAL_PATH && relay ? relay.wss : upgradePath === HUB_PATH && hub ? hub : null;
    if (!wss) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      resolve({
        url: `http://127.0.0.1:${actual}`,
        close: () => {
          if (relay) relay.close();
          if (hub) {
            for (const socket of hub.clients) socket.terminate();
            hub.close();
          }
          server.close();
        },
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // node server.mjs [port] [host]; use host 0.0.0.0 to serve other devices on the network
  const port = Number(process.argv[2] || 8080);
  const host = process.argv[3] || '127.0.0.1';
  const { url } = await serve(port, DIST, host);
  console.log(`Serving ${DIST} at ${url}${host === '0.0.0.0' ? ' (and on all network interfaces)' : ''}`);
  console.log(relayModule ? `Network games find each other through this server (${SIGNAL_PATH})`
    : 'No signaling relay (npm install in web/test): network games use the public trackers');
  console.log(wsModule ? `Network games can play through this server (${HUB_PATH}), also without WebRTC`
    : 'No packet hub (npm install in web/test): network games need WebRTC');
}
