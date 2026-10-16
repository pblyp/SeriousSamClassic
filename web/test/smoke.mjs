// Smoke test: starts the Karnak demo level in each browser and build, walks,
// shoots, and checks for errors, frame rate and that something was drawn.
//
//   node smoke.mjs [chromium:jspi,chromium:asyncify,firefox:jspi,webkit:jspi]

import { runGame } from './run.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configs = (process.argv[2] || 'chromium:jspi,chromium:asyncify,firefox:jspi,webkit:jspi')
  .split(',').map((c) => c.split(':'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-smoke-'));
let failed = 0;

// PNG screenshots of a game frame are a few hundred KB; an all black frame compresses to almost nothing
const looksDrawn = (file) => fs.statSync(file).size > 50000;

for (const [browser, build] of configs) {
  const { errors, saved, log, fps } = await runGame({
    browser, build, quiet: true,
    args: '+level Levels/KarnakDemo.wld',
    seconds: 30, shots: [26], out: path.join(out, `${browser}-${build}`),
    width: 1024, height: 768, until: '',
    actions: [
      ['8', 'click'], ['9', 'press', 'Escape'], ['11', 'down', 'KeyW'], ['15', 'up', 'KeyW'],
      ['16', 'mousedown'], ['18', 'mouseup'], ['19', 'down', 'ArrowLeft'], ['21', 'up', 'ArrowLeft'],
    ],
  });
  const problems = [...errors];
  const usedBuild = log.find((l) => l.startsWith('Using the'));
  if (!usedBuild || !usedBuild.includes(build)) problems.push(`expected the ${build} build, got: ${usedBuild}`);
  if (!log.some((l) => l.includes('Adding player'))) problems.push('the level did not start');
  for (const l of log) {
    if (/FatalError|Cannot |error/i.test(l) && !/PersistentSymbols|SeriousSam\.gms|Cannot load game settings|ModName\.var|DefaultMod\.txt|gfx_fProbeRatio|different types/.test(l)) {
      problems.push(`log: ${l}`);
    }
  }
  const steadyFps = fps.slice(2);
  const minFps = steadyFps.length ? Math.min(...steadyFps) : 0;
  if (minFps < 30) problems.push(`frame rate dropped to ${minFps.toFixed(1)} fps`);
  if (!saved.length || !looksDrawn(saved[0])) problems.push('the screenshot looks empty');

  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${browser} ${build}: min ${minFps.toFixed(0)} fps`);
  for (const p of problems) console.log(`     ${p}`);
  failed += problems.length ? 1 : 0;
}
console.log(`screenshots in ${out}`);
process.exit(failed ? 1 : 0);
