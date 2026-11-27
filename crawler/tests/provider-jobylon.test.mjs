// Jobylon preset (jobylon = jsonld_direct over emp.jobylon.com posting links) and the generic link reader on links in inline JSON
// state, in the shape of www.greencargo.com/karriar/lediga-jobb (2026-11-27; synthetic, no personal data). No network: fetch is stubbed.
// Run: node --test crawler/tests/provider-jobylon.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providers, setCacheDir } from '../providers.mjs';
import { jobLinks } from '../providers-generic.mjs';

const PAGE = `<html><body><div class="gce-jobylon"></div><script>AppRegistry.registerInitialState('12.x',{"jobs":{"jobs":[
{"title":"Verksamhetsutvecklare med fokus på AI","city":"Hallsberg","href":"https:\\u002F\\u002Femp.jobylon.com\\u002Fjobs\\u002F391777-acme-verksamhetsutvecklare\\u002F","startDate":"2026-10-20"},
{"title":"Examensarbete: Running resistance","city":"Stockholm","href":"https://emp.jobylon.com/jobs/391035-acme-examensarbete/","startDate":"2026-10-16"}]}});</script>
<a href="https://emp.jobylon.com/jobs/391035-acme-examensarbete/">Examensarbete</a><a href="https://www.jobylon.com/?utm_source=x">Jobylon</a></body></html>`;
const POSTING = (title, city) => `<html><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title, datePosted: '2026-10-20',
  hiringOrganization: { '@type': 'Organization', name: 'Acme Cargo' }, jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: city, addressCountry: 'SE' } }, description: '<p>Om rollen</p>' })}</script></html>`;

test('generic jobLinks: with json_links, links in inline JSON state count, escaped slashes included; other hosts and paths do not', () => {
  const off = jobLinks(PAGE, 'https://www.acme.se/karriar/lediga-jobb', /^\/jobs\/[0-9]+-/, ['emp.jobylon.com']);
  assert.deepEqual(off, ['https://emp.jobylon.com/jobs/391035-acme-examensarbete/'], 'without json_links only <a> links count');
  const links = jobLinks(PAGE, 'https://www.acme.se/karriar/lediga-jobb', /^\/jobs\/[0-9]+-/, ['emp.jobylon.com'], { jsonLinks: true });
  assert.deepEqual(links.sort(), ['https://emp.jobylon.com/jobs/391035-acme-examensarbete/', 'https://emp.jobylon.com/jobs/391777-acme-verksamhetsutvecklare/']);
});

test('jobylon: reads the employer page, then each posting page JSON-LD once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-jobylon-'));
  setCacheDir(dir);
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    if (u.startsWith('https://www.acme.se/')) return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    if (u.includes('391777')) return new Response(POSTING('Verksamhetsutvecklare med fokus på AI', 'Hallsberg'), { status: 200, headers: { 'content-type': 'text/html' } });
    if (u.includes('391035')) return new Response(POSTING('Examensarbete: Running resistance', 'Stockholm'), { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('no', { status: 404 });
  };
  try {
    const jobs = await providers.jobylon.fetch('https://www.acme.se/karriar/lediga-jobb', {});
    assert.equal(jobs.length, 2);
    const ai = jobs.find((j) => j.url.includes('391777'));
    assert.equal(ai.title, 'Verksamhetsutvecklare med fokus på AI');
    assert.match(ai.location, /Hallsberg/);
    assert.ok(!asked.some((u) => /api|feed/.test(u)), 'no Jobylon API or feed');
  } finally { globalThis.fetch = real; rmSync(dir, { recursive: true, force: true }); }
});
