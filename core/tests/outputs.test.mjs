// Outputs (row 2A.2): field allowlist, snapshot NDJSON / JSON Feed 1.1 / RSS 2.0 over both streams, bookmarks, golden files,
// and an e2e from an empty data folder to RSS. Golden files: UPDATE_GOLDEN=1 rewrites them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openSqliteStore } from '../state/sqlite-store.mjs';
import { runBoardOn } from '../run-board.mjs';
import { runResolver } from '../resolve/resolver.mjs';
import { parseFields, DEFAULT_FIELDS, excerptOf, fromPosting, project, FieldError, EXCERPT_CHARS } from '../outputs/fields.mjs';
import { renderRss, renderJsonFeed, renderNdjson } from '../outputs/render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'cli', 'jobcrawl.mjs');
const GOLD = join(HERE, 'golden', 'outputs');
const NOW = '2026-11-28T12:00:00.000Z';
const tmp = () => mkdtempSync(join(tmpdir(), 'jcx-out-'));
const cli = (args) => spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { encoding: 'utf8' });
const T = (d, h = 6) => new Date(Date.UTC(2026, 10, d, h));
const item = (n, title, location = 'Munich, Germany', postedAt = `2026-11-0${n}`) => ({ url: `https://boards.greenhouse.io/acme/jobs/40${n}`, title, location, postedAt });

async function fixture() {
  const dir = tmp();
  const store = await openSqliteStore(dir);
  const read = (board, at, items) => runBoardOn(store, { name: board }, { read: { ok: true, items, complete: true, emptyOk: true }, now: () => at });
  await read('Acme', T(20), [item(1, 'Senior Thermal Engineer (m/w/d)'), item(2, 'AIT Manager <Munich> & Test', 'Oberpfaffenhofen, Germany')]);
  await read('Beta', T(21), [{ url: 'https://jobs.lever.co/beta/aaaa-1111', title: 'Systems Engineer', location: 'Berlin', postedAt: '2026-11-03' }]);
  await read('Acme', T(22), [item(1, 'Senior Thermal Engineer (m/w/d)'), item(2, 'AIT Manager <Munich> & Test', 'Oberpfaffenhofen, Germany'), item(4, 'Quality Lead')]);
  await runResolver(store, { facts: () => ({}), config: { companies: [] }, now: () => T(22, 12) });
  store.close();
  return dir;
}
const golden = (name, text) => {
  const f = join(GOLD, name);
  if (process.env.UPDATE_GOLDEN || !existsSync(f)) { mkdirSync(GOLD, { recursive: true }); writeFileSync(f, text); }
  assert.equal(text, readFileSync(f, 'utf8').replace(/\r\n/g, '\n'), `golden ${name}`);
};
const run = (args) => { const r = cli(args); assert.equal(r.status, 0, r.stderr); return r.stdout; };

test('fields: default set, explicit description only by name, private and unknown names refused', () => {
  assert.deepEqual(parseFields(undefined), DEFAULT_FIELDS);
  assert.ok(!DEFAULT_FIELDS.includes('description'));
  assert.deepEqual(parseFields('title,description,title'), ['title', 'description']);
  for (const bad of ['match_score', 'fit_verdict', 'keywords', 'title,match_score', 'fit-verdict', 'private_notes', 'salary_target']) assert.throws(() => parseFields(bad), FieldError, bad);
  assert.throws(() => parseFields('title,bogus'), /unknown field/);
});

test('excerpt: tags stripped, cut at a word boundary to at most 1200 characters', () => {
  const long = `<p>${'Thermal vacuum campaign. '.repeat(200)}</p>`;
  const e = excerptOf(long);
  assert.ok(e.length <= EXCERPT_CHARS && e.endsWith('…') && !e.includes('<'));
  assert.equal(excerptOf('<b>Short</b>  text'), 'Short text');
});

test('private data never reaches an output, even when the source record carries it', () => {
  const p = { '@type': 'JobPosting', title: 'T', url: 'https://x.test/1', description: 'Plain description', match_score: 4.2, fit_verdict: 'apply', keywords: ['laser'],
    jobcrawl: { id: 'jc1_a', board: 'B', status: 'open', first_seen: NOW, match_score: 4.2, keywords: ['laser'] } };
  const rec = fromPosting(p);
  const fields = parseFields('title,url,excerpt,description');
  const all = [renderNdjson([rec], { fields, from: 'delta', now: new Date(NOW) }), renderJsonFeed([rec], { fields, now: new Date(NOW) }), renderRss([rec], { fields, now: new Date(NOW) })].join('\n');
  for (const k of ['match_score', 'fit_verdict', 'keywords', 'apply', '4.2']) assert.ok(!all.includes(k), k);
  assert.deepEqual(Object.keys(project(rec, fields)), ['id', 'title', 'url', 'excerpt', 'description']);
  const dir = tmp();
  for (const f of ['match_score', 'title,fit_verdict', 'keywords']) {
    const r = cli(['snapshot', '--data', dir, '--format', 'rss', '--fields', f]);
    assert.equal(r.status, 2, f);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /private/);
  }
});

