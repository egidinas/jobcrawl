// Advertiser attribution (advertiser.mjs): real crawls against a local HTTP server (sitemap boards whose pages declare a JSON-LD
// hiringOrganization), plus the Workday detail capture and the raw-capture seed. No network beyond 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldName, loadRules, ruleFor, seedFromRawCapture, openAdvertisers } from '../advertiser.mjs';
import { providers } from '../providers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HEADER = ['url', 'company', 'title', 'location', 'first_seen', 'last_seen', 'status', 'posted'];
// the tenant's postings: id -> [title, city, declared advertiser]
const JOBS = {
  1: ['Systems Engineer', 'Munich', '922E Airbus Defence and Space GmbH'],
  2: ['Test Engineer', 'Donauwoerth', 'Airbus Helicopters Deutschland GmbH'],
  3: ['Software Engineer', 'Hamburg', 'Airbus Operations GmbH'],
  4: ['Data Engineer', 'Berlin', 'Some Unknown Entity GmbH'],
};
const page = (org, title, city) => `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'JobPosting', title, datePosted: '2026-11-01', hiringOrganization: { name: org },
  description: `<p>${org} is hiring a ${title} in ${city}.</p>`,
  jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: city, addressCountry: 'DE' } },
})}</script></head><body>${title}</body></html>`;
function serve(live) {
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/t/sitemap.xml') {
      res.setHeader('content-type', 'application/xml');
      return res.end(`<?xml version="1.0"?><urlset>${[...live].map((n) => `<url><loc>${base}/t/job/${n}</loc><lastmod>2026-11-01</lastmod></url>`).join('')}</urlset>`);
    }
    if (req.url === '/other/sitemap.xml') { res.setHeader('content-type', 'application/xml'); return res.end('<?xml version="1.0"?><urlset></urlset>'); }
    const m = req.url.match(/^\/t\/job\/(\d)$/);
    if (m && JOBS[m[1]]) { res.setHeader('content-type', 'text/html; charset=utf-8'); const [t, c, o] = JOBS[m[1]]; return res.end(page(o, t, c)); }
    res.statusCode = 404; res.end('missing');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}
