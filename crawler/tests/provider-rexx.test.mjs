// rexx systems provider on recorded listing pages (2026-11-27): a table theme on an employer domain (karriere.n3eos.com, with an
// Atom feed) and a div.joboffer_container theme (career.schiebel.net), plus the vendor-hosted article-card theme (synthetic).
// No network: fetch is stubbed.   Run: node --test crawler/tests/provider-rexx.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providers } from '../providers.mjs';
import { rexxOrigin, parseRexxListing, parseRexxFeed, rexxFeedUrl } from '../providers-extra.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

async function withRoutes(routes, fn) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    const hit = Object.entries(routes).find(([k]) => u.includes(k));
    return hit ? new Response(hit[1], { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('missing', { status: 404 });
  };
  try { return await fn(asked); } finally { globalThis.fetch = real; }
}

test('rexx: board is a tenant label or an employer host', () => {
  assert.equal(rexxOrigin('acme'), 'https://acme-portal.rexx-systems.com');
  assert.equal(rexxOrigin('karriere.n3eos.com'), 'https://karriere.n3eos.com');
  assert.equal(rexxOrigin('https://Career.Schiebel.net/stellenangebote.html'), 'https://career.schiebel.net');
  assert.throws(() => rexxOrigin('bad host/../x y'));
  assert.equal(providers.rexx.detect('https://acme-portal.rexx-systems.com/stellenangebote.html'), 'acme');
  assert.equal(providers.rexx.detect('https://karriere.n3eos.com/'), null);
});

test('rexx: table theme reads every row and no intro links', () => {
  const jobs = parseRexxListing(fx('rexx-table-listing.html'), 'https://karriere.n3eos.com');
  assert.equal(jobs.length, 28);
  assert.ok(jobs.every((j) => /^https:\/\/karriere\.n3eos\.com\/.+-j\d+\.html$/.test(j.url) && j.title));
  assert.ok(jobs.some((j) => j.title.includes('Fluggerätmechaniker')), 'UTF-8 umlauts survive');
  assert.ok(!jobs.some((j) => /-f\d+\.html$/.test(j.url)), 'the unsolicited-application link (-f11) is not a job');
  assert.equal(new Set(jobs.map((j) => j.id)).size, jobs.length);
});

test('rexx: container theme reads title and place, skips the intro-text links', () => {
  const jobs = parseRexxListing(fx('rexx-container-listing.html'), 'https://career.schiebel.net');
  assert.equal(jobs.length, 11);
  const ids = jobs.map((j) => j.id);
  assert.ok(!ids.includes('11') && !ids.includes('263'), 'unsolicited application and internship links in the intro stay out');
  const harness = jobs.find((j) => j.id === '305');
  assert.equal(harness.location, 'Wien, Wiener Neustadt');
  assert.match(harness.title, /^Electrical Harness Design Engineer/);
});

test('rexx: vendor-hosted article cards still parse', () => {
  const html = `<html><body><div id="joboffers">
<article class="joboffer"><div class="joboffer_title_text"><a href="/Systems-Engineer-mwd-de-j12.html">Systems Engineer (m/w/d)</a></div><div class="job_standort">München</div></article>
<article class="joboffer"><div class="joboffer_title_text"><a href="https://acme-portal.rexx-systems.com/Test-Engineer-en-j13.html">Test Engineer</a></div><div class="job_standort">Gilching</div></article>
</div></body></html>`;
  const jobs = parseRexxListing(html, 'https://acme-portal.rexx-systems.com');
  assert.deepEqual(jobs.map((j) => [j.id, j.title, j.location]), [['12', 'Systems Engineer (m/w/d)', 'München'], ['13', 'Test Engineer', 'Gilching']]);
  assert.equal(jobs[0].url, 'https://acme-portal.rexx-systems.com/Systems-Engineer-mwd-de-j12.html');
});

test('rexx: Atom feed gives dates by URL; only a same-origin feed link is followed', () => {
  const html = fx('rexx-table-listing.html');
  assert.equal(rexxFeedUrl(html, 'https://karriere.n3eos.com'), 'https://karriere.n3eos.com/rss_generator-rss0.php?unit=n3eos&lang=de');
  assert.equal(rexxFeedUrl('<a href="https://evil.example/rss_generator-rss0.php">', 'https://karriere.n3eos.com'), '');
  const byUrl = parseRexxFeed(fx('rexx-feed.atom'));
  assert.equal(byUrl.size, 3);
  assert.equal(byUrl.get('https://karriere.n3eos.com/Ingenieur-Wartung-Instandhaltung-Triebwerkspruefstand-mwd-de-j734.html').postedAt, '2026-11-23');
});

test('rexx: fetch joins listing and feed, one request each', async () => {
  await withRoutes({ '/stellenangebote.html': fx('rexx-table-listing.html'), 'rss_generator': fx('rexx-feed.atom') }, async (asked) => {
    const jobs = await providers.rexx.fetch('karriere.n3eos.com', {});
    assert.equal(jobs.length, 28);
    assert.equal(asked.length, 2);
    assert.equal(jobs.find((j) => j.url.endsWith('-j734.html')).postedAt, '2026-11-23');
    assert.ok(jobs.every((j) => !('id' in j) && j.department === ''));
  });
});

test('rexx: a broken feed does not lose the listing', async () => {
  await withRoutes({ '/stellenangebote.html': fx('rexx-table-listing.html') }, async () => {
    const jobs = await providers.rexx.fetch('karriere.n3eos.com', {});
    assert.equal(jobs.length, 28);
    assert.ok(jobs.every((j) => j.postedAt === ''));
  });
});

test('rexx: a row whose first job link is an image link takes its next link with text', () => {
  const html = `<div id="joboffers"><div class="joboffer_container">
<a href="https://acme-portal.rexx-systems.com/Test-Engineer-de-j21.html"><img src="/logo.png" alt=""></a>
<div class="joboffer_title_text"><a href="https://acme-portal.rexx-systems.com/Test-Engineer-de-j21.html">Test Engineer (m/w/d)</a></div>
<div class="joboffer_informations joboffer_box">Gilching<div id="job_location"></div></div></div></div>`;
  const jobs = parseRexxListing(html, 'https://acme-portal.rexx-systems.com');
  assert.deepEqual(jobs.map((j) => [j.id, j.title, j.location]), [['21', 'Test Engineer (m/w/d)', 'Gilching']]);
});
