// Hide only by the admitting board (admission.mjs): real crawls against a local HTTP server, boards that share URLs. No network beyond
// 127.0.0.1. Cases: two boards on one tenant with a site whitelist on one (Leonardo / Kopter), an aggregator and the employer's own
// board (ESA / Space Individuals), the two-way whitelist (Airbus), a real close by the admitting board, the 48 h expiry, a policy hide,
// the first run without state, and an unreadable state file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAdmissions, ADMIT_HOLD_H } from '../admission.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HEADER = ['url', 'company', 'title', 'location', 'first_seen', 'last_seen', 'status', 'posted'];
// the tenant's postings: id -> [title, city]; `live` is what the tenant lists now (a test removes one to close it)
const JOBS = { 1: ['Systems Engineer', 'Berlin'], 2: ['Test Engineer', 'Munich'], 3: ['Software Engineer', 'Paris'] };

const page = (org, title, city) => `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'JobPosting', title, datePosted: '2026-11-01', hiringOrganization: { name: org },
  description: `<p>${org} is hiring a ${title} in ${city}, reference ${org}-${title.length}-${city}.</p>`,
  jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: city, addressCountry: 'DE' } },
})}</script></head><body>${title}</body></html>`;

function serve(live) {
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    // /t/... the shared tenant (several boards read the same sitemap); /agg/sitemap.xml lists the tenant's own URLs (an aggregator)
    if (req.url === '/t/sitemap.xml' || req.url === '/agg/sitemap.xml') {
      res.setHeader('content-type', 'application/xml');
      return res.end(`<?xml version="1.0"?><urlset>${[...live].map((n) => `<url><loc>${base}/t/job/${n}</loc><lastmod>2026-11-01</lastmod></url>`).join('')}</urlset>`);
    }
    const m = req.url.match(/^\/t\/job\/(\d)$/);
    if (m && JOBS[m[1]]) { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(page('Tenant Co', ...JOBS[m[1]])); }
    // /p/list.json: another board listing posting 1 with a place the profile blocks hard (a policy hide)
    if (req.url.startsWith('/p/list.json')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ items: live.has(1) ? [{ title: JOBS[1][0], url: `${base}/t/job/1`, location: 'Pune, India' }] : [] }));
    }
    res.statusCode = 404; res.end('missing');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const history = (data) => readFileSync(join(data, 'scan-history.tsv'), 'utf8').trim().split('\n').slice(1)
  .map((l) => Object.fromEntries(l.split('\t').map((v, i) => [HEADER[i], v])));
const statusOf = (data, n) => history(data).find((r) => r.url.endsWith(`/t/job/${n}`))?.status;
const statuses = (data) => [1, 2, 3].map((n) => statusOf(data, n));

function profile(dir, entries) {
  const prof = join(dir, 'profile'), data = join(dir, 'data');
  mkdirSync(prof, { recursive: true }); mkdirSync(data, { recursive: true });
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 'fixture', crawl: { companies_file: 'companies.json' } }));
  writeFileSync(join(prof, 'companies.json'), JSON.stringify({
    title_filter: { positive: ['Engineer'], negative: ['Sales'], seniority_boost: ['Senior'] },
    location_filter: { allow: ['Berlin', 'Munich', 'Paris'], block_hard: ['India'], allow_unknown: true },
    tracked_companies: entries,
  }));
  return { prof, data };
}
const crawl = (prof, data) => new Promise((done) => {
  const p = spawn(process.execPath, [resolve(ROOT, 'crawler/crawl.mjs'), '--profile', prof, '--data', data], {
    cwd: ROOT, env: { ...process.env, JOBCRAWL_PROFILE: '', JOBCRAWL_RAW_DIR: '', MADE_LIFECYCLE: '' },
  });
  let stdout = '', stderr = '';
  p.stdout.on('data', (c) => (stdout += c)); p.stderr.on('data', (c) => (stderr += c));
  p.on('close', (status) => done({ status, stdout, stderr }));
});
const keptLine = (r) => { const l = r.stdout.split('\n').find((x) => x.includes('hides kept back')); assert.ok(l, r.stdout + r.stderr); return l; };
const ok = (r) => assert.equal(r.status, 0, r.stdout + r.stderr);
// R3: the live watcher counts lines matching LIVE in the cycle log, the batch watcher bare BATCH lines; each fallback must be one line of both
const LIVE = /step failed|continuing with/, BATCH = /^\[degraded\] [^/\s]+\/[^:\s]+: .+ \((\d+)\)$/;
const admissionLines = (out) => out.split(/\r?\n/).filter((l) => l.includes('crawl/admission') || l.startsWith('[admission]'));
const counted = (out) => { const ls = admissionLines(out); return [ls.filter((l) => LIVE.test(l)).length, ls.filter((l) => BATCH.test(l)).reduce((t, l) => t + Number(l.match(BATCH)[1]), 0)]; };

