#!/usr/bin/env node
// One crawl cycle: crawl -> (optional) geo sanitize -> catalog -> (optional) board build.
//
//   node crawler/run.mjs --profile <dir> [--data <dir>] [--jd] [--refresh-only] [--geo] [--build] [--rebuild]
//
//   --jd, --refresh-only   passed to crawl.mjs (--jd saves descriptions, --refresh-only never adds new roles)
//   --geo                  run the python geo step (jobcrawl.geo.sanitize) before the catalog; it never stops the cycle
//   --build                run the python board build (`python -m jobcrawl build`) after the catalog; skipped when its inputs
//                          are unchanged since the last build, --rebuild forces it
//   PYTHON                 environment variable: the python interpreter for the optional steps (default python3)
//
// Nothing is published or pushed. The output is the data folder (catalog.json, the board files under <data>/site when built).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, profileDirFromArgs, resolveDataDir } from './profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);

if (flag('help')) {
  console.log('usage: node crawler/run.mjs --profile <dir> [--data <dir>] [--jd] [--refresh-only] [--geo] [--build] [--rebuild]');
  process.exit(0);
}
let PROFILE;
try { PROFILE = loadProfile(profileDirFromArgs(args)); } catch (e) { console.error(`[run] ${e.message}`); process.exit(2); }
if (!PROFILE) { console.error('[run] no profile. Pass --profile <dir> (or set JOBCRAWL_PROFILE).'); process.exit(2); }
const DATA = resolveDataDir(args.includes('--data') ? args[args.indexOf('--data') + 1] : undefined, PROFILE);
const PY = process.env.PYTHON ?? 'python3';

const node = (script, extra = []) => spawnSync(process.execPath, ['--no-warnings', resolve(HERE, script), '--profile', PROFILE.dir, '--data', DATA, ...extra], { stdio: 'inherit' });
const python = (moduleArgs) => spawnSync(PY, ['-m', 'jobcrawl', ...moduleArgs], { stdio: 'inherit', cwd: REPO });

// The board build only needs to run when something it reads is newer than the last build: the catalog (rewritten only when the open
// set changed), the profile and its companies file, and the Python sources. The marker is written after a successful build.
const BUILT = resolve(DATA, '.board-built');
const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
function pySources(dir) {
  try { return readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.py')).map((f) => resolve(dir, String(f))); } catch { return []; }
}
function boardUpToDate() {
  if (flag('rebuild') || !existsSync(BUILT)) return false;
  const built = mtime(BUILT);
  const inputs = [resolve(DATA, 'catalog.json'), PROFILE.file, PROFILE.companiesFile, ...pySources(resolve(REPO, 'jobcrawl'))];
  return inputs.every((p) => mtime(p) <= built);
}

const steps = [
  ['crawl', () => node('crawl.mjs', ['--jd', '--refresh-only'].filter((f) => flag(f.slice(2))))],
  ...(flag('geo') ? [['geo', () => {
    // Canonical places for every open position and a place on each new one (GeoNames gazetteer, no network).
    const r = spawnSync(PY, ['-m', 'jobcrawl.geo.sanitize', '--data', DATA], { stdio: 'inherit', cwd: REPO });
    if (r.status !== 0) console.error(`[run] geo step failed (exit ${r.status}); continuing with the raw locations`);
    return { status: 0 };
  }]] : []),
  ['catalog', () => node('catalog.mjs')],
  ...(flag('build') ? [['board', () => {
    if (boardUpToDate()) { console.log('[run] board inputs unchanged since the last build, skipped (--rebuild forces it)'); return { status: 0 }; }
    const r = python(['build', '--profile', PROFILE.dir, '--catalog', resolve(DATA, 'catalog.json'), '--out', resolve(DATA, 'site')]);
    if (r.status === 0) writeFileSync(BUILT, new Date().toISOString() + '\n');
    return r;
  }]] : []),
];
for (const [name, run] of steps) {
  const r = run();
  if (r.status !== 0) { console.error(`[run] step "${name}" failed (exit ${r.status}); later steps skipped`); process.exit(r.status || 1); }
}
