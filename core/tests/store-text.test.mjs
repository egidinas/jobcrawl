// Stored text (excerpt per posting, optional full description) in both backends, carried to resolved/v1 and the outputs.
// Golden files: UPDATE_GOLDEN=1 rewrites them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { openSqliteStore } from '../state/sqlite-store.mjs';
import { jsonStore } from '../state/store.mjs';
import { runBoardOn } from '../run-board.mjs';
import { runResolver, resolvedRecords } from '../resolve/resolver.mjs';
import { boardKey } from '../state/board-store.mjs';
import { validate } from '../schema/validate.mjs';
import { textOf, splitText, excerptOf, EXCERPT_CHARS } from '../text.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'cli', 'jobcrawl.mjs');
const GOLD = join(HERE, 'golden', 'store-text');
const NOW = '2026-11-28T12:00:00.000Z';
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JOBCRAWL_')));
const tmp = (p = 'jcx-txt-') => mkdtempSync(join(tmpdir(), p));
const cli = (args, env = {}) => spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { encoding: 'utf8', env: { ...ENV, ...env }, input: '' });
const run = (args, env) => { const r = cli(args, env); assert.equal(r.status, 0, r.stderr); return r.stdout; };
const T = (d, h = 6) => new Date(Date.UTC(2026, 10, d, h));

const THERMAL = '<div><h2>Senior Thermal Engineer (m/w/d)</h2>\n<p>At Acme Space we build satellites that link the world.   You will design, analyse and test the thermal control system of our\nspacecraft, own thermal models in ESATAN and run thermal vacuum campaigns together with our test team.</p>\n<ul><li>Degree in mechanical or aerospace engineering</li><li>Five years of spacecraft thermal design</li><li>Fluent German and English</li></ul>\n<p>We offer a team of 40 engineers in Oberpfaffenhofen, flexible hours, 30 days of leave &amp; a relocation package.</p></div>';
const THERMAL_V2 = THERMAL.replace('Five years', 'Eight years');
const AIT = 'Lead the assembly, integration and test of our flight hardware in Munich.\n\n' + 'You coordinate suppliers, write procedures, run vibration and thermal tests and report to the head of production. '.repeat(14);
const items = (thermal = THERMAL) => [
  { url: 'https://boards.greenhouse.io/acme/jobs/401', title: 'Senior Thermal Engineer (m/w/d)', location: 'Oberpfaffenhofen, Germany', postedAt: '2026-11-02', description: thermal },
  { url: 'https://boards.greenhouse.io/acme/jobs/402', title: 'AIT Manager', location: 'Munich, Germany', postedAt: '2026-11-03', description: AIT },
  { url: 'https://boards.greenhouse.io/acme/jobs/403', title: 'Quality Lead', location: 'Munich, Germany', postedAt: '2026-11-04' },
];
const read = (store, at, its) => runBoardOn(store, { name: 'Acme' }, { read: { ok: true, items: its, complete: true, emptyOk: true }, now: () => at });
const golden = (name, text) => {
  const f = join(GOLD, name);
  if (process.env.UPDATE_GOLDEN || !existsSync(f)) { mkdirSync(GOLD, { recursive: true }); writeFileSync(f, text); }
  assert.equal(text, readFileSync(f, 'utf8').replace(/\r\n/g, '\n'), `golden ${name}`);
};
const textRows = (store) => store.readTransaction((db) => db.prepare('SELECT id, content_hash, length(excerpt) AS n, description IS NOT NULL AS d FROM posting_text ORDER BY id').all());

test('text: excerpt is plain, whitespace-normalised, at most 1,200 characters; the description only on request', () => {
  const t = textOf({ description: THERMAL });
  assert.ok(t.excerpt.startsWith('Senior Thermal Engineer (m/w/d) At Acme Space we build satellites that link the world. You will design'));
  assert.ok(!/[<>\n]|  /.test(t.excerpt) && t.excerpt.includes('leave & a relocation'));
  assert.equal(t.description, undefined);
  assert.equal(textOf({ description: THERMAL }, { keepDescription: true }).description, t.excerpt);
  const long = textOf({ description: AIT }, { keepDescription: true });
  assert.ok(long.excerpt.length <= EXCERPT_CHARS && long.excerpt.endsWith('…') && long.description.length > EXCERPT_CHARS);
  assert.deepEqual(textOf({}), {});
  assert.equal(excerptOf('  a \n b '), 'a b');
  assert.deepEqual(splitText({ title: 'x', excerpt: 'e' }), { slim: { title: 'x' }, text: { excerpt: 'e' } });
});

