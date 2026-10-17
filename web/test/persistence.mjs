// Checks that settings survive reloading the page: run the game, hide the page
// (which makes it save), then start it again in the same browser profile.

import { chromium } from 'playwright';
import { serve } from './server.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const server = await serve();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-profile-'));

async function session(fn) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(`${server.url}/index.html?autostart=1&p2p=0&exec=` + encodeURIComponent('web_fMaxPixelRatio=1.25;'));
    await page.waitForFunction(() => window.engineLog && window.engineLog.some((l) => l.includes('START NEW DISPLAY MODE')), null, { timeout: 60000 });
    await page.waitForTimeout(3000);
    return await fn(page);
  } finally {
    await context.close();
  }
}

let failed = false;

// 1st run: no saved settings yet; hide the page so the game saves
const firstLog = await session(async (page) => {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // give IndexedDB time to store the files
  await page.waitForTimeout(2000);
  return page.evaluate(() => window.engineLog);
});
if (!firstLog.some((l) => l.includes("Cannot load script file 'Scripts/PersistentSymbols.ini"))) {
  console.log('note: first run already had saved settings');
}

// 2nd run: the settings must load
const secondLog = await session(async (page) => {
  const value = await page.evaluate(() => Module.FS.readFile('/user/Scripts/PersistentSymbols.ini', { encoding: 'utf8' }));
  if (!value.includes('web_fMaxPixelRatio=(FLOAT)1.25')) {
    console.log('FAIL: web_fMaxPixelRatio was not saved:\n' + value.split('\n').filter((l) => l.includes('web_') || l.includes('sam_iScreen')).join('\n'));
    failed = true;
  }
  return page.evaluate(() => window.engineLog);
});
if (secondLog.some((l) => l.includes("Cannot load script file 'Scripts/PersistentSymbols.ini"))) {
  console.log('FAIL: settings were not loaded on the second run');
  failed = true;
}

server.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(failed ? 'persistence test FAILED' : 'persistence test passed');
process.exit(failed ? 1 : 0);
