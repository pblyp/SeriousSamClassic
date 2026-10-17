// Puts the page's third-party libraries into the site:
//   webtorrent.min.js    WebTorrent (demo download), as published
//   netplay-signal.js    Trystero (network game signaling), bundled with esbuild
//
//   node build_libs.mjs <dist dir>

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2];
if (!distDir) {
  console.error('usage: node build_libs.mjs <dist dir>');
  process.exit(1);
}

fs.copyFileSync(path.join(here, 'node_modules/webtorrent/dist/webtorrent.min.js'), path.join(distDir, 'webtorrent.min.js'));
await build({
  entryPoints: [path.join(here, 'netplay-signal.entry.mjs')],
  outfile: path.join(distDir, 'netplay-signal.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'eof',
  logLevel: 'warning',
});
console.log(`libraries in ${distDir}: webtorrent.min.js, netplay-signal.js`);