test('sqlite: text lives in posting_text keyed by id and content hash; unchanged postings write nothing', async () => {
  const store = await openSqliteStore(tmp());
  await read(store, T(20), items());
  assert.equal(textRows(store).length, 2, 'two postings have text');
  assert.ok(textRows(store).every((r) => r.d === 0), 'no description by default');
  const slim = store.readTransaction((db) => db.prepare('SELECT rec FROM postings').all().map((r) => r.rec).join(''));
  assert.ok(!slim.includes('excerpt'), 'the posting record stays slim');
  const w0 = store.textWrites;
  assert.equal(w0, 2);
  await read(store, T(21), items());
  assert.equal(store.textWrites, w0, 'an unchanged read writes no text');
  const [, ...snap] = store.snapshot();
  assert.ok(snap.find((p) => p.title.startsWith('Senior')).jobcrawl.excerpt.startsWith('Senior Thermal Engineer'));
  assert.equal(snap.find((p) => p.title === 'Quality Lead').jobcrawl.excerpt, undefined, 'no text: stays null');
  const before = textRows(store).find((r) => r.n > 0);
  await read(store, T(22), items(THERMAL_V2));
  assert.equal(store.textWrites, w0 + 1, 'a changed description writes one row');
  assert.equal(textRows(store).length, 2, 'the old content hash is dropped');
  assert.ok(textRows(store).some((r) => r.id === before.id && r.content_hash !== before.content_hash));
  assert.ok(store.snapshot()[1 + 0], 'snapshot still reads');
  store.close();
});

test('sqlite: keepDescription stores the full text; the default does not', async () => {
  const on = await openSqliteStore(tmp(), { keepDescription: true });
  await read(on, T(20), items());
  assert.ok(textRows(on).filter((r) => r.d === 1).length === 2);
  const ait = on.snapshot().find((p) => p.title === 'AIT Manager');
  assert.ok(ait.description.length > EXCERPT_CHARS && ait.jobcrawl.excerpt.length <= EXCERPT_CHARS);
  on.close();
});

test('json backend: the same fields on the posting record; an old state without text stays valid', async () => {
  const root = tmp();
  const store = jsonStore(root);
  await read(store, T(20), items().slice(2));                       // an "old" state: no text at all
  assert.equal(store.snapshot().length, 2);
  assert.equal(store.snapshot()[1].jobcrawl.excerpt, undefined);
  await read(store, T(21), items());
  const posts = store.openBoard('Acme').postings;
  const rec = Object.values(posts).find((r) => r.title.startsWith('Senior'));
  assert.ok(rec.excerpt.startsWith('Senior Thermal Engineer') && rec.description === undefined);
  const snap = store.snapshot().slice(1);
  assert.ok(snap.find((p) => p.title === 'AIT Manager').jobcrawl.excerpt);
  assert.equal(snap.find((p) => p.title === 'Quality Lead').jobcrawl.excerpt, undefined);
  const kd = jsonStore(tmp(), { keepDescription: true });
  await read(kd, T(20), items());
  assert.ok(kd.snapshot().find((p) => p.title === 'AIT Manager').description.length > EXCERPT_CHARS);
});

test('resolved/v1 carries the excerpt as an optional field and still validates', async () => {
  const store = await openSqliteStore(tmp());
  await read(store, T(20), items());
  await runResolver(store, { facts: () => ({}), config: { companies: [] }, now: () => T(20, 12) });
  const recs = resolvedRecords(store, { after: 0, limit: 100 });
  assert.equal(recs.length, 3);
  for (const r of recs) assert.deepEqual(validate(r, 'resolved-v1'), [], JSON.stringify(r).slice(0, 120));
  assert.ok(recs.find((r) => r.title === 'AIT Manager').excerpt.startsWith('Lead the assembly'));
  assert.equal(recs.find((r) => r.title === 'Quality Lead').excerpt, undefined);
  store.close();
});

