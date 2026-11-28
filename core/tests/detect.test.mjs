// Detector v2 (core/detect, JOBCRAWLX row 2A.5): fingerprint coverage, the fixture set, ranking, the fetch path (injected fetch only,
// never the network), and the MCP / CLI switches. No test touches an employer site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { detect, detectOffline, best, coverage, FINGERPRINTS, SCHEMA, slugFor } from '../detect/index.mjs';
import { detectV1 } from '../detect/v1.mjs';
import { providers, resolve as resolveEntry } from '../../crawler/providers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'detect');
const ROOT = join(HERE, '..', '..');

test('fingerprints: schema v2, one row per registry provider, every regex compiles', () => {
  assert.equal(SCHEMA, 'jobcrawl-detect-fingerprints-v2');
  const c = coverage();
  assert.deepEqual(c.missing, [], `providers without a fingerprint row: ${c.missing.join(', ')}`);
  assert.ok(c.providers >= 121, `registry has ${c.providers} providers`);
  const raw = JSON.parse(readFileSync(join(ROOT, 'core/detect/fingerprints.json'), 'utf8'));
  for (const p of raw.providers) {
    assert.ok(['ats', 'site', 'generic', 'aggregator'].includes(p.kind), `${p.provider ?? p.platform}: kind ${p.kind}`);
    for (const s of [...p.hosts, ...p.url, ...p.cname, ...Object.values(p.html ?? {}).flat()]) assert.doesNotThrow(() => new RegExp(s, 'i'), `${p.provider}: ${s}`);
    for (const r of p.slug) assert.ok(['url', 'detect', 'const', 'ref', 'origin', 'host', 'page'].includes(r.from), `${p.provider}: slug rule ${r.from}`);
    if (p.provider && p.kind !== 'generic') assert.ok(p.hosts.length || p.url.length || Object.keys(p.html ?? {}).length || p.provider in { consider: 1, eploy: 1, jibe: 1 }, `${p.provider}: no signal at all`);
  }
  // no two rows claim the same provider
  const ids = FINGERPRINTS.map((p) => p.provider).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
});

// Each fixture's first line: <!-- expect: <provider|none> [<slug>] url=<page url> [cname=<target>] -->
const fixtures = readdirSync(FIX).filter((f) => /\.html$/.test(f)).map((f) => {
  const txt = readFileSync(join(FIX, f), 'utf8');
  const nl = txt.indexOf('\n');
  const head = txt.slice(0, nl);
  const m = head.match(/expect:\s*(\S+)(?:\s+(?!url=|cname=)(\S+))?/);
  return { f, provider: m[1], slug: m[2] ?? null, url: head.match(/url=(\S+)/)?.[1], cname: head.match(/cname=(\S+)/)?.[1] ?? '', html: txt.slice(nl + 1) };
});

test('fixtures: the best readable candidate and its slug', () => {
  assert.ok(fixtures.length >= 10);
  for (const x of fixtures) {
    const b = best(detectOffline({ url: x.url, html: x.html, cname: x.cname }).candidates);
    if (x.provider === 'none') { assert.equal(b, null, `${x.f}: expected nothing, got ${b?.provider}`); continue; }
    assert.equal(b?.provider, x.provider, `${x.f}`);
    if (x.slug) assert.equal(b.slug, x.slug, `${x.f}: slug`);
    assert.ok(b.evidence.length >= 1 && b.confidence > 0 && b.confidence <= 1, `${x.f}: evidence and confidence`);
  }
});

test('custom boards: generic candidates carry a proposed config for the crawler', () => {
  const cards = fixtures.find((x) => x.f === 'job-cards.html');
  const c = best(detectOffline({ url: cards.url, html: cards.html }).candidates);
  assert.equal(c.kind, 'generic');
  assert.equal(c.config.provider, 'paginated_list');
  assert.ok(c.config.list, 'a paginated_list html config');
  assert.ok(c.evidence.some((e) => e.kind === 'pagination'), 'pagination seen');
  const ld = fixtures.find((x) => x.f === 'jsonld-list.html');
  assert.deepEqual(best(detectOffline({ url: ld.url, html: ld.html }).candidates).config, { provider: 'jsonld_direct', careers_url: ld.url, slug: ld.url, max_jobs: 1000 });
});

