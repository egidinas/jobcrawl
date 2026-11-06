// Career-site profiler (crawler/profiler.mjs, crawler/profiler/*): detection on captured and synthetic pages, the polite network layer,
// the cascade end to end on a stubbed web, and the crawl's re-profiling trigger. No network.   Run: node --test crawler/tests/profiler.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setCacheDir } from '../providers.mjs';
import { itemsOf, fieldsOf } from '../providers-generic.mjs';
import {
  atsFingerprints, careerLinks, linkGroups, htmlListConfig, pagination, jobArrays, pagingParam, sitemapLocs, sitemapJobGroup, titleScore, regDomain,
} from '../profiler/detect.mjs';
import { parseRobots, robotsAllows } from '../profiler/net.mjs';
import { xhrListConfig, baseline } from '../profiler/cascade.mjs';
import { reprofileCycle, REPROFILE_CYCLES } from '../profiler/health.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
setCacheDir(mkdtempSync(join(tmpdir(), 'profiler-test-')));

// A careers list shaped like the verified 2026-11-06 sites (li containers, heading inside the link, location span, "weiter" link).
const LIST = `<html><body><nav class="main-nav"><a href="/karriere">Karriere</a><a href="/produkte">Produkte</a><a href="/kontakt">Kontakt</a></nav>
<main><h1>Offene Stellen</h1><ul class="job-list">
<li class="job-item"><a href="/karriere/stellen/123-optik"><h3>Ingenieur Optikdesign (m/w/d)</h3><span class="job-location">Jena</span></a></li>
<li class="job-item"><a href="/karriere/stellen/124-embedded"><h3>Embedded Software Engineer (m/w/d)</h3><span class="job-location">Berlin</span></a></li>
<li class="job-item"><a href="/karriere/stellen/125-fertigung"><h3>Techniker Fertigung</h3><span class="job-location">Jena</span></a></li>
<li class="job-item"><a href="/karriere/stellen/126-qm"><h3>Qualitätsmanager (w/m/d)</h3><span class="job-location">Gera</span></a></li>
</ul><a href="/karriere/stellen?page=2">weiter</a></main><footer><a href="/impressum">Impressum</a><a href="/datenschutz">Datenschutz</a><a href="/agb">AGB</a></footer></body></html>`;

test('title score: postings vs navigation', () => {
  for (const t of ['Ingenieur Optikdesign (m/w/d)', 'Embedded Software Engineer', 'Werkstudent Mechatronik', 'Head of Propulsion']) assert.ok(titleScore(t) >= 0.6, t);
  for (const t of ['Karriere', 'Mehr erfahren', 'Impressum', 'Jobs', '12', 'Cookie-Einstellungen']) assert.ok(titleScore(t) < 0.6, t);
});

test('robots.txt: own token group beats "*", longest match, Allow on a tie, wildcards', () => {
  const txt = 'User-agent: *\nDisallow: /search\nAllow: /search/jobs\n\nUser-agent: MADE-jobs-crawler\nDisallow: /private\nDisallow: /*.pdf$\nCrawl-delay: 3\n';
  const own = parseRobots(txt, 'MADE-jobs-crawler');
  assert.equal(own.delay, 3);
  assert.equal(robotsAllows(own, '/search?q=x'), true);    // the "*" group does not apply to us once we have our own
  assert.equal(robotsAllows(own, '/private/x'), false);
  assert.equal(robotsAllows(own, '/a/b.pdf'), false);
  const star = parseRobots(txt, 'otherbot');
  assert.equal(robotsAllows(star, '/search?q=x'), false);
  assert.equal(robotsAllows(star, '/search/jobs/1'), true);
});

