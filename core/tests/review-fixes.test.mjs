// Reproductions of the Phase-0 review findings (review_phase0.md, 2026-11-27), each fixed on this branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { assertPublicUrl, isPrivateAddress, parseIPv6, safeFetch, SsrfError } from '../fetch/ssrf.mjs';
import { applyRun } from '../delta/board-delta.mjs';
import { boardKey, commitRun, lease, openBoard, readEvents, snapshot } from '../state/board-store.mjs';
import { LocalQueue } from '../dist/queue.mjs';
import { LocalArtifacts } from '../dist/artifacts.mjs';
import { defaultRouting, routeFor } from '../route/router.mjs';

const B = 'Example GmbH';
const job = (n) => ({ url: `https://jobs.example.com/p/${n}`, title: `Engineer ${n}`, location: 'Munich' });
const at = (h) => new Date(Date.UTC(2026, 10, 1) + h * 3600e3);
const w = { id: 'w', capabilities: { net: true } };

// ---- (1) SSRF ----
test('ssrf: every spelling of a non-public address is refused, by bytes not strings', async () => {
  const bad = ['::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::7f00:1', '::127.0.0.1', 'fec0::1', 'fc00::1', 'fe80::1%eth0',
    '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::1', '2002:7f00:1::1', '2002:c0a8:0101::1', '2001:0:4136:e378::1', '2001:db8::1', 'ff02::1', '::', '::1',
    '169.254.169.254', '127.0.0.1', '10.0.0.1', '0.0.0.0', '100.64.0.1', '192.0.0.8', '198.18.0.1', '224.0.0.1', '255.255.255.255', 'not-an-ip'];
  for (const ip of bad) assert.equal(isPrivateAddress(ip), true, ip);
  const good = ['8.8.8.8', '2a00:1450:4001:82a::200e', '64:ff9b::808:808', '2002:0808:0808::1', '2606:4700::6810:84e5'];
  for (const ip of good) assert.equal(isPrivateAddress(ip), false, ip);
  assert.deepEqual(parseIPv6('::ffff:127.0.0.1'), parseIPv6('::ffff:7f00:1'));
});

test('ssrf: the URL path (normalised brackets), metadata, and mapped DNS answers are refused', async () => {
  const pub = async () => [{ address: '93.184.216.34' }];
  for (const u of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:a9fe:a9fe]/latest/meta-data/', 'http://[fec0::1]/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/', 'http://169.254.169.254/'])
    await assert.rejects(assertPublicUrl(u, { lookupImpl: pub }), SsrfError, u);
  await assert.rejects(assertPublicUrl('https://evil.example/', { lookupImpl: async () => [{ address: '::ffff:7f00:1', family: 6 }] }), SsrfError);
  await assert.rejects(assertPublicUrl('https://evil.example/', { lookupImpl: async () => [{ address: '8.8.8.8' }, { address: '10.0.0.1' }] }), SsrfError, 'one private answer is enough');
  await assertPublicUrl('https://ok.example/', { lookupImpl: pub });
});

test('ssrf: safeFetch checks every redirect hop', async () => {
  const pub = async () => [{ address: '93.184.216.34' }];
  const hops = { 'https://a.example/': ['https://b.example/x'], 'https://b.example/x': ['http://[::ffff:7f00:1]/admin'] };
  const calls = [];
  const fetchImpl = async (u) => { calls.push(u); const to = hops[u]?.[0]; return to ? new Response(null, { status: 302, headers: { location: to } }) : new Response('ok'); };
  await assert.rejects(safeFetch('https://a.example/', {}, { fetchImpl, lookupImpl: pub }), SsrfError);
  assert.deepEqual(calls, ['https://a.example/', 'https://b.example/x'], 'the private hop is never requested');
  const ok = await safeFetch('https://b.example/x'.replace('x', 'y'), {}, { fetchImpl, lookupImpl: pub });
  assert.equal(ok.status, 200);
});

