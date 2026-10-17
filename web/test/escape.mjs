// Escape with the mouse captured: it opens the menu, and Escape in the menu closes
// it for good. Playwright's key presses don't make Chromium release the mouse, so the
// page does what browsers do: Escape releases pointer lock (without reaching the page),
// also when the lock was taken while Escape was held down.
//
//   node escape.mjs   (opens a browser window: pointer lock needs a focused page)

import { chromium } from 'playwright';
import { serve } from './server.mjs';

const server = await serve();
const browser = await chromium.launch({ headless: false, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack || e.message));
await page.addInitScript(() => {
  let swallowKeyUp = false;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !document.pointerLockElement) return;
    document.exitPointerLock();
    e.stopImmediatePropagation();
    e.preventDefault();
    swallowKeyUp = true;
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.key !== 'Escape') return;
    if (swallowKeyUp) {
      swallowKeyUp = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    } else if (document.pointerLockElement) {
      document.exitPointerLock();
    }
  }, true);
});
await page.bringToFront();
await page.goto(`${server.url}/index.html?autostart=1&p2p=0&args=${encodeURIComponent('+level Levels/KarnakDemo.wld')}`);
await page.waitForFunction(() => window.engineLog.some((l) => l.includes('Adding player')), null, { timeout: 120000 });
await page.waitForTimeout(4000);

const wait = (ms) => page.waitForTimeout(ms);
const playing = () => page.evaluate(() => Module.webGameInput === true);
const locked = () => page.evaluate(() => !!document.pointerLockElement);
async function escape() {
  await page.keyboard.down('Escape');
  await wait(120);  // as long as a person holds it
  await page.keyboard.up('Escape');
  await wait(1500);
}

await escape();  // NETRICSA away
await page.mouse.click(512, 320);  // capture the mouse
await wait(1000);
const lockedWhilePlaying = await locked();
await escape();
const menuOpened = !await playing();
await escape();
const menuClosed = await playing();
await wait(1500);
const menuStaysClosed = await playing();
const lockedAgain = await locked();

await browser.close();
server.close();

const results = {
  'clicking the game captures the mouse': lockedWhilePlaying,
  'Escape opens the menu': menuOpened,
  'Escape in the menu closes it': menuClosed,
  'the menu doesn\'t come back': menuStaysClosed,
  'the mouse is captured again': lockedAgain,
  'no page errors': errors.length === 0,
};
let failed = false;
for (const [name, ok] of Object.entries(results)) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  failed ||= !ok;
}
for (const e of errors) console.log(e);
process.exit(failed ? 1 : 0);
