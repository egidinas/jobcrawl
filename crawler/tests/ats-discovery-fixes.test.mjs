// Fixes proposed by the 2026-11-12 failing-sources check: the policy's login rule must not block WordPress's public admin-ajax.php (MBDA),
// and csod entries naming one career site share one read per cycle (OHB SE / MT Aerospace / OHB-System AG / KIRK).  No network.
// Run: node --test crawler/tests/ats-discovery-fixes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { noFetchReason } from '../policy.mjs';
import { providers } from '../providers.mjs';

test('noFetchReason: wp-admin/admin-ajax.php is public, wp-admin pages and wp-login stay refused', () => {
  assert.equal(noFetchReason('https://www.mbda-careers.de/wp/wp-admin/admin-ajax.php'), null);
  assert.match(noFetchReason('https://example.org/wp-admin/options.php'), /login/);
  assert.match(noFetchReason('https://example.org/wp-login.php'), /login/);
  assert.match(noFetchReason('https://example.org/login'), /login/);
});

test('csod: entries on the same career site share one read', async () => {
  let reads = 0;
  const real = providers.csod.fetchOnce;
  providers.csod.fetchOnce = async () => { reads++; return [{ title: 'x', url: 'https://t.csod.com/r/1' }]; };
  try {
    const slug = 'https://t.csod.com/ux/ats/careersite/4/home?c=t';
    const [a, b, c] = await Promise.all([providers.csod.fetch(slug, {}), providers.csod.fetch(slug, {}), providers.csod.fetch('https://t.csod.com/ux/ats/careersite/4/home/requisition/6817?c=t&sq=req6817&lang=en-GB', {})]);
    assert.equal(reads, 1);
    assert.equal(a.length, 1); assert.equal(b[0].title, 'x'); assert.equal(c.length, 1);
    providers.csod.fetchOnce = async () => { reads++; throw new Error('boom'); };
    const other = 'https://u.csod.com/ux/ats/careersite/4/home?c=u';
    await assert.rejects(providers.csod.fetch(other, {}), /boom/);
    await assert.rejects(providers.csod.fetch(other, {}), /boom/);   // a failure is not shared: the next entry retries
    assert.equal(reads, 3);
  } finally { providers.csod.fetchOnce = real; }
});