test('ranking: an ATS embed outranks the page\'s own job cards; a slugless platform is reported, not answered', () => {
  const cards = fixtures.find((x) => x.f === 'job-cards.html');
  const html = cards.html.replace('</body>', '<script src="https://boards.greenhouse.io/embed/job_board/js?for=acmetech"></script></body>');
  const { candidates } = detectOffline({ url: cards.url, html });
  assert.equal(best(candidates).provider, 'greenhouse');
  assert.ok(candidates.some((c) => c.kind === 'generic'), 'the generic proposal is still listed');
  // reachmee's new "attract" UI: the vendor host is named, but no slug the reader can use
  const r = detectOffline({ url: 'https://acme.attract.reachmee.com/jobs/' });
  assert.equal(r.candidates[0].provider, 'reachmee');
  assert.equal(r.candidates[0].slug, null);
  assert.equal(best(r.candidates), null);
});

test('r2 tenant precedence: a markup-only hit does not take the page address over a link that names a tenant (personio vs jobylon)', () => {
  // shape of the 2026-11-28 hold-out miss: a careers page with Jobylon markup and links to emp.jobylon.com postings, and Personio
  // posting links naming the tenant; the label is Personio
  const html = '<div class="jobylon-jobs"></div><script>var u="https://emp.jobylon.com/jobs/";</script>'
    + '<a href="https://emp.jobylon.com/jobs/395836-financial-controller/">Financial Controller</a>'
    + '<a href="https://lime-tech.jobs.personio.de/job/2840664?language=en">Backend Developer</a>';
  const { candidates } = detectOffline({ url: 'https://jobs.lime.example/open-positions/', html });
  const b = best(candidates);
  assert.equal(b.provider, 'personio');
  assert.equal(b.slug, 'lime-tech');
  assert.ok(b.tenant);
  const jy = candidates.find((c) => c.provider === 'jobylon');
  assert.ok(jy && !jy.tenant, 'jobylon is listed, its slug only the page address');
  // emp.jobylon.com/jobs/123456-title is Jobylon's own host: never a Teamtailor custom domain
  assert.ok(!candidates.some((c) => c.provider === 'teamtailor'));
});

test('r2 tenant precedence: an embed with only the page address loses to a tenant link (avature vs radancy)', () => {
  const html = '<script src="https://services.tmpwebeng.com/magicbullet/"></script>'
    + '<a href="https://synopsys.avature.net/talentcommunity?jobId=88&source=Radancy">Join our talent community</a>';
  const { candidates } = detectOffline({ url: 'https://careers.synopsys.example/', html });
  assert.equal(best(candidates).provider, 'avature');
  assert.equal(best(candidates).slug, 'https://synopsys.avature.net');
  const rd = candidates.find((c) => c.provider === 'radancy');
  assert.ok(rd && !rd.tenant && rd.confidence < 0.9, 'radancy penalised: slug is only the page origin');
  // with a CNAME to the vendor the careers host IS the tenant: the origin slug is real evidence again
  const withCname = detectOffline({ url: 'https://careers.synopsys.example/', html: '<script src="https://services.tmpwebeng.com/magicbullet/"></script>', cname: 'x.radancy.net' });
  assert.ok(best(withCname.candidates).tenant);
});

test('r2: a slug-less hit seen in markup alone is penalised', () => {
  const { candidates } = detectOffline({ url: 'https://acme.example/jobs', html: '<div class="attrax-vacancy-tile" data-x="1"></div>' });
  const a = candidates.find((c) => c.provider === 'attrax');
  assert.ok(a && a.slug === null && a.confidence < 0.6);
  assert.equal(best(candidates)?.provider ?? null, null);
});

test('single-employer readers count only on their own domain', () => {
  const page = detectOffline({ url: 'https://www.bwi.de/karriere', html: '<a href="/karriere/stellen">Stellen</a>' });
  assert.equal(best(page.candidates)?.provider, 'bwi');
  const foreign = fixtures.find((x) => x.f === 'site-foreign-link.html');
  assert.ok(!detectOffline({ url: foreign.url, html: foreign.html }).candidates.some((c) => c.kind === 'site'));
});

