// SuccessFactors classic career site (opt-in provider successfactors_classic) on replayed DWR answers shaped like the live tenant
// career2.successfactors.eu?company=aciturriae (2026-11-27). No network: fetch is stubbed.
// Run: node --test crawler/tests/provider-sfclassic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { providers } from '../providers.mjs';
import { sfClassicConfig, dwrParams, parseDwr, sfDates } from '../providers-sfclassic.mjs';

const BOOT = `<html lang="es-ES"><script>var ajaxSecKey="KEY123";AjaxService.setViewId('/ui/rcmcareer/pages/careersite/career.jsp.xhtml');</script></html>`;
const INIT = `throw 'allowScriptTagRemoting is false.';
//#DWR-REPLY
var s0={};var s1={};var s2=[];s0.fieldName="country";s0.fieldType="picklist";s1.value="es_ES";s1.label="Español";s2[0]=s0;
dwr.engine._remoteHandleCallback('0','0',{filters:s2,searchScope:"1"});`;
const UPDATE = `//#DWR-REPLY
dwr.engine._remoteHandleCallback('1','0',null);`;
const search = (rows, count) => `//#DWR-REPLY
var s0={};var s1=[];${rows.map((r, i) => `var s${i + 2}={};s${i + 2}.id=${r.id};s${i + 2}.title="${r.title}";s${i + 2}.postingDate="${r.date}";s${i + 2}.defaultLocale="es_ES";s1[${i}]=s${i + 2};`).join('')}
s0.postings=s1;s0.postingCount=${count};s0.detailURLPrefix="/career?career_ns=job_listing&company=acme&navBarLevel=JOB_SEARCH&rcm_site_locale=en_US&career_job_req_id=";
dwr.engine._remoteHandleCallback('2','0',s0);`;

async function withSite(answers, fn) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    asked.push({ u, init });
    if (u.includes('/career?company=')) return new Response(BOOT, { status: 200, headers: { 'content-type': 'text/html', 'set-cookie': 'JSESSIONID=abc; Path=/' } });
    const m = u.match(/\.(\w+)\.dwr$/)?.[1];
    const body = answers[m]?.shift?.() ?? answers[m];
    return body ? new Response(body, { status: 200 }) : new Response('nope', { status: 500 });
  };
  try { return await fn(asked); } finally { globalThis.fetch = real; }
}

test('sfclassic: slug forms and refusals; opt-in (detect never claims a URL)', () => {
  assert.deepEqual(sfClassicConfig('https://career2.successfactors.eu/career?company=aciturriae'), { origin: 'https://career2.successfactors.eu', company: 'aciturriae' });
  assert.deepEqual(sfClassicConfig('career5.successfactors.eu|termaas'), { origin: 'https://career5.successfactors.eu', company: 'termaas' });
  assert.equal(sfClassicConfig('https://evil.example/career?company=x'), null);
  assert.equal(sfClassicConfig('https://career5.successfactors.eu/career?company=a%20b'), null);
  assert.equal(providers.successfactors_classic.detect('https://career2.successfactors.eu/career?company=aciturriae'), null);
});

test('sfclassic: DWR parameter encoding and reply parsing', () => {
  assert.deepEqual(dwrParams([{ a: 'x y', b: [1] }]), ['c0-e1=string:x%20y', 'c0-e3=number:1', 'c0-e2=Array:[reference:c0-e3]', 'c0-param0=Object_Object:{a:reference:c0-e1, b:reference:c0-e2}']);
  const objs = parseDwr(search([{ id: 5035, title: 'OPERARIO/A DE MONTAJE', date: '23/11/2026' }], 1));
  assert.equal(objs.find((o) => o.postings).postings[0].title, 'OPERARIO/A DE MONTAJE');
  assert.throws(() => parseDwr('<html>login</html>'), /not a DWR reply/);
  assert.throws(() => parseDwr("dwr.engine._remoteHandleException('0','0',{\"message\":\"denied\"});"), /DWR error denied/);
  assert.equal(sfDates(['23/11/2026'], 'es')('23/11/2026'), '2026-11-23');
  assert.equal(sfDates(['11/23/2026'], 'en')('11/23/2026'), '2026-11-23');
});

