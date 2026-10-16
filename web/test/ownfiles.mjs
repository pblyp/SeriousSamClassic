// Starts the game with "Use my game files", picking the staged demo folder as the player's installation.

import { chromium } from 'playwright';
import { serve } from './server.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const gameDir = process.argv[2] || path.resolve(here, '../build/demo-data');
const server = await serve();
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack || e.message));

await page.goto(`${server.url}/index.html`);
await page.setInputFiles('#folder', gameDir);
await page.waitForSelector('#start:not([hidden])', { timeout: 120000 });
console.log('status:', await page.textContent('#status'));
await page.click('#start');
await page.waitForFunction(() => window.engineLog.some((l) => l.includes('Demo data detected')), null, { timeout: 60000 });
await page.waitForTimeout(8000);
const log = await page.evaluate(() => window.engineLog);
for (const l of log.filter((l) => /Copied|group files|\.gro:|Demo data|START NEW|Error|error/.test(l))) console.log(l);
await page.screenshot({ path: process.argv[3] || path.join(here, '../build/ownfiles.png') });
await browser.close();
server.close();
for (const e of errors) console.log('pageerror:', e);
process.exit(errors.length ? 1 : 0);
