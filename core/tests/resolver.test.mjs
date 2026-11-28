// Resolver job (row 1.4): crosslist, admission, protected set, the 3-day sweep, unknown; lease + checkpoints; resolved stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openSqliteStore } from '../state/sqlite-store.mjs';
import { jsonStore } from '../state/store.mjs';
import { runBoardOn } from '../run-board.mjs';
import { LEGACY_RULES, DEFAULT_RULES } from '../delta/board-delta.mjs';
import { postingId } from '../id.mjs';
import { validate } from '../schema/validate.mjs';
import { createResolver } from '../resolve/engine.mjs';
import { runResolver, resolvedRecords, resolvedGroups, derivedSet, acquireResolverLease, LeaseLost, RESOLVER_BOARD } from '../resolve/resolver.mjs';
import { fingerprintText } from '../../crawler/fingerprint.mjs';
import { openAdmissions } from '../../crawler/admission.mjs';

const tmp = (p = 'jcx-res-') => mkdtempSync(join(tmpdir(), p));
const CLI = join(fileURLToPath(new URL('../../cli/jobcrawl.mjs', import.meta.url)));
const H = 3600e3;
const T0 = Date.parse('2026-11-20T06:00:00Z');
const at = (h) => new Date(T0 + h * H);
const DESC = 'We are looking for a Senior Thermal Engineer to design, analyse and test the thermal control system of our satellites. '
  + 'You will own thermal models, run thermal vacuum campaigns, write test procedures and work with suppliers of heaters, MLI and radiators. '
  + 'Requirements: degree in mechanical or aerospace engineering, five years of spacecraft thermal design, ESATAN or Thermal Desktop.';
const FP = fingerprintText(DESC);
const COMPANIES = [
  { name: 'Acme', provider: 'greenhouse', slug: 'acme' },
  { name: 'Acme Careers', provider: 'greenhouse', slug: 'acme' },
  { name: 'Space-Careers', provider: 'spacecareers' },
];
const DIRECT = 'https://boards.greenhouse.io/acme/jobs/4012345';
const AGG = 'https://www.space-careers.com/jobs/9911-senior-thermal-engineer';

/** facts by url: { company, fp, applyText, kept } */
const factsFrom = (map) => (rec) => map[rec.posting?.url] ?? {};
async function read(store, board, at_, items, { rules = LEGACY_RULES, ok = true } = {}) {
  return runBoardOn(store, { name: board }, { read: ok ? { ok: true, items, complete: true, emptyOk: true } : { ok: false, items: [], error: { cls: 'HTTP_5XX' } }, now: () => at_, rules });
}
const item = (url, title = 'Senior Thermal Engineer (m/w/d)', location = 'Munich, Germany') => ({ url, title, location });
const resolve = (store, facts, h, extra = {}) => runResolver(store, { facts, config: { companies: COMPANIES }, now: () => at(h), batch: 3, ...extra });
const statusOf = (store, url) => resolvedGroups(store).find((g) => g.id === postingId(url))?.status;

test('resolver: an aggregator copy of an open direct posting is a dup; the direct posting stays open', async () => {
  const store = await openSqliteStore(tmp());
  const facts = factsFrom({ [DIRECT]: { company: 'Acme GmbH', fp: FP }, [AGG]: { company: 'Acme (via Space-Careers)', fp: FP } });
  await read(store, 'Acme', at(0), [item(DIRECT)]);
  await read(store, 'Space-Careers', at(1), [item(AGG, 'Senior Thermal Engineer')]);
  const r = await resolve(store, facts, 2);
  assert.equal(r.bootstrapped, true);
  assert.equal(statusOf(store, DIRECT), 'open');
  assert.equal(statusOf(store, AGG), 'dup');
  const g = resolvedGroups(store, { status: 'dup' })[0];
  assert.equal(g.dup_of, postingId(DIRECT));
  const recs = resolvedRecords(store);
  assert.deepEqual(recs.map((x) => `${x.op}:${x.status}`), ['added:open', 'dup:dup']);
  for (const x of recs) assert.deepEqual(validate(x, 'resolved-v1'), []);
  store.close();
});

