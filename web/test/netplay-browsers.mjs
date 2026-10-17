// Network games over WebRTC between different browsers (Safari's WebKit, Firefox,
// Chromium): one hosts Karnak, the other joins with the room code, and they keep
// playing. Signaling goes through a local Trystero relay; connections go through a
// local TURN server, so this also works where direct WebRTC connections don't (e.g.
// behind some VPNs).
//
//   node netplay-browsers.mjs [host:client ...] [--public]   (default: a mix of all three)

import { chromium, firefox, webkit } from 'playwright';
import { createWsRelayServer } from '@trystero-p2p/ws-relay/server';
import Turn from 'node-turn';
import { serve } from './server.mjs';

const BROWSERS = { chromium, firefox, webkit };
const pairArgs = process.argv.slice(2).filter((a) => a.includes(':'));
const pairs = pairArgs.length
  ? pairArgs.map((p) => p.split(':'))
  : [['webkit', 'firefox'], ['firefox', 'webkit'], ['chromium', 'firefox'], ['webkit', 'webkit']];

const server = await serve();
const relay = createWsRelayServer({ host: '127.0.0.1', port: 0 });
await relay.ready;
const turn = new Turn({ listeningPort: 3478, listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'],
  authMech: 'long-term', credentials: { sam: 'sam' }, debugLevel: 'OFF' });
turn.start();
// (--public: the public trackers and Nostr relays instead of the local relay)
const usePublic = process.argv.includes('--public');
const query = `connection=secure&nethub=off${usePublic ? '&signal=public' : `&signal=${encodeURIComponent(`ws://127.0.0.1:${relay.address().port}`)}`}`
  + `&turn=${encodeURIComponent('turn:sam:sam@127.0.0.1:3478')}`;

const results = {};
const errors = [];
const browsers = [];

async function openPlayer(name, type, extra) {
  // (Firefox leaves out a TURN server on the loopback address unless told otherwise)
  const options = type === 'firefox' ? { firefoxUserPrefs: { 'media.peerconnection.ice.loopback': true } }
    : type === 'chromium' ? { args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] } : {};
  const browser = await BROWSERS[type].launch(options);
  browsers.push(browser);
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.stack || e.message}`));
  await page.goto(`${server.url}/index.html?autostart=1&${query}&${extra}`);
  return page;
}

for (const [hostType, clientType] of pairs) {
  const label = `${hostType} hosts, ${clientType} joins`;
  const host = await openPlayer(`${label}: host`, hostType, `args=${encodeURIComponent('+level Levels/KarnakDemo.wld +server')}`);
  await host.waitForFunction(() => Module.netplay && Module.netplay.code && Module.webGameInput, null, { timeout: 180000 });
  const code = await host.evaluate(() => Module.netplay.code);
  const client = await openPlayer(`${label}: client`, clientType, `join=${code}&quickjoin`);
  await client.waitForFunction(() => Module.netplay && ['joined', 'failed'].includes(Module.netplay.state), null, { timeout: 180000 })
    .catch(() => {});
  const [state, error] = await client.evaluate(() => [Module.netplay.state, Module.netplay.error]);
  if (state === 'joined') {
    await client.waitForTimeout(20000);
  }
  const hostBadge = await host.textContent('#net-badge-text');
  results[`${label}: joined, still connected after 20 s (${state === 'joined' ? hostBadge : error})`] =
    state === 'joined' && hostBadge.endsWith('1 player joined')
    && await client.evaluate(() => Module.netplay.state === 'joined');
  for (const browser of browsers.splice(0)) await browser.close();
}

turn.stop();
await relay.close();
server.close();

results['no page errors'] = errors.length === 0;
let failed = false;
for (const [name, ok] of Object.entries(results)) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  failed ||= !ok;
}
for (const e of errors) console.log(e);
process.exit(failed ? 1 : 0);
