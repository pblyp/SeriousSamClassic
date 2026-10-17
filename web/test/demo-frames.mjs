// Plays the first demo at a fixed rate (1/30 s of demo time per frame), saves
// chosen frames as PNG and compares them with frames saved by a native build.
//
//   node demo-frames.mjs [--frames 30,90,150] [--out dir] [--native dir] [--browser chromium]
//
// Frames from a native build: run it with a script containing the commands in
// CAPTURE_COMMANDS (e.g. +script), they land in its ScreenShots/Anim_*.tga.

import { chromium, firefox, webkit } from 'playwright';
import { serve } from './server.mjs';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const CAPTURE_COMMANDS =
  'sam_strIntroLevel=""; dem_fSyncRate=30; dem_iAnimFrame=0; web_fMaxPixelRatio=1;';

const opts = { frames: [30, 90, 150, 210], out: 'frames', native: '', browser: 'chromium', width: 640, height: 480, exec: '' };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const next = () => process.argv[++i];
  if (a === '--frames') opts.frames = next().split(',').map(Number);
  else if (a === '--out') opts.out = next();
  else if (a === '--native') opts.native = next();
  else if (a === '--browser') opts.browser = next();
  else if (a === '--exec') opts.exec = next();
  else if (a === '--late') opts.late = next();
  else throw new Error(`Unknown option ${a}`);
}

// --- images

// decode an uncompressed 24/32-bit TGA into RGB rows, top row first
function decodeTGA(buf) {
  const idLength = buf[0];
  const type = buf[2];
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const bpp = buf[16];
  const topDown = (buf[17] & 0x20) !== 0;
  if (type !== 2 || (bpp !== 24 && bpp !== 32)) throw new Error(`unsupported TGA type ${type}/${bpp}`);
  const px = bpp / 8;
  const rgb = Buffer.alloc(width * height * 3);
  let p = 18 + idLength;
  for (let y = 0; y < height; y++) {
    const row = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x++, p += px) {
      const o = (row * width + x) * 3;
      rgb[o] = buf[p + 2];
      rgb[o + 1] = buf[p + 1];
      rgb[o + 2] = buf[p];
    }
  }
  return { width, height, rgb };
}

function encodePNG({ width, height, rgb }) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// mean absolute difference (0..255) and PSNR; also an amplified difference image
function compare(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('frame sizes differ');
  let sum = 0;
  let sumSq = 0;
  const diff = Buffer.alloc(a.rgb.length);
  for (let i = 0; i < a.rgb.length; i++) {
    const d = Math.abs(a.rgb[i] - b.rgb[i]);
    sum += d;
    sumSq += d * d;
    diff[i] = Math.min(255, d * 4);
  }
  const mse = sumSq / a.rgb.length;
  return {
    mean: sum / a.rgb.length,
    psnr: mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse),
    diff: { width: a.width, height: a.height, rgb: diff },
  };
}

// --- capture

const frameName = (n) => `Anim_${String(n).padStart(5, '0')}`;

async function capture() {
  const server = await serve();
  const browserType = { chromium, firefox, webkit }[opts.browser];
  const args = opts.browser === 'chromium' ? ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] : [];
  const browser = await browserType.launch({ headless: true, args });
  const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height } });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${server.url}/index.html?autostart=1&p2p=0&exec=${encodeURIComponent(CAPTURE_COMMANDS + (opts.exec || ''))}`);

  // commands to run once the demo plays (after startup scripts and video settings)
  if (opts.late) {
    await page.waitForFunction(() => window.engineLog.some((l) => l.includes('Started playing demo')), null, { timeout: 120000, polling: 50 });
    await page.evaluate((cmd) => { Module.webCommands = [cmd]; }, opts.late);
  }
  const last = Math.max(...opts.frames);
  await page.waitForFunction((file) => {
    try { return window.Module && Module.FS && Module.FS.analyzePath(file).exists; } catch (e) { return false; }
  }, `/user/ScreenShots/${frameName(last)}.tga`, { timeout: 300000, polling: 500 });
  await page.evaluate(() => { Module.webCommands = ['dem_iAnimFrame=-1;']; });

  const frames = {};
  for (const n of opts.frames) {
    const data = await page.evaluate((file) => Array.from(Module.FS.readFile(file)), `/user/ScreenShots/${frameName(n)}.tga`);
    frames[n] = decodeTGA(Buffer.from(data));
  }
  const demoLine = (await page.evaluate(() => window.engineLog)).find((l) => l.includes('Started playing demo'));
  console.log(demoLine || 'no demo started?');
  await browser.close();
  server.close();
  return frames;
}

const frames = await capture();
fs.mkdirSync(opts.out, { recursive: true });
let worst = Infinity;
for (const n of opts.frames) {
  fs.writeFileSync(path.join(opts.out, `${frameName(n)}-web.png`), encodePNG(frames[n]));
  if (opts.native) {
    const nativeFile = path.join(opts.native, `${frameName(n)}.tga`);
    if (!fs.existsSync(nativeFile)) {
      console.log(`${frameName(n)}: no native frame`);
      continue;
    }
    const native = decodeTGA(fs.readFileSync(nativeFile));
    fs.writeFileSync(path.join(opts.out, `${frameName(n)}-native.png`), encodePNG(native));
    const c = compare(frames[n], native);
    fs.writeFileSync(path.join(opts.out, `${frameName(n)}-diff.png`), encodePNG(c.diff));
    console.log(`${frameName(n)}: mean difference ${c.mean.toFixed(2)}, PSNR ${c.psnr.toFixed(1)} dB`);
    worst = Math.min(worst, c.psnr);
  }
}
console.log(`frames saved in ${opts.out}`);
if (opts.native && worst !== Infinity) console.log(`worst PSNR ${worst.toFixed(1)} dB`);