// ---- (2) torn state, fsync, fail closed ----
test('store: an unreadable state.json is rebuilt from the log, never reset to seq 0 with the log cut', () => {
  const root = mkdtempSync(join(tmpdir(), 'jcx-torn-'));
  let r = applyRun(openBoard(root, B), { ok: true, items: [job(1), job(2)] }, { board: B, now: at(0) });
  commitRun(root, B, r.state, r.events);
  r = applyRun(openBoard(root, B), { ok: true, items: [job(1), job(3)] }, { board: B, now: at(1) });
  commitRun(root, B, r.state, r.events);
  const before = [...readEvents(root)].length;
  assert.equal(before, 5);
  const dir = join(root, 'boards', boardKey(B));
  writeFileSync(join(dir, 'state.json'), '{"schema":"board-state/v1","seq":');      // torn write
  const logs = [];
  const s = openBoard(root, B, { log: (m) => logs.push(m) });
  assert.equal(s.seq, 5, 'seq restored from the log');
  assert.equal(s.rebuilt.from, 'state.prev.json@3');
  assert.ok(readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-')), 'the unreadable file is kept');
  assert.equal([...readEvents(root)].length, 5, 'no event was cut');
  assert.deepEqual(Object.values(s.postings).filter((p) => p.status === 'open').map((p) => p.title).sort(), ['Engineer 1', 'Engineer 2', 'Engineer 3']);
  assert.match(logs[0], /state rebuilt/);
  // and the next run continues the sequence
  r = applyRun(s, { ok: true, items: [job(1), job(3)] }, { board: B, now: at(2) });
  assert.equal(r.events[0].seq, 6);
});

test('store: a lost state.json with a log (no prev) is rebuilt from the whole log', () => {
  const root = mkdtempSync(join(tmpdir(), 'jcx-lost-'));
  const r = applyRun(openBoard(root, B), { ok: true, items: [job(1)] }, { board: B, now: at(0) });
  commitRun(root, B, r.state, r.events);
  const dir = join(root, 'boards', boardKey(B));
  writeFileSync(join(dir, 'state.json'), 'garbage');
  const s = openBoard(root, B);
  assert.equal(s.seq, 2);
  assert.equal(s.rebuilt.from, 'empty');
});

// ---- (3) readEvents stops at the committed seq ----
test('store: events appended but not yet committed are invisible to readers', () => {
  const root = mkdtempSync(join(tmpdir(), 'jcx-mid-'));
  const r = applyRun(openBoard(root, B), { ok: true, items: [job(1)] }, { board: B, now: at(0) });
  commitRun(root, B, r.state, r.events);
  appendFileSync(join(root, 'boards', boardKey(B), 'events.ndjson'), JSON.stringify({ schema: 'delta/v1', board: B, seq: 3, op: 'added', id: 'x' }) + '\n');
  assert.deepEqual([...readEvents(root)].map((e) => e.seq), [1, 2], 'mid-commit: only committed events');
  assert.equal([...snapshot(root)][0].watermarks[B], 2);
});

// ---- (4) lease takeover is atomic ----
test('lease: two takers of one expired lease (two handles = two processes): exactly one wins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jcx-race-'));
  const f = join(root, 'leases.sqlite');
  const mk = () => { const d = new DatabaseSync(f); d.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS leases (board TEXT PRIMARY KEY, token TEXT NOT NULL, owner TEXT, expires INTEGER NOT NULL);'); return d; };
  const a = mk(), b = mk();
  let t = 0; const now = () => t;
  assert.ok(await lease(root, B, 1000, now, { db: a }));
  t = 5000;                                                  // expired for both
  const ra = await lease(root, B, 1000, now, { db: a });
  const rb = await lease(root, B, 1000, now, { db: b });
  assert.equal([ra, rb].filter(Boolean).length, 1, 'only one taker');
  ra?.(); rb?.();
  const stale = await lease(root, B, 1000, now, { db: b });
  assert.ok(stale, 'the release freed it');
  a.close(); b.close();
});

// ---- (5) queue: newer version during a lease; expiry counts attempts ----
test('queue: a newer version enqueued during a lease is kept and delivered after ack', () => {
  const q = new LocalQueue(':memory:');
  q.enqueue({ key: 'k', topic: 't', version: 1, payload: 'v1' });
  const [a] = q.lease(w, { topics: ['t'] });
  assert.deepEqual(q.enqueue({ key: 'k', topic: 't', version: 2, payload: 'v2' }), { added: true, pending: true });
  assert.equal(q.enqueue({ key: 'k', topic: 't', version: 2, payload: 'v2' }).added, false, 'idempotent');
  q.ack(a.leaseId);
  const [b] = q.lease(w, { topics: ['t'] });
  assert.equal(b.version, 2); assert.equal(b.payload, 'v2'); assert.equal(b.attempts, 1, 'fresh attempts for the new version');
});

test('queue: expired leases count as attempts and end in the dead letter at maxAttempts', () => {
  let t = 0;
  const q = new LocalQueue(':memory:', { clock: () => t });
  q.enqueue({ key: 'poison', topic: 't', maxAttempts: 2 });
  for (let i = 0; i < 2; i++) { const got = q.lease(w, { topics: ['t'], ttlMs: 100 }); assert.equal(got.length, 1, `delivery ${i + 1}`); t += 200; }
  assert.equal(q.lease(w, { topics: ['t'], ttlMs: 100 }).length, 0, 'no third delivery');
  assert.deepEqual(q.stats(), { t: { dead: 1 } });
});

test('queue: ack and heartbeat refuse an expired lease', () => {
  let t = 0;
  const q = new LocalQueue(':memory:', { clock: () => t });
  q.enqueue({ key: 'k', topic: 't' });
  const [a] = q.lease(w, { topics: ['t'], ttlMs: 100 });
  t = 150;
  assert.throws(() => q.heartbeat(a.leaseId), /expired/);
  assert.throws(() => q.ack(a.leaseId), /expired/);
});

