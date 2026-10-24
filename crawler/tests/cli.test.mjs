// The command line entry points: usage text and exit codes. Runs the scripts as child processes; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = (script, args, env = {}) => spawnSync(process.execPath, [resolve(ROOT, 'crawler', script), ...args], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, JOBCRAWL_PROFILE: '', ...env },
});

test('crawl --help prints usage and exits 0 (without touching a profile)', () => {
  const r = run('crawl.mjs', ['--profile', 'profiles/minimal', '--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usage: node crawler\/crawl\.mjs --profile <dir>/);
  assert.match(r.stdout, /--data <dir>/);
});

test('crawl without a profile exits 2 with a hint', () => {
  const r = run('crawl.mjs', []);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no profile/);
});

test('crawl with a missing profile folder exits 2', () => {
  const r = run('crawl.mjs', ['--profile', 'profiles/does-not-exist']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no profile\.json/);
});

test('run --help and catalog without a history name the next step', () => {
  const h = run('run.mjs', ['--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /run\.mjs --profile <dir>/);
  const c = run('catalog.mjs', ['--data', resolve(ROOT, 'profiles/minimal/no-such-data')]);
  assert.equal(c.status, 1);
  assert.match(c.stderr, /run crawler\/crawl\.mjs --profile <dir> first/);
});
