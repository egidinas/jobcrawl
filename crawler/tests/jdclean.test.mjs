// Description retention (crawl.jd_keep_days, crawler/jdclean.mjs): which files go, which stay, the profile key, and the standalone
// --jd-cleanup-only mode. Temp folders only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanJd, jdFileName } from '../jdclean.mjs';
import { loadProfile, ProfileError } from '../profile.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = () => mkdtempSync(join(tmpdir(), 'jobcrawl-jdclean-'));
const TODAY = '2026-10-26';
const ago = (n) => new Date(Date.parse(TODAY) - n * 864e5).toISOString().slice(0, 10);

// The fixture of the spec: an open role 200 days old (kept), a gone role 100 days old (removed), a gone role 30 days old (kept),
// a filtered role 120 days old (removed), plus an extra dup role 95 days old (removed) and an unknown .md file (kept).
const ROWS = [
  { url: 'https://jobs.example.com/open-old', company: 'Example', title: 'Open old', location: 'Berlin', first_seen: ago(300), last_seen: ago(200), status: 'open', posted: '' },
  { url: 'https://jobs.example.com/gone-100', company: 'Example', title: 'Gone 100', location: 'Berlin', first_seen: ago(150), last_seen: ago(100), status: 'gone', posted: '' },
  { url: 'https://jobs.example.com/gone-30', company: 'Example', title: 'Gone 30', location: 'Berlin', first_seen: ago(60), last_seen: ago(30), status: 'gone', posted: '' },
  { url: 'https://jobs.example.com/filtered-120', company: 'Example', title: 'Filtered 120', location: 'Berlin', first_seen: ago(130), last_seen: ago(120), status: 'filtered', posted: '' },
  { url: 'https://jobs.example.com/dup-95', company: 'Example', title: 'Dup 95', location: 'Berlin', first_seen: ago(100), last_seen: ago(95), status: 'dup', posted: '' },
];
const HEADER = ['url', 'company', 'title', 'location', 'first_seen', 'last_seen', 'status', 'posted'];

/** A data folder with the description files of ROWS, plus an unknown .md file; returns { data, jd, names }. */
function fixture(rows = ROWS) {
  const data = tmp(), jd = join(data, 'jd');
  mkdirSync(jd, { recursive: true });
  const names = {};
  for (const r of rows) {
    names[r.url] = jdFileName(r.url);
    writeFileSync(join(jd, names[r.url]), `# ${r.title}\n\n${'body '.repeat(300)}\n`);
  }
  writeFileSync(join(jd, 'notes.md'), 'hand-written, not from the crawler\n');
  writeFileSync(join(data, 'scan-history.tsv'), [HEADER.join('\t'), ...rows.map((r) => HEADER.map((h) => r[h]).join('\t'))].join('\n') + '\n');
  return { data, jd, names };
}
const historyOf = (rows) => new Map(rows.map((r) => [r.url, r]));
const left = (jd) => readdirSync(jd).sort();

