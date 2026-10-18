// "Use my game files" with the staged demo folder zipped, as a player does with their
// installation: checks that the page unpacks zips made in different ways exactly,
// refuses what isn't a zip, starts the game from a zip made like macOS Finder's
// "Compress" (with __MACOSX entries), keeps the files for the next visit ("Play my game
// files"), explains what is wrong with broken game files (and doesn't keep those), and
// clears the assets and the player's data separately when asked to.
//
//   node ownfiles.mjs [--browser chromium|webkit|firefox] [game dir] [screenshot]

import { chromium, webkit, firefox } from 'playwright';
import { serve } from './server.mjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const browserIndex = argv.indexOf('--browser');
const browserName = browserIndex >= 0 ? argv.splice(browserIndex, 2)[1] : 'chromium';
const gameDir = argv[0] || path.resolve(here, '../build/demo-data');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-zips-'));

// the game folder, zipped as "Serious Sam/...", as files at the top, and stored (not compressed)
const linked = path.join(tmp, 'Serious Sam');
fs.symlinkSync(gameDir, linked);
const zips = {
  'folder inside': path.join(tmp, 'folder.zip'),
  'files at the top, stored': path.join(tmp, 'stored.zip'),
};
execFileSync('zip', ['-r', '-q', zips['folder inside'], 'Serious Sam', '-x', '*.DS_Store'], { cwd: tmp });
execFileSync('zip', ['-r', '-q', '-0', zips['files at the top, stored'], '.', '-x', '*.DS_Store'], { cwd: gameDir });
// broken installations: a .gro file cut short, and one that isn't the game's
function brokenZip(name, groContents) {
  const dir = path.join(tmp, name);
  execFileSync('rsync', ['-a', '--exclude', '.DS_Store', `${gameDir}/`, `${dir}/`]);
  fs.writeFileSync(path.join(dir, '1_00c_demo.gro'), groContents);
  execFileSync('zip', ['-r', '-q', `${dir}.zip`, '.'], { cwd: dir });
  return `${dir}.zip`;
}
const cutShortZip = brokenZip('cut-short', fs.readFileSync(path.join(gameDir, '1_00c_demo.gro')).subarray(0, 20000000));
execFileSync('zip', ['-q', path.join(tmp, 'other.zip'), 'ModEXT.txt'], { cwd: gameDir });
const notTheGameZip = brokenZip('not-the-game', fs.readFileSync(path.join(tmp, 'other.zip')));

let finderZip = zips['folder inside'];
if (process.platform === 'darwin') {
  finderZip = zips['made by ditto (like Finder)'] = path.join(tmp, 'ditto.zip');
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', gameDir, finderZip]);
}

// what the zips must contain
const expected = new Map();
(function walk(dir, prefix) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = prefix + name;
    if (fs.statSync(full).isDirectory()) walk(full, `${rel}/`);
    else if (name !== '.DS_Store') expected.set(rel, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
  }
})(gameDir, '');

const server = await serve();
const browser = await { chromium, webkit, firefox }[browserName].launch({ headless: true,
  args: browserName === 'chromium' ? ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] : [] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack || e.message));
await page.goto(`${server.url}/index.html`);
const results = {};

// unpack each zip in the page and compare every file
await page.evaluate(() => {
  const input = document.createElement('input');
  input.type = 'file';
  input.id = 'zip-check';
  input.hidden = true;
  document.body.append(input);
});
for (const [name, zip] of Object.entries(zips)) {
  await page.setInputFiles('#zip-check', zip);
  const unpacked = await page.evaluate(async () => {
    const entries = await ZipReader.list(document.getElementById('zip-check').files[0]);
    const hashes = {};
    for (const entry of entries) {
      const digest = await crypto.subtle.digest('SHA-256', await entry.read());
      hashes[entry.path] = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return hashes;
  });
  // (the folder the files are in, if any)
  const prefix = Object.keys(unpacked).find((p) => /(^|\/)SE1_10b\.gro$/.test(p) && !p.includes('__MACOSX')).replace(/SE1_10b\.gro$/, '');
  const missing = [...expected].filter(([p, hash]) => unpacked[prefix + p] !== hash).map(([p]) => p);
  results[`${name}: all ${expected.size} files unpacked exactly${missing.length ? ` (wrong: ${missing.slice(0, 3).join(', ')})` : ''}`] = missing.length === 0;
}

// something that isn't a zip
const notZipFile = path.join(tmp, 'notes.zip');
fs.writeFileSync(notZipFile, 'not a zip');
await page.setInputFiles('#game-zip', notZipFile);
await page.waitForFunction(() => /not a \.zip/.test(document.getElementById('own-files-note').textContent));
results['a file that isn\'t a zip is refused'] = true;

// play from the Finder-like zip
await page.setInputFiles('#game-zip', finderZip);
await page.waitForSelector('#start:not([hidden])', { timeout: 120000 });
await page.click('#start');
await page.waitForFunction(() => window.engineLog.some((l) => l.includes('Demo data detected')), null, { timeout: 60000 });
await page.waitForTimeout(8000);
const log = await page.evaluate(() => window.engineLog);
for (const l of log.filter((l) => /Copied|Demo data|Error|error/.test(l))) console.log(l);
results['the game starts from the zip'] = log.some((l) => l.includes('Demo data detected'))
  && !log.some((l) => l.includes('FatalError'));
await page.screenshot({ path: argv[1] || path.join(here, '../build/ownfiles.png') });
const pageDatabases = (p) => p.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).sort().join(' '));
await page.waitForFunction(() => window.engineLog.some((l) => l.includes('are kept in this browser')), null, { timeout: 20000 })
  .catch(() => {});
