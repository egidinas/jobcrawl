// Higher CandidatePortal (<tenant>.uhigher.com) on recorded api.uhigher.com answers of 2026-11-28 (SOVA, trimmed to 3 vacancies;
// Konecranes' 403). No network: fetch is stubbed. Run: node --test crawler/tests/provider-candidateportal.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providers } from '../providers.mjs';
import { parseCandidatePortalJobs } from '../providers-extra.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('candidateportal: tenant from the uhigher.com host only', () => {
  assert.equal(providers.candidateportal.detect('https://konecranes.uhigher.com/lediga-jobb'), 'konecranes');
  assert.equal(providers.candidateportal.detect('https://api.uhigher.com/api/v1/jobs'), null);
  assert.equal(providers.candidateportal.detect('https://higherjobs.uhigher.com/'), null);
  assert.equal(providers.candidateportal.detect('https://teracom.weselect.com/lediga-jobb'), null);
});

test('candidateportal: rows with place, category, text and deadline', () => {
  const rows = parseCandidatePortalJobs(JSON.parse(fx('candidateportal-jobs.json')), 'sova');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, 'Säljare - Sängexpert');
  assert.equal(rows[0].location, 'Mölndal (Västra Götalands)');
  assert.equal(rows[0].department, 'Försäljning');
  assert.equal(rows[0].deadline, '2027-01-08');
  assert.equal(rows[0].url, 'https://sova.uhigher.com/sv/job-details?job=e8de21b8-3f96-4d2c-accc-2470972d5e08');
  assert.ok(rows[0].description.length > 200 && !/<p /.test(rows[0].description));
});

test('candidateportal: fetch = company id, then the job list', async () => {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url); asked.push(u);
    return u.includes('company_landing_page') ? new Response(fx('candidateportal-company.json'), { status: 200 })
      : new Response(fx('candidateportal-jobs.json'), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const jobs = await providers.candidateportal.fetch('sova', {});
    assert.equal(jobs.length, 3);
    assert.equal(asked.length, 2);
    assert.match(asked[1], /company=43&publishOnHigher=1&status=active&limit=100&page=1/);
  } finally { globalThis.fetch = real; }
});

test('candidateportal: a closed tenant (403 "Company is not active") is an empty board', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(fx('candidateportal-inactive.json'), { status: 403 });
  try {
    assert.deepEqual(await providers.candidateportal.fetch('konecranes', {}), []);
  } finally { globalThis.fetch = real; }
});