test('resolver: a direct posting arriving after the aggregator copy swaps over it; when it departs the copy takes over (undup)', async () => {
  const store = await openSqliteStore(tmp());
  const facts = factsFrom({ [DIRECT]: { company: 'Acme GmbH', fp: FP }, [AGG]: { company: 'Acme (via Space-Careers)', fp: FP } });
  await read(store, 'Space-Careers', at(0), [item(AGG, 'Senior Thermal Engineer')]);
  await resolve(store, facts, 0.5);
  assert.equal(statusOf(store, AGG), 'open');
  await read(store, 'Acme', at(1), [item(DIRECT)]);
  await resolve(store, facts, 1.5);
  assert.equal(statusOf(store, DIRECT), 'open');
  assert.equal(statusOf(store, AGG), 'dup');
  await read(store, 'Acme', at(2), [item('https://boards.greenhouse.io/acme/jobs/4019999', 'Other role')]);   // complete answer without it
  await read(store, 'Space-Careers', at(2.2), [item(AGG, 'Senior Thermal Engineer')]);
  await resolve(store, facts, 2.5);
  assert.equal(statusOf(store, DIRECT), 'departed');
  assert.equal(statusOf(store, AGG), 'open');
  const ops = resolvedRecords(store).filter((x) => x.id === postingId(AGG)).map((x) => x.op);
  assert.deepEqual(ops, ['added', 'dup', 'undup']);
  store.close();
});

test('resolver: the same ATS posting id in an aggregator description is a cross-listing without a fingerprint', async () => {
  const store = await openSqliteStore(tmp());
  const facts = factsFrom({ [DIRECT]: { company: 'Acme' }, [AGG]: { company: 'Acme (via Space-Careers)', applyText: `Apply here: ${DIRECT}?gh_src=sc.` } });
  await read(store, 'Acme', at(0), [item(DIRECT)]);
  await read(store, 'Space-Careers', at(1), [item(AGG, 'Thermal Engineer, senior')]);
  await resolve(store, facts, 2);
  assert.equal(statusOf(store, AGG), 'dup');
  store.close();
});

test('resolver: admission: a second board cannot hide or close a role another board admitted within 48 h; the admitting board can', async () => {
  const store = await openSqliteStore(tmp());
  const kept = { Acme: true, 'Acme Careers': false };   // Acme Careers' site whitelist hides the role
  const facts = (rec) => ({ company: 'Acme', kept: kept[rec.board] });
  await read(store, 'Acme', at(0), [item(DIRECT)]);
  await read(store, 'Acme Careers', at(0.1), [item(DIRECT)]);
  let r = await resolve(store, facts, 0.5);
  assert.equal(statusOf(store, DIRECT), 'open');
  assert.equal(r.stats.blockedHide, 1);
  let g = resolvedGroups(store).find((x) => x.id === postingId(DIRECT));
  assert.deepEqual(Object.keys(g.adm), ['Acme']);
  await read(store, 'Acme Careers', at(1), []);                                  // the other board closes: held
  await read(store, 'Acme', at(1.1), [item(DIRECT)]);
  r = await resolve(store, facts, 1.5);
  assert.equal(statusOf(store, DIRECT), 'open');
  await read(store, 'Acme', at(2), []);                                          // the admitting board says it is gone
  await resolve(store, facts, 2.5);
  assert.equal(statusOf(store, DIRECT), 'departed');
  store.close();
});

