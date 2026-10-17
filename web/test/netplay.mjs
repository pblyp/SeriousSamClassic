// Network games between browsers (shell/netplay.js, Engine/Base/Emscripten/WebNet.cpp):
// one browser hosts a cooperative game on Karnak (its server), another joins it with
// the room code, they play for a while, and the second one leaves. Each browser has
// its own storage, as two players' would.
//
// A third player joins after that, and is told when the host leaves. A link to a
// room nobody is in says so.
//
//  0. connections that close, come back and are replaced (as WebRTC signaling does),
//     with a stand-in transport: a player only leaves when none is left for a while
//  1. "No WebRTC": through the page server's hub, which passes the packets on
//  2. over WebRTC only (no hub), finding each other through the page's server (as on a
//     local network; where direct connections don't work, e.g. behind some VPNs, through
//     a local TURN server)
//  3. "WebRTC" where WebRTC can't connect: the game goes through the page server's
//     hub instead (only run where direct WebRTC connections fail)
//  4. a page on plain http without the hub: no WebRTC there (browsers have no crypto.subtle),
//     and it says what to do
//
//   node netplay.mjs [--out dir] [--build jspi|asyncify] [--seconds N (how long to play, 18)]

import { chromium } from 'playwright';
import { createWsRelayServer } from '@trystero-p2p/ws-relay/server';
import Turn from 'node-turn';
import { serve } from './server.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outIndex = process.argv.indexOf('--out');
const out = outIndex > 0 ? process.argv[outIndex + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'sam-netplay-'));
fs.mkdirSync(out, { recursive: true });
const buildIndex = process.argv.indexOf('--build');
const buildQuery = buildIndex > 0 ? `&build=${process.argv[buildIndex + 1]}` : '';
const secondsIndex = process.argv.indexOf('--seconds');
const playSeconds = secondsIndex > 0 ? Number(process.argv[secondsIndex + 1]) : 18;

const server = await serve();
// (sam.test: an address that isn't localhost, so a page there has no crypto.subtle)
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required',
  '--disable-features=WebRtcHideLocalIpsWithMdns', '--host-resolver-rules=MAP sam.test 127.0.0.1'] });
const results = {};
const errors = [];