test('ATS fingerprints: embeds and links, never a company-specific provider on someone else\'s link', () => {
  const html = `<iframe src="https://acme.jobs.personio.de/?display=de"></iframe><script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
    <a href="https://www.bwi.de/karriere">Partner BWI</a><a href="https://careers.acme-group.com/search/?createNewAlert=false&q=">Jobs</a>`;
  const f = atsFingerprints(html, 'https://www.acme.de/karriere');
  const ids = f.map((x) => `${x.provider}:${x.slug}`);
  assert.ok(ids.includes('personio:acme'), ids.join(' '));
  assert.ok(ids.includes('greenhouse:acme'), ids.join(' '));
  assert.ok(ids.includes('successfactors:careers.acme-group.com'), ids.join(' '));
  assert.ok(!ids.some((x) => x.startsWith('bwi:')), 'bwi.de link on acme.de is not the acme board');
  assert.equal(atsFingerprints('<a href="https://www.bwi.de/karriere/stellen">x</a>', 'https://www.bwi.de/').some((x) => x.provider === 'bwi'), true);
});

test('careers link from a home page', () => {
  const home = '<a href="/produkte">Produkte</a><a href="/unternehmen/karriere/">Karriere</a><a href="https://www.linkedin.com/company/acme/jobs">LinkedIn</a>';
  assert.equal(careerLinks(home, 'https://www.acme.de/')[0].url, 'https://www.acme.de/unternehmen/karriere/');
});

test('repeated link group -> paginated_list html config that the production parser reads', () => {
  const url = 'https://www.acme.de/karriere/stellen';
  const g = linkGroups(LIST, url)[0];
  assert.equal(g.n, 4);
  assert.equal(g.hp.prefix, '/karriere/stellen/');
  assert.equal(g.titleSource, 'heading');
  const pg = pagination(LIST, url, g.n);
  assert.equal(pg.template, 'https://www.acme.de/karriere/stellen?page={page}');
  const list = htmlListConfig(g, url, LIST, pg);
  const { items } = itemsOf(LIST, list);
  const jobs = items.map((it) => fieldsOf(it, { ...list, url_base: url }));
  assert.deepEqual(jobs.map((j) => j.title), ['Ingenieur Optikdesign (m/w/d)', 'Embedded Software Engineer (m/w/d)', 'Techniker Fertigung', 'Qualitätsmanager (w/m/d)']);
  assert.equal(jobs[0].url, 'https://www.acme.de/karriere/stellen/123-optik');
  assert.equal(jobs[1].location, 'Berlin');
  // the footer and navigation never form a job group
  assert.ok(!linkGroups(LIST, url).some((x) => x.urls.some((u) => /impressum/.test(u)) && x.titleFrac > 0.4));
});

test('repeated link group on a captured careers page (dresden-elektronik.de, verified 2026-11-06)', () => {
  const html = fixture('profiler-dresden-elektronik-careers.html');
  const url = 'https://www.dresden-elektronik.de/karriere.html';
  const g = linkGroups(html, url).filter((x) => x.titleFrac >= 0.5)[0];
  assert.equal(g.hp.prefix, '/stellenangebot/');
  const list = htmlListConfig(g, url, html, pagination(html, url, g.n));
  assert.ok(!/category_8|arc_6/.test(list.items), 'no instance/category classes in the item pattern');
  const jobs = itemsOf(html, list).items.map((it) => fieldsOf(it, { ...list, url_base: url })).filter((j) => j.title && j.url);
  assert.ok(jobs.length >= 5, `${jobs.length} jobs`);
  assert.ok(jobs.some((j) => j.title === 'Embedded Softwareentwickler in der Verkehrstechnik (m/w/d)'), jobs.map((j) => j.title).join(' | '));
  assert.ok(jobs.every((j) => j.url.startsWith('https://www.dresden-elektronik.de/stellenangebot/')));
});

test('job sitemap (captured: autoflug.com jobs-sitemap.xml)', () => {
  const { isIndex, locs } = sitemapLocs(fixture('profiler-autoflug-jobs-sitemap.xml'));
  assert.equal(isIndex, false);
  const g = sitemapJobGroup(locs);
  assert.equal(g.prefix, '/job/');
  assert.ok(g.urls.length >= 10);
});

