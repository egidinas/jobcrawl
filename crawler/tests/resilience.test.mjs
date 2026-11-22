// node --test jobcrawl/crawler/tests/resilience.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyError, makeBreaker, livenessGuard } from '../resilience.mjs';

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
