// Free-space guard: the min_free_mb profile key, checkDisk, and the crawl exit code when the disk is too full. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, ProfileError } from '../profile.mjs';
import { freeMb, checkDisk } from '../diskguard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = () => mkdtempSync(join(tmpdir(), 'jobcrawl-disk-'));
const write = (dir, obj) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'profile.json'), JSON.stringify(obj)); };

test('crawl.min_free_mb defaults to 0 and must be a number >= 0', () => {
  const d = tmp();
  try {
    write(join(d, 'none'), {});
    assert.equal(loadProfile(join(d, 'none')).minFreeMb, 0);
    write(join(d, 'ok'), { crawl: { min_free_mb: 1024 } });
    assert.equal(loadProfile(join(d, 'ok')).minFreeMb, 1024);
    write(join(d, 'zero'), { crawl: { min_free_mb: 0 } });
    assert.equal(loadProfile(join(d, 'zero')).minFreeMb, 0);
    write(join(d, 'str'), { crawl: { min_free_mb: '1024' } });
    assert.throws(() => loadProfile(join(d, 'str')), (e) => e instanceof ProfileError && e.message === 'crawl.min_free_mb must be a number >= 0');
    write(join(d, 'neg'), { crawl: { min_free_mb: -5 } });
    assert.throws(() => loadProfile(join(d, 'neg')), (e) => e instanceof ProfileError && /crawl\.min_free_mb/.test(e.message));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('freeMb reports a finite size for a folder that does not exist yet (nearest existing parent)', () => {
  const d = tmp();
  try {
    const f = freeMb(join(d, 'not', 'yet', 'here'));
    assert.ok(Number.isFinite(f) && f >= 0, String(f));
    assert.ok(Math.abs(f - freeMb(d)) < 1024, 'same filesystem as the existing parent');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('checkDisk: null for 0 and for a tiny limit, a message for an impossible limit', () => {
  const d = tmp();
  try {
    assert.equal(checkDisk(d, 0), null);
    assert.equal(checkDisk(d, 1), null);
    const msg = checkDisk(d, 1e12);
    assert.match(msg, /^only \d+ MB free on .+ \(crawl\.min_free_mb is 1000000000000\): nothing crawled, free some space first$/);
    assert.ok(msg.includes(resolve(d)));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('crawl exits 3 with the message and writes nothing when the disk is too full', () => {
  const p = tmp(), data = tmp();
  try {
    write(p, { crawl: { min_free_mb: 1e12 } });
    writeFileSync(join(p, 'companies.json'), JSON.stringify({
      tracked_companies: [{ name: 'Example GmbH', ats: 'greenhouse', slug: 'example', enabled: false }],
    }));
    const r = spawnSync(process.execPath, [resolve(ROOT, 'crawler/crawl.mjs'), '--profile', p, '--data', join(data, 'out')], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, JOBCRAWL_PROFILE: '' },
    });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /^crawl: only \d+ MB free on .+ \(crawl\.min_free_mb is 1000000000000\): nothing crawled, free some space first/m);
    assert.equal(existsSync(join(data, 'out')), false, 'data folder must not be created');
    assert.deepEqual(readdirSync(data), []);
  } finally {
    rmSync(p, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});
