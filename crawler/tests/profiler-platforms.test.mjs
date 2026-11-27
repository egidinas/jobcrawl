// Multi-signal board identification (crawler/profiler/platforms.mjs + fingerprints.json) on recorded and synthetic pages. No network.
// Run: node --test crawler/tests/profiler-platforms.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { identifyPlatforms, isVendorHost, pageRefs, PLATFORMS } from '../profiler/platforms.mjs';
import { providers } from '../providers.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('fingerprints.json: every row compiles, ids are unique, every named provider exists', () => {
  const ids = new Set();
  for (const p of PLATFORMS) {
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`); ids.add(p.id);
    if (p.provider) assert.ok(providers[p.provider], `${p.id}: provider ${p.provider} is not registered`);
    assert.ok([null, 'origin', 'host'].includes(p.slug), `${p.id}: slug rule`);
  }
});

test('rexx on the employer domain: markup names the platform, the careers host is the slug', () => {
  const [top] = identifyPlatforms({ pages: [{ url: 'https://karriere.n3eos.com/stellenangebote.html', html: fx('rexx-table-listing.html') }] });
  assert.equal(top.id, 'rexx');
  assert.equal(top.slug, 'karriere.n3eos.com');
  assert.ok(top.confidence >= 0.5);
});

test('a page on the vendor host and a redirect from the employer host are the strongest signal', () => {
  const [top] = identifyPlatforms({ pages: [{ requested: 'https://jobs.acme.de/', url: 'https://acme.jobs.personio.de/', html: '<html></html>' }] });
  assert.equal(top.id, 'personio');
  assert.equal(top.slug, 'acme');
  assert.ok(top.confidence >= 0.95);
});

test('an iframe embed outranks a bare link; the slug comes from the provider detect() on the embed URL', () => {
  const html = '<iframe src="https://acme.recruitee.com/embed"></iframe><a href="https://boards.greenhouse.io/other">x</a>';
  const out = identifyPlatforms({ pages: [{ url: 'https://www.acme.com/careers', html }] });
  assert.equal(out[0].id, 'recruitee');
  assert.equal(out[0].signals[0].kind, 'embed_host');
  assert.ok(out[0].confidence > out.find((x) => x.id === 'greenhouse').confidence);
});

test('CNAME to the vendor identifies a branded careers host with no markup at all', () => {
  const [top] = identifyPlatforms({ pages: [{ url: 'https://careers.acme.com/', html: '<html><body>Jobs</body></html>' }], cnames: { 'careers.acme.com': 'acme.teamtailor.com' } });
  assert.equal(top.id, 'teamtailor');
  assert.equal(top.slug, 'https://careers.acme.com');
});

test('unsupported platforms are named without a provider or slug', () => {
  const [top] = identifyPlatforms({ pages: [{ url: 'https://www.acme.se/jobb', html: '<script src="https://cdn.jobylon.com/embedder.js"></script>' }] });
  assert.equal(top.id, 'jobylon');
  assert.equal(top.provider, null);
  assert.equal(top.slug, null);
});

test('plain company page: nothing found; vendor hosts recognised', () => {
  assert.deepEqual(identifyPlatforms({ pages: [{ url: 'https://www.acme.de/karriere', html: '<a href="/karriere/ingenieur">Ingenieur (m/w/d)</a>' }] }), []);
  assert.equal(isVendorHost('acme-portal.rexx-systems.com'), true);
  assert.equal(isVendorHost('www.acme.de'), false);
  const r = pageRefs('<script src="//cdn.x.com/a.js"></script><a href="/jobs">j</a>', 'https://acme.de/');
  assert.deepEqual(r.embeds, ['https://cdn.x.com/a.js']);
  assert.ok(r.links.includes('https://acme.de/jobs'));
});
