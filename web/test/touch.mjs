// Checks the touch screen controls on their own (analog stick, taps as the mouse),
// then plays with them: closes NETRICSA with a tap, walks with the joystick, looks
// around, shoots, and opens the menu with the Esc button.
//
//   node touch.mjs [--out dir] [--size 844x390]

import { chromium } from 'playwright';
import { serve } from './server.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outIndex = process.argv.indexOf('--out');
const out = outIndex > 0 ? process.argv[outIndex + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'sam-touch-'));
fs.mkdirSync(out, { recursive: true });
const sizeIndex = process.argv.indexOf('--size');
const [W, H] = sizeIndex > 0 ? process.argv[sizeIndex + 1].split('x').map(Number) : [1024, 640];

const server = await serve();
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack || e.message));
const cdp = await context.newCDPSession(page);

const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: points.map(([x, y, id]) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })),
});
const wait = (ms) => page.waitForTimeout(ms);
const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const log = () => page.evaluate(() => window.engineLog);

await page.goto(`${server.url}/index.html`);
await wait(300);
await shot('0-start-page');
const option = await page.inputValue('#touch-mode');
const touchHelp = await page.isVisible('#help-touch');

// the controls without the game: a stand-in Module records what they do
await page.evaluate(() => {
  document.getElementById('overlay').hidden = true;
  const canvas = document.getElementById('canvas');
  window.fake = { webGameInput: false, mouse: [] };
  for (const type of ['mousedown', 'mouseup']) canvas.addEventListener(type, () => fake.mouse.push(type));
  TouchControls.create(fake, canvas, document.getElementById('game'));
});
const mouseEvents = () => page.evaluate(() => fake.mouse.join(' '));
// a tap in a menu that starts the game ends while playing (iOS); taps must still work afterwards
await touch('touchStart', [[W / 2, H / 2, 1]]);
await wait(100);
await page.evaluate(() => fake.onWebGameInput(true));
await touch('touchEnd', []);
await page.evaluate(() => fake.onWebGameInput(false));
await touch('touchStart', [[W / 2, H / 2, 2]]);
await wait(100);
await touch('touchEnd', []);
await wait(200);
const tapsAfterPlaying = await mouseEvents();
// the stick is analog: a short push walks, a full one runs
await page.evaluate(() => fake.onWebGameInput(true));
const move = () => page.evaluate(() => [fake.webTouch.moveX, fake.webTouch.moveY].map((v) => Math.round(v * 100) / 100));
await touch('touchStart', [[150, H * 0.7, 1]]);
await touch('touchMove', [[150, H * 0.7 - 28, 1]]);
const halfMove = await move();
await touch('touchMove', [[150, H * 0.7 - 100, 1]]);
const fullMove = await move();
// past the rim the stick stays put: coming back from there slows down
await touch('touchMove', [[150, H * 0.7 - 100 + 56, 1]]);
const backMove = await move();
await touch('touchEnd', []);
const releasedMove = await move();

await page.goto('about:blank');
await page.goto(`${server.url}/index.html?autostart=1&args=${encodeURIComponent('+level Levels/KarnakDemo.wld')}`);
await page.waitForFunction(() => window.engineLog.some((l) => l.includes('Adding player')), null, { timeout: 120000 });
await wait(4000);
await shot('1-netricsa');
const controlsHiddenInMenu = await page.evaluate(() => document.querySelector('.touch-controls').classList.contains('menu-mode'));

// tap NETRICSA's Exit (top right corner)
await touch('touchStart', [[W - 40, 18, 1]]);
await wait(80);
await touch('touchEnd', []);
await wait(1500);
const playing = await page.evaluate(() => Module.webGameInput === true);
await shot('2-playing');

// walk forward with the joystick while looking left with the right thumb
await touch('touchStart', [[150, H * 0.7, 1]]);
await touch('touchMove', [[150, H * 0.7 - 70, 1]]);
await wait(1500);
await touch('touchStart', [[150, H * 0.7 - 70, 1], [W * 0.7, H * 0.45, 2]]);
for (let i = 1; i <= 10; i++) {
  await touch('touchMove', [[150, H * 0.7 - 70, 1], [W * 0.7 - i * 15, H * 0.45, 2]]);
  await wait(30);
}
await wait(500);
await shot('3-walked-and-turned');
await touch('touchEnd', []);

// shoot: hold the fire button
const fire = await page.evaluate(() => {
  const r = document.querySelector('.tc-fire').getBoundingClientRect();
  return [r.x + r.width / 2, r.y + r.height / 2];
});
await touch('touchStart', [[fire[0], fire[1], 3]]);
await wait(300);
await shot('4-firing');
await wait(700);
await touch('touchEnd', []);

// the Esc button opens the menu
const esc = await page.evaluate(() => {
  const r = document.querySelector('.tc-escape').getBoundingClientRect();
  return [r.x + r.width / 2, r.y + r.height / 2];
});
await touch('touchStart', [[esc[0], esc[1], 4]]);
await wait(80);
await touch('touchEnd', []);
await wait(1000);
const menu = await page.evaluate(() => Module.webGameInput === false);
await shot('5-menu');

await browser.close();
server.close();

const results = {
  'touch controls are on by default on a touch screen': option === 'auto' && touchHelp,
  [`taps work after a tap that started the game (${tapsAfterPlaying})`]: tapsAfterPlaying === 'mousedown mouseup mousedown mouseup',
  [`stick is analog (${halfMove} / ${fullMove} / ${backMove} / ${releasedMove})`]:
    halfMove[0] === 0 && halfMove[1] < -0.3 && halfMove[1] > -0.5 && fullMove[1] === -1
    && backMove[1] < -0.7 && backMove[1] > -0.8 && releasedMove[1] === 0,
  'controls hidden while NETRICSA is up': controlsHiddenInMenu,
  'tapping Exit closed NETRICSA': playing,
  'Esc button opened the menu': menu,
  'no page errors': errors.length === 0,
};
let failed = false;
for (const [name, ok] of Object.entries(results)) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  failed ||= !ok;
}
for (const e of errors) console.log(e);
console.log(`screenshots in ${out}`);
process.exit(failed ? 1 : 0);