test('golden: excerpts through snapshot and feed outputs, both streams', async () => {
  const dir = tmp();
  const store = await openSqliteStore(dir);
  await read(store, T(20), items());
  await runResolver(store, { facts: () => ({}), config: { companies: [] }, now: () => T(20, 12) });
  store.close();
  const base = ['--data', dir, '--store', 'sqlite', '--now', NOW];
  golden('snapshot-delta.rss.xml', run(['snapshot', ...base, '--format', 'rss', '--title', 'Test board', '--link', 'https://example.test/']));
  golden('snapshot-delta.jsonfeed.json', run(['snapshot', ...base, '--format', 'jsonfeed']));
  golden('snapshot-resolved.ndjson', run(['snapshot', ...base, '--from', 'resolved', '--format', 'ndjson']));
  golden('feed-delta.ndjson', run(['feed', ...base, '--format', 'ndjson']));
  const full = run(['snapshot', ...base, '--format', 'ndjson', '--fields', 'title,description']);
  assert.ok(!full.includes('"description":"'), 'a store without keep_description has no full text to emit');
});

test('e2e: empty data dir, a replayed read, resolve, then RSS with excerpts (and the full text with keep_description)', () => {
  const base = tmp('jcx-txt-e2e-');
  const prof = join(base, 'profile'), rec = join(base, 'rec'), data = join(base, 'data');
  for (const d of [prof, join(rec, 'lists')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 't', crawl: { user_agent: 'jcx-test (+https://example.org)' } }));
  writeFileSync(join(prof, 'companies.json'), JSON.stringify({ tracked_companies: [{ name: 'Acme', provider: 'greenhouse', slug: 'acme' }] }));
  writeFileSync(join(rec, 'lists', `${boardKey('Acme')}.json.gz`), gzipSync(JSON.stringify({ board: 'Acme', provider: 'greenhouse', complete: true, items: items() })));
  const routing = join(base, 'routing.json');
  writeFileSync(routing, JSON.stringify({ schema: 'routing/v1', providers: { greenhouse: 'shadow' } }));
  const rss0 = run(['snapshot', '--data', data, '--store', 'sqlite', '--format', 'rss', '--now', NOW]);
  assert.ok(!rss0.includes('<item>'), 'empty data dir: a valid empty feed');
  run(['run', '--profile', prof, '--data', data, '--routing', routing, '--replay', rec, '--store', 'sqlite']);
  run(['resolve', '--data', data, '--store', 'sqlite']);
  for (const from of ['delta', 'resolved']) {
    const rss = run(['snapshot', '--data', data, '--store', 'sqlite', '--from', from, '--format', 'rss', '--now', NOW]);
    assert.equal((rss.match(/<item>/g) ?? []).length, 3, from);
    assert.ok(rss.includes('<description>Senior Thermal Engineer (m/w/d) At Acme Space we build satellites'), `${from}: excerpt in the feed`);
    assert.ok(rss.includes('leave &amp; a relocation package.</description>'));
    assert.ok(!rss.includes('Eight years') && !rss.includes('<h2>'));
  }
  const fields = ['snapshot', '--data', data, '--store', 'sqlite', '--format', 'ndjson', '--fields', 'title,description', '--now', NOW];
  assert.ok(!run(fields).includes('"description":"'), 'default store: no full description');
  const data2 = join(base, 'data2');
  run(['run', '--profile', prof, '--data', data2, '--routing', routing, '--replay', rec, '--store', 'sqlite', '--keep-description']);
  const full = run(['snapshot', '--data', data2, '--store', 'sqlite', '--format', 'ndjson', '--fields', 'title,description', '--now', NOW]).split('\n').filter(Boolean).slice(1).map((l) => JSON.parse(l));
  assert.ok(full.find((r) => r.title === 'AIT Manager').description.length > EXCERPT_CHARS);
  assert.equal(full.find((r) => r.title === 'Quality Lead').description, null);
});
