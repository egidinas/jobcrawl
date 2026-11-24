// Infinite Orbits provider on a trimmed listing: titles from the card's <h2>, not from the URL slug (24 Nov 2026: the slug of one posting
// repeats its title, "Senior thermal engineersenior thermal engineer" on the board). No network.
// Run: node --test crawler/tests/provider-infiniteorbits.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providers, parseInfiniteOrbits, undoubled } from '../providers.mjs';

const html = readFileSync(new URL('./fixtures/infiniteorbits-listing.html', import.meta.url), 'utf8');

test('titles come from the card heading; links are deduplicated', () => {
  const jobs = parseInfiniteOrbits(html);
  assert.deepEqual(jobs.map((j) => j.title), ['Senior Thermal Engineer', 'Mechanical & Thermal Subsystem Lead', 'Systems engineer']);
  assert.ok(jobs.every((j) => j.location === 'Toulouse, France' && j.url.startsWith('https://jobs.infiniteorbits.io/jobs/')));
});

test('a slug title is de-doubled; ordinary titles are left alone', () => {
  assert.equal(undoubled('senior thermal engineersenior thermal engineer'), 'senior thermal engineer');
  assert.equal(undoubled('Thermal Engineer'), 'Thermal Engineer');
  assert.equal(undoubled('abab'), 'abab');
  assert.equal(undoubled('Go Go'), 'Go Go');
});

test('the provider entry reads the listing page', async () => {
  const real = globalThis.fetch; const asked = [];
  globalThis.fetch = async (u) => { asked.push(String(u)); return new Response(html, { status: 200 }); };
  try {
    const jobs = await providers.infiniteorbits.fetch('infiniteorbits', {});
    assert.equal(jobs.length, 3);
    assert.equal(jobs[0].title, 'Senior Thermal Engineer');
    assert.equal(asked.length, 1);
  } finally { globalThis.fetch = real; }
});
