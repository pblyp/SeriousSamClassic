// Checks gamepads (shell/gamepad.js), with a stand-in for the browser's Gamepad API:
//  - the start page notices a pad being plugged in
//  - playing: B closes NETRICSA, the left stick walks and the right stick turns (the view
//    changes much more than when standing still), RT fires
//  - aim assist (AUTO: on with a pad): turning slowly while shooting near enemies, a shot
//    goes to one; unplugging the pad turns it off
//  - Start opens the menu, where the D-pad and A choose Quick Save
//
//   node gamepad.mjs [--out dir]

import { chromium } from 'playwright';
import { serve } from './server.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outIndex = process.argv.indexOf('--out');
const out = outIndex > 0 ? process.argv[outIndex + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'sam-gamepad-'));
fs.mkdirSync(out, { recursive: true });

// standard mapping
const A = 0, B = 1, RT = 7, START = 9, DOWN = 13;

const server = await serve();
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack || e.message));
// a pad the test plugs in and works
await page.addInitScript(() => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false }));
  window.fakePad = { id: 'Test pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard',
    axes: [0, 0, 0, 0], buttons, timestamp: 0 };
  window.padPlugged = false;
  navigator.getGamepads = () => (window.padPlugged ? [window.fakePad] : []);
  window.plugPad = (plugged) => {
    window.padPlugged = plugged;
    // (like the browser's GamepadEvent, which SDL reads too)
    const event = new Event(plugged ? 'gamepadconnected' : 'gamepaddisconnected');
    Object.defineProperty(event, 'gamepad', { value: window.fakePad });
    window.dispatchEvent(event);
  };
  window.press = (i, down) => { buttons[i].pressed = down; buttons[i].value = down ? 1 : 0; };
});

const wait = (ms) => page.waitForTimeout(ms);
const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const engineLog = () => page.evaluate(() => window.engineLog);
const command = (text) => page.evaluate((t) => { Module.webCommands = (Module.webCommands || []).concat([t]); }, text);
const tap = async (button) => {
  await page.evaluate((b) => press(b, true), button);
  await wait(150);
  await page.evaluate((b) => press(b, false), button);
  await wait(150);
};
const sticks = (axes) => page.evaluate((a) => { fakePad.axes = a; }, axes);
// a console variable's value, as the console prints it
async function readVariable(name) {
  const before = (await engineLog()).length;
  await command(`${name};`);
  await page.waitForFunction((n) => window.engineLog.length > n, before);
  return Number.parseInt((await engineLog())[before], 10);
}
// lines the game printed from now (or since line number before) until the condition
// holds (or the time is up)
async function linesUntil(test, timeout, before = undefined) {
  if (before === undefined) before = (await engineLog()).length;
  await page.waitForFunction(([n, src]) => window.engineLog.slice(n).some((l) => new RegExp(src).test(l)),
    [before, test.source], { timeout }).catch(() => {});
  return (await engineLog()).slice(before);
}

// how different two moments of the game look (average difference of the pixels, 0-255)
const frame = async () => (await page.screenshot({ type: 'jpeg', quality: 80 })).toString('base64');
const difference = (a, b) => page.evaluate(async ([x, y]) => {
  const pixels = async (data) => {
    const image = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob());
    const canvas = new OffscreenCanvas(image.width >> 2, image.height >> 2);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const [p, q] = [await pixels(x), await pixels(y)];
  let sum = 0;
  for (let i = 0; i < p.length; i += 4) {
    sum += Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
  }
  return sum / (p.length / 4) / 3;
}, [a, b]);

const results = {};

// the start page
await page.goto(`${server.url}/index.html`);
const helpBefore = await page.isVisible('#help-gamepad');
await page.evaluate(() => plugPad(true));
results['the start page shows the gamepad\'s controls once a pad is there'] = !helpBefore && await page.isVisible('#help-gamepad');

// playing
await page.goto(`${server.url}/index.html?autostart=1&args=${encodeURIComponent('+level Levels/KarnakDemo.wld')}`
  + `&exec=${encodeURIComponent('cht_bGod=1;dbg_bAimAssist=1;')}`);
await page.waitForFunction(() => window.engineLog.some((l) => l.includes('Adding player')), null, { timeout: 120000 });
await wait(4000);
await page.evaluate(() => plugPad(true));
let lines = await linesUntil(/^Aim assist on/, 5000);
results['plugging in a pad turns aim assist on'] = lines.some((l) => l.startsWith('Aim assist on'));
await shot('1-netricsa');
await tap(B);
await wait(1000);
results['B closes NETRICSA'] = await page.evaluate(() => Module.webGameInput === true);

const still0 = await frame();
await wait(1000);
const still1 = await frame();
await sticks([0, -1, 0, 0]);
await wait(1500);
await sticks([0, 0, 0, 0]);
await wait(300);
const walked = await frame();
await shot('2-walked');
await sticks([0, 0, 0.7, 0]);
await wait(1000);
await sticks([0, 0, 0, 0]);
await wait(300);
const turned = await frame();
await shot('3-turned');
const dStill = await difference(still0, still1);
const dWalk = await difference(still1, walked);
const dTurn = await difference(walked, turned);
results[`the left stick walks (view changed ${dWalk.toFixed(1)}, standing still ${dStill.toFixed(1)})`] = dWalk > 2 * dStill + 2;
results[`the right stick turns (view changed ${dTurn.toFixed(1)})`] = dTurn > 2 * dStill + 2;

await page.evaluate((b) => press(b, true), RT);
await wait(300);
const firing = await readVariable('ctl_bFire');
await page.evaluate((b) => press(b, false), RT);
await wait(300);
const stopped = await readVariable('ctl_bFire');
results[`RT fires (${firing}, then ${stopped})`] = firing === 1 && stopped === 0;

// aim assist: where there are enemies, turn slowly while shooting
await command('cht_iGoToMarker=3;');
await wait(2500);
await page.evaluate((b) => press(b, true), RT);
await sticks([0, 0, 0.25, 0]);
lines = await linesUntil(/^aim assist: /, 40000);
await sticks([0, 0, 0, 0]);
await page.evaluate((b) => press(b, false), RT);
await shot('4-aim-assist');
const assisted = lines.find((l) => l.startsWith('aim assist: '));
results[`aim assist turns a shot to an enemy (${assisted || 'none'})`] = !!assisted;
await page.evaluate(() => plugPad(false));
lines = await linesUntil(/^Aim assist off/, 5000);
results['unplugging the pad turns aim assist off'] = lines.some((l) => l.startsWith('Aim assist off'));
await page.evaluate(() => plugPad(true));
await linesUntil(/^Aim assist on/, 5000);

// the menu
await tap(START);
await wait(1000);
results['Start opens the menu'] = await page.evaluate(() => Module.webGameInput === false);
await shot('5-menu');
// (QUICK LOAD is selected; QUICK SAVE is below it)
await tap(DOWN);
await wait(300);
await shot('6-quick-save');
const beforeA = (await engineLog()).length;
await tap(A);
lines = await linesUntil(/^Saved game: /, 5000, beforeA);
results['the D-pad and A choose Quick Save'] = lines.some((l) => l.startsWith('Saved game: '));

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