async function openPlayer(name, query, origin = server.url) {
  // (a context each: storage, and so player profiles, of their own)
  const context = await browser.newContext({ viewport: { width: 800, height: 500 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.stack || e.message}`));
  // (by default "No WebRTC": the demo from the site, games through the page server's hub)
  await page.goto(`${origin}/index.html?autostart=1${buildQuery}&${/connection=/.test(query) ? '' : 'connection=none&'}${query}`);
  return page;
}
const engineLog = (page) => page.evaluate(() => window.engineLog);
const logHas = async (page, re) => (await engineLog(page)).some((l) => re.test(l));

async function play(label, transportQuery) {
  const host = await openPlayer('host', `${transportQuery}&args=${encodeURIComponent('+level Levels/KarnakDemo.wld +server')}`);
  await host.waitForFunction(() => Module.netplay && Module.netplay.code && Module.webGameInput, null, { timeout: 120000 });
  const code = await host.evaluate(() => Module.netplay.code);
  const badge = await host.textContent('#net-badge-text');
  if (label.startsWith('webrtc')) {
    results[`${label}: players find each other through the page's server`] = await logHas(host, /find each other through this page's server/);
  }

  const client = await openPlayer('client', `${transportQuery}&join=${code}&quickjoin`);
  let joined = true;
  try {
    await client.waitForFunction(() => Module.netplay && Module.netplay.state === 'joined' && Module.webGameInput, null, { timeout: 180000 });
  } catch (e) {
    joined = false;
  }
  results[`${label}: host shows the room (${badge})`] = /^Room [A-Z0-9]{3}-[A-Z0-9]{3} · waiting for players$/.test(badge);
  results[`${label}: the second player joins with the code`] = joined && await logHas(host, /CRC check OK/);
  const via = joined ? await client.evaluate(() => Module.netplay.via) : '';
  if (label.startsWith('webrtc')) results[`${label}: connected with WebRTC (${via})`] = via === 'with WebRTC';
  if (label.startsWith('fallback')) results[`${label}: connected through the page's server (${via})`] = via === 'through this page\'s server';
  if (!joined) {
    console.log((await engineLog(client)).slice(-15).join('\n'));
    await host.context().close();
    await client.context().close();
    return;
  }
  // play: the joined player walks; both keep the game for a while
  await client.keyboard.down('KeyW');
  await client.waitForTimeout(3000);
  await client.keyboard.up('KeyW');
  await client.waitForTimeout((playSeconds - 3) * 1000);
  await host.screenshot({ path: path.join(out, `${label}-host.png`) });
  await client.screenshot({ path: path.join(out, `${label}-client.png`) });
  const hostBadge = await host.textContent('#net-badge-text');
  results[`${label}: both still play after ${playSeconds} s (${hostBadge})`] = hostBadge.endsWith('1 player joined')
    && await client.evaluate(() => Module.webGameInput === true)
    && !await logHas(host, /disconnected/i);
  // the second player leaves: the host goes on
  await client.context().close();
  await host.waitForFunction(() => window.engineLog.some((l) => /Client .* disconnected/.test(l)), null, { timeout: 90000 }).catch(() => {});
  results[`${label}: the host notices the player leaving, and goes on`] = await logHas(host, /Client .* disconnected/)
    && await host.evaluate(() => Module.webGameInput === true);
  // another player joins; then the host leaves: the player is told
  const second = await openPlayer('second', `${transportQuery}&join=${code}&quickjoin`);
  await second.waitForFunction(() => Module.netplay && Module.netplay.state === 'joined' && Module.webGameInput, null, { timeout: 120000 })
    .catch(() => {});
  const secondJoined = await second.evaluate(() => Module.netplay.state === 'joined');
  await host.context().close();
  await second.waitForFunction(() => document.getElementById('net-badge-text').textContent === 'The host has left the game'
    && !document.getElementById('net-badge').hidden, null, { timeout: 60000 }).catch(() => {});
  await second.waitForTimeout(1000);
  // (the game says "Disconnected: Link or server is down" on the screen)
  await second.screenshot({ path: path.join(out, `${label}-host-left.png`) });
  results[`${label}: a player is told when the host leaves`] = secondJoined
    && await second.textContent('#net-badge-text') === 'The host has left the game';
  await second.context().close();
}

// 0. connections coming and going
{
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`links: ${e.stack || e.message}`));
  await page.goto(`${server.url}/index.html`);
  const steps = await page.evaluate(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const channel = () => ({ readyState: 'open', bufferedAmount: 0, sent: 0, send() { this.sent++; }, close() { this.readyState = 'closed'; } });
    const drop = (c) => { c.readyState = 'closed'; if (c.onclose) c.onclose(); };
    const stand_in = () => {
      const transport = { listeners: {}, on(event, fn) { this.listeners[event] = fn; }, leave() {} };
      return [transport, async () => transport];
    };
    const steps = [];
    // the host's side: player P
    const [hostSide, hostTransport] = stand_in();
    const host = NetPlay.create({ transport: hostTransport, linkGraceMs: 300 });
    host.open(true);
    await wait(10);
    const P = 0x0A530002;  // 10.83.0.2
    const [a, b, b2, c] = [channel(), channel(), channel(), channel()];
    hostSide.listeners.link('torrent:P', 'P', { channel: a, sendRole() {} });
    host.send(P, 0, new Uint8Array(1));
    steps.push(['joined', a.sent === 1 && host.players === 1]);
    hostSide.listeners.link('nostr:P', 'P', { channel: b, sendRole() {} });
    drop(a);
    host.send(P, 0, new Uint8Array(1));
    steps.push(['one connection closes, the other carries on', b.sent === 1 && host.players === 1 && host.takeDeparted() === 0]);
    hostSide.listeners.link('nostr:P', 'P', { channel: b2, sendRole() {} });
    host.send(P, 0, new Uint8Array(1));
    steps.push(['a connection is replaced', b2.sent === 1 && b.readyState === 'closed']);
    drop(b2);
    await wait(100);
    hostSide.listeners.link('torrent:P', 'P', { channel: c, sendRole() {} });
    await wait(400);
    steps.push(['all close, one comes back in time', host.takeDeparted() === 0 && host.players === 1]);
    drop(c);
    await wait(100);
    const early = host.takeDeparted();
    await wait(400);
    steps.push(['all close for good: gone', early === 0 && host.takeDeparted() === P && host.players === 0]);
    // the joining side: the host H
    const [clientSide, clientTransport] = stand_in();
    const client = NetPlay.create({ transport: clientTransport, linkGraceMs: 300 });
    client.open(false);
    const joining = client.join('K7Q-2MX');
    await wait(10);
    const [h1, h2] = [channel(), channel()];
    clientSide.listeners.link('torrent:H', 'H', { channel: h1, sendRole() {} });
    clientSide.listeners.role('H', 'host');
    const hostIp = await joining;
    drop(h1);
    await wait(100);
    clientSide.listeners.link('nostr:H', 'H', { channel: h2, sendRole() {} });
    await wait(400);
    client.send(hostIp, 0, new Uint8Array(1));
    steps.push(['the host\'s connection is replaced in time', client.state === 'joined' && h2.sent === 1]);
    drop(h2);
    await wait(500);
    steps.push(['the host is gone', client.state === 'host-left' && client.takeDeparted() === hostIp]);
    return steps;
  });
  for (const [name, ok] of steps) results[`links: ${name}`] = ok;
  await page.close();
}

