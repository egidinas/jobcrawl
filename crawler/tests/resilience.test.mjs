// node --test jobcrawl/crawler/tests/resilience.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyError, makeBreaker, livenessGuard, breakerHostOf, slugHost, PLATFORM_MIN_HOSTS } from '../resilience.mjs';

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

// ---------- platform key beside the per-host keys (2026-11-25, REVIEWB condition) ----------
const sfHosts = (n, ok = false, from = 0) => Array.from({ length: n }, (_, i) => ['successfactors', `jobs.t${from + i}.example`, ok]);
const logOf = (d, boards, retryFails = true) => {
  const lines = [];
  const b = makeBreaker({ ...d, log: (s) => lines.push(s) });
  const skipped = [];
  boards.forEach(([p, h, ok], i) => { if (b.shouldSkip(p, h)) skipped.push(i); else { const k = b.record(p, h, ok, ok ? null : TO); if (k) b.commit(k, retryFails); } });
  b.finish();
  const f = join(d.healthDir, 'CRAWL_PROVIDER_DOWN.flag');
  return { skipped, lines, flag: existsSync(f) ? readFileSync(f, 'utf8') : '' };
};

test('platform key: 6 distinct SuccessFactors hosts fail before any answers: trip, the rest skipped, same flag and log line as before', () => {
  const d = dirs();
  const run = [...sfHosts(6), ...sfHosts(3, true, 10), ['reachmee', 'web103.reachmee.com', true]];
  const r = logOf(d, run);
  assert.equal(PLATFORM_MIN_HOSTS, 6);
  assert.deepEqual(r.skipped, [6, 7, 8], 'the SuccessFactors boards after the trip are skipped, other providers are not');
  assert.ok(r.lines.includes('[breaker] successfactors: 6 of 6 boards failed with TIMEOUT_TLS timeout, the retry failed too; the rest are skipped for 1 cycle(s) (level 1)'), r.lines.join('\n'));
  assert.match(r.flag, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z crawl provider down \(circuit breaker\) successfactors: TIMEOUT_TLS timeout, skipped until cycle 2 \(level 1; Timed out after 35s\)\n$/);
  const st = stateOf(d).successfactors;
  assert.deepEqual([st.level, st.cls, st.code, st.tripped_cycle, st.open_until], [1, 'TIMEOUT_TLS', 'timeout', 1, 2]);
  // next cycle: every SuccessFactors board skipped (level 1 = 1 cycle), whatever its host
  const r2 = logOf(d, [...sfHosts(2, true, 20), ['reachmee', 'web103.reachmee.com', true]]);
  assert.deepEqual(r2.skipped, [0, 1]);
});

test('platform key: scattered failures do not trip it', () => {
  // 5 hosts fail, the rest answer
  let r = logOf(dirs(), [...sfHosts(5), ...sfHosts(10, true, 10)]); assert.deepEqual(r.skipped, []); assert.equal(r.flag, '');
  // one board answered first: 8 hosts failing after it are not a platform outage (each host on its own)
  r = logOf(dirs(), [...sfHosts(1, true, 50), ...sfHosts(8)]); assert.deepEqual(r.skipped, []); assert.equal(r.flag, '');
  // 5 hosts fail with different classes
  const d = dirs(), b = makeBreaker({ ...d, log: () => {} });
  ['HTTP_5XX', 'MOVED', 'DNS', 'WAF', 'PARSE'].forEach((cls, i) => assert.equal(b.record('successfactors', `jobs.m${i}.example`, false, { cls }), null));
  assert.equal(b.shouldSkip('successfactors', 'jobs.other.example'), false);
  // five failures of ONE host are that host's breaker, not the platform's
  const r5 = logOf(dirs(), [...Array(5).fill(['successfactors', 'jobs.one.example', false]), ['successfactors', 'jobs.two.example', true]]);
  assert.deepEqual(r5.skipped, [3, 4]); assert.match(r5.flag, /successfactors@jobs\.one\.example: /); assert.doesNotMatch(r5.flag, /successfactors: /);
  // the retry answers: no trip, and the count of failing hosts starts again
  const d6 = dirs(), r6 = logOf(d6, [...sfHosts(6), ...sfHosts(5, false, 10)], false);
  assert.deepEqual(r6.skipped, []); assert.ok(r6.lines.some((l) => /^\[breaker\] successfactors: 6 of 6 boards failed with TIMEOUT_TLS, but the retry answered: no trip/.test(l)));
});

test('platform key: recovers like the provider breaker (level 1, still down: level 2 = 2 cycles, then a clean cycle closes it)', () => {
  const d = dirs();
  const down = [...sfHosts(7)];
  let r = logOf(d, down); assert.deepEqual(r.skipped, [6]);
  r = logOf(d, down); assert.deepEqual(r.skipped, [0, 1, 2, 3, 4, 5, 6]);
  r = logOf(d, down); assert.deepEqual(r.skipped, [6]); assert.equal(stateOf(d).successfactors.level, 2);
  r = logOf(d, down); assert.deepEqual(r.skipped, [0, 1, 2, 3, 4, 5, 6]);
  r = logOf(d, down); assert.deepEqual(r.skipped, [0, 1, 2, 3, 4, 5, 6]);
  const up = sfHosts(6, true);
  r = logOf(d, up); assert.deepEqual(r.skipped, []); assert.equal(r.flag, ''); assert.deepEqual(stateOf(d), {});
  assert.ok(r.lines.includes('[breaker] successfactors: recovered (6 of 6 boards ok), breaker closed'));
});

test('platform key: the state file of the code before per-host keys is read as it is (an open "successfactors" key keeps skipping)', () => {
  const d = dirs();
  // state as the old rule left it: SuccessFactors open until cycle 12 at level 2, reachmee open until cycle 11
  writeFileSync(join(d.dataDir, 'provider-breaker.json'), JSON.stringify({ cycle: 10, providers: {
    successfactors: { level: 2, cls: 'TIMEOUT_TLS', tripped_cycle: 10, open_until: 12, code: 'timeout', host: 'jobs.avl.com' },
    reachmee: { level: 1, cls: 'TIMEOUT_TLS', tripped_cycle: 10, open_until: 11, code: 'timeout', host: 'web103.reachmee.com' } } }));
  let r = logOf(d, [['successfactors', 'jobs.avl.com', true], ['successfactors', 'careers.nus.edu.sg', true], ['reachmee', 'web103.reachmee.com', true]]);
  assert.deepEqual(r.skipped, [0, 1, 2]);
  assert.match(r.flag, /successfactors: TIMEOUT_TLS timeout, skipped until cycle 12 \(level 2/);
  r = logOf(d, [['successfactors', 'jobs.avl.com', true], ['reachmee', 'web103.reachmee.com', true]]);
  assert.deepEqual(r.skipped, [0]);
  // cycle 13: tried again, clean: closed, the same as the old code would
  r = logOf(d, [['successfactors', 'jobs.avl.com', true], ['successfactors', 'careers.nus.edu.sg', true]]);
  assert.deepEqual(r.skipped, []); assert.deepEqual(stateOf(d), {}); assert.equal(r.flag, '');
  // what the new code writes keeps the old entry shape for every key (old code reads level, open_until, cls, code, example)
  const d2 = dirs(); logOf(d2, sfHosts(6));
  for (const [k, s] of Object.entries(stateOf(d2))) for (const f of ['level', 'cls', 'tripped_cycle', 'open_until', 'tripped_at', 'example', 'code', 'host']) assert.ok(f in s, `${k} ${f}`);
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
