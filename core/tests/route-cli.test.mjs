// Routing façade, ledger, SSRF guard and the CLI contract (help never touches the network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultRouting, routeFor, validateRouting } from '../route/router.mjs';
import { isEligible, recordParity, loadLedger, ledgerSummary, PASSES_NEEDED } from '../route/ledger.mjs';
import { isPrivateAddress, assertPublicUrl, SsrfError } from '../fetch/ssrf.mjs';
import { validate } from '../schema/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'cli', 'jobcrawl.mjs');
// a preload that fails the process on any network use: proves --help and offline commands send nothing
const NO_NET = join(mkdtempSync(join(tmpdir(), 'jcx-nonet-')), 'nonet.mjs');
writeFileSync(NO_NET, "globalThis.fetch = () => { console.error('NETWORK USED'); process.exit(99); };\n"
  + "import dns from 'node:dns'; dns.lookup = () => { console.error('NETWORK USED'); process.exit(99); };\n");
const cli = (args, env = {}) => spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(NO_NET).href, CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, input: '' });

test('routing precedence: kill switch > board > provider > default; new needs allow_new', () => {
  const r = { ...defaultRouting(), providers: { greenhouse: 'shadow' }, boards: { Stripe: 'new', Acme: 'legacy' } };
  assert.equal(routeFor(r, { board: 'X', provider: 'lever' }).route, 'legacy');
  assert.equal(routeFor(r, { board: 'X', provider: 'greenhouse' }).route, 'shadow');
  assert.equal(routeFor(r, { board: 'Acme', provider: 'greenhouse' }).route, 'legacy');
  assert.equal(routeFor(r, { board: 'Stripe', provider: 'greenhouse' }).route, 'shadow', 'new is not honoured before allow_new');
  assert.equal(routeFor({ ...r, allow_new: true }, { board: 'Stripe' }).route, 'new');
  assert.equal(routeFor({ ...r, allow_new: true, kill_switch: true }, { board: 'Stripe' }).route, 'legacy');
  assert.equal(routeFor({ ...r, allow_new: true }, { board: 'Stripe' }, { JOBCRAWL_ROUTE_KILL: '1' }).route, 'legacy');
  assert.deepEqual(validateRouting({ schema: 'routing/v1', default: 'sideways' }).length, 1);
  assert.deepEqual(validate({ schema: 'routing/v1', default: 'legacy', boards: { a: 'new' } }, 'routing-v1'), []);
});

test('ledger: eligible after consecutive recent passes only', () => {
  const now = Date.UTC(2026, 10, 27);
  const p = (h, verdict) => ({ t: new Date(now - h * 3600e3).toISOString(), verdict });
  assert.equal(isEligible([p(3, 'pass'), p(2, 'pass'), p(1, 'pass')], now), true);
  assert.equal(isEligible([p(3, 'pass'), p(2, 'fail'), p(1, 'pass')], now), false);
  assert.equal(isEligible([p(100, 'pass'), p(2, 'pass'), p(1, 'pass')], now), false, 'too old');
  let led = loadLedger(null);
  const routing = { ...defaultRouting(), providers: { greenhouse: 'shadow' } };
  for (let i = 0; i < PASSES_NEEDED; i++) led = recordParity(led, [{ board: 'Stripe', provider: 'greenhouse', verdict: 'pass', overlap: 1 }], routing, { now: new Date(now + i * 1000) });
  assert.equal(led.boards.Stripe.route, 'shadow');
  assert.equal(led.boards.Stripe.eligible, true);
  assert.deepEqual(ledgerSummary(led), { boards: 1, legacy: 0, shadow: 1, new: 0, eligible: 1 });
});

test('ssrf: private, loopback, link-local, mapped and non-http targets are refused', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.8.156', '172.20.0.1', '169.254.169.254', '100.79.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '151.101.1.69', '2a00:1450:4001::64']) assert.equal(isPrivateAddress(ip), false, ip);
  await assert.rejects(assertPublicUrl('file:///etc/passwd'), SsrfError);
  await assert.rejects(assertPublicUrl('http://user:pw@example.com/'), SsrfError);
  await assert.rejects(assertPublicUrl('http://internal.example/', { lookupImpl: async () => [{ address: '10.0.0.5' }] }), SsrfError);
  await assertPublicUrl('https://example.com/', { lookupImpl: async () => [{ address: '93.184.216.34' }] });
});