test('URL tier: v2 from data alone agrees with providers.resolve on provider and slug', () => {
  const urls = [
    'https://boards.greenhouse.io/stripe', 'https://job-boards.eu.greenhouse.io/acme', 'https://jobs.ashbyhq.com/acme', 'https://jobs.lever.co/acme',
    'https://acme.jobs.personio.de/', 'https://jobs.smartrecruiters.com/Acme', 'https://acme.teamtailor.com/jobs', 'https://acme.recruitee.com/',
    'https://apply.workable.com/acme/', 'https://acme.wd3.myworkdayjobs.com/en-US/External', 'https://acme.bamboohr.com/careers', 'https://acme.breezy.hr/',
    'https://join.com/companies/acme', 'https://web103.reachmee.com/ext/I007/625/main?site=2&validator=b1b468e44c47fee73ea159bfa669dc82&lang=SE',
    'https://acme.varbi.com/se/', 'https://acme.career.emply.com/', 'https://dorbit-space.factorial.it', 'https://jobs.actago.de/jobs/Careers',
    'https://www.rheinmetall.com/de/karriere', 'https://careers.reorbit.space/', 'https://acme.applytojob.com/apply',
  ];
  for (const u of urls) {
    const v1 = resolveEntry({ careers_url: u });
    const v2 = best(detectOffline({ url: u }).candidates);
    assert.ok(v1, `v1 knows ${u}`);
    assert.equal(v2?.provider, v1.provider, u);
    assert.equal(v2?.slug, v1.slug, u);
  }
});

test('slug rules: a rule list per row, detect() as the code fallback', () => {
  const wd = FINGERPRINTS.find((p) => p.provider === 'workday');
  assert.equal(slugFor(wd, 'https://acme.wd3.myworkdayjobs.com/en-US/External'), providers.workday.detect('https://acme.wd3.myworkdayjobs.com/en-US/External'));
  const tt = FINGERPRINTS.find((p) => p.provider === 'teamtailor');
  assert.equal(slugFor(tt, '', { pageUrl: 'https://jobs.acme.example/' }), 'https://jobs.acme.example');
  assert.equal(slugFor(tt, 'https://app.teamtailor.com/x', { pageUrl: 'https://jobs.acme.example/' }), null, 'never a vendor host as an employer origin');
});

test('v1 baseline keeps the shipped order: URL match, link fingerprints, platform signals', () => {
  const hits = detectV1({ url: 'https://acme.example/careers', html: '<a href="https://jobs.lever.co/acme/1">x</a>' });
  assert.equal(hits[0].provider, 'lever');
  assert.equal(hits[0].evidence[0].type, 'page');
});

// ---- fetch path: injected fetch only ----
const page = (url, body, status = 200) => ({ status, url, headers: new Headers({ 'content-type': 'text/html' }), text: async () => body });
const publicDns = async () => [{ address: '93.184.216.34' }];   // the guard's DNS hook: every test host resolves to a public address

test('detect(): offline when html is given, even with a fetch', async () => {
  let calls = 0;
  const r = await detect({ url: 'https://acme.example/', html: '<a href="https://jobs.lever.co/acme">x</a>', fetch: async () => { calls++; throw new Error('no'); } });
  assert.equal(calls, 0);
  assert.equal(best(r.candidates).provider, 'lever');
});

test('detect(): one page plus at most one follow (careers link), never more', async () => {
  const seen = [];
  const site = {
    'https://www.acme.example/': '<a href="/karriere">Karriere</a><a href="/produkte">Produkte</a>',
    'https://www.acme.example/karriere': '<iframe src="https://www.acme.example/jobs-frame"></iframe><a href="https://acme-gmbh.jobs.personio.de/">Jobs</a>',
  };
  const f = async (u) => { seen.push(u); if (!(u in site)) throw new Error(`unexpected request ${u}`); return page(u, site[u]); };
  const r = await detect({ url: 'https://www.acme.example/', fetch: f, lookupImpl: publicDns });
  assert.deepEqual(seen, ['https://www.acme.example/', 'https://www.acme.example/karriere']);
  const b = best(r.candidates);
  assert.equal(b.provider, 'personio');
  assert.equal(b.slug, 'acme-gmbh');
  assert.ok(b.evidence.some((e) => e.kind === 'follow'));
  assert.equal(r.fetched.length, 2);
});