test('resolver: admission hold expires: after 48 h without a listing by the admitting board, another board\'s hide goes ahead', async () => {
  const store = await openSqliteStore(tmp());
  const kept = { Acme: true, 'Acme Careers': false };
  const facts = (rec) => ({ company: 'Acme', kept: kept[rec.board] });
  await read(store, 'Acme', at(0), [item(DIRECT)]);
  await resolve(store, facts, 0.5);
  await read(store, 'Acme', at(1), [], { ok: false });                           // failing from now on: no listing, no miss
  await read(store, 'Acme Careers', at(50), [item(DIRECT)]);
  await resolve(store, facts, 50.5);
  assert.equal(statusOf(store, DIRECT), 'hidden');
  store.close();
});

test('resolver: differential test against crawler/admission.mjs (the legacy module) on random multi-board cycles', async () => {
  // Fixed keep verdict per (board, url) (a verdict change without a posting change has no per-board event: see the report), up to 5
  // urls per board (under both mass-drop guards), legacy departure rule (first complete miss).
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const boards = ['A', 'B', 'C'];
  const urls = [0, 1, 2, 3].map((i) => `https://boards.greenhouse.io/acme/jobs/40100${i}`);
  const keep = Object.fromEntries(boards.flatMap((b) => urls.map((u) => [`${b}|${u}`, rnd() > 0.25])));
  const legacyDir = tmp('jcx-adm-');
  const store = await openSqliteStore(tmp());
  const facts = (rec) => ({ company: 'Acme', kept: keep[`${rec.board}|${rec.posting.url}`] });
  let disagreements = 0, compared = 0;
  for (let c = 0; c < 40; c++) {
    const nowMs = T0 + c * 6 * H;
    const listings = Object.fromEntries(boards.map((b) => [b, rnd() < 0.15 ? null : urls.filter(() => rnd() > 0.35)]));   // null: failed
    // legacy cycle: withdraw from complete answers first, then each board in order
    const adm = openAdmissions(legacyDir, { now: nowMs, log: () => {} });
    adm.withdrawFromAnswers(boards.filter((b) => listings[b]).map((b) => ({ board: b, listed: new Set(listings[b]), complete: true, emptyOk: true })));
    for (const b of boards) {
      if (!listings[b]) continue;
      for (const u of listings[b]) { if (keep[`${b}|${u}`]) adm.admit(u, b); else adm.mayHide(u, b, 'location (site whitelist)', true); }
    }
    adm.save();
    for (const b of boards) await read(store, b, new Date(nowMs), (listings[b] ?? []).map((u) => item(u)), { ok: Boolean(listings[b]) });
    await runResolver(store, { facts, config: { companies: [] }, now: () => new Date(nowMs + 60e3), batch: 50 });
    const legacy = JSON.parse(readFileSync(join(legacyDir, 'admit-state.json'), 'utf8'));
    for (const u of urls) {
      const want = (legacy.urls[u] ?? []).map(([bi]) => legacy.boards[bi]).sort();
      const g = resolvedGroups(store).find((x) => x.id === postingId(u));
      const got = Object.entries(g?.adm ?? {}).filter(([, t]) => nowMs + 60e3 - t < 48 * H).map(([b]) => b).sort();
      compared++;
      if (JSON.stringify(want) !== JSON.stringify(got)) disagreements++;
    }
  }
  assert.equal(disagreements, 0, `${disagreements} of ${compared} admission sets differ from the legacy module`);
  store.close();
});

