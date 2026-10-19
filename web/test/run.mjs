// Runs the web build in a browser, prints the engine log and optionally saves screenshots.
//
//   node run.mjs [--browser chromium|firefox|webkit] [--build jspi|asyncify]
//                [--args "+engine args"] [--seconds 20] [--shots 5,10,15] [--out dir]
//                [--headed] [--until "log text"]

import { chromium, firefox, webkit } from 'playwright';
import { serve } from './server.mjs';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const opts = {
    browser: 'chromium',
    build: '',
    args: '',
    seconds: 20,
    shots: [],
    out: '',
    headed: false,
    until: '',
    width: 1024,
    height: 768,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--browser': opts.browser = next(); break;
      case '--build': opts.build = next(); break;
      case '--args': opts.args = next(); break;
      case '--exec': opts.exec = next(); break;
      case '--seconds': opts.seconds = Number(next()); break;
      case '--shots': opts.shots = next().split(',').map(Number); break;
      case '--out': opts.out = next(); break;
      case '--headed': opts.headed = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--until': opts.until = next(); break;
      case '--size': [opts.width, opts.height] = next().split('x').map(Number); break;
      case '--profile': opts.profile = next().split(',').map(Number); break;
      case '--glstats': opts.glstats = true; break;
      case '--p2p': opts.p2p = true; break;
      // input at given times, e.g. "10:press:Escape,12:down:KeyW,14:up:KeyW,15:click,16:move:100:0"
      case '--actions': opts.actions = next().split(',').map((a) => a.split(':')); break;
      case '--trace': opts.trace = next().split(',').map(Number); break;
      default: throw new Error(`Unknown option ${a}`);
    }
  }
  return opts;
}

// print the functions with the most self time
function printProfile(profile) {
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    dt.set(id, (dt.get(id) || 0) + (profile.timeDeltas[i] || 0));
  }
  let total = 0;
  for (const [id, t] of dt) {
    const n = byId.get(id);
    const name = n.callFrame.functionName || '(anonymous)';
    self.set(name, (self.get(name) || 0) + t);
    total += t;
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  process.stdout.write(`--- CPU profile, ${(total / 1000).toFixed(0)} ms sampled ---\n`);
  for (const [name, t] of top) {
    process.stdout.write(`${(100 * t / total).toFixed(1).padStart(5)}%  ${name}\n`);
  }
}

// print the event names with the most total duration, per thread
function summarizeTrace(events) {
  const threadNames = new Map();
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name') threadNames.set(`${e.pid}:${e.tid}`, e.args.name);
  }
  const totals = new Map();
  for (const e of events) {
    if (e.ph !== 'X' || !e.dur) continue;
    const key = `${threadNames.get(`${e.pid}:${e.tid}`) || e.tid} | ${e.name}`;
    const t = totals.get(key) || { dur: 0, count: 0, max: 0 };
    t.dur += e.dur; t.count++; t.max = Math.max(t.max, e.dur);
    totals.set(key, t);
  }
  const top = [...totals.entries()].sort((a, b) => b[1].dur - a[1].dur).slice(0, 25);
  process.stdout.write('--- trace: total ms, count, max ms ---\n');
  for (const [k, t] of top) {
    process.stdout.write(`${(t.dur / 1000).toFixed(0).padStart(7)} ${String(t.count).padStart(6)} ${(t.max / 1000).toFixed(1).padStart(8)}  ${k}\n`);
  }
}

