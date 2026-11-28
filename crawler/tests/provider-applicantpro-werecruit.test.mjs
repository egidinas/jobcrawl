// ApplicantPro (X-Bow Systems) and WeRecruit (Unseenlabs) on recorded answers of 2026-11-28. No network: fetch is stubbed.
// Run: node --test crawler/tests/provider-applicantpro-werecruit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providers } from '../providers.mjs';
import { applicantProDomainId, parseApplicantProJobs, parseWeRecruit, weRecruitListLink } from '../providers-extra.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('applicantpro: tenant from any page of the subdomain; domain id from the jobs page', () => {
  assert.equal(providers.applicantpro.detect('https://xbowsystems.applicantpro.com/jobs/4259336'), 'xbowsystems');
  assert.equal(providers.applicantpro.detect('https://www.applicantpro.com/openings/xbowsystems/jobs'), null);
  assert.equal(applicantProDomainId(fx('applicantpro-jobs-page.html')), '15073');
});

test('applicantpro: rows with place, department and the posting date', () => {
  const rows = parseApplicantProJobs(JSON.parse(fx('applicantpro-core-jobs.json')), 'xbowsystems');
  assert.equal(rows.length, 55);
  assert.equal(rows[0].title, 'Design Engineer, Solid Rocket Motor (SRM)');
  assert.equal(rows[0].location, 'Huntsville, AL, USA, 35806');
  assert.equal(rows[0].postedAt, '2026-11-19');
  assert.equal(rows[0].url, 'https://xbowsystems.applicantpro.com/jobs/4175504');
  assert.equal(rows[0].department, 'Operations');
});

test('applicantpro: fetch = jobs page, then the core listing', async () => {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url); asked.push(u);
    return u.includes('/core/jobs/15073') ? new Response(fx('applicantpro-core-jobs.json'), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(fx('applicantpro-jobs-page.html'), { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    const jobs = await providers.applicantpro.fetch('xbowsystems', {});
    assert.equal(jobs.length, 55);
    assert.equal(asked.length, 2);
  } finally { globalThis.fetch = real; }
});

test('werecruit: tenant from the careers URL; offers read, spontaneous application left out', () => {
  assert.equal(providers.werecruit.detect('https://careers.werecruit.io/en/unseenlabs'), 'unseenlabs');
  assert.equal(providers.werecruit.detect('https://careers.werecruit.io/unseenlabs/offres/x-abc123'), 'unseenlabs');
  const origin = 'https://careers.werecruit.io';
  assert.equal(parseWeRecruit(fx('werecruit-home.html'), origin).length, 0);
  assert.equal(weRecruitListLink(fx('werecruit-home.html'), 'unseenlabs', origin), 'https://careers.werecruit.io/en/unseenlabs/eb51ac');
  const rows = parseWeRecruit(fx('werecruit-offers.html'), origin);
  assert.equal(rows.length, 4);
  assert.ok(rows.some((r) => r.id === '9010b9' && /logiciel RF/i.test(r.title) && /Cesson/.test(r.location)), JSON.stringify(rows));
  assert.ok(rows.every((r) => !/spontaneous/.test(r.url)));
});
