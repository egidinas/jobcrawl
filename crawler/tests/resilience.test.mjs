// node --test jobcrawl/crawler/tests/resilience.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyError, makeBreaker, livenessGuard, breakerHostOf, slugHost } from '../resilience.mjs';

test('classifyError: the classes', () => {
  const c = (e) => classifyError(e).cls;
  assert.equal(c(new Error('HTTP 500 https://x/')), 'HTTP_5XX');
  assert.equal(c(new Error('HTTP 403 https://x/')), 'WAF');
  assert.equal(c(new Error('HTTP 429 https://x/')), 'WAF');
  assert.equal(c(new Error('HTTP 404 https://x/')), 'MOVED');
  assert.equal(c(new Error('HTTP 422 https://x/')), 'HTTP_4XX');
  assert.equal(c(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'DNS');
  assert.equal(c(Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })), 'TIMEOUT_TLS');
  assert.equal(c(Object.assign(new Error('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' } })), 'TIMEOUT_TLS');
  assert.equal(c(new Error('Timed out after 35s (X)')), 'TIMEOUT_TLS');
  assert.equal(c(new Error('Unexpected token < in JSON')), 'PARSE');
  assert.equal(c(new Error('no supported ATS (set provider+slug or fix careers_url)')), 'CONFIG');
  assert.equal(c(new Error('something else entirely')), 'OTHER');
});

test('breaker: trips at 50 % and at least 3 of one class, backs off 1, 2, 4, 8, writes one flag, clears it', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'brk-')), healthDir = mkdtempSync(join(tmpdir(), 'hlt-'));
  const flag = join(healthDir, 'CRAWL_PROVIDER_DOWN.flag');
  const quiet = () => {};
  const t5 = { cls: 'HTTP_5XX', code: 500, detail: 'HTTP 500' };
  const run = (outcomes, opts = {}) => {
    const b = makeBreaker({ dataDir, healthDir, log: quiet, ...opts });
    const skipped = [];
    outcomes.forEach((ok, i) => { if (b.shouldSkip('reachmee', '')) skipped.push(i); else { const k = b.record('reachmee', '', ok, ok ? null : t5); if (k) b.commit(k, true); } });
    return { b, skipped, fin: b.finish() };
  };
  // 2 failures of 2: no trip (minimum 3)
  let r = run([false, false, true, true]);
  assert.equal(r.skipped.length, 0); assert.ok(!existsSync(flag));
  // 3 failures of 3: trip, the 4th and 5th are skipped
  r = run([false, false, false, true, true]);
  assert.deepEqual(r.skipped, [3, 4]); assert.ok(existsSync(flag));
  assert.match(readFileSync(flag, 'utf8'), /reachmee: HTTP_5XX 500/);
  // next cycle: level 1 = 1 cycle skipped
  r = run([true, true]); assert.deepEqual(r.skipped, [0, 1]);
  // then the provider is tried again, fails again: level 2 = 2 cycles
  r = run([false, false, false, false]); assert.deepEqual(r.skipped, [3]);
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'provider-breaker.json'), 'utf8')).providers.reachmee.level, 2);
  r = run([true]); assert.deepEqual(r.skipped, [0]);
  r = run([true]); assert.deepEqual(r.skipped, [0]);
  // tried again and healthy: breaker closed, flag removed
  r = run([true, true, true]); assert.equal(r.skipped.length, 0); assert.ok(!existsSync(flag));
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'provider-breaker.json'), 'utf8')).providers, {});
});

test('breaker: mixed classes do not trip; EURES is exempt; a dry run writes nothing', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'brk-')), healthDir = mkdtempSync(join(tmpdir(), 'hlt-'));
  const b = makeBreaker({ dataDir, healthDir, log: () => {}, dryRun: true });
  for (const cls of ['HTTP_5XX', 'MOVED', 'DNS', 'WAF']) b.record('x', '', false, { cls });
  assert.equal(b.shouldSkip('x', ''), false);
  for (let i = 0; i < 5; i++) b.record('eures', '', false, { cls: 'HTTP_5XX' });
  assert.equal(b.shouldSkip('eures', ''), false);
  b.finish();
  assert.ok(!existsSync(join(dataDir, 'provider-breaker.json')));
});