test('golden: snapshot of the per-board stream in all three formats', async () => {
  const dir = await fixture();
  const base = ['snapshot', '--data', dir, '--store', 'sqlite', '--now', NOW];
  golden('snapshot-delta.ndjson', run([...base, '--format', 'ndjson']));
  golden('snapshot-delta.jsonfeed.json', run([...base, '--format', 'jsonfeed', '--title', 'Test board', '--link', 'https://example.test/', '--feed-url', 'https://example.test/feed.json']));
  golden('snapshot-delta.rss.xml', run([...base, '--format', 'rss', '--title', 'Test board', '--link', 'https://example.test/', '--feed-url', 'https://example.test/feed.xml']));
  assert.equal(run([...base, '--format', 'rss']), run([...base, '--format', 'rss']), 'deterministic');
  const rss = run([...base, '--format', 'rss']);
  assert.ok(rss.includes('AIT Manager &lt;Munich&gt; &amp; Test'), 'escaped');
  assert.ok(!rss.includes('<description>Plain'), 'no description by default');
});

test('golden: the resolved stream in all three formats', async () => {
  const dir = await fixture();
  const base = ['snapshot', '--data', dir, '--from', 'resolved', '--now', NOW];
  golden('snapshot-resolved.ndjson', run([...base, '--format', 'ndjson']));
  golden('snapshot-resolved.jsonfeed.json', run([...base, '--format', 'jsonfeed']));
  golden('snapshot-resolved.rss.xml', run([...base, '--format', 'rss']));
  const f = ['feed', '--data', dir, '--store', 'sqlite', '--from', 'resolved', '--now', NOW, '--format', 'ndjson'];
  golden('feed-resolved.ndjson', run(f));
});

test('feed: a consumer bookmark moves only with --commit, for both streams', async () => {
  const dir = await fixture();
  for (const from of ['delta', 'resolved']) {
    const args = ['feed', '--data', dir, '--store', 'sqlite', '--from', from, '--format', 'jsonfeed', '--consumer', `c-${from}`, '--now', NOW];
    const a = JSON.parse(run(args));
    assert.ok(a.items.length >= 3, from);
    assert.equal(JSON.parse(run(args)).items.length, a.items.length, 'no --commit: nothing moved');
    run([...args, '--commit']);
    assert.equal(JSON.parse(run(args)).items.length, 0, `${from}: after the commit the feed is empty`);
  }
  assert.ok(JSON.parse(run(['bookmark', '--data', dir, '--json'])).length >= 1);
});

test('e2e: empty data folder to a valid RSS 2.0 file, then the same folder after a run', async () => {
  const dir = tmp();
  const out = join(tmp(), 'jobs.xml');
  run(['snapshot', '--data', dir, '--store', 'sqlite', '--format', 'rss', '--out', out, '--now', NOW]);
  const empty = readFileSync(out, 'utf8');
  assert.match(empty, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<rss version="2.0"/);
  assert.ok(!empty.includes('<item>') && empty.includes('<lastBuildDate>Sat, 28 Nov 2026 12:00:00 GMT</lastBuildDate>'));
  assert.equal((empty.match(/<channel>/g) ?? []).length, 1);
  const filled = await fixture();
  run(['snapshot', '--data', filled, '--store', 'sqlite', '--format', 'rss', '--out', out, '--now', NOW]);
  const xml = readFileSync(out, 'utf8');
  assert.equal((xml.match(/<item>/g) ?? []).length, 4);
  assert.equal((xml.match(/<\/item>/g) ?? []).length, 4);
  for (const tag of ['title', 'link', 'guid', 'pubDate', 'dc:creator']) assert.equal((xml.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length >= 4, true, tag);
});

test('cli: --fields, --from and --out need --format; unknown format and stream are usage errors', async () => {
  const dir = tmp();
  for (const a of [['--fields', 'title'], ['--from', 'resolved'], ['--format', 'html'], ['--format', 'rss', '--from', 'x']]) assert.equal(cli(['snapshot', '--data', dir, ...a]).status, 2, a.join(' '));
  assert.equal(cli(['feed', '--data', dir, '--out', 'x']).status, 2);
});