test('detect(): no follow when the first page already names a board', async () => {
  const seen = [];
  const f = async (u) => { seen.push(u); return page(u, '<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script><a href="/careers">c</a>'); };
  const r = await detect({ url: 'https://acme.example/', fetch: f, lookupImpl: publicDns });
  assert.equal(seen.length, 1);
  assert.equal(best(r.candidates).slug, 'acme');
});

test('detect(): the default fetch is the egress guard (private addresses refused, no throw)', async () => {
  const r = await detect({ url: 'http://127.0.0.1:9/careers', allowFetch: true });
  assert.ok(r.error, 'refused');
  assert.equal(r.fetched.length, 0);
});

test('detect(): a caller fetch is guarded too: a follow link to a private address is refused before any request', async () => {
  const seen = [];
  const f = async (u) => { seen.push(u); return page(u, '<iframe src="http://192.168.1.10/careers-frame"></iframe>'); };
  const r = await detect({ url: 'https://acme.example/', fetch: f, lookupImpl: publicDns });
  assert.deepEqual(seen, ['https://acme.example/'], 'the private follow never reached the fetch');
  assert.match(String(r.fetched[1]?.error ?? ''), /./, 'the refused follow is recorded');
});

// ---- MCP and CLI switches (default stays v1) ----
test('MCP detect_board: v1 by default, v2 behind the detector option, same input schema', async () => {
  const { buildTools } = await import('../mcp/tools.mjs');
  const store = { kind: 'json', readTransaction: () => [], listBoards: () => [] };
  const v1 = (await buildTools({ store })).find((t) => t.name === 'detect_board');
  const v2 = (await buildTools({ store, detector: 'v2' })).find((t) => t.name === 'detect_board');
  assert.deepEqual(v1.inputSchema, v2.inputSchema);
  const html = '<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>';
  const a = await v1.handler({ url: 'https://acme.example/careers', html });
  const b = await v2.handler({ url: 'https://acme.example/careers', html });
  assert.equal(a.data.detector, undefined);
  assert.equal(b.data.detector, 'v2');
  assert.equal(b.data.hits[0].provider, 'greenhouse');
  assert.equal(b.data.hits[0].slug, 'acme');
  assert.ok(typeof b.data.hits[0].confidence === 'number');
});

test('MCP detect_page with detector v2: private targets refused, nothing reaches the network layer', async () => {
  const { buildTools } = await import('../mcp/tools.mjs');
  const store = { kind: 'json', readTransaction: () => [], listBoards: () => [] };
  const calls = [];
  const base = async (u) => { calls.push(String(u)); return new Response('<a href="https://jobs.lever.co/acme">x</a>', { status: 200, headers: { 'content-type': 'text/html' } }); };
  const lookupImpl = async (host) => [{ address: host === 'rebind.example' ? '10.1.2.3' : '93.184.216.34' }];
  const tool = (await buildTools({ store, allowCrawl: true, fetchImpl: base, lookupImpl, detector: 'v2' })).find((t) => t.name === 'detect_page');
  for (const url of ['http://127.0.0.1/', 'http://localhost:8080/x', 'http://169.254.169.254/latest/meta-data/', 'http://rebind.example/']) {
    const r = await tool.handler({ url });
    assert.equal(r.isError, true, url);
  }
  assert.deepEqual(calls, []);
  const ok = await tool.handler({ url: 'https://example.com/' });
  assert.equal(ok.isError, false);
  assert.equal(ok.data.detector, 'v2');
  assert.equal(ok.data.hits[0].provider, 'lever');
  assert.deepEqual(calls, ['https://example.com/']);
});

test('CLI detect --detector v2 --html: offline, ranked candidates', () => {
  const cli = join(ROOT, 'cli', 'jobcrawl.mjs');
  const out = JSON.parse(execFileSync(process.execPath, [cli, 'detect', 'https://acme.example/careers', '--detector', 'v2', '--html', join(FIX, 'greenhouse.html'), '--json'], { encoding: 'utf8' }));
  assert.equal(out.detector, 'v2');
  assert.equal(out.candidates[0].provider, 'greenhouse');
  assert.deepEqual(out.fetched, []);
  const v1 = execFileSync(process.execPath, [cli, 'detect', 'https://jobs.lever.co/acme'], { encoding: 'utf8' });
  assert.match(v1, /^lever:acme \(url\)/);
});
