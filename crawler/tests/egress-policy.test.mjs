import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurePolicy, installGuard, robotsFor } from '../policy.mjs';
import { runWithSignal } from '../../core/fetch/context.mjs';

const pub = async () => [{ address: '93.184.216.34' }];

test('egress: robots.txt memoized by a board does not inherit that board abort signal; its rules stay correct', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (String(u).endsWith('robots.txt')) {
      await new Promise((r) => setTimeout(r, 80));
      if (init?.signal?.aborted) throw new Error('aborted');
      return new Response('User-agent: *\nDisallow: /private/\nCrawl-delay: 2\n');
    }
    return new Response('ok');
  };
  configurePolicy({ egressGuard: false });
  const uninstall = installGuard({ egress: true, lookupImpl: pub });
  try {
    const ac = new AbortController();
    const p = runWithSignal(ac.signal, () => robotsFor('https://robots-test.example'));
    ac.abort();   // the board ends (budget) while robots.txt is still in flight
    const r = await p;
    assert.equal(r.status, 200);
    assert.ok(r.rules.some((x) => x.path === '/private/' && x.allow === false), 'rules survived the abort');
    assert.equal(r.delay, 2);
  } finally { uninstall(); globalThis.fetch = origFetch; }
});

test('egress: the new path puts the guard inside the policy guard (robots redirect to a private host refused); credentials are stripped cross-origin only when on', async () => {
  const origFetch = globalThis.fetch, saved = process.env.JOBCRAWL_EGRESS_GUARD;
  delete process.env.JOBCRAWL_EGRESS_GUARD;
  const seen = [];
  globalThis.fetch = async (u, init) => {
    seen.push([String(u), new Headers(init?.headers ?? {}).get('authorization')]);
    if (String(u) === 'https://a.example/x') return new Response(null, { status: 302, headers: { location: 'https://b.example/y' } });
    if (String(u) === 'https://a.example/robots.txt') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/robots.txt' } });
    const rb = String(u).endsWith('robots.txt');
    return new Response(rb ? '' : 'ok', { status: rb ? 404 : 200 });
  };
  try {
    configurePolicy({ egressGuard: false });
    let un = installGuard();               // switch OFF: unchanged, credentials follow (legacy behaviour)
    await fetch('https://a.example/x', { headers: { authorization: 'Bearer t' } });
    assert.equal(seen.find(([u]) => u === 'https://b.example/y')[1], 'Bearer t');
    un();
    seen.length = 0;
    configurePolicy({ egressGuard: false });
    un = installGuard({ egress: true, lookupImpl: pub });   // new path
    await fetch('https://a.example/x', { headers: { authorization: 'Bearer t' } });
    assert.equal(seen.find(([u]) => u === 'https://b.example/y')[1], null);
    const r = await robotsFor('https://a.example');
    assert.ok(!seen.some(([u]) => u.includes('169.254.169.254')), 'the private hop was never requested');
    assert.equal(r.status, 0);
    un();
  } finally { globalThis.fetch = origFetch; if (saved !== undefined) process.env.JOBCRAWL_EGRESS_GUARD = saved; }
});
