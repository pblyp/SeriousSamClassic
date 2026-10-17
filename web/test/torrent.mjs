// Checks how the demo is downloaded (shell/demo-download.js):
//  1. from the site (the torrent's web seed), then from IndexedDB on the next visit
//  2. from another player: two browsers find each other through a local tracker,
//     and the second one can't reach the site's demo files (skipped where WebRTC
//     can't connect, e.g. behind some VPNs)
//  3. without WebTorrent, file by file
//  4. from an http address that isn't localhost (like a computer on the local network),
//     where browsers have no crypto.subtle (which WebTorrent needs): directly
//
//   node torrent.mjs

import { chromium } from 'playwright';
import TrackerServer from 'bittorrent-tracker/server';
import { serve } from './server.mjs';
import fs from 'node:fs';

const server = await serve();
const tracker = new TrackerServer({ udp: false, http: false, ws: true, stats: false });
await new Promise((resolve) => tracker.listen(0, '127.0.0.1', resolve));
const trackerUrl = `ws://127.0.0.1:${tracker.ws.address().port}`;

// (Chrome hides local addresses behind mDNS names, which headless Chromium can't resolve)
// (sam.test: an address that isn't localhost, so not a secure context)
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--host-resolver-rules=MAP sam.test 127.0.0.1'] });
const results = {};
const errors = [];

async function openPage(query, { blockDemoFiles = false, blockWebTorrent = false, origin = server.url } = {}) {
  const context = await browser.newContext({ viewport: { width: 640, height: 400 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  page.demoRequests = 0;
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/demo/')) page.demoRequests++; });
  if (blockDemoFiles) await page.route(/\/demo\//, (route) => route.abort());
  if (blockWebTorrent) await page.route(/webtorrent\.min\.js/, (route) => route.abort());
  // a stand-in for the engine, which only takes the files
  await page.route(/serioussam\.js$/, (route) => route.fulfill({ contentType: 'text/javascript', body: `
    window.written = 0;
    Module.FS = { mkdirTree() {}, writeFile(path, data) { written += data.length; } };
    Module.callMain = () => {};
    Module.ExitStatus = class {};
    Module.onRuntimeInitialized();` }));
  await page.goto(`${origin}/index.html?autostart=1&${query}`);
  return page;
}

const engineLog = (page) => page.evaluate(() => window.engineLog);
const waitForLog = (page, text, timeout = 120000) =>
  page.waitForFunction((t) => window.engineLog.some((l) => l.includes(t)), text, { timeout });
const written = (page) => page.waitForFunction(() => window.engineLog.some((l) => l.startsWith('Copied ')))
  .then(() => page.evaluate(() => window.written));
const DEMO_BYTES = JSON.parse(fs.readFileSync(new URL('../build/dist/demo-torrent.json', import.meta.url)))
  .files.reduce((sum, file) => sum + file.length, 0);
const readyLine = async (page) => (await engineLog(page)).find((l) => l.startsWith('Demo data ready')) || '';

// 1. from the site, then from IndexedDB
{
  const page = await openPage('p2p=0');
  await waitForLog(page, 'Demo data ready');
  const first = await readyLine(page);
  const firstRequests = page.demoRequests;
  page.demoRequests = 0;
  await page.reload();
  await waitForLog(page, 'Demo data ready');
  const second = await readyLine(page);
  results[`first visit downloads from the site (${first})`] = /\((10[0-9]\.\d) MB downloaded, \1 MB of it from the site\)/.test(first) && firstRequests > 0;
  results[`next visit downloads nothing (${second}, ${page.demoRequests} requests)`] = second.includes('(0.0 MB downloaded') && page.demoRequests === 0;
  await page.context().close();
}

// can two WebRTC connections reach each other on this machine at all?
async function webRtcWorks() {
  const page = await browser.newPage();
  const result = await page.evaluate(async () => {
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    const channel = a.createDataChannel('check');
    const opened = new Promise((resolve) => {
      channel.onopen = () => resolve(true);
      setTimeout(() => resolve(false), 5000);
    });
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    return opened;
  });
  await page.close();
  return result;
}

// 2. from another player
if (!await webRtcWorks()) {
  console.log('skip another player shares the demo: WebRTC connections fail on this machine');
} else {
  const query = `trackers=${encodeURIComponent(trackerUrl)}`;
  const seeder = await openPage(query);
  await waitForLog(seeder, 'Demo data ready');
  const leecher = await openPage(query, { blockDemoFiles: true });
  await waitForLog(leecher, 'Demo data ready', 180000);
  const line = await readyLine(leecher);
  results[`another player shares the demo (${line})`] = /\(10[0-9]\.\d MB downloaded, 0\.0 MB of it from the site\)/.test(line);
  results['the second player got all the files'] = await written(leecher) === DEMO_BYTES;
  await seeder.context().close();
  await leecher.context().close();
}

// 3. without WebTorrent
{
  const page = await openPage('p2p=0', { blockWebTorrent: true });
  const bytes = await written(page);
  results['falls back to downloading the files'] = (await engineLog(page)).some((l) => l.includes('downloading the files directly'))
    && bytes === DEMO_BYTES;
  await page.context().close();
}

// 4. from an address on the local network
{
  const page = await openPage(`connection=secure&trackers=${encodeURIComponent(trackerUrl)}`,
    { origin: server.url.replace('127.0.0.1', 'sam.test') });
  const bytes = await written(page);
  const log = await engineLog(page);
  const line = log.find((l) => /Demo data ready|WebTorrent failed/.test(l));
  const insecure = await page.evaluate(() => !isSecureContext);
  results[`plain http: directly (${line})`] = insecure && !log.some((l) => l.startsWith('Demo data ready'))
    && bytes === DEMO_BYTES;
  await page.context().close();
}

await browser.close();
tracker.close();
server.close();

results['no page errors'] = errors.length === 0;
let failed = false;
for (const [name, ok] of Object.entries(results)) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  failed ||= !ok;
}
for (const e of errors) console.log(e);
process.exit(failed ? 1 : 0);