const RULES = { version: 1, rules: [
  { match: '^airbus defence and space\\b', company: 'Airbus Defence and Space' },
  { match: '^airbus helicopters\\b', company: null },
  { match: '^airbus operations\\b', company: 'Airbus' },
] };
function profile(dir, entries, rules = RULES) {
  const prof = join(dir, 'profile'), data = join(dir, 'data');
  mkdirSync(prof, { recursive: true }); mkdirSync(data, { recursive: true });
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 'fixture', crawl: { companies_file: 'companies.json', ...(rules === undefined ? {} : { advertisers_file: 'advertisers.json' }) } }));
  if (rules !== undefined) writeFileSync(join(prof, 'advertisers.json'), typeof rules === 'string' ? rules : JSON.stringify(rules));
  writeFileSync(join(prof, 'companies.json'), JSON.stringify({
    title_filter: { positive: ['Engineer'], negative: ['Sales'], seniority_boost: ['Senior'] },
    location_filter: { allow: [], block_hard: [], allow_unknown: true },
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
const ok = (r) => assert.equal(r.status, 0, r.stdout + r.stderr);
const history = (data) => readFileSync(join(data, 'scan-history.tsv'), 'utf8').trim().split('\n').slice(1)
  .map((l) => Object.fromEntries(l.split('\t').map((v, i) => [HEADER[i], v])));
const row = (data, n) => history(data).find((r) => r.url.endsWith(`/t/job/${n}`));
const LIVE = /step failed|continuing with/, BATCH = /^\[degraded\] [^/\s]+\/[^:\s]+: .+ \((\d+)\)$/;
const counted = (out) => { const ls = out.split(/\r?\n/).filter((l) => l.includes('crawl/advertiser')); return [ls.filter((l) => LIVE.test(l)).length, ls.filter((l) => BATCH.test(l)).length]; };
const sm = (base, name, extra = {}) => ({ name, provider: 'sitemap', slug: `${base}/t/sitemap.xml`, url_pattern: '/job/', any_location: true, ...extra });
async function withServer(fn) {
  const live = new Set([1, 2, 3, 4]);
  const server = await serve(live);
  const dir = mkdtempSync(join(tmpdir(), 'jobcrawl-advertiser-'));
  try { await fn({ base: `http://127.0.0.1:${server.address().port}`, dir, live }); } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('a role shows under the advertiser its posting declares; unknown names keep the board company and are listed; null rules keep it', () => withServer(async ({ base, dir }) => {
  const p = profile(dir, [sm(base, 'Airbus (Workday, all sites)')]);
  const r = await crawl(p.prof, p.data); ok(r);
  assert.equal(row(p.data, 1).company, 'Airbus Defence and Space');
  assert.equal(row(p.data, 2).company, 'Airbus (Workday, all sites)', 'a rule with company null keeps the board company');
  assert.equal(row(p.data, 3).company, 'Airbus');
  assert.equal(row(p.data, 4).company, 'Airbus (Workday, all sites)', 'no rule: the board company stays (inferred)');
  assert.match(r.stdout, /advertiser attribution: 2 roles shown under their declared advertiser; this run 2 relabelled, 0 given back to their board \(Airbus \(Workday, all sites\) -> Airbus Defence and Space 1, Airbus \(Workday, all sites\) -> Airbus 1\); 1 declared names without a rule on 1 listed roles/);
  const tsv = readFileSync(join(p.data, 'advertisers-unknown.tsv'), 'utf8').trim().split('\n');
  assert.equal(tsv.length, 2); assert.match(tsv[1], /^Some Unknown Entity GmbH\t1\tAirbus \(Workday, all sites\)\t/);
  assert.deepEqual(counted(r.stdout), [0, 0], 'a normal run prints no degraded line');
  const again = await crawl(p.prof, p.data); ok(again);
  assert.match(again.stdout, /advertiser attribution: 2 roles shown under their declared advertiser; this run 0 relabelled/);
}));

test('ownership: a relabelled role is closed by the board that lists it, never by a board whose name it now carries', () => withServer(async ({ base, dir, live }) => {
  // "Airbus Defence and Space" is also a tracked board (another sitemap that lists none of these URLs)
  const other = { name: 'Airbus Defence and Space', provider: 'sitemap', slug: `${base}/other/sitemap.xml`, url_pattern: '/job/', any_location: true };
  const p = profile(dir, [sm(base, 'Airbus (Workday, all sites)'), other]);
  ok(await crawl(p.prof, p.data));
  const r = await crawl(p.prof, p.data); ok(r);
  assert.equal(row(p.data, 1).status, 'open', 'the other board answered with nothing and does not close it');
  assert.doesNotMatch(r.stdout, /GONE: Airbus Defence and Space - Systems Engineer/);
  live.delete(1);
  const r3 = await crawl(p.prof, p.data); ok(r3);
  assert.equal(row(p.data, 1).status, 'gone', 'the listing board closes it when its answer drops it');
  assert.match(r3.stdout, /GONE: Airbus Defence and Space - Systems Engineer/);
}));

test('a rule removed from the file gives the board\'s company back at the next listing; aggregators keep their own rows', () => withServer(async ({ base, dir }) => {
  let p = profile(dir, [sm(base, 'Airbus (Workday, all sites)')]);
  ok(await crawl(p.prof, p.data));
  assert.equal(row(p.data, 3).company, 'Airbus');
  p = profile(dir, [sm(base, 'Airbus (Workday, all sites)')], { version: 1, rules: RULES.rules.slice(0, 2) });
  const r = await crawl(p.prof, p.data); ok(r);
  assert.equal(row(p.data, 3).company, 'Airbus (Workday, all sites)');
  assert.match(r.stdout, /1 given back to their board \(Airbus -> Airbus \(Workday, all sites\) \(rule gone\) 1\)/);
  const d2 = join(dir, 'agg');
  const q = profile(d2, [sm(base, 'Agg Board', { aggregator: true, employer_from_jsonld: true })]);
  ok(await crawl(q.prof, q.data));
  assert.equal(row(q.data, 1).company, '922E Airbus Defence and Space GmbH (via Agg Board)', 'an aggregator row is left as the aggregator names it');
}));

test('R3: an unreadable rules file and an unreadable record each print one line both watchers count; the crawl goes on', () => withServer(async ({ base, dir }) => {
  const p = profile(dir, [sm(base, 'Airbus (Workday, all sites)')], '{not json');
  const r = await crawl(p.prof, p.data); ok(r);
  assert.deepEqual(counted(r.stdout), [1, 1]);
  assert.match(r.stdout, /\[degraded\] crawl\/advertiser: rules .*advertisers\.json unreadable \(.*\), continuing without relabelling \(1\)/);
  assert.equal(row(p.data, 1).company, 'Airbus (Workday, all sites)');
  assert.match(r.stdout, /advertiser attribution: off \(rules unreadable\)/);
  const q = profile(dir, [sm(base, 'Airbus (Workday, all sites)')]);
  writeFileSync(join(q.data, 'advertisers.json'), '[1,2');
  const r2 = await crawl(q.prof, q.data); ok(r2);
  assert.deepEqual(counted(r2.stdout), [1, 1]);
  assert.equal(row(q.data, 1).company, 'Airbus Defence and Space', 'the names are read again from the answer');
}));

test('unit: folding drops entity codes and accents; first rule wins; bad rules files are refused', () => {
  assert.equal(foldName('922E Airbus Defence and Space GmbH'), 'airbus defence and space gmbh');
  assert.equal(foldName('2164 Airbus Defence and Space SAU'), 'airbus defence and space sau');
  assert.equal(foldName('Y99000 General Electric Company'), 'general electric company');
  assert.equal(foldName('3D Systems GmbH'), '3d systems gmbh', 'a name that starts with a short token is not an entity code');
  assert.equal(foldName('AW PZL-Świdnik S.A.'), 'aw pzl swidnik s a');
  const dir = mkdtempSync(join(tmpdir(), 'jobcrawl-advertiser-unit-'));
  try {
    const f = join(dir, 'a.json');
    writeFileSync(f, JSON.stringify({ version: 1, rules: [{ match: '^ge avio\\b', company: null }, { match: '^ge ', company: 'GE Aerospace' }] }));
    const rules = loadRules(f);
    assert.deepEqual(ruleFor(rules, 'GE Avio S.r.l.'), { hit: true, company: null });
    assert.deepEqual(ruleFor(rules, 'GE Aviation Systems LLC'), { hit: true, company: 'GE Aerospace' });
    assert.deepEqual(ruleFor(rules, 'Avio SpA'), { hit: false, company: null });
    writeFileSync(f, JSON.stringify({ version: 1, rules: [{ match: '(', company: 'X' }] }));
    assert.throws(() => loadRules(f));
    writeFileSync(f, JSON.stringify({ version: 1, rules: [{ match: 'x', company: '' }] }));
    assert.throws(() => loadRules(f));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unit: the Workday description fetch keeps the declared advertiser; the raw-capture seed reads stored answers', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ hiringOrganization: { name: '922E Airbus Defence and Space GmbH' }, jobPostingInfo: { jobDescription: '<p>Build satellites.</p>' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const job = { url: 'https://ag.wd3.myworkdayjobs.com/Airbus/job/Munich/X_JR1', externalPath: '/job/Munich/X_JR1' };
    const text = await providers.workday.fetchDescription(job, 'ag|wd3|Airbus');
    assert.match(text, /Build satellites/);
    assert.equal(job.organization, '922E Airbus Defence and Space GmbH');
  } finally { globalThis.fetch = realFetch; }
  const raw = mkdtempSync(join(tmpdir(), 'jobcrawl-advertiser-raw-'));
  try {
    const body = Buffer.from(JSON.stringify({ hiringOrganization: { name: 'Airbus Operations GmbH' } }));
    const sha = createHash('sha256').update(body).digest('hex');
    mkdirSync(join(raw, 'objects', sha.slice(0, 2)), { recursive: true }); mkdirSync(join(raw, 'index'));
    writeFileSync(join(raw, 'objects', sha.slice(0, 2), `${sha}.gz`), gzipSync(body));
    writeFileSync(join(raw, 'index', '2026-11-24.jsonl'), JSON.stringify({ url: 'https://ag.wd3.myworkdayjobs.com/wday/cxs/ag/Airbus/job/Hamburg/Y_JR2', status: 200, sha256: sha }) + '\n');
    const m = seedFromRawCapture(raw, null);
    assert.equal(m.get('https://ag.wd3.myworkdayjobs.com/Airbus/job/Hamburg/Y_JR2'), 'Airbus Operations GmbH');
    const data = mkdtempSync(join(tmpdir(), 'jobcrawl-advertiser-data-'));
    const lines = [];
    const hist = new Map([['https://ag.wd3.myworkdayjobs.com/Airbus/job/Hamburg/Y_JR2', { url: 'https://ag.wd3.myworkdayjobs.com/Airbus/job/Hamburg/Y_JR2', company: 'Airbus (Workday, all sites)', status: 'open' }]]);
    const rf = join(data, 'rules.json'); writeFileSync(rf, JSON.stringify(RULES));
    const a = openAdvertisers(data, { rulesFile: rf, rawDir: raw, history: hist, log: (l) => lines.push(l) });
    assert.match(lines.join('\n'), /\[advertiser\] no record yet: 1 declared advertisers read from the raw capture \(1 Workday roles in the history\)/);
    const r = hist.values().next().value;
    assert.equal(a.applyTo(r, 'Airbus (Workday, all sites)'), 'relabelled');
    assert.equal(r.company, 'Airbus');
    assert.equal(a.ownerBoard(r.url), 'Airbus (Workday, all sites)');
    rmSync(data, { recursive: true, force: true });
  } finally { rmSync(raw, { recursive: true, force: true }); }
});