test('resolver: 3-day sweep: legacy rules depart a posting nothing confirmed for 3 days; lifecycle rules keep it, then unknown at 14 days', async () => {
  for (const [rules, want3, want15] of [['legacy', 'departed', 'departed'], ['lifecycle', 'open', 'unknown']]) {
    const store = await openSqliteStore(tmp());
    const facts = () => ({ company: 'Acme' });
    await read(store, 'Acme', at(0), [item(DIRECT)]);
    await runResolver(store, { facts, config: { companies: COMPANIES, rules }, now: () => at(1) });
    await runResolver(store, { facts, config: { companies: COMPANIES, rules }, now: () => at(4 * 24) });
    assert.equal(statusOf(store, DIRECT), want3, rules);
    await runResolver(store, { facts, config: { companies: COMPANIES, rules }, now: () => at(15 * 24) });
    assert.equal(statusOf(store, DIRECT), want15, rules);
    const last = resolvedRecords(store).at(-1);
    assert.equal(last.reason, 'sweep');
    // a listing after the sweep reopens it
    await read(store, 'Acme', at(15 * 24 + 1), [item(DIRECT)], { rules: DEFAULT_RULES });
    await runResolver(store, { facts, config: { companies: COMPANIES, rules }, now: () => at(15 * 24 + 2) });
    assert.equal(statusOf(store, DIRECT), 'open', `${rules}: reopened`);
    store.close();
  }
});

test('resolver: a crash inside a checkpoint commits nothing; the rerun gives exactly the records of an uninterrupted run', async () => {
  const build = async () => {
    const store = await openSqliteStore(tmp());
    await read(store, 'Acme', at(0), [item(DIRECT)]);
    await read(store, 'Space-Careers', at(1), [item(AGG, 'Senior Thermal Engineer')]);
    await read(store, 'Acme', at(2), [item(DIRECT), item('https://boards.greenhouse.io/acme/jobs/4012346', 'Test Engineer')]);
    await read(store, 'Acme', at(3), [item('https://boards.greenhouse.io/acme/jobs/4012346', 'Test Engineer')]);
    return store;
  };
  const facts = factsFrom({ [DIRECT]: { company: 'Acme GmbH', fp: FP }, [AGG]: { company: 'Acme (via Space-Careers)', fp: FP } });
  const clean = await build();
  await resolve(clean, facts, 4);
  const want = resolvedRecords(clean).map(({ src_event_id, ...r }) => r);
  const crashy = await build();
  await assert.rejects(resolve(crashy, facts, 4, { hooks: { beforeCommit: (n) => { if (n === 2) throw new Error('power cut'); } } }), /power cut/);
  const partial = resolvedRecords(crashy);
  await resolve(crashy, facts, 4);
  const got = resolvedRecords(crashy).map(({ src_event_id, ...r }) => r);
  assert.ok(partial.length < got.length);
  assert.deepEqual(got, want);
  assert.equal(new Set(got.map((r) => r.seq)).size, got.length);
  assert.equal(crashy.bookmarkGet('resolver'), clean.bookmarkGet('resolver'));
  clean.close(); crashy.close();
});

test('resolver: lease: a second resolver is refused while one holds it; a resolver whose lease was taken over cannot commit', async () => {
  const store = await openSqliteStore(tmp());
  await read(store, 'Acme', at(0), [item(DIRECT)]);
  const held = acquireResolverLease(store, 60e3);
  assert.ok(held);
  const r = await resolve(store, () => ({}), 1);
  assert.match(r.skipped, /lease held/);
  held.release();
  await assert.rejects(resolve(store, () => ({}), 1, { hooks: { beforeCommit: () => store.db.prepare('UPDATE leases SET token = ? WHERE board = ?').run('thief', RESOLVER_BOARD) } }), LeaseLost);
  assert.equal(resolvedRecords(store).length, 0);
  store.close();
});