const sm = (base, name, extra = {}) => ({ name, provider: 'sitemap', slug: `${base}/t/sitemap.xml`, url_pattern: '/job/', ...extra });
async function withServer(fn) {
  const live = new Set([1, 2, 3]);
  const server = await serve(live);
  const dir = mkdtempSync(join(tmpdir(), 'jobcrawl-admission-'));
  try { await fn({ base: `http://127.0.0.1:${server.address().port}`, dir, live }); } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('one tenant, a site whitelist on one board (Leonardo / Kopter): the whitelist never hides what the all-sites board admitted', () => withServer(async ({ base, dir }) => {
  const all = sm(base, 'All Sites', { any_location: true }), narrow = sm(base, 'Munich Only', { only_locations: ['Munich'] });
  let p = profile(dir, [all, narrow]);
  let r = await crawl(p.prof, p.data); ok(r);
  assert.deepEqual(statuses(p.data), ['open', 'open', 'open'], 'run 1: both boards due, the all-sites board admitted all three');
  assert.deepEqual(counted(r.stdout), [0, 0], 'a normal run prints no degraded line');
  assert.match(keptLine(r), /hides kept back \(another board admitted the role within 48 h\): 2 hides, 0 closes, by board pair \(hider > admitting board\): Munich Only > All Sites 2/);
  // only the whitelisted board is due (the case of 24 Nov 18:24): before the rule all but Munich became 'filtered'
  p = profile(dir, [{ ...all, enabled: false }, narrow]);
  r = await crawl(p.prof, p.data); ok(r);
  assert.deepEqual(statuses(p.data), ['open', 'open', 'open'], 'run 2: nothing hidden');
  assert.match(keptLine(r), /Munich Only > All Sites 2/);
  assert.ok(JSON.parse(readFileSync(join(p.data, 'admit-state.json'), 'utf8')).boards.includes('All Sites'));
}));

test('an aggregator and the employer\'s own board (ESA / Space Individuals): the shadow verdict never hides the employer\'s admitted role', () => withServer(async ({ base, dir }) => {
  const own = sm(base, 'Tenant Co'), agg = { name: 'Agg Board', provider: 'sitemap', slug: `${base}/agg/sitemap.xml`, url_pattern: '/job/', aggregator: true, employer_from_jsonld: true };
  let p = profile(dir, [own, agg]);
  ok(await crawl(p.prof, p.data));
  // run 2: the employer now has open rows, so the aggregator's listing is "shadowed by the employer ATS"
  const r = await crawl(p.prof, p.data); ok(r);
  assert.deepEqual(statuses(p.data), ['open', 'open', 'open']);
  assert.match(keptLine(r), /Agg Board > Tenant Co 3/);
  // only the aggregator is due (24 Nov 21:30 with ESA timing out): still nothing hidden
  p = profile(dir, [{ ...own, enabled: false }, agg]);
  const r3 = await crawl(p.prof, p.data); ok(r3);
  assert.deepEqual(statuses(p.data), ['open', 'open', 'open']);
}));

test('two-way whitelist (Airbus): each board keeps what it admitted, whichever runs alone', () => withServer(async ({ base, dir }) => {
  const x = sm(base, 'Berlin Board', { only_locations: ['Berlin'] }), y = sm(base, 'Paris Board', { only_locations: ['Paris'] });
  let p = profile(dir, [x, y]);
  ok(await crawl(p.prof, p.data));
  assert.equal(statusOf(p.data, 1), 'open'); assert.equal(statusOf(p.data, 3), 'open');
  for (const due of [[x, { ...y, enabled: false }], [{ ...x, enabled: false }, y], [x, y]]) {
    p = profile(dir, due);
    ok(await crawl(p.prof, p.data));
    assert.equal(statusOf(p.data, 1), 'open', 'Berlin role stays open'); assert.equal(statusOf(p.data, 3), 'open', 'Paris role stays open');
    assert.equal(statusOf(p.data, 2), 'filtered', 'the Munich role nobody admits stays filtered');
  }
}));

test('a real close by the admitting board goes ahead at once, also for a role that carries the other board\'s name', () => withServer(async ({ base, dir, live }) => {
  // the narrow board is listed first, so it creates the rows (its name stays on them); the all-sites board admits them
  const narrow = sm(base, 'Munich Only', { only_locations: ['Munich'] }), all = sm(base, 'All Sites', { any_location: true });
  let p = profile(dir, [narrow, all]);
  ok(await crawl(p.prof, p.data));
  assert.deepEqual(statuses(p.data), ['open', 'open', 'open']);
  assert.equal(history(p.data).find((r) => r.url.endsWith('/t/job/1')).company, 'Munich Only');
  live.delete(1);
  // the admitting board alone says posting 1 is gone: it closes now, not at the other board's next fetch
  p = profile(dir, [{ ...narrow, enabled: false }, all]);
  const r = await crawl(p.prof, p.data); ok(r);
  assert.equal(statusOf(p.data, 1), 'gone');
  assert.match(r.stdout, /GONE: Munich Only - Systems Engineer/);
  assert.deepEqual([statusOf(p.data, 2), statusOf(p.data, 3)], ['open', 'open']);
  // and the role's own board closes what it lists no more, exactly as before
  live.delete(2);
  p = profile(dir, [narrow, { ...all, enabled: false }]);
  ok(await crawl(p.prof, p.data));
  assert.equal(statusOf(p.data, 2), 'gone', 'posting 2 was admitted by the narrow board itself: its close goes ahead');
}));

test('48 h expiry: an admission older than the hold no longer protects', () => withServer(async ({ base, dir }) => {
  const all = sm(base, 'All Sites', { any_location: true }), narrow = sm(base, 'Munich Only', { only_locations: ['Munich'] });
  let p = profile(dir, [all, narrow]);
  ok(await crawl(p.prof, p.data));
  const f = join(p.data, 'admit-state.json'), s = JSON.parse(readFileSync(f, 'utf8'));
  const allIdx = s.boards.indexOf('All Sites');
  for (const list of Object.values(s.urls)) for (const e of list) if (e[0] === allIdx) e[1] -= (ADMIT_HOLD_H + 1) * 3600e3;
  writeFileSync(f, JSON.stringify(s));
  p = profile(dir, [{ ...all, enabled: false }, narrow]);
  const r = await crawl(p.prof, p.data); ok(r);
  assert.deepEqual(statuses(p.data), ['filtered', 'open', 'filtered'], 'the all-sites board has not listed them for 49 h: the whitelist hides them');
  assert.match(keptLine(r), /: none/);
}));

test('a policy hide wins: the profile\'s hard location block hides a role another board admitted', () => withServer(async ({ base, dir }) => {
  const all = sm(base, 'All Sites', { any_location: true });
  const list = { name: 'List Board', provider: 'paginated_list', list: { url: `${base}/p/list.json?page={page}`, kind: 'json', items: 'items', fields: { title: 'title', url: 'url', location: 'location' } } };
  const p = profile(dir, [all, list]);
  const r = await crawl(p.prof, p.data); ok(r);
  assert.equal(statusOf(p.data, 1), 'filtered', 'blocked-location is policy: it is never kept back');
  assert.match(keptLine(r), /: none/);
}));

test('first run after the deploy (no state): open rows are seeded as admitted; an unreadable state file seeds too and the run goes on', () => withServer(async ({ base, dir }) => {
  const all = sm(base, 'All Sites', { any_location: true }), narrow = sm(base, 'Munich Only', { only_locations: ['Munich'] });
  let p = profile(dir, [all, { ...narrow, enabled: false }]);
  ok(await crawl(p.prof, p.data));
  rmSync(join(p.data, 'admit-state.json'));
  p = profile(dir, [{ ...all, enabled: false }, narrow]);
  let r = await crawl(p.prof, p.data); ok(r);
  assert.match(r.stdout, /\[admission\] no state yet: 3 open roles seeded as admitted \(0 by the board that last listed them, 3 by the board their company names\)/);
  assert.deepEqual(statuses(p.data), ['open', 'open', 'open']);
  writeFileSync(join(p.data, 'admit-state.json'), '{not json');
  r = await crawl(p.prof, p.data); ok(r);
  assert.deepEqual(counted(r.stdout), [1, 1], 'the unreadable state is counted once by each watcher');
  assert.match(admissionLines(r.stdout)[0], /^\[degraded\] crawl\/admission: admit-state\.json unreadable \(.*\), continuing with a fresh seed from the history \(1\)$/);
  assert.deepEqual(statuses(p.data), ['open', 'open', 'open']);
  assert.ok(existsSync(join(p.data, 'admit-state.json')) && JSON.parse(readFileSync(join(p.data, 'admit-state.json'), 'utf8')).v === 1);
}));

test('admission rule, unit: own hide withdraws, a suspect answer withdraws nothing, the summary line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobcrawl-admission-unit-'));
  try {
    const now = Date.parse('2026-11-25T12:00:00Z');
    const a = openAdmissions(dir, { now, log: () => {} });
    for (let n = 0; n < 10; n++) a.admit(`u${n}`, 'A');
    a.admit('u0', 'B');
    assert.equal(a.mayHide('u0', 'B', 'location (site whitelist)'), 'A', 'B may not hide what A admitted');
    assert.equal(a.mayHide('u0', 'A', 'negative-title'), null, 'A hides its own role (B withdrew by its hide)');
    assert.equal(a.mayHide('u1', 'B', 'blocked-location'), null, 'policy');
    assert.equal(a.mayHide('u1', 'B', 'x', false), null, 'a row that is not visible');
    a.withdrawFromAnswers([{ board: 'A', listed: new Set(['u1', 'u2']), complete: true, emptyOk: false }]);
    assert.equal(a.mayHide('u5', 'B', 'x'), 'A', 'a suspect answer (2 of 9 still listed) withdraws nothing');
    a.withdrawFromAnswers([{ board: 'A', listed: new Set(['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7']), complete: true, emptyOk: false }]);
    assert.equal(a.mayClose('u8', 'B'), null, 'A said u8 is gone: B may close it');
    assert.equal(a.mayClose('u7', 'B'), 'A');
    assert.match(a.summaryLine(), /^hides kept back \(another board admitted the role within 48 h\): 2 hides, 1 closes, by board pair \(hider > admitting board\): B > A 3; 4 admissions withdrawn$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R3: a state file that cannot be written is counted once by each watcher and the run goes on', () => withServer(async ({ base, dir }) => {
  const all = sm(base, 'All Sites', { any_location: true });
  const p = profile(dir, [all]);
  mkdirSync(join(p.data, 'admit-state.json.tmp'), { recursive: true });
  const r = await crawl(p.prof, p.data); ok(r);
  assert.deepEqual(statuses(p.data), ['open', 'open', 'open'], 'the crawl itself is complete');
  assert.deepEqual(counted(r.stdout), [1, 1]);
  assert.match(admissionLines(r.stdout).find((l) => l.startsWith('[degraded]')), /^\[degraded\] crawl\/admission: admit-state\.json not written \(.*\), continuing with a fresh seed at the next run \(1\)$/);
}));

