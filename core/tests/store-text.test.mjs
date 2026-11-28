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
import { applyRun } from '../delta/board-delta.mjs';
import { RUNS } from './helpers/text-fixture.mjs';
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
  const store = await openSqliteStore(tmp(), { storeText: true });
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
  const store = jsonStore(root, { storeText: true });
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
  const store = await openSqliteStore(tmp(), { storeText: true });
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
  const store = await openSqliteStore(dir, { storeText: true });
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

test('opt-in: applyRun and the stores with default options are byte-identical to main d50ace8 (shadow hook, authority)', async () => {
  const a = applyRun(null, RUNS[0].run, { board: 'Acme', now: new Date(RUNS[0].now) });
  const b = applyRun(a.state, RUNS[1].run, { board: 'Acme', now: new Date(RUNS[1].now) });
  const f = join(GOLD, 'applyrun-main-d50ace8.json');
  const eol = String.fromCharCode(10), cr = String.fromCharCode(13);
  assert.equal(JSON.stringify([a, b], null, 1) + eol, readFileSync(f, 'utf8').split(cr + eol).join(eol), 'state and events of default applyRun equal the ones main produced');
  // the stores without the option store no text either (runBoardOn with a default store)
  const sq = await openSqliteStore(tmp());
  await read(sq, T(20), items());
  assert.equal(textRows(sq).length, 0);
  assert.ok(!JSON.stringify(sq.events({ after: 0 })).includes('excerpt'));
  sq.close();
  const js = jsonStore(tmp());
  await read(js, T(20), items());
  assert.ok(!JSON.stringify(js.openBoard('Acme')).includes('excerpt'));
});

test('opt-in: the CLI run stores excerpts by default, --no-excerpt and a plain store command do not', () => {
  const base = tmp('jcx-txt-optin-');
  const prof = join(base, 'profile'), rec = join(base, 'rec');
  for (const d of [prof, join(rec, 'lists')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 't', crawl: { user_agent: 'jcx-test (+https://example.org)' } }));
  writeFileSync(join(prof, 'companies.json'), JSON.stringify({ tracked_companies: [{ name: 'Acme', provider: 'greenhouse', slug: 'acme' }] }));
  writeFileSync(join(rec, 'lists', `${boardKey('Acme')}.json.gz`), gzipSync(JSON.stringify({ board: 'Acme', provider: 'greenhouse', complete: true, items: items() })));
  const routing = join(base, 'routing.json');
  writeFileSync(routing, JSON.stringify({ schema: 'routing/v1', providers: { greenhouse: 'shadow' } }));
  const go = (data, extra = []) => run(['run', '--profile', prof, '--data', data, '--routing', routing, '--replay', rec, '--store', 'sqlite', ...extra]);
  const feed = (data) => run(['snapshot', '--data', data, '--store', 'sqlite', '--format', 'ndjson', '--now', NOW]);
  go(join(base, 'on'));
  assert.ok(feed(join(base, 'on')).includes('Senior Thermal Engineer (m/w/d) At Acme Space'));
  go(join(base, 'off'), ['--no-excerpt']);
  assert.ok(!feed(join(base, 'off')).includes('At Acme Space'));
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 't', store: { excerpt: false }, crawl: { user_agent: 'jcx-test (+https://example.org)' } }));
});

test('resolver bootstrap seeds excerpts from posting_text when present', async () => {
  const dir = tmp();
  const jd = tmp();
  const js = jsonStore(jd, { storeText: true });
  await read(js, T(20), items());
  const sq = await openSqliteStore(dir);
  sq.importJson(jd);
  await runResolver(sq, { facts: () => ({}), config: { companies: [] }, now: () => T(20, 12) });
  const [snap] = [sq.snapshot().slice(1)];
  assert.ok(snap.find((p) => p.title === 'AIT Manager').jobcrawl.excerpt, 'imported text is in posting_text');
  // a refresh after bootstrap carries the member excerpt into a resolved record
  await read(sq, T(21), items(THERMAL_V2));
  await runResolver(sq, { facts: () => ({}), config: { companies: [] }, now: () => T(21, 12) });
  const recs = resolvedRecords(sq, { after: 0, limit: 100 });
  assert.ok(recs.some((r) => r.excerpt), 'a resolved record carries an excerpt');
  sq.close();
});

test('opt-in: profile key store.excerpt turns the excerpt on for commands that are not run/crawl (dual-run), and --no-excerpt wins over it', () => {
  const base = tmp('jcx-txt-profkey-');
  const rec = join(base, 'rec'), legacy = join(base, 'legacy');
  for (const d of [join(rec, 'lists'), legacy]) mkdirSync(d, { recursive: true });
  const its = items();
  writeFileSync(join(rec, 'lists', `${boardKey('Acme')}.json.gz`), gzipSync(JSON.stringify({ board: 'Acme', provider: 'greenhouse', complete: true, items: its })));
  writeFileSync(join(legacy, 'scan-history.tsv'), 'url\tcompany\ttitle\tlocation\tfirst_seen\tlast_seen\tstatus\tposted\n'
    + its.map((i) => `${i.url}\tAcme\t${i.title}\t${i.location}\t2026-11-01\t2026-11-27\topen\t`).join('\n') + '\n');
  const routing = join(base, 'routing.json');
  writeFileSync(routing, JSON.stringify({ schema: 'routing/v1', providers: { greenhouse: 'shadow' } }));
  let n = 0;
  const profile = (store) => {
    const p = join(base, `profile-${n++}`);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'profile.json'), JSON.stringify({ name: 't', ...(store === undefined ? {} : { store }), crawl: { user_agent: 'jcx-test (+https://example.org)' } }));
    writeFileSync(join(p, 'companies.json'), JSON.stringify({ tracked_companies: [{ name: 'Acme', provider: 'greenhouse', slug: 'acme' }] }));
    return p;
  };
  // dual-run is neither run nor crawl: only the profile key (or JOBCRAWL_STORE_TEXT) can switch the excerpt on
  const excerpts = (store, extra = [], env = {}) => {
    const data = join(base, `data-${n++}`);
    run(['dual-run', '--profile', profile(store), '--data', data, '--legacy-data', legacy, '--replay', rec, '--routing', routing, '--json', ...extra], env);
    const posts = Object.values(jsonStore(data).openBoard('Acme').postings);
    assert.equal(posts.length, 3);
    return posts.filter((p) => p.excerpt).length;
  };
  assert.equal(excerpts(undefined), 0, 'no profile key: no excerpt for dual-run');
  assert.equal(excerpts({ excerpt: false }), 0, 'store.excerpt false: no excerpt');
  assert.equal(excerpts({ excerpt: 'yes' }), 0, 'only the boolean true counts');
  assert.equal(excerpts({ excerpt: true }), 2, 'store.excerpt true: the two postings with a description carry one');
  assert.equal(excerpts({ excerpt: true }, ['--no-excerpt']), 0, '--no-excerpt wins over the profile');
  assert.equal(excerpts(undefined, [], { JOBCRAWL_STORE_TEXT: '1' }), 2, 'the environment switch does the same');
});
