// Parity against the legacy crawl's latest answer of the same board (lifecycle state), from the parity analysis of 2026-11-28: the first
// method attributed history rows by the company column (the provider's company name for teamtailor, workday, ...) and compared answers
// hours apart, so most failures were the method, not the new path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { boardKey } from '../state/board-store.mjs';
import { legacyFetchesFromLifecycle } from '../route/parity.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NO_NET = join(mkdtempSync(join(tmpdir(), 'jcx-nonet3-')), 'nonet.mjs');
writeFileSync(NO_NET, "globalThis.fetch = () => { process.exit(99); };\nimport dns from 'node:dns'; dns.lookup = () => { process.exit(99); };\n");
const cli = (args) => spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(NO_NET).href, join(ROOT, 'cli', 'jobcrawl.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, JOBCRAWL_ROUTING: '' }, input: '' });
const U = (b, n) => `https://${b}.teamtailor.com/jobs/${n}-engineer`;

function fixture({ recordedAt, legacyAtMs, recorded, legacyLatest, legacyOlder = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'jcx-plc-'));
  const prof = join(dir, 'p'), rec = join(dir, 'rec'), legacy = join(dir, 'legacy');
  for (const d of [prof, join(rec, 'lists'), join(legacy, 'lifecycle')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 't' }));
  writeFileSync(join(prof, 'companies.json'), JSON.stringify({ tracked_companies: [{ name: 'Acme Space', provider: 'teamtailor', slug: 'acme' }] }));
  writeFileSync(join(rec, 'lists', `${boardKey('Acme Space')}.json.gz`), gzipSync(JSON.stringify({ board: 'Acme Space', provider: 'teamtailor', t: recordedAt, complete: true, items: recorded.map((n) => ({ url: U('acme', n), title: `T${n}`, location: 'Munich' })) })));
  // the history files these rows under the provider's company name ("ACME GmbH"), not the board name
  writeFileSync(join(legacy, 'scan-history.tsv'), 'url\tcompany\ttitle\tlocation\tfirst_seen\tlast_seen\tstatus\tposted\n'
    + [...legacyLatest, ...legacyOlder].map((n) => `${U('acme', n)}\tACME GmbH\tT${n}\tMunich\t2026-11-20\t2026-11-28\topen\t`).join('\n') + '\n');
  const urls = {};
  for (const n of legacyLatest) urls[U('acme', n)] = ['Acme Space', '2026-11-28', 0, legacyAtMs];
  for (const n of legacyOlder) urls[U('acme', n)] = ['Acme Space', '2026-11-27', 1, legacyAtMs - 86400e3];
  writeFileSync(join(legacy, 'lifecycle', 'state.json'), JSON.stringify({ v: 'lifecycle_obs_v1', at: new Date(legacyAtMs).toISOString(), urls }));
  return { dir, prof, rec, legacy };
}
const run = (f) => {
  const r = cli(['dual-run', '--profile', f.prof, '--data', join(f.dir, 'store'), '--legacy-data', f.legacy, '--replay', f.rec, '--boards', 'all', '--report', join(f.dir, 'parity.json'), '--json']);
  return { r, rep: JSON.parse(readFileSync(join(f.dir, 'parity.json'), 'utf8')) };
};

test('lifecycle attribution: rows filed under the provider company name still belong to the board; the latest fetch only', () => {
  const f = fixture({ recordedAt: '2026-11-28T03:10:00Z', legacyAtMs: Date.parse('2026-11-28T03:30:00Z'), recorded: [1, 2, 3], legacyLatest: [1, 2, 3], legacyOlder: [9] });
  const { r, rep } = run(f);
  assert.equal(r.status, 0, r.stderr);
  const b = rep.boards[0];
  assert.equal(b.verdict, 'pass', JSON.stringify(b));
  assert.equal(b.gap_min, 20);
  assert.match(r.stderr, /lifecycle state/);
  // the old method (history by company name) misses all three rows
  const old = cli(['dual-run', '--profile', f.prof, '--data', join(f.dir, 'store-old'), '--legacy-data', f.legacy, '--replay', f.rec, '--boards', 'all', '--no-lifecycle', '--report', join(f.dir, 'parity-old.json'), '--json']);
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'parity-old.json'), 'utf8')).boards[0].verdict, 'fail', old.stderr);
  assert.deepEqual(legacyFetchesFromLifecycle(join(f.legacy, 'lifecycle', 'state.json'), ['Acme Space']).get('Acme Space').urls.length, 3, 'older fetches are not the board\'s latest answer');
});

test('a difference hours apart is skew, not a failure; the same difference within the window fails', () => {
  const far = fixture({ recordedAt: '2026-11-28T03:10:00Z', legacyAtMs: Date.parse('2026-11-28T09:10:00Z'), recorded: [1, 2], legacyLatest: [1, 2, 4] });
  assert.equal(run(far).rep.boards[0].verdict, 'skew');
  const near = fixture({ recordedAt: '2026-11-28T03:10:00Z', legacyAtMs: Date.parse('2026-11-28T03:40:00Z'), recorded: [1, 2], legacyLatest: [1, 2, 4] });
  assert.equal(run(near).rep.boards[0].verdict, 'fail');
});

test('one legacy fetch: a title the legacy history froze at first sighting is counted, not a failure', () => {
  const f = fixture({ recordedAt: '2026-11-28T03:10:00Z', legacyAtMs: Date.parse('2026-11-28T03:20:00Z'), recorded: [1, 2], legacyLatest: [1, 2] });
  const hist = join(f.legacy, 'scan-history.tsv');
  writeFileSync(hist, readFileSync(hist, 'utf8').replace('	T1	', '	Old title at first sighting	'));
  const b = run(f).rep.boards[0];
  assert.equal(b.verdict, 'pass'); assert.equal(b.title_diff, 1);
});