test('resolver: bootstrap from an imported store (postings, no events) is a silent baseline epoch; later events resolve', async () => {
  const src = await openSqliteStore(tmp());
  await read(src, 'Acme', at(0), [item(DIRECT)]);
  // an import: postings and board rows, no events (as importJson writes them)
  const store = await openSqliteStore(tmp());
  const st = src.openBoard('Acme');
  store.withTransaction((db) => {
    for (const [id, rec] of Object.entries(st.postings)) db.prepare('INSERT INTO postings (board, id, status, rec) VALUES (?, ?, ?, ?)').run('Acme', id, rec.status, JSON.stringify(rec));
    const { postings, ...meta } = st;
    db.prepare('INSERT INTO boards (board, seq, state, updated_at) VALUES (?, ?, ?, ?)').run('Acme', st.seq, JSON.stringify(meta), at(0).toISOString());
    db.prepare('INSERT INTO imports (board, source, seq, event_id, postings, at) VALUES (?, ?, ?, ?, ?, ?)').run('Acme', 'test', st.seq, 0, 1, at(0).toISOString());
  });
  const r = await resolve(store, () => ({ company: 'Acme' }), 1);
  assert.equal(r.bootstrapped, true);
  assert.equal(r.records, 0);
  assert.equal(statusOf(store, DIRECT), 'open');
  assert.ok(derivedSet(store).includes('Acme'));        // tracked non-probation entry: protected
  await read(store, 'Acme', at(2), []);
  const r2 = await resolve(store, () => ({ company: 'Acme' }), 3);
  assert.equal(r2.bootstrapped, false);
  assert.deepEqual(resolvedRecords(store).map((x) => x.op), ['departed']);
  src.close(); store.close();
});

test('resolver: store records without seq (refreshed) are applied by event_id; two strong keys under one id are flagged', () => {
  const eng = createResolver(null, { companies: COMPANIES });
  const id = postingId(DIRECT);
  const posting = (url, status = 'open') => ({ url, title: 'Senior Thermal Engineer', jobcrawl: { status, first_seen: at(0).toISOString(), last_seen: at(0).toISOString() } });
  eng.apply({ board: 'Acme', seq: null, op: 'refreshed', id, t: at(0).toISOString(), fields: ['new'], posting: posting(DIRECT) }, { company: 'Acme' });
  assert.equal(eng.groupOf(id).status, 'open');
  eng.apply({ board: 'Acme', seq: 5, op: 'reappeared', id, t: at(1).toISOString(), posting: posting('https://boards.greenhouse.io/acme/jobs/4077777') }, { company: 'Acme' });
  assert.equal(eng.stats.suspectAlias, 1);
  const recs = eng.drain();
  assert.equal(recs.at(-1).suspect, 'shared-url');
  for (const x of recs) assert.deepEqual(validate(x, 'resolved-v1'), []);
});

test('resolver: protected set = catalogue + "(via industry aggregator)" employers + tracked entries + what industry aggregators list now', async () => {
  const store = await openSqliteStore(tmp());
  await read(store, 'Space-Careers', at(0), [item(AGG, 'Senior Thermal Engineer')]);
  await runResolver(store, { facts: () => ({ company: 'Orbital Widgets (via Space-Careers)' }), config: { companies: [...COMPANIES, { name: 'Probe Co', probation: true }], catalogue: ['Catalogue AG'] }, now: () => at(1) });
  const names = derivedSet(store);
  for (const n of ['Acme', 'Acme Careers', 'Catalogue AG', 'Orbital Widgets', 'Orbital Widgets (via Space-Careers)']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('Probe Co'));
  assert.ok(!names.includes('Space-Careers'));
  store.close();
});