test('cli: no arguments, help, --help and -h print usage, exit 0, use no network', () => {
  for (const a of [[], ['help'], ['--help'], ['-h'], ['crawl', '--help'], ['dual-run', '--help']]) {
    const r = cli(a);
    assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}`);
    assert.match(r.stdout, /jobcrawl <command>/);
  }
});

test('cli: offline commands answer JSON without network; usage errors exit 2', () => {
  let r = cli(['providers', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).providers.length > 100);
  r = cli(['detect', 'https://boards.greenhouse.io/stripe', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hits[0].provider, 'greenhouse');
  r = cli(['route', '--json'], { JOBCRAWL_ROUTE_KILL: '1' });
  assert.equal(JSON.parse(r.stdout).route, 'legacy');
  r = cli(['doctor', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Array.isArray(JSON.parse(r.stdout).checks));
  r = cli(['crawl', '--json']);
  assert.equal(r.status, 2);
  r = cli(['frobnicate']);
  assert.equal(r.status, 2);
});

test('cli: the new path refuses a legacy data folder', () => {
  const d = mkdtempSync(join(tmpdir(), 'jcx-legacy-'));
  writeFileSync(join(d, 'scan-history.tsv'), 'url\tcompany\n');
  const r = cli(['crawl', '--board', 'X', '--data', d, '--json']);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /legacy crawl state/);
});

test('cli: crawl and dual-run from a recording, with a ledger, without network', async () => {
  const { gzipSync } = await import('node:zlib');
  const { boardKey } = await import('../state/board-store.mjs');
  const base = mkdtempSync(join(tmpdir(), 'jcx-dual-'));
  const prof = join(base, 'profile'), rec = join(base, 'rec'), legacy = join(base, 'legacy'), data = join(base, 'data');
  for (const d of [prof, join(rec, 'lists'), legacy]) mkdirSync(d, { recursive: true });
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 't', crawl: { user_agent: 'jcx-test (+https://example.org)' } }));
  writeFileSync(join(prof, 'companies.json'), JSON.stringify({ tracked_companies: [{ name: 'Stripe', provider: 'greenhouse', slug: 'stripe' }] }));
  const items = [{ url: 'https://boards.greenhouse.io/stripe/jobs/1', title: 'A', location: 'Berlin' }, { url: 'https://boards.greenhouse.io/stripe/jobs/2', title: 'B', location: 'Munich' }];
  writeFileSync(join(rec, 'lists', `${boardKey('Stripe')}.json.gz`), gzipSync(JSON.stringify({ board: 'Stripe', provider: 'greenhouse', complete: true, items })));
  writeFileSync(join(legacy, 'scan-history.tsv'), 'url\tcompany\ttitle\tlocation\tfirst_seen\tlast_seen\tstatus\tposted\n'
    + items.map((i) => `${i.url}\tStripe\t${i.title}\t${i.location}\t2026-11-01\t2026-11-27\topen\t`).join('\n') + '\n');
  const routing = join(base, 'routing.json');
  writeFileSync(routing, JSON.stringify({ schema: 'routing/v1', providers: { greenhouse: 'shadow' } }));
  let r = cli(['dual-run', '--profile', prof, '--data', data, '--legacy-data', legacy, '--replay', rec, '--routing', routing, '--ledger', join(base, 'ledger.json'), '--report', join(base, 'parity.json'), '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).verdicts, { pass: 1, near: 0, fail: 0, skew: 0, incomplete: 0, 'no-legacy': 0, empty: 0, error: 0 });
  const rep = JSON.parse((await import('node:fs')).readFileSync(join(base, 'parity.json'), 'utf8'));
  assert.deepEqual(validate(rep, 'parity-v1'), []);
  r = cli(['crawl', '--board', 'Stripe', '--profile', prof, '--data', join(base, 'data2'), '--replay', rec, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).counts, { added: 2, 'board-ok': 1 });
  r = cli(['feed', '--data', join(base, 'data2')]);
  assert.equal(r.stdout.trim().split('\n').length, 3);
});
