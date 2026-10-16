// Starts the game the way a phone player does (tapping Play, Start and NETRICSA's
// Exit) on emulated phones, then checks that the touch controls drive the game.
// The iPhone run removes what iPhone Safari lacks: element fullscreen, pointer lock
// and JSPI.
//
//   node mobile.mjs [--out dir]

import { chromium, webkit, devices } from 'playwright';
import { serve } from './server.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outIndex = process.argv.indexOf('--out');
const out = outIndex > 0 ? process.argv[outIndex + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'sam-mobile-'));
fs.mkdirSync(out, { recursive: true });

const IPHONE_LIMITS = () => {
  delete Element.prototype.requestFullscreen;
  delete Element.prototype.webkitRequestFullscreen;
  delete Element.prototype.requestPointerLock;
  delete WebAssembly.Suspending;
};

const runs = [
  { name: 'android', browserType: chromium, device: devices['Pixel 7'], args: ['--use-angle=metal'] },
  { name: 'iphone', browserType: webkit, device: devices['iPhone 13'], init: IPHONE_LIMITS },
];

const server = await serve();
let failed = false;
for (const run of runs) {
  const browser = await run.browserType.launch({ headless: true, args: run.args || [] });
  // landscape
  const { width, height } = run.device.viewport;
  const context = await browser.newContext({ ...run.device, viewport: { width: height, height: width } });
  if (run.init) await context.addInitScript(run.init);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  const results = {};
  try {
    await page.goto(`${server.url}/index.html?args=${encodeURIComponent('+level Levels/KarnakDemo.wld')}`);
    await page.tap('#play-demo');
    await page.waitForSelector('#start:not([hidden])', { timeout: 180000 });
    await page.tap('#start');
    results['the game started'] = await page.waitForFunction(
      () => window.engineLog.some((l) => l.includes('Adding player')), null, { timeout: 120000 }).then(() => true, () => false);
    results['touch controls are on'] = await page.evaluate(() => !!document.querySelector('.touch-controls'));
    await page.waitForTimeout(3000);
    const vp = page.viewportSize();
    await page.touchscreen.tap(vp.width - 15, 8);  // NETRICSA's Exit
    await page.waitForTimeout(1500);
    results['tapping Exit closed NETRICSA'] = await page.evaluate(() => Module.webGameInput === true);
    await page.screenshot({ path: path.join(out, `${run.name}.png`) });
  } catch (e) {
    errors.push(e.message);
  }
  results['no page errors'] = errors.length === 0;
  for (const [name, ok] of Object.entries(results)) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${run.name}: ${name}`);
    failed ||= !ok;
  }
  for (const e of errors) console.log(`     ${e}`);
  await browser.close();
}
server.close();
console.log(`screenshots in ${out}`);
process.exit(failed ? 1 : 0);