test('resolver: the JSON store is refused; the CLI resolves a sqlite data folder and refuses --store json', async () => {
  await assert.rejects(runResolver(jsonStore(tmp())), /--store sqlite/);
  const data = tmp();
  const store = await openSqliteStore(data);
  await read(store, 'Acme', at(0), [item(DIRECT)]);
  store.close();
  const env = { ...process.env }; delete env.JOBCRAWL_LOG_DIR;
  const r = spawnSync(process.execPath, [CLI, 'resolve', '--data', data, '--store', 'sqlite', '--json'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const outp = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(outp.bootstrapped, true);
  const r2 = spawnSync(process.execPath, [CLI, 'resolve', '--data', data, '--store', 'json', '--json'], { encoding: 'utf8', env });
  assert.equal(r2.status, 2);
  const r3 = spawnSync(process.execPath, [CLI, 'resolved', '--data', data, '--json'], { encoding: 'utf8', env });
  assert.equal(r3.status, 0, r3.stderr);
});

test('resolver: jobcrawl run --resolve runs the resolver after the boards (sqlite); without the flag nothing of the resolver is written', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { gzipSync } = await import('node:zlib');
  const { boardKey } = await import('../state/board-store.mjs');
  const base = tmp('jcx-res-run-');
  const prof = join(base, 'profile'), rec = join(base, 'rec');
  for (const d of [prof, join(rec, 'lists')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 't', crawl: { user_agent: 'jcx-test (+https://example.org)' } }));
  const boards = [{ name: 'B1', provider: 'greenhouse', slug: 'b1' }, { name: 'B2', provider: 'greenhouse', slug: 'b2' }];
  writeFileSync(join(prof, 'companies.json'), JSON.stringify({ tracked_companies: boards }));
  for (const b of boards) writeFileSync(join(rec, 'lists', `${boardKey(b.name)}.json.gz`), gzipSync(JSON.stringify({ board: b.name, provider: 'greenhouse', complete: true, items: [item(DIRECT)] })));
  const routing = join(base, 'routing.json');
  writeFileSync(routing, JSON.stringify({ schema: 'routing/v1', providers: { greenhouse: 'shadow' } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JOBCRAWL_')));
  const run = (data, extra) => spawnSync(process.execPath, ['--no-warnings', CLI, 'run', '--profile', prof, '--data', data, '--routing', routing, '--replay', rec, '--store', 'sqlite', '--json', ...extra], { encoding: 'utf8', env, input: '' });
  const off = run(join(base, 'd-off'), []);
  assert.equal(off.status, 0, off.stderr);
  const s0 = await openSqliteStore(join(base, 'd-off'));
  assert.equal(s0.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'resolve%'").get().n, 0);
  s0.close();
  const on = run(join(base, 'd-on'), ['--resolve']);
  assert.equal(on.status, 0, on.stderr);
  const res = JSON.parse(on.stdout.trim().split('\n').at(-1));
  assert.equal(res.resolver.bootstrapped, true);
  const s1 = await openSqliteStore(join(base, 'd-on'));
  const g = resolvedGroups(s1).find((x) => x.id === postingId(DIRECT));
  assert.deepEqual(Object.keys(g.adm).sort(), ['B1', 'B2']);   // one posting, two admitting boards
  s1.close();
});

test('resolver: a fingerprint that arrives late (refresh) feeds the aggregator sweep; the arrival decision itself is not re-taken', async () => {
  const store = await openSqliteStore(tmp());
  let late = false;
  const facts = (rec) => {
    const url = rec.posting?.url;
    if (url === DIRECT) return { company: 'Acme GmbH', fp: late || rec.op !== 'refresh' ? undefined : undefined };
    if (url === AGG) return { company: 'Acme (via Space-Careers)', fp: FP };
    return {};
  };
  await read(store, 'Acme', at(0), [item(DIRECT)]);
  await read(store, 'Space-Careers', at(1), [item(AGG, 'Senior Thermal Engineer')]);
  await resolve(store, facts, 2);
  assert.equal(statusOf(store, AGG), 'open');                      // the direct posting has no text yet: no match
  late = true;
  const facts2 = (rec) => (rec.posting?.url === DIRECT ? { company: 'Acme GmbH', fp: rec.op === 'refresh' ? FP : undefined } : facts(rec));
  await read(store, 'Acme', at(3), [item(DIRECT)]);
  await resolve(store, facts2, 4);
  assert.equal(statusOf(store, AGG), 'dup');                       // the sweep matches it once the direct text is known
  assert.equal(statusOf(store, DIRECT), 'open');
  assert.equal(resolvedRecords(store).at(-1).reason, 'cross-listing sweep');
  store.close();
});
