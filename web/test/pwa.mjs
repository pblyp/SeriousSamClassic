// Checks that the page is an installable app that starts offline (shell/sw.js,
// shell/manifest.webmanifest):
//  1. the manifest and its icons
//  2. the service worker takes over the page
//  3. after playing the demo once, the game starts again with the browser offline
//  4. ?nosw: no service worker
//
//   node pwa.mjs

import { chromium } from 'playwright';
import { serve } from './server.mjs';

const server = await serve();
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const results = {};
const errors = [];

const started = (page, timeout = 120000) => page.waitForFunction(
  () => window.engineLog.some((l) => l.includes('Adding player')), null, { timeout }).then(() => true, () => false);

// 1. the manifest and its icons
{
  const page = await browser.newPage();
  await page.goto(`${server.url}/index.html?nosw`);
  const href = await page.getAttribute('link[rel="manifest"]', 'href');
  const response = await page.request.get(new URL(href, page.url()).href);
  const manifest = await response.json();
  const icons = [];
  for (const icon of manifest.icons || []) {
    const r = await page.request.get(new URL(icon.src, response.url()).href);
    icons.push(r.ok() && (r.headers()['content-type'] || '').startsWith('image/'));
  }
  results[`the manifest describes the app (${manifest.short_name}, ${manifest.display}, ${icons.length} icons)`] =
    response.headers()['content-type'] === 'application/manifest+json' && manifest.name && manifest.start_url
    && manifest.display === 'fullscreen' && icons.length >= 2 && icons.every((ok) => ok)
    && (manifest.icons || []).some((i) => parseInt(i.sizes, 10) >= 192);
  results['?nosw: no service worker'] = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).length === 0);
  await page.close();
}

// 2. and 3. the service worker, and starting offline
{
  const context = await browser.newContext({ viewport: { width: 800, height: 500 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  const level = `args=${encodeURIComponent('+level Levels/KarnakDemo.wld')}`;
  await page.goto(`${server.url}/index.html?autostart=1&${level}`);
  const ready = await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const firstStart = await started(page);
  results['the demo plays online, and a service worker is there'] = ready && firstStart;

  await context.setOffline(true);
  await page.reload();
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  const offlineStart = await started(page);
  const log = await page.evaluate(() => window.engineLog);
  if (!offlineStart) console.log('offline status:', await page.textContent('#status'), '\n', log.slice(-15).join('\n'));
  results[`offline: the page comes from the service worker (${controlled ? 'controlled' : 'not controlled'})`] = controlled;
  results[`offline: the game starts again (${log.find((l) => l.startsWith('Demo data ready')) || 'no demo'})`] = offlineStart;
  await context.close();
}

// an offline first visit says what is wrong
{
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${server.url}/index.html`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await context.setOffline(true);
  await page.click('#play-demo');
  await page.waitForSelector('#error:not([hidden])', { timeout: 30000 }).catch(() => {});
  const status = await page.textContent('#status');
  results[`offline without the demo: explained (${status})`] = /offline/i.test(status);
  await context.close();
}

await browser.close();
server.close();

results['no page errors'] = errors.length === 0;
let failed = false;
for (const [name, ok] of Object.entries(results)) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  failed ||= !ok;
}
for (const e of errors) console.log(e);
process.exit(failed ? 1 : 0);
