// Describes the demo data (a folder named "demo") as a torrent, which the page
// downloads with WebTorrent from other players and from the web site itself.
//
//   node make_torrent.mjs <dist dir> [site url]
//
// Writes into <dist dir>:
//   demo.torrent       for BitTorrent clients that want to help seeding: lists the
//                      trackers, and the site as web seed when its URL is given
//   demo-page.torrent  the same torrent (same info hash) without them, for the page,
//                      which adds the trackers and the web seed it wants itself
//   demo-torrent.json  the trackers, and the files (for downloading them without WebTorrent)

import createTorrent from 'create-torrent';
import fs from 'node:fs';
import path from 'node:path';

// WebSocket trackers, which browsers can use
const TRACKERS = [
  'wss://tracker.webtorrent.dev',
  'wss://tracker.openwebtorrent.com',
];
// pieces are verified and shared one by one
const PIECE_LENGTH = 256 * 1024;

const [distDir, siteUrl] = process.argv.slice(2);
if (!distDir) {
  console.error('usage: node make_torrent.mjs <dist dir> [site url]');
  process.exit(1);
}
const demoDir = path.join(distDir, 'demo');

function make(opts) {
  return new Promise((resolve, reject) => {
    createTorrent(demoDir, {
      name: 'demo',
      comment: 'Serious Sam: The First Encounter demo, for the web version',
      createdBy: 'SeriousSamClassic web build',
      creationDate: new Date(0),
      pieceLength: PIECE_LENGTH,
      private: false,
      ...opts,
    }, (err, torrent) => (err ? reject(err) : resolve(torrent)));
  });
}

const forClients = await make({
  announceList: TRACKERS.map((url) => [url]),
  urlList: siteUrl ? [siteUrl.replace(/\/?$/, '/')] : [],
});
const forPage = await make({ announceList: [], urlList: [] });
fs.writeFileSync(path.join(distDir, 'demo.torrent'), forClients);
fs.writeFileSync(path.join(distDir, 'demo-page.torrent'), forPage);

// the file list (like the torrent, without hidden files)
const files = [];
function walk(dir, prefix) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(full).isDirectory()) {
      walk(full, rel);
    } else if (!name.startsWith('.') && fs.statSync(full).size > 0) {  // (left out of the torrent too)
      files.push({ path: rel, length: fs.statSync(full).size });
    }
  }
}
walk(demoDir, '');
fs.writeFileSync(path.join(distDir, 'demo-torrent.json'), JSON.stringify({ trackers: TRACKERS, files }, null, 1) + '\n');

const total = files.reduce((sum, f) => sum + f.length, 0);
console.log(`demo.torrent: ${files.length} files, ${(total / 1048576).toFixed(1)} MB${siteUrl ? `, web seed ${siteUrl}` : ''}`);
