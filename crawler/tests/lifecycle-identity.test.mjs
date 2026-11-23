// Byte identity of the crawl's outputs with the posting lifecycle on (MADE_LIFECYCLE=shadow) and off (coordinator 2026-11-24: shadow must not
// change anything the board is built from). Two crawl cycles on a frozen input (stubbed boards; the second cycle drops one posting, so the
// crawl's own gone logic runs too), then catalog.mjs, once per mode: every file the board build reads is byte-identical; only shadow writes
// <data>/lifecycle/. Child processes, no network.   Run: node --test crawler/tests/lifecycle-identity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BOARD_INPUTS = ['scan-history.tsv', 'catalog.json', 'job-meta.json', 'title-released.tsv'];   // what catalog / the board build read (job-meta: content)

function profileDir() {
  const d = mkdtempSync(join(tmpdir(), 'lcid-prof-'));
  writeFileSync(join(d, 'profile.json'), JSON.stringify({ name: 'lcid', crawl: { companies_file: 'companies.json', robots: 'advisory' } }));
  writeFileSync(join(d, 'companies.json'), JSON.stringify({
    title_filter: { positive: ['Engineer'], negative: ['Intern'] },
    location_filter: { allow_unknown: true, block_hard: [], allow: ['Germany'] },
    tracked_companies: [
      { name: 'Alpha', careers_url: 'https://boards.greenhouse.io/alpha', provider: 'greenhouse', slug: 'alpha', enabled: true },
      { name: 'Beta', careers_url: 'https://boards.greenhouse.io/beta', provider: 'greenhouse', slug: 'beta', enabled: true },
    ],
  }));
  return d;
}

// fetch stub, loaded with --import: Greenhouse board answers from the cycle number in LCID_CYCLE; anything else (robots.txt, pages) is 404
function stubFile() {
  const f = join(mkdtempSync(join(tmpdir(), 'lcid-stub-')), 'stub.mjs');
  writeFileSync(f, `
const cyc = Number(process.env.LCID_CYCLE || 1);
const boards = { alpha: ['Systems Engineer', 'Test Engineer', 'Optics Engineer'], beta: ['Software Engineer', 'Intern Engineering'] };
globalThis.fetch = async (url) => {
  const u = String(url);
  const m = u.match(/boards-api\\.greenhouse\\.io\\/v1\\/boards\\/([a-z]+)\\/jobs/);
  if (!m) return new Response('not found', { status: 404 });
  let titles = boards[m[1]] || [];
  if (cyc >= 2 && m[1] === 'alpha') titles = titles.slice(0, 2);   // 'Optics Engineer' leaves alpha's board in cycle 2
  const jobs = titles.map((t, i) => ({ id: 1000 + i, title: t, absolute_url: 'https://boards.greenhouse.io/' + m[1] + '/jobs/' + (1000 + i),
    location: { name: 'Munich, Germany' }, updated_at: '2026-11-20T10:00:00Z', first_published: '2026-11-01T10:00:00Z', content: '' }));
  return new Response(JSON.stringify({ jobs, meta: { total: jobs.length } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
`);
  return f;
}

function runCycles(mode, prof, stub) {
  const data = mkdtempSync(join(tmpdir(), `lcid-${mode}-`));
  for (const cyc of [1, 2]) {
    for (const [script, args] of [['crawl.mjs', ['--force-due']], ['catalog.mjs', []]]) {
      const r = spawnSync(process.execPath, ['--import', stub, resolve(ROOT, 'crawler', script), '--profile', prof, '--data', data, ...args], {
        cwd: ROOT, encoding: 'utf8', env: { ...process.env, JOBCRAWL_PROFILE: '', MADE_LIFECYCLE: mode, LCID_CYCLE: String(cyc), JOBCRAWL_RAW_DIR: '' } });
      assert.equal(r.status, 0, `${mode} cycle ${cyc} ${script}: ${r.stderr}\n${r.stdout.slice(-800)}`);
    }
  }
  return data;
}

const files = (d) => readdirSync(d, { recursive: true }).map(String).filter((f) => statSync(join(d, f)).isFile());

test('lifecycle shadow: the crawl outputs the board reads are byte-identical to off; only shadow writes lifecycle/', () => {
  const prof = profileDir(), stub = stubFile();
  const off = runCycles('off', prof, stub), shadow = runCycles('shadow', prof, stub);
  const hist = readFileSync(join(off, 'scan-history.tsv'), 'utf8');
  assert.match(hist, /Optics Engineer.*\tgone\t/, 'the fixture exercises the gone logic');
  for (const f of BOARD_INPUTS) {
    if (!existsSync(join(off, f)) && !existsSync(join(shadow, f))) continue;
    if (f === 'job-meta.json') {   // carries its write time ('updated'), which differs between any two runs: the content must be identical
      const j = (d) => JSON.parse(readFileSync(join(d, f), 'utf8')).jobs;
      assert.deepEqual(j(shadow), j(off), `${f} jobs differ between off and shadow`);
      continue;
    }
    assert.ok(readFileSync(join(off, f)).equals(readFileSync(join(shadow, f))), `${f} differs between off and shadow`);
  }
  const jd = (d) => (existsSync(join(d, 'jd')) ? files(join(d, 'jd')).sort() : []);
  assert.deepEqual(jd(off), jd(shadow));
  for (const f of jd(off)) assert.ok(readFileSync(join(off, 'jd', f)).equals(readFileSync(join(shadow, 'jd', f))), `jd/${f} differs`);
  assert.equal(existsSync(join(off, 'lifecycle')), false, 'off wrote lifecycle/');
  const lc = files(join(shadow, 'lifecycle'));
  assert.ok(lc.includes('state.json') && lc.some((f) => f.includes('ev-')), `shadow lifecycle files: ${lc}`);
  // the only files that differ at all are lifecycle/ and the crawl's own clocks (next-due times, run stamps, logs)
  const volatile = /^(lifecycle[\\/]|crawl-state\.json$|last-run\.txt$|logs[\\/]|source-health\.json$|policy|provider-breaker\.json$|robots)/;
  const extra = files(shadow).filter((f) => !existsSync(join(off, f))).map((f) => relative('.', f)).filter((f) => !volatile.test(f));
  assert.deepEqual(extra, [], 'files only shadow wrote outside lifecycle/');
});