test('breaker: a candidate whose retry answers is no trip (transient burst), counts start again', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'brk-')), healthDir = mkdtempSync(join(tmpdir(), 'hlt-'));
  const b = makeBreaker({ dataDir, healthDir, log: () => {} });
  const t = { cls: 'TIMEOUT_TLS', code: 'UND_ERR_CONNECT_TIMEOUT', detail: 'x' };
  let k = null;
  for (let i = 0; i < 3; i++) k = b.record('lever', '', false, t);
  assert.equal(k, 'lever'); b.commit(k, false);
  assert.equal(b.shouldSkip('lever', ''), false);
  for (let i = 0; i < 3; i++) k = b.record('lever', '', false, t);
  assert.equal(k, 'lever'); b.commit(k, true);
  assert.equal(b.shouldSkip('lever', ''), true);
});

// ---------- per-host breaker (2026-11-25, fix/breaker-per-host) ----------
const TO = { cls: 'TIMEOUT_TLS', code: 'timeout', detail: 'Timed out after 35s' };
const dirs = () => ({ dataDir: mkdtempSync(join(tmpdir(), 'brk-')), healthDir: mkdtempSync(join(tmpdir(), 'hlt-')) });
/** one cycle: boards = [[provider, host, ok]] in order; returns the indices skipped, the result of finish() and the flag text ('' when none) */
const cycleOf = (d, boards, retryFails = true) => {
  const b = makeBreaker({ ...d, log: () => {} });
  const skipped = [];
  boards.forEach(([p, h, ok], i) => { if (b.shouldSkip(p, h)) skipped.push(i); else { const k = b.record(p, h, ok, ok ? null : TO); if (k) b.commit(k, retryFails); } });
  const fin = b.finish();
  const f = join(d.healthDir, 'CRAWL_PROVIDER_DOWN.flag');
  return { skipped, fin, flag: existsSync(f) ? readFileSync(f, 'utf8') : '' };
};
const stateOf = (d) => JSON.parse(readFileSync(join(d.dataDir, 'provider-breaker.json'), 'utf8')).providers;

test('breakerHostOf: SuccessFactors keys on the fetched host (api, slug), bare host-name slugs fill an empty host, other slugs do not', () => {
  // nine SuccessFactors boards have only a bare slug: hostOf() gives '' and the slug is the host
  assert.equal(breakerHostOf('successfactors', { slug: 'careers.nus.edu.sg' }, 'careers.nus.edu.sg'), 'careers.nus.edu.sg');
  assert.equal(breakerHostOf('successfactors', { slug: 'careers.a-star.edu.sg' }, 'careers.a-star.edu.sg'), 'careers.a-star.edu.sg');
  // the careers page is the employer's site, the fetch goes to the tenant (slug)
  assert.equal(breakerHostOf('successfactors', { careers_url: 'https://www.frequentis.com/en/careers', slug: 'jobs.frequentis.com' }, 'jobs.frequentis.com'), 'jobs.frequentis.com');
  assert.equal(breakerHostOf('successfactors', { api: 'https://tenant.example.com/x', slug: 'jobs.x.com' }, 'jobs.x.com'), 'tenant.example.com');
  // no slug on the entry: crawl.mjs passes the slug the provider detected from careers_url
  assert.equal(breakerHostOf('successfactors', { careers_url: 'https://jobs.hensoldt.net/' }, 'jobs.hensoldt.net'), 'jobs.hensoldt.net');
  assert.equal(breakerHostOf('successfactors', { careers_url: 'https://jobs.hensoldt.net/' }, undefined), 'jobs.hensoldt.net');
  // generic readers: hostOf() first, the slug only when it names a host
  assert.equal(breakerHostOf('jsonld_direct', { careers_url: 'https://www.acme.de/jobs' }, 'other.example.org'), 'www.acme.de');
  assert.equal(breakerHostOf('sitemap', {}, 'https://acme.example.org/sitemap.xml'), 'acme.example.org');
  assert.equal(breakerHostOf('jsonld_direct', {}, 'acme'), '');
  assert.equal(slugHost('acme-tenant'), ''); assert.equal(slugHost('a/b.com'), ''); assert.equal(slugHost('Jobs.AVL.com'), 'jobs.avl.com');
});