export async function runGame(opts) {
  const server = await serve();
  const browserType = { chromium, firefox, webkit }[opts.browser];
  const launchArgs = opts.browser === 'chromium'
    ? ['--enable-unsafe-swiftshader', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required']
    : [];
  const browser = await browserType.launch({ headless: !opts.headed, args: launchArgs });
  const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack || e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`console error: ${msg.text()}`);
    }
  });

  // the demo from the local web seed only, unless --p2p (WebRTC: public trackers)
  const query = new URLSearchParams({ autostart: '1', ...(opts.p2p ? { webrtc: 'true' } : {}) });
  if (opts.args) query.set('args', opts.args);
  if (opts.exec) query.set('exec', opts.exec);
  if (opts.build) query.set('build', opts.build);
  // count presented frames to report the frame rate
  await page.addInitScript(() => {
    window.frameCount = 0;
    const tick = () => { window.frameCount++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  // count WebGL calls (and time spent in them) per frame
  if (opts.glstats) {
    await page.addInitScript(() => {
      const stats = window.glStats = { calls: {}, time: {}, frames: 0 };
      const proto = WebGL2RenderingContext.prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const desc = Object.getOwnPropertyDescriptor(proto, name);
        if (typeof desc.value !== 'function') continue;
        const orig = desc.value;
        proto[name] = function (...args) {
          const t = performance.now();
          const r = orig.apply(this, args);
          stats.calls[name] = (stats.calls[name] || 0) + 1;
          stats.time[name] = (stats.time[name] || 0) + performance.now() - t;
          return r;
        };
      }
      const tick = () => { stats.frames++; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
  }
  await page.goto(`${server.url}/index.html?${query}`);
  let lastFrames = 0;
  let lastFrameTime = Date.now();
  const fpsSamples = [];
  let lines = [];

  // optional CPU profile between two times (chromium only)
  let cdp = null;
  let profiling = false;
  if (opts.profile && opts.browser === 'chromium') {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  }

  // optional browser trace between two times (chromium only), summarized by event duration
  let tracing = 0;
  const traceEvents = [];
  let traceCdp = null;
  if (opts.trace && opts.browser === 'chromium') {
    traceCdp = await page.context().newCDPSession(page);
    traceCdp.on('Tracing.dataCollected', (e) => traceEvents.push(...e.value));
  }

  const start = Date.now();
  const shots = [...opts.shots].sort((a, b) => a - b);
  const actions = [...(opts.actions || [])];
  const saved = [];
  let seen = 0;
  for (;;) {
    const elapsed = (Date.now() - start) / 1000;
    lines = await page.evaluate(() => window.engineLog || []);
    for (; seen < lines.length; seen++) {
      if (!opts.quiet) process.stdout.write(`${lines[seen]}\n`);
    }
    if (cdp && !profiling && elapsed >= opts.profile[0]) {
      profiling = true;
      await cdp.send('Profiler.start');
    }
    if (cdp && profiling && elapsed >= opts.profile[1]) {
      const { profile } = await cdp.send('Profiler.stop');
      printProfile(profile);
      cdp = null;
    }
    if (traceCdp && tracing === 0 && elapsed >= opts.trace[0]) {
      tracing = 1;
      await traceCdp.send('Tracing.start', { categories: 'devtools.timeline,toplevel,gpu,disabled-by-default-devtools.timeline,blink,cc,viz', transferMode: 'ReportEvents' });
    }
    if (traceCdp && tracing === 1 && elapsed >= opts.trace[1]) {
      tracing = 2;
      const done = new Promise((r) => traceCdp.once('Tracing.tracingComplete', r));
      await traceCdp.send('Tracing.end');
      await done;
      summarizeTrace(traceEvents);
    }
    if (Date.now() - lastFrameTime >= 5000) {
      const frames = await page.evaluate(() => window.frameCount);
      const fps = (frames - lastFrames) * 1000 / (Date.now() - lastFrameTime);
      fpsSamples.push(fps);
      const heap = await page.evaluate(() => (window.Module && Module.HEAPU8) ? Module.HEAPU8.length : 0);
      if (!opts.quiet) process.stdout.write(`[${elapsed.toFixed(0)}s] ${fps.toFixed(1)} fps, heap ${(heap / 1048576).toFixed(0)}MB\n`);
      if (opts.glstats) {
        const st = await page.evaluate(() => { const s = window.glStats; const r = { ...s }; s.calls = {}; s.time = {}; s.frames = 0; return r; });
        const f = Math.max(1, st.frames);
        const top = Object.entries(st.calls).sort((a, b) => st.time[b[0]] - st.time[a[0]]).slice(0, 8);
        process.stdout.write('   per frame: ' + top.map(([n, c]) => `${n} ${(c / f).toFixed(0)}x ${(st.time[n] / f).toFixed(2)}ms`).join(', ') + '\n');
      }
      lastFrames = frames;
      lastFrameTime = Date.now();
    }
    while (shots.length && elapsed >= shots[0]) {
      const t = shots.shift();
      if (opts.out) {
        fs.mkdirSync(opts.out, { recursive: true });
        const file = path.join(opts.out, `shot-${String(t).padStart(3, '0')}s.png`);
        await page.screenshot({ path: file });
        saved.push(file);
      }
    }
    while (actions.length && elapsed >= Number(actions[0][0])) {
      const [, what, a, b] = actions.shift();
      if (!opts.quiet) process.stdout.write(`[action ${what} ${a || ''} ${b || ''}]\n`);
      if (what === 'press') await page.keyboard.press(a);
      else if (what === 'down') await page.keyboard.down(a);
      else if (what === 'up') await page.keyboard.up(a);
      else if (what === 'click') await page.mouse.click(opts.width / 2, opts.height / 2);
      else if (what === 'clickat') {
        // like a person: point at it first, the menus react to the mouse a frame later
        await page.mouse.move(Number(a), Number(b));
        await page.waitForTimeout(100);
        await page.mouse.click(Number(a), Number(b));
      }
      else if (what === 'mousedown') await page.mouse.down();
      else if (what === 'mouseup') await page.mouse.up();
      else if (what === 'move') {
        // relative motion, as while the pointer is locked
        await page.evaluate(([dx, dy]) => {
          const c = document.getElementById('canvas');
          c.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementX: dx, movementY: dy, clientX: 10, clientY: 10 }));
        }, [Number(a), Number(b || 0)]);
      }
    }
    if (opts.until && lines.some((l) => l.includes(opts.until)) && !shots.length) break;
    if (elapsed >= opts.seconds) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  await browser.close();
  server.close();
  if (!opts.quiet) for (const e of errors) process.stdout.write(`${e}\n`);
  return { errors, saved, log: lines, fps: fpsSamples };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  const { saved } = await runGame(opts);
  for (const f of saved) process.stdout.write(`saved ${f}\n`);
}
