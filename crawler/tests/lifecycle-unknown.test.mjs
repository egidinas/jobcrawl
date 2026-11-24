// The scan-history status 'unknown' (MADE_LIFECYCLE=on, D1: nothing listed a posting for 14 days; never a close) is accepted by the crawl's
// own readers (coordinator 2026-11-24 checklist, precondition of the 29 Nov gate). Child processes for the CLI steps, no network.
//   Run: node --test crawler/tests/lifecycle-unknown.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planBackfill } from '../detail-backfill.mjs';
import { groupAggregatorRows } from '../aggregator-employers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HEADER = 'url\tcompany\ttitle\tlocation\tfirst_seen\tlast_seen\tstatus\tposted';
const row = (u, c, t, st, ls = '2026-11-01') => [u, c, t, 'Munich, Germany', '2026-10-20', ls, st, ''].join('\t');

function profileDir() {
  const d = mkdtempSync(join(tmpdir(), 'lcun-prof-'));
  writeFileSync(join(d, 'profile.json'), JSON.stringify({ name: 'lcun', crawl: { companies_file: 'companies.json', robots: 'advisory' } }));
  writeFileSync(join(d, 'companies.json'), JSON.stringify({
    title_filter: { positive: ['Engineer'], negative: [] }, location_filter: { allow_unknown: true, block_hard: [], allow: ['Germany'] },
    tracked_companies: [{ name: 'Alpha', careers_url: 'https://boards.greenhouse.io/alpha', provider: 'greenhouse', slug: 'alpha', enabled: true }],
  }));
  return d;
}
function stubFile() {
  const f = join(mkdtempSync(join(tmpdir(), 'lcun-stub-')), 'stub.mjs');
  writeFileSync(f, `globalThis.fetch = async (url) => {
  if (!/boards-api\\.greenhouse\\.io\\/v1\\/boards\\/alpha\\/jobs/.test(String(url))) return new Response('not found', { status: 404 });
  const jobs = [{ id: 1, title: 'Systems Engineer', absolute_url: 'https://boards.greenhouse.io/alpha/jobs/1', location: { name: 'Munich, Germany' }, first_published: '2026-10-20T00:00:00Z', content: '' }];
  return new Response(JSON.stringify({ jobs }), { status: 200, headers: { 'content-type': 'application/json' } });
};`);
  return f;
}
const run = (script, prof, data, extra = [], env = {}) => spawnSync(process.execPath, ['--import', stubFile(), resolve(ROOT, 'crawler', script), '--profile', prof, '--data', data, ...extra],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, JOBCRAWL_PROFILE: '', JOBCRAWL_RAW_DIR: '', MADE_LIFECYCLE: 'off', ...env } });
const statuses = (d) => Object.fromEntries(readFileSync(join(d, 'scan-history.tsv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t')).map((p) => [p[0], p[6]]));

test('catalog: an unknown row is not in the catalog (only open rows are)', () => {
  const prof = profileDir(), data = mkdtempSync(join(tmpdir(), 'lcun-cat-'));
  writeFileSync(join(data, 'scan-history.tsv'), [HEADER, row('https://x/1', 'Alpha', 'A Engineer', 'open'), row('https://x/2', 'Alpha', 'B Engineer', 'unknown')].join('\n') + '\n');
  const r = run('catalog.mjs', prof, data);
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(readFileSync(join(data, 'catalog.json'), 'utf8'));
  const urls = (Array.isArray(c) ? c : c.items).map((x) => x.url);
  assert.deepEqual(urls, ['https://x/1']);
});

test('crawl: an unknown row that its board lists again is open again; an unlisted unknown row stays unknown', () => {
  const prof = profileDir(), data = mkdtempSync(join(tmpdir(), 'lcun-crawl-'));
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(join(data, 'scan-history.tsv'), [HEADER, row('https://boards.greenhouse.io/alpha/jobs/1', 'Alpha', 'Systems Engineer', 'unknown'),
    row('https://boards.greenhouse.io/alpha/jobs/2', 'Alpha', 'Test Engineer', 'unknown', today)].join('\n') + '\n');
  const r = run('crawl.mjs', prof, data, ['--force-due']);
  assert.equal(r.status, 0, r.stderr + r.stdout.slice(-500));
  const st = statuses(data);
  assert.equal(st['https://boards.greenhouse.io/alpha/jobs/1'], 'open');
  assert.equal(st['https://boards.greenhouse.io/alpha/jobs/2'], 'unknown');
});

test('detail backfill: an unknown row is not fetched', () => {
  const history = new Map([['https://boards.greenhouse.io/alpha/jobs/9', { url: 'https://boards.greenhouse.io/alpha/jobs/9', company: 'Alpha', status: 'unknown' }]]);
  const plan = planBackfill({ history, boards: new Map([['Alpha', { provider: 'workday', slug: 'alpha' }]]) });
  assert.equal(plan.queue.length, 0);
  assert.equal(plan.skipped.status, 1);
});

test('aggregator employers: an unknown row is counted as unknown, never as open', () => {
  const got = groupAggregatorRows([{ url: 'u1', company: 'Acme GmbH (via EURES)', title: 'Engineer', status: 'unknown' },
    { url: 'u2', company: 'Acme GmbH (via EURES)', title: 'Engineer 2', status: 'open' }]);
  const [e] = [...got.values()];
  assert.equal(e.open, 1);
  assert.equal(e.unknown, 1);
  assert.equal(e.rows, 2);
});