// ---- (6) artifacts: only 64-hex hashes become paths ----
test('artifacts: a ref with a non-hex or traversal sha is refused', () => {
  const s = new LocalArtifacts(mkdtempSync(join(tmpdir(), 'jcx-sha-')));
  for (const bad of ['../../etc/passwd', 'ab/../../x', 'A'.repeat(64), 'abc', '', null])
    assert.throws(() => s.get({ sha256: bad }), /not a sha256/, String(bad));
  assert.throws(() => s.has('../x'), /not a sha256/);
});

// ---- (7) router: kill switch spellings, own properties ----
test('router: kill switch accepts 1/true/yes/on; inherited names never route', () => {
  const r = { ...defaultRouting(), allow_new: true, boards: { Stripe: 'new' } };
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(routeFor(r, { board: 'Stripe' }, { JOBCRAWL_ROUTE_KILL: v }).route, 'legacy', v);
  assert.equal(routeFor(r, { board: 'Stripe' }, { JOBCRAWL_ROUTE_KILL: '0' }).route, 'new');
  assert.equal(routeFor(r, { board: 'constructor', provider: 'toString' }).route, 'legacy');
  assert.equal(routeFor({ ...r, kill_switch: 'true' }, { board: 'Stripe' }).route, 'new', 'only a boolean true in the file (validateRouting rejects strings)');
});

// ---- CLI: live crawl obeys routing and kill switch; dual-run exit 1 ----
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NO_NET = join(mkdtempSync(join(tmpdir(), 'jcx-nonet2-')), 'nonet.mjs');
writeFileSync(NO_NET, "globalThis.fetch = () => { console.error('NETWORK USED'); process.exit(99); };\nimport dns from 'node:dns'; dns.lookup = () => { console.error('NETWORK USED'); process.exit(99); };\n");
const cli = (args, env = {}) => spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(NO_NET).href, join(ROOT, 'cli', 'jobcrawl.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, JOBCRAWL_ROUTING: '', ...env }, input: '' });

test('cli: a live crawl is refused for a legacy-routed board and under the kill switch, before any network use', () => {
  const base = mkdtempSync(join(tmpdir(), 'jcx-live-'));
  const prof = join(base, 'p'); mkdirSync(prof);
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 't', crawl: { user_agent: 'jcx-test (+https://example.org)' } }));
  writeFileSync(join(prof, 'companies.json'), JSON.stringify({ tracked_companies: [{ name: 'Stripe', provider: 'greenhouse', slug: 'stripe' }] }));
  let r = cli(['crawl', '--board', 'Stripe', '--profile', prof, '--data', join(base, 'd'), '--json']);
  assert.equal(r.status, 2, r.stderr); assert.match(r.stdout, /routed legacy/);
  const routing = join(base, 'routing.json');
  writeFileSync(routing, JSON.stringify({ schema: 'routing/v1', boards: { Stripe: 'shadow' } }));
  r = cli(['crawl', '--board', 'Stripe', '--profile', prof, '--data', join(base, 'd'), '--routing', routing, '--json'], { JOBCRAWL_ROUTE_KILL: 'true' });
  assert.equal(r.status, 2, r.stderr); assert.match(r.stdout, /kill switch/);
  assert.doesNotMatch(r.stderr, /NETWORK USED/);
});

test('cli: dual-run exits 1 when a board errors (not in the recording)', () => {
  const base = mkdtempSync(join(tmpdir(), 'jcx-dualerr-'));
  const prof = join(base, 'p'), rec = join(base, 'rec'), legacy = join(base, 'legacy');
  for (const d of [prof, join(rec, 'lists'), legacy]) mkdirSync(d, { recursive: true });
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 't' }));
  writeFileSync(join(prof, 'companies.json'), JSON.stringify({ tracked_companies: [{ name: 'Gone Board', provider: 'greenhouse', slug: 'x' }] }));
  writeFileSync(join(legacy, 'scan-history.tsv'), 'url\tcompany\ttitle\tlocation\tfirst_seen\tlast_seen\tstatus\tposted\n');
  const r = cli(['dual-run', '--profile', prof, '--data', join(base, 'd'), '--legacy-data', legacy, '--replay', rec, '--boards', 'all', '--json']);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(JSON.parse(r.stdout).verdicts.error, 1);
});

test('cli: --since-json handles board names with commas', () => {
  const root = mkdtempSync(join(tmpdir(), 'jcx-since-'));
  const name = 'Acme, Inc.';
  const r = applyRun(openBoard(root, name), { ok: true, items: [job(1)] }, { board: name, now: at(0) });
  commitRun(root, name, r.state, r.events);
  const out = cli(['feed', '--data', root, '--since-json', JSON.stringify({ [name]: 1 })]);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.stdout.trim().split('\n').map((l) => JSON.parse(l).seq), [2]);
});