test('90 days: the gone and filtered roles past 90 days go, the open, recent and unknown files stay', () => {
  const { data, jd, names } = fixture();
  try {
    const r = cleanJd({ history: historyOf(ROWS), jdDir: jd, keepDays: 90, today: TODAY });
    const removed = r.removed.map((x) => x.name).sort();
    assert.deepEqual(removed, [names[ROWS[1].url], names[ROWS[3].url], names[ROWS[4].url]].sort());
    assert.equal(r.kept, 3);                                         // open 200d, gone 30d, unknown notes.md
    assert.ok(r.bytes > 0);
    assert.deepEqual(left(jd), [names[ROWS[0].url], names[ROWS[2].url], 'notes.md'].sort());
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('30 days: "more than" is strict, so the role last seen exactly 30 days ago stays; the open role stays', () => {
  const { data, jd, names } = fixture();
  try {
    const r = cleanJd({ history: historyOf(ROWS), jdDir: jd, keepDays: 30, today: TODAY });
    assert.equal(r.removed.length, 3);
    assert.ok(existsSync(join(jd, names[ROWS[2].url])), 'gone 30 days ago: exactly 30 is not more than 30');
    assert.ok(existsSync(join(jd, names[ROWS[0].url])), 'open role never removed');
    assert.ok(existsSync(join(jd, 'notes.md')), 'unknown file never removed');
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('dry run counts the same files and deletes nothing', () => {
  const { data, jd } = fixture();
  try {
    const before = left(jd);
    const r = cleanJd({ history: historyOf(ROWS), jdDir: jd, keepDays: 90, today: TODAY, dryRun: true });
    assert.equal(r.removed.length, 3);
    assert.deepEqual(left(jd), before);
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('jd_keep_days 0 removes nothing', () => {
  const { data, jd } = fixture();
  try {
    const before = left(jd);
    const r = cleanJd({ history: historyOf(ROWS), jdDir: jd, keepDays: 0, today: TODAY });
    assert.equal(r.removed.length, 0);
    assert.match(r.skipped, /cleanup off/);
    assert.deepEqual(left(jd), before);
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('an empty history removes nothing (a broken history must not wipe the folder)', () => {
  const { data, jd } = fixture();
  try {
    const before = left(jd);
    const r = cleanJd({ history: new Map(), jdDir: jd, keepDays: 90, today: TODAY });
    assert.equal(r.removed.length, 0);
    assert.equal(r.skipped, 'history empty');
    assert.deepEqual(left(jd), before);
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('a row without a usable last_seen date is never a reason to remove its file', () => {
  const { data, jd, names } = fixture([ROWS[1]]);
  try {
    const bad = [{ ...ROWS[1], last_seen: '' }];
    const r = cleanJd({ history: historyOf(bad), jdDir: jd, keepDays: 90, today: TODAY });
    assert.equal(r.removed.length, 0);
    assert.ok(existsSync(join(jd, names[ROWS[1].url])));
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('a missing jd folder is a no-op', () => {
  const d = tmp();
  try {
    const r = cleanJd({ history: historyOf(ROWS), jdDir: join(d, 'jd'), keepDays: 90, today: TODAY });
    assert.equal(r.removed.length, 0);
    assert.equal(r.skipped, 'no jd folder');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('crawl.jd_keep_days defaults to 90 and must be a number >= 0', () => {
  const d = tmp();
  const write = (name, obj) => { mkdirSync(join(d, name), { recursive: true }); writeFileSync(join(d, name, 'profile.json'), JSON.stringify(obj)); };
  try {
    write('none', {});
    assert.equal(loadProfile(join(d, 'none')).jdKeepDays, 90);
    write('zero', { crawl: { jd_keep_days: 0 } });
    assert.equal(loadProfile(join(d, 'zero')).jdKeepDays, 0);
    write('str', { crawl: { jd_keep_days: '90' } });
    assert.throws(() => loadProfile(join(d, 'str')), (e) => e instanceof ProfileError && e.message === 'crawl.jd_keep_days must be a number >= 0');
    write('neg', { crawl: { jd_keep_days: -1 } });
    assert.throws(() => loadProfile(join(d, 'neg')), (e) => e instanceof ProfileError && /crawl\.jd_keep_days/.test(e.message));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('crawl.history_prune_days defaults to 0 (never prune) and must be a number >= 0', () => {
  const d = tmp();
  const write = (name, obj) => { mkdirSync(join(d, name), { recursive: true }); writeFileSync(join(d, name, 'profile.json'), JSON.stringify(obj)); };
  try {
    write('none', {});
    assert.equal(loadProfile(join(d, 'none')).historyPruneDays, 0);
    write('zero', { crawl: { history_prune_days: 0 } });
    assert.equal(loadProfile(join(d, 'zero')).historyPruneDays, 0);
    write('valid', { crawl: { history_prune_days: 365 } });
    assert.equal(loadProfile(join(d, 'valid')).historyPruneDays, 365);
    write('str', { crawl: { history_prune_days: '90' } });
    assert.throws(() => loadProfile(join(d, 'str')), (e) => e instanceof ProfileError && e.message === 'crawl.history_prune_days must be a number >= 0');
    write('neg', { crawl: { history_prune_days: -1 } });
    assert.throws(() => loadProfile(join(d, 'neg')), (e) => e instanceof ProfileError && e.message === 'crawl.history_prune_days must be a number >= 0');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('crawl --jd-cleanup-only removes the old descriptions, runs no crawl and prints the one-line summary', () => {
  const { data, jd, names } = fixture();
  const p = tmp();
  try {
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'profile.json'), JSON.stringify({ crawl: { jd_keep_days: 90 } }));
    writeFileSync(join(p, 'companies.json'), JSON.stringify({ tracked_companies: [] }));
    const r = spawnSync(process.execPath, [resolve(ROOT, 'crawler/crawl.mjs'), '--profile', p, '--data', data, '--jd-cleanup-only'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, JOBCRAWL_PROFILE: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^descriptions: 3 removed \(not seen for more than 90 days\), 3 kept$/m);
    assert.ok(!existsSync(join(jd, names[ROWS[1].url])));
    assert.ok(existsSync(join(jd, names[ROWS[0].url])));
    // The history file is not touched by the cleanup.
    assert.equal(readdirSync(data).includes('scan-history.tsv'), true);
    assert.ok(!existsSync(join(data, 'last-new.json')), 'no crawl output written');
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(p, { recursive: true, force: true });
  }
});