test('per-host breaker: three slow SuccessFactors boards on their own hosts do not switch off the other tenants', () => {
  const d = dirs();
  const run = [['successfactors', 'jobs.avl.com', false], ['successfactors', 'jobs.esa.int', false], ['successfactors', 'careers.vatvalve.com', false],
    ['successfactors', 'jobs.frequentis.com', true], ['successfactors', 'jobs.dlr.de', true], ['successfactors', 'careers.nus.edu.sg', true]];
  for (let c = 0; c < 3; c++) {
    const r = cycleOf(d, run);
    assert.deepEqual(r.skipped, [], `cycle ${c}`); assert.equal(r.flag, ''); assert.deepEqual(r.fin.open, []);
  }
  // the same outcomes under one key per provider (the rule before, still the rule for providers outside PER_HOST) trip it
  const d2 = dirs();
  const r = cycleOf(d2, run.map(([, h, ok]) => ['workday', h, ok]));
  assert.deepEqual(r.skipped, [3, 4, 5]); assert.match(r.flag, /workday: TIMEOUT_TLS timeout/);
});

test('per-host breaker: a shared host that is down still trips for its boards, same levels and skip lengths, then recovers', () => {
  const d = dirs();
  const H = 'jobs.shared-tenant.example', O = 'jobs.other.example';
  const down = [['successfactors', H, false], ['successfactors', H, false], ['successfactors', H, false], ['successfactors', H, true], ['successfactors', O, true]];
  // cycle 1: 3 of 3 on the shared host fail, the retry fails too: trip at level 1, the 4th board of that host is skipped, the other host not
  let r = cycleOf(d, down);
  assert.deepEqual(r.skipped, [3]);
  assert.match(r.flag, /successfactors@jobs\.shared-tenant\.example: TIMEOUT_TLS timeout, skipped until cycle 2 \(level 1/);
  assert.equal(stateOf(d)[`successfactors@${H}`].level, 1);
  // cycle 2: level 1 = 1 cycle skipped, for that host only
  r = cycleOf(d, down); assert.deepEqual(r.skipped, [0, 1, 2, 3]);
  // cycle 3: tried again, still down: level 2 = 2 cycles
  r = cycleOf(d, down); assert.deepEqual(r.skipped, [3]); assert.equal(stateOf(d)[`successfactors@${H}`].level, 2);
  r = cycleOf(d, down); assert.deepEqual(r.skipped, [0, 1, 2, 3]);
  r = cycleOf(d, down); assert.deepEqual(r.skipped, [0, 1, 2, 3]);
  // cycle 6: still down: level 3 = 4 cycles
  r = cycleOf(d, down); assert.deepEqual(r.skipped, [3]); assert.equal(stateOf(d)[`successfactors@${H}`].level, 3);
  for (let c = 0; c < 4; c++) { r = cycleOf(d, down); assert.deepEqual(r.skipped, [0, 1, 2, 3]); }
  // cycle 11: still down: level 4 = 8 cycles, and it stays at 8
  r = cycleOf(d, down); assert.deepEqual(r.skipped, [3]); assert.equal(stateOf(d)[`successfactors@${H}`].level, 4);
  for (let c = 0; c < 8; c++) { r = cycleOf(d, down); assert.deepEqual(r.skipped, [0, 1, 2, 3]); }
  r = cycleOf(d, down); assert.deepEqual(r.skipped, [3]); assert.equal(stateOf(d)[`successfactors@${H}`].level, 4);
  for (let c = 0; c < 8; c++) cycleOf(d, down);
  // recovery: the host answers again: the breaker closes and the flag goes
  const up = down.map(([p, h]) => [p, h, true]);
  r = cycleOf(d, up); assert.deepEqual(r.skipped, []); assert.equal(r.flag, ''); assert.deepEqual(stateOf(d), {});
});

test('per-host breaker: a retry that answers is no trip; keys per provider and per host', () => {
  const d = dirs();
  const H = 'jobs.shared-tenant.example';
  const r = cycleOf(d, [['successfactors', H, false], ['successfactors', H, false], ['successfactors', H, false], ['successfactors', H, true]], false);
  assert.deepEqual(r.skipped, []); assert.deepEqual(stateOf(d), {});
  const b = makeBreaker({ ...dirs(), log: () => {} });
  assert.equal(b.keyOf('jsonld_direct', 'www.acme.de'), 'jsonld_direct@www.acme.de');
  assert.equal(b.keyOf('successfactors', 'jobs.avl.com'), 'successfactors@jobs.avl.com');
  assert.equal(b.keyOf('successfactors', ''), 'successfactors@?');
  assert.equal(b.keyOf('reachmee', 'web103.reachmee.com'), 'reachmee');
  assert.equal(b.keyOf('workday', 'acme.wd3.myworkdayjobs.com'), 'workday');
});

test('per-host breaker: a provider-wide successfactors key left open from before is dropped, not kept in the flag', () => {
  const d = dirs();
  // state as the old rule left it: SuccessFactors open until cycle 12 at level 2, reachmee open until cycle 11
  writeFileSync(join(d.dataDir, 'provider-breaker.json'), JSON.stringify({ cycle: 10, providers: {
    successfactors: { level: 2, cls: 'TIMEOUT_TLS', tripped_cycle: 10, open_until: 12, code: 'timeout', host: 'jobs.avl.com' },
    reachmee: { level: 1, cls: 'TIMEOUT_TLS', tripped_cycle: 10, open_until: 11, code: 'timeout', host: 'web103.reachmee.com' } } }));
  const r = cycleOf(d, [['successfactors', 'jobs.avl.com', true], ['successfactors', 'jobs.dlr.de', true], ['reachmee', 'web103.reachmee.com', true]]);
  assert.deepEqual(r.skipped, [2]);
  const st = stateOf(d);
  assert.equal(st.successfactors, undefined); assert.equal(st.reachmee.level, 1);
  assert.match(r.flag, /^\S+ crawl provider down \(circuit breaker\) reachmee: /); assert.doesNotMatch(r.flag, /successfactors/);
});

test('livenessGuard: holds under half of more than 5 open roles twice, closes on the third, resets on a good fetch, honours emptyOk', () => {
  const st = {};
  assert.equal(livenessGuard(st, 'b', 40, 38).hold, false);            // normal churn
  assert.equal(livenessGuard(st, 'b', 5, 0).hold, false);              // not more than 5 open roles
  assert.deepEqual(livenessGuard(st, 'b', 40, 0), { hold: true, n: 1, confirmed: false });
  assert.deepEqual(livenessGuard(st, 'b', 40, 10), { hold: true, n: 2, confirmed: false });
  assert.equal(livenessGuard(st, 'b', 40, 39).hold, false); assert.deepEqual(st, {});   // recovered: the count starts again
  livenessGuard(st, 'b', 40, 0); livenessGuard(st, 'b', 40, 0);
  assert.deepEqual(livenessGuard(st, 'b', 40, 0), { hold: false, n: 3, confirmed: true });
  assert.equal(livenessGuard({}, 'c', 40, 0, { emptyOk: true }).hold, false);
});