// 1. through the hub
await play('hub', 'connection=none');
{
  const lost = await openPlayer('lost', 'connection=none&join=ZZZ-ZZZ&quickjoin');
  await lost.waitForFunction(() => Module.netplay && Module.netplay.state === 'failed', null, { timeout: 120000 }).catch(() => {});
  await lost.waitForTimeout(2000);
  await lost.screenshot({ path: path.join(out, 'hub-no-game.png') });
  const text = await lost.textContent('#net-badge-text');
  results[`hub: a code nobody hosts is reported (${text})`] = text.startsWith('No game was found in room ZZZ-ZZZ')
    && await lost.isVisible('#net-badge');
  await lost.context().close();
}

// 2. over WebRTC
async function webRtcWorks() {
  const page = await browser.newPage();
  const ok = await page.evaluate(async () => {
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    const channel = a.createDataChannel('check');
    const opened = new Promise((resolve) => { channel.onopen = () => resolve(true); setTimeout(() => resolve(false), 5000); });
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    return opened;
  });
  await page.close();
  return ok;
}
const relay = createWsRelayServer({ host: '127.0.0.1', port: 0 });
await relay.ready;
const signal = encodeURIComponent(`ws://127.0.0.1:${relay.address().port}`);
const webRtc = await webRtcWorks();
if (webRtc) {
  await play('webrtc', 'connection=secure&nethub=off');
} else {
  const turn = new Turn({ listeningPort: 3478, listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'],
    authMech: 'long-term', credentials: { sam: 'sam' }, debugLevel: 'OFF' });
  turn.start();
  await play('webrtc (TURN)', `connection=secure&nethub=off&turn=${encodeURIComponent('turn:sam:sam@127.0.0.1:3478')}`);
  turn.stop();
  // 3. WebRTC chosen, but it can't connect here: through the page server's hub
  await play('fallback', 'connection=secure');
}

// 4. plain http without the page server's hub: WebRTC can't work there (no crypto.subtle),
// and the page says what to do
{
  const http = await openPlayer('http host', `connection=secure&nethub=off&signal=${signal}&args=${encodeURIComponent('+level Levels/KarnakDemo.wld +server')}`,
    server.url.replace('127.0.0.1', 'sam.test'));
  await http.waitForFunction(() => Module.netplay && Module.netplay.state === 'failed', null, { timeout: 120000 }).catch(() => {});
  results['plain http without a hub explains itself'] =
    (await http.textContent('#net-badge-text')).startsWith('WebRTC needs this page on https');
  await http.context().close();
}
await relay.close();

await browser.close();
server.close();

results['no page errors'] = errors.length === 0;
let failed = false;
for (const [name, ok] of Object.entries(results)) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  failed ||= !ok;
}
for (const e of errors) console.log(e);
console.log(`screenshots in ${out}`);
process.exit(failed ? 1 : 0);