results['the files are kept in this browser'] = (await page.evaluate(() => window.engineLog))
  .some((l) => l.includes('are kept in this browser'));

// the next visit plays them without the zip
await page.reload();
await page.waitForSelector('#play-own:not([hidden])', { timeout: 10000 }).catch(() => {});
const offered = await page.isVisible('#play-own');
results[`the next visit offers them (${await page.textContent('#play-own-note')})`] = offered;
if (offered) {
  await page.click('#play-own');
  await page.waitForSelector('#start:not([hidden])', { timeout: 120000 });
  await page.click('#start');
  await page.waitForFunction(() => window.engineLog.some((l) => l.includes('Demo data detected')), null, { timeout: 60000 });
  await page.waitForTimeout(5000);
  const log2 = await page.evaluate(() => window.engineLog);
  results['the game starts from the kept files'] = log2.some((l) => l.includes('Copied')) && !log2.some((l) => l.includes('FatalError'));
}

// clearing the assets keeps the player's data, and the other way round
await page.reload();
await page.waitForSelector('#play-own:not([hidden])', { timeout: 10000 }).catch(() => {});
await page.evaluate(() => localStorage.setItem('p2pMode', 'off'));
let before = await pageDatabases(page);
page.once('dialog', (dialog) => dialog.dismiss());
await page.click('#clear-assets');
const keptWhenCancelled = await pageDatabases(page) === before;
page.once('dialog', (dialog) => dialog.accept());
await page.click('#clear-assets');
await page.waitForFunction(() => document.getElementById('purge-status').textContent !== '');
let after = await pageDatabases(page);
results[`clearing the assets asks first, keeps settings and saved games (${before} -> ${after || 'none'})`] = keptWhenCancelled
  && before.includes('sam-own-files') && !after.includes('sam-own-files') && !after.includes('EM_PRELOAD_CACHE')
  && after.includes('/user') && await page.evaluate(() => localStorage.getItem('p2pMode') === 'off')
  && !await page.isVisible('#play-own');
before = after;
page.once('dialog', (dialog) => dialog.accept());
await page.click('#clear-data');
await page.waitForFunction(() => document.getElementById('purge-status').textContent.includes('data'));
after = await pageDatabases(page);
results[`clearing my data removes settings and saved games and resets the options (${before} -> ${after || 'none'})`] =
  before.includes('/user') && !after.includes('/user')
  && await page.evaluate(() => localStorage.getItem('p2pMode') === null && document.getElementById('p2p-mode').value === 'secure');

// broken game files: the page says what is wrong and what to do
async function failWith(zip) {
  const failing = await browser.newPage({ viewport: { width: 900, height: 700 } });
  failing.on('pageerror', (e) => errors.push(e.stack || e.message));
  await failing.goto(`${server.url}/index.html`);
  await failing.setInputFiles('#game-zip', zip);
  await failing.waitForFunction(() => !document.getElementById('error').hidden || !document.getElementById('start').hidden, null, { timeout: 120000 });
  if (await failing.isVisible('#start')) {
    await failing.click('#start');
    await failing.waitForFunction(() => !document.getElementById('error').hidden, null, { timeout: 60000 });
  }
  return failing;
}
let failing = await failWith(cutShortZip);
results['a cut short .gro is named'] = /1_00c_demo\.gro is damaged or incomplete/.test(await failing.textContent('#status'))
  && await failing.isVisible('#start-over');
await failing.close();
failing = await failWith(notTheGameZip);
results['the game failing to start with the files is explained'] =
  (await failing.textContent('#status')).includes('couldn\'t start with your game files')
  && (await failing.textContent('#error-hint')).includes('.zip')
  && (await failing.textContent('#error-text')).includes('Cannot initialize classes');

// clearing from the error: the assets, then the player's data
before = await pageDatabases(failing);
failing.once('dialog', (dialog) => dialog.accept());
await failing.click('#error-clear-assets');
await failing.waitForSelector('#play-demo');
await failing.waitForTimeout(500);
after = await pageDatabases(failing);
results[`files the game didn't start with aren't offered, and clearing the assets from the error removes them (${before} -> ${after || 'none'})`] =
  !await failing.isVisible('#play-own') && before.includes('sam-own-files') && !after.includes('sam-own-files') && after.includes('/user');
await failing.close();
failing = await failWith(notTheGameZip);
failing.once('dialog', (dialog) => dialog.accept());
await failing.click('#error-clear-data');
await failing.waitForSelector('#play-demo');
await failing.waitForTimeout(500);
results['clearing my data from the error removes settings and saved games'] = !(await pageDatabases(failing)).includes('/user');
await failing.close();

await browser.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });

results['no page errors'] = errors.length === 0;
let failed = false;
for (const [name, ok] of Object.entries(results)) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  failed ||= !ok;
}
for (const e of errors) console.log('pageerror:', e);
process.exit(failed ? 1 : 0);