test('R3: failed rule calls and an unreadable lifecycle state are each counted once per run, and the rule goes on as before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobcrawl-admission-r3-'));
  try {
    const lines = [];
    const bad = { url: 'u-bad', company: 'X', last_seen: '2026-11-24', get status() { throw new Error('broken row'); } };
    const good = { url: 'u-good', company: 'All Sites', last_seen: '2026-11-24', status: 'open' };
    const a = openAdmissions(dir, { now: Date.parse('2026-11-25T12:00:00Z'), log: (m) => lines.push(m),
      history: new Map([['u-bad', bad], ['u-bad2', bad], ['u-good', good]]), lifecycleState: () => { throw new Error('truncated'); } });
    assert.equal(a.mayHide('u-good', 'Narrow', 'location (site whitelist)'), 'All Sites', 'the good row is still seeded and held');
    const out = [...lines, a.degradedLine()].join(String.fromCharCode(10));
    assert.deepEqual(counted(out), [2, 2], 'two cases, each one line: the lifecycle fallback and the failed calls (two rows, one line)');
    assert.match(a.degradedLine(), /^\[degraded\] crawl\/admission: 2 rule call\(s\) failed, continuing with the hides and closes as before \(1\)$/);
    assert.ok(lines.some((l) => /^\[degraded\] crawl\/admission: lifecycle state unreadable \(truncated\), continuing with a seed by company name \(1\)$/.test(l)));
    const clean = openAdmissions(dir, { log: () => {} });
    assert.equal(clean.degradedLine(), null, 'no failed call: no line');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