const API = { data: { total: 3, items: [
  { id: 811, jobTitle: 'Systems Engineer Satellite Bus (m/w/d)', city: 'Bremen', publishedAt: '2026-11-01', path: '/jobs/811-systems-engineer' },
  { id: 812, jobTitle: 'Thermal Engineer (m/w/d)', city: 'Bremen', publishedAt: '2026-10-28', path: '/jobs/812-thermal-engineer' },
  { id: 813, jobTitle: 'Werkstudent AIT', city: 'München', publishedAt: '2026-10-20', path: '/jobs/813-werkstudent-ait' },
] }, nav: [{ name: 'Home' }, { name: 'Jobs' }, { name: 'Kontakt' }] };

test('sniffed JSON: the job array, its fields, the paging knob -> paginated_list json', () => {
  const a = jobArrays(API)[0];
  assert.equal(a.path, 'data.items');
  assert.equal(a.fields.title, 'jobTitle');
  assert.equal(a.fields.url, 'path');
  assert.equal(a.fields.location, 'city');
  assert.equal(a.fields.postedAt, 'publishedAt');
  assert.deepEqual(pagingParam('https://api.acme.de/v1/jobs?lang=de&page=1&size=3'), { where: 'query', key: 'page', value: 1, kind: 'page' });
  assert.deepEqual(pagingParam('https://api.acme.de/search', '{"query":{"from":0,"size":20}}'), { where: 'body', key: 'query.from', value: 0, kind: 'offset' });
  const list = xhrListConfig({ url: 'https://api.acme.de/v1/jobs?lang=de&page=1&size=3', method: 'GET', json: API }, a, '', 'https://www.acme.de/karriere');
  assert.equal(list.url, 'https://api.acme.de/v1/jobs?lang=de&page={page}&size=3');
  assert.equal(list.first_page, 1);
  const { items } = itemsOf(JSON.stringify(API), list);
  const j = fieldsOf(items[0], list);
  assert.equal(j.url, 'https://www.acme.de/jobs/811-systems-engineer');
  assert.equal(j.location, 'Bremen');
  const post = xhrListConfig({ url: 'https://api.acme.de/search', method: 'POST', postData: '{"query":{"from":0,"size":20}}', reqHeaders: { 'content-type': 'application/json' }, json: API }, a, '', 'https://www.acme.de/');
  assert.equal(post.body, '{"query":{"from":{offset},"size":20}}');
  assert.equal(post.method, 'POST');
});

test('registrable domain and baseline', () => {
  assert.equal(regDomain('jobs.acme.co.uk'), 'acme.co.uk');
  assert.equal(regDomain('www.karriere.acme.de'), 'acme.de');
  assert.deepEqual(baseline(20), { expected_min: 5, expected_max: 90 });
  assert.deepEqual(baseline(2), { expected_min: 0, expected_max: 18 });
});

test('reprofile_due: set after 3 low or failed cycles, cleared on recovery or a newer profile', () => {
  const profile = { method: 'dom', at: '2026-11-06', items: 20, expected_min: 5, expected_max: 90 };
  const h = { fails: 0 };
  for (let i = 1; i < REPROFILE_CYCLES; i++) assert.equal(reprofileCycle(h, profile, { ok: true, n: 1, today: 'd' }), '');
  assert.match(reprofileCycle(h, profile, { ok: true, n: 1, today: 'd3' }), /^REPROFILE 1 jobs, under the profiled minimum 5 for 3 cycles/);
  assert.equal(h.reprofile_due, true); assert.equal(h.reprofile_since, 'd3');
  reprofileCycle(h, profile, { ok: true, n: 12, today: 'd4' });
  assert.equal(h.reprofile_due, undefined);
  const f = { fails: 3 };
  assert.match(reprofileCycle(f, profile, { ok: false, today: 'd' }), /failed 3 cycles/);
  reprofileCycle(f, { ...profile, at: '2026-11-20' }, { ok: false, today: 'd' });   // re-profiled: the old flag goes, the new baseline counts
  assert.equal(f.low, 0);
  assert.equal(reprofileCycle({ fails: 9 }, undefined, { ok: false, today: 'd' }), '');   // entries without a profile are never flagged
});

