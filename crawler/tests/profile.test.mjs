// Profile loader and the data-folder rule. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, profileDirFromArgs, resolveDataDir, applyProfileFilters, ProfileError } from '../profile.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = () => mkdtempSync(join(tmpdir(), 'jobcrawl-profile-'));
const write = (dir, obj) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'profile.json'), typeof obj === 'string' ? obj : JSON.stringify(obj)); };

test('aerospace profile resolves its companies file and data folder against the profile folder', () => {
  const p = loadProfile(join(ROOT, 'profiles/aerospace'));
  assert.equal(p.companiesFile, join(ROOT, 'profiles/aerospace/companies.json'));
  assert.equal(p.dataDir, join(ROOT, 'profiles/aerospace/data'));
  assert.equal(p.catalogueFile, null);
  assert.equal(p.titleFilter, null);                       // the filters stay in companies.json
  assert.ok(p.relevance.keywords.includes('word:space'));
  assert.ok(p.relevance.ssic_deeptech.includes('303'));
});

test('minimal profile loads with its own lists', () => {
  const p = loadProfile(join(ROOT, 'profiles/minimal'));
  assert.equal(p.name, 'minimal');
  assert.ok(p.relevance.keywords.length > 0);
  assert.deepEqual(p.relevance.ssic_deeptech, []);
});

test('no folder gives null; a missing profile.json names the folder', () => {
  assert.equal(loadProfile(null), null);
  const d = tmp();
  try { assert.throws(() => loadProfile(d), (e) => e instanceof ProfileError && e.message.includes('no profile.json')); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('invalid JSON and wrong types name the key', () => {
  const d = tmp();
  try {
    write(join(d, 'a'), '{ not json');
    assert.throws(() => loadProfile(join(d, 'a')), /not valid JSON/);
    write(join(d, 'b'), { crawl: { relevance: { keywords: 'software' } } });
    assert.throws(() => loadProfile(join(d, 'b')), /crawl\.relevance\.keywords must be a list of strings/);
    write(join(d, 'c'), { crawl: { companies_file: 3 } });
    assert.throws(() => loadProfile(join(d, 'c')), /crawl\.companies_file must be a string/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('defaults: companies.json next to the profile, no catalogue, no data_dir', () => {
  const d = tmp();
  try {
    write(d, {});
    const p = loadProfile(d);
    assert.equal(p.companiesFile, join(d, 'companies.json'));
    assert.equal(p.catalogueFile, null);
    assert.equal(p.dataDir, null);
    assert.deepEqual(p.relevance, { keywords: [], negative: [], ssic_deeptech: [] });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('--profile and JOBCRAWL_PROFILE', () => {
  assert.equal(profileDirFromArgs(['--profile', 'profiles/minimal'], {}), 'profiles/minimal');
  assert.equal(profileDirFromArgs([], { JOBCRAWL_PROFILE: 'x/y' }), 'x/y');
  assert.equal(profileDirFromArgs(['--profile', 'a'], { JOBCRAWL_PROFILE: 'x/y' }), 'a');
  assert.equal(profileDirFromArgs([], {}), null);
  assert.throws(() => profileDirFromArgs(['--profile'], {}), ProfileError);
  assert.throws(() => profileDirFromArgs(['--profile', '--data', 'd'], {}), ProfileError);
});

test('data folder: --data, then the profile data_dir, then ./data', () => {
  const p = loadProfile(join(ROOT, 'profiles/minimal'));
  assert.equal(resolveDataDir('/abs/elsewhere', p), '/abs/elsewhere');
  assert.equal(resolveDataDir(undefined, p), join(ROOT, 'profiles/minimal/data'));
  assert.equal(resolveDataDir(undefined, null), resolve('data'));
});

test('applyProfileFilters: profile filters replace the companies file ones only when set', () => {
  const cfg = { title_filter: { positive: ['A'] }, location_filter: { allow: ['B'] } };
  assert.equal(applyProfileFilters(cfg, null), cfg);
  assert.deepEqual(applyProfileFilters(cfg, { titleFilter: null, locationFilter: null }), cfg);
  assert.deepEqual(applyProfileFilters(cfg, { titleFilter: { positive: ['C'] }, locationFilter: null }).title_filter, { positive: ['C'] });
  assert.deepEqual(applyProfileFilters(cfg, { titleFilter: null, locationFilter: null }).location_filter, { allow: ['B'] });
});

test('crawl.user_agent and crawl.review_dir are optional and resolved like the other keys', async () => {
  const d = tmp();
  try {
    write(d, { crawl: { user_agent: 'Mozilla/5.0 (compatible; example-crawler; +https://example.org/about)', review_dir: 'review' } });
    const p = loadProfile(d);
    assert.equal(p.userAgent, 'Mozilla/5.0 (compatible; example-crawler; +https://example.org/about)');
    assert.equal(p.reviewDir, join(d, 'review'));
    write(d, {});
    assert.equal(loadProfile(d).userAgent, null);
    assert.equal(loadProfile(d).reviewDir, null);
    write(d, { crawl: { user_agent: 7 } });
    assert.throws(() => loadProfile(d), /crawl.user_agent/);
    // the user agent is a live binding: providers see the profile's value once it is set
    const ua = await import('../useragent.mjs');
    ua.setUserAgent('example-crawler/1');
    assert.equal(ua.UA, 'example-crawler/1');
    ua.setUserAgent(null);
    assert.equal(ua.UA, ua.DEFAULT_UA);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
