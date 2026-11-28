import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurePolicy, installGuard, policyFromProfile } from '../policy.mjs';
import { loadProfile } from '../profile.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The live crawl's egress guard is a switch: OFF by default (requests exactly as before), ON by profile crawl.egress_guard or env.
async function withInstalled(egressGuard, env, fn) {
  const origFetch = globalThis.fetch, origEnv = process.env.JOBCRAWL_EGRESS_GUARD;
  const hits = [];
  globalThis.fetch = async (u) => { hits.push(String(u)); return new Response(String(u).endsWith('robots.txt') ? '' : 'ok', { status: String(u).endsWith('robots.txt') ? 404 : 200 }); };
  if (env === undefined) delete process.env.JOBCRAWL_EGRESS_GUARD; else process.env.JOBCRAWL_EGRESS_GUARD = env;
  configurePolicy({ egressGuard });
  const uninstall = installGuard();
  try { await fn(hits); } finally {
    uninstall(); globalThis.fetch = origFetch;
    if (origEnv === undefined) delete process.env.JOBCRAWL_EGRESS_GUARD; else process.env.JOBCRAWL_EGRESS_GUARD = origEnv;
  }
}

test('egress switch: default OFF leaves the live path unchanged (a private target is still requested)', async () => {
  await withInstalled(false, undefined, async (hits) => {
    const r = await fetch('http://127.0.0.1:9/x');
    assert.equal(await r.text(), 'ok');
    assert.ok(hits.some((h) => h.includes('127.0.0.1')));
  });
});

test('egress switch: profile key or env turns the guard on; env 0 forces it off', async () => {
  await withInstalled(true, undefined, async (hits) => {
    await assert.rejects(fetch('http://127.0.0.1:9/x'), /non-public|loopback/);
    await assert.rejects(fetch('http://169.254.169.254/'), /non-public/);
    assert.equal(hits.length, 0, 'nothing reached the network layer');
  });
  await withInstalled(false, '1', async () => { await assert.rejects(fetch('http://[::ffff:7f00:1]/'), /non-public/); });
  await withInstalled(true, '0', async () => { assert.equal(await (await fetch('http://127.0.0.1:9/x')).text(), 'ok'); });
});

test('egress switch: profile.json crawl.egress_guard is parsed and validated', () => {
  const d = mkdtempSync(join(tmpdir(), 'jcx-eg-'));
  writeFileSync(join(d, 'profile.json'), JSON.stringify({ crawl: { egress_guard: true } }));
  assert.equal(policyFromProfile(loadProfile(d), d).egressGuard, true);
  writeFileSync(join(d, 'profile.json'), JSON.stringify({ crawl: {} }));
  assert.equal(policyFromProfile(loadProfile(d), d).egressGuard, false);
  writeFileSync(join(d, 'profile.json'), JSON.stringify({ crawl: { egress_guard: 'yes' } }));
  assert.throws(() => loadProfile(d), /egress_guard/);
});