// ---------- end to end on a stubbed web ----------
const WEB = {
  'https://www.acme.de/robots.txt': 'User-agent: *\nDisallow: /intern\n',
  'https://www.acme.de/': '<html><body><a href="/karriere">Karriere</a><a href="/intern/karriere-alt">alt</a></body></html>',
  'https://www.acme.de/karriere': '<html><body><h1>Karriere</h1><a href="/karriere/stellen">Offene Stellen</a></body></html>',
  'https://www.acme.de/karriere/stellen': LIST,
  'https://www.acme.de/karriere/stellen?page=1': LIST,
  'https://www.acme.de/karriere/stellen?page=2': LIST.replace(/stellen\/12(\d)/g, 'stellen/22$1'),
};
async function withWeb(web, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = web[String(url)];
    return new Response(body ?? 'not found', { status: body == null ? 404 : 200, headers: { 'content-type': /\.xml$|robots/.test(String(url)) ? 'text/plain' : 'text/html' } });
  };
  try {
    const { makeNet } = await import(`../profiler/net.mjs?web=${Math.random()}`);   // a fresh module captures the stub as its "real" fetch
    const { profileSite } = await import('../profiler/cascade.mjs');
    const net = makeNet({ token: 'MADE-jobs-crawler', minGapMs: 0, budget: 10 });
    net.install();
    try { return await fn({ net, profileSite, calls }); } finally { net.uninstall(); }
  } finally { globalThis.fetch = real; }
}

test('cascade: home -> careers -> list -> verified paginated_list (dom), within the request budget, robots respected', async () => {
  await withWeb(WEB, async ({ net, profileSite, calls }) => {
    const site = { key: 'u:acme.de', name: 'ACME Optics GmbH', website: 'https://www.acme.de/', country: 'DE' };
    const rec = await net.run(site, () => profileSite(site, { net, date: '2026-11-06' }));
    assert.equal(rec.verified, true, JSON.stringify(rec.steps));
    assert.equal(rec.method, 'dom');
    assert.equal(rec.entry.provider, 'paginated_list');
    assert.equal(rec.entry.list.url, 'https://www.acme.de/karriere/stellen?page={page}');
    assert.ok(rec.items >= 4);
    assert.equal(rec.entry.profile.method, 'dom');
    assert.ok(rec.requests <= 10, `${rec.requests} requests`);
    assert.ok(!calls.some((u) => u.includes('/intern')), 'robots.txt Disallow honoured');
    assert.equal(calls.filter((u) => u.endsWith('/karriere/stellen')).length, 1, 'the verification re-read the cached list page');
  });
});

test('cascade: a domain the employer does not own is rejected', async () => {
  const web = { ...WEB, 'https://www.other.com/robots.txt': '', 'https://www.other.com/jobs': LIST };
  await withWeb(web, async ({ net, profileSite }) => {
    const site = { key: 'u:inno', name: 'inno-spec', website: 'https://www.inno.de/', careers_url: 'https://www.other.com/jobs', country: 'DE' };
    const rec = await net.run(site, () => profileSite(site, { net, date: '2026-11-06' }));
    assert.equal(rec.verified, false);
    assert.match(rec.steps.careers_in, /other_domain/);
  });
});

test('cascade: JobPosting JSON-LD on the posting pages -> jsonld_direct', async () => {
  const posting = (t) => `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"${t}","datePosted":"2026-11-01","jobLocation":{"address":{"addressLocality":"Jena","addressCountry":"DE"}}}</script></head><body></body></html>`;
  const web = { ...WEB };
  for (const [i, t] of ['Ingenieur Optikdesign (m/w/d)', 'Embedded Software Engineer (m/w/d)', 'Techniker Fertigung', 'Qualitätsmanager (w/m/d)'].entries()) web[`https://www.acme.de/karriere/stellen/12${3 + i}-${['optik', 'embedded', 'fertigung', 'qm'][i]}`] = posting(t);
  await withWeb(web, async ({ net, profileSite }) => {
    const site = { key: 'u:acme.de', name: 'ACME Optics GmbH', website: 'https://www.acme.de/', country: 'DE' };
    const rec = await net.run(site, () => profileSite(site, { net, date: '2026-11-06' }));
    assert.equal(rec.method, 'jsonld', JSON.stringify(rec.steps));
    assert.equal(rec.entry.provider, 'jsonld_direct');
    assert.equal(rec.entry.job_url_pattern, '^/karriere/stellen/');
    assert.equal(rec.items, 4);
  });
});