test('sfclassic: fetch replays the anonymous flow with cookie and CSRF key, pages until a short page', async () => {
  const page1 = search(Array.from({ length: 50 }, (_, i) => ({ id: 6000 + i, title: `Ingeniero ${i}`, date: '20/11/2026' })), 51);
  const page2 = search([{ id: 5035, title: 'Operario de montaje', date: '23/11/2026' }], 51);
  await withSite({ getInitialJobSearchData: INIT, updateUserSelectedValues: UPDATE, search: [page1, page2] }, async (asked) => {
    const jobs = await providers.successfactors_classic.fetch('https://career2.successfactors.eu/career?company=acme', { detail_places: false });
    assert.equal(jobs.length, 51);
    assert.equal(jobs[50].url, 'https://career2.successfactors.eu/career?career_ns=job_listing&company=acme&navBarLevel=JOB_SEARCH&rcm_site_locale=es_ES&career_job_req_id=5035');
    assert.equal(jobs[50].postedAt, '2026-11-23');
    const post = asked.find((a) => a.u.endsWith('.search.dwr'));
    assert.equal(post.init.headers['x-csrf-token'], 'KEY123');
    assert.equal(post.init.headers.cookie, 'JSESSIONID=abc');
    assert.equal(asked.filter((a) => a.u.endsWith('.search.dwr')).length, 2);
  });
});

test('sfclassic: a login page instead of the search fails the board', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html>Sign in</html>', { status: 200 });
  try { await assert.rejects(providers.successfactors_classic.fetch('career5.successfactors.eu|acme', {}), /no ajaxSecKey/); } finally { globalThis.fetch = real; }
});

test('sfclassic: dotted German dates', () => {
  assert.equal(sfDates(['27.11.2026'], 'de-DE')('27.11.2026'), '2026-11-27');
});

test('sfclassic: places come from the microdata of each posting page, read once (cached)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { setCacheDir } = await import('../providers.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'jc-sfc-'));
  setCacheDir(dir);
  const page1 = search([{ id: 13954, title: 'Einkäufer (w/m/d)', date: '27.11.2026' }], 1);
  const detail = '<html><span itemprop="jobLocation" itemscope itemtype="http://schema.org/Place"><span itemprop="address" itemscope itemtype="http://schema.org/PostalAddress"><meta itemprop="addressLocality" content="Salzgitter"><meta itemprop="addressRegion" content="NI"><meta itemprop="addressCountry" content="DE"></span></span><span itemprop="title">Einkäufer (w/m/d)</span></html>';
  const real = globalThis.fetch;
  let details = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('career_job_req_id=')) { details++; return new Response(detail, { status: 200, headers: { 'content-type': 'text/html' } }); }
    if (u.includes('/career?company=')) return new Response(BOOT, { status: 200, headers: { 'set-cookie': 'JSESSIONID=abc' } });
    const m = u.match(/\.(\w+)\.dwr$/)?.[1];
    return new Response({ getInitialJobSearchData: INIT, updateUserSelectedValues: UPDATE, search: page1 }[m] ?? 'x', { status: 200 });
  };
  try {
    const a = await providers.successfactors_classic.fetch('career5.successfactors.eu|gesisgesel', {});
    assert.match(a[0].location, /Salzgitter/);
    assert.equal(a[0].postedAt, '2026-11-27');
    const b = await providers.successfactors_classic.fetch('career5.successfactors.eu|gesisgesel', {});
    assert.match(b[0].location, /Salzgitter/);
    assert.equal(details, 1, 'the posting page is read once');
  } finally { globalThis.fetch = real; rmSync(dir, { recursive: true, force: true }); }
});