test('splice: verified entries appended with probation and profile, tracked names and hosts skipped, file stays valid JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'profiler-splice-'));
  try {
    const companies = join(dir, 'companies.json');
    writeFileSync(companies, JSON.stringify({ title_filter: {}, tracked_companies: [{ name: 'Old Co', careers_url: 'https://www.old.de/jobs', provider: 'jsonld_direct', slug: 'https://www.old.de/jobs', enabled: true }] }, null, 2) + '\n');
    writeFileSync(join(dir, 'profile.json'), JSON.stringify({ name: 't', crawl: { companies_file: 'companies.json' } }));
    const rec = (name, url, key) => ({ key, name, verified: true, method: 'dom', items: 6, samples: [{ title: 'Engineer (m/w/d)', url: `${url}/1` }], input: { source: 'universe:assoc:tierA', signal: 10 },
      entry: { name, careers_url: url, provider: 'paginated_list', slug: `profiled-${key}`, list: { kind: 'html', url, items: '<a>.*?</a>' }, profile: { method: 'dom', at: '2026-11-06', items: 6, expected_min: 1, expected_max: 34 } } });
    const report = join(dir, 'r.jsonl');
    writeFileSync(report, [rec('New Co', 'https://www.new.de/karriere', 'a'), rec('Old Co', 'https://www.x.de/jobs', 'b'), rec('Same Host', 'https://jobs.old.de/list', 'c'),
      { key: 'd', name: 'Watch Co', verified: false, reason: 'no_openings', careers_page: 'https://www.watch.de/karriere', input: { source: 'universe:assoc:tierA' } }].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, [new URL('../profiler.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'splice', '--profile', dir, '--report', report, '--date', '2026-11-06'], { encoding: 'utf8' });
    assert.match(out, /2 entries to add \(1 watch\/empty\)/);
    const cfg = JSON.parse(readFileSync(companies, 'utf8'));
    const watch = cfg.tracked_companies.at(-1);
    assert.equal(watch.name, 'Watch Co');
    assert.equal(watch.interval_hours, 168);
    assert.equal(watch.jsonld_only, true);
    assert.equal(watch.probation, true);
    assert.match(watch.note, /^profiled: empty at 2026-11-06/);
    const added = cfg.tracked_companies.at(-2);
    assert.equal(added.name, 'New Co');
    assert.equal(added.probation, true);
    assert.equal(added.enabled, true);
    assert.equal(added.profile.expected_min, 1);
    assert.match(added.note, /^profiled dom 2026-11-06/);
    assert.equal(cfg.tracked_companies.length, 3);
    // --replace: the verified board of a tracked name replaces that entry's board fields (re-resolved / re-profiled), nothing is added
    const out2 = execFileSync(process.execPath, [new URL('../profiler.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'splice', '--profile', dir, '--report', report, '--date', '2026-11-07', '--replace'], { encoding: 'utf8' });
    assert.match(out2, /replaced the board of 2 tracked entries: New Co; Old Co/);
    const cfg2 = JSON.parse(readFileSync(companies, 'utf8'));
    const old = cfg2.tracked_companies.find((c) => c.name === 'Old Co');
    assert.equal(old.provider, 'paginated_list');
    assert.equal(old.careers_url, 'https://www.x.de/jobs');
    assert.equal(old.enabled, true);
    assert.equal(old.slug, 'profiled-b');
    assert.equal(cfg2.tracked_companies.length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
