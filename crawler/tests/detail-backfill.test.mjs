// Detail backfill: the work list (which rows, in which order), the per-host scheduler, and the command line (dry run, raw capture required).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planBackfill, runQueue, nextRetry, lockIsActive, LIST_HAS_DESCRIPTION, jdAfterFetch } from '../detail-backfill.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const row = (url, company, status, first_seen = '2026-10-20') => [url, { url, company, title: 't', location: 'x', first_seen, last_seen: first_seen, status, posted: '' }];

test('planBackfill: skips vendors whose list carries descriptions, done and waiting URLs, no-scrape hosts; orders by need', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const history = new Map([
    row('https://a.wd5.myworkdayjobs.com/A/job/x/open-no-text', 'Acme', 'open'),
    row('https://a.wd5.myworkdayjobs.com/A/job/x/open-clipped', 'Acme', 'open'),
    row('https://a.wd5.myworkdayjobs.com/A/job/x/open-complete', 'Acme', 'open'),
    row('https://a.wd5.myworkdayjobs.com/A/job/x/extra-new', 'Acme', 'extra', '2026-10-30'),
    row('https://a.wd5.myworkdayjobs.com/A/job/x/extra-old', 'Acme', 'extra', '2026-10-21'),
    row('https://a.wd5.myworkdayjobs.com/A/job/x/extra-done', 'Acme', 'extra'),
    row('https://a.wd5.myworkdayjobs.com/A/job/x/extra-waiting', 'Acme', 'extra'),
    row('https://a.wd5.myworkdayjobs.com/A/job/x/gone', 'Acme', 'gone'),
    row('https://boards.greenhouse.io/g/jobs/1', 'Gee', 'extra'),
    row('https://www.linkedin.com/jobs/view/1', 'Acme', 'extra'),
    row('https://unknown.example/j/1', 'Nobody', 'extra'),
  ]);
  const boards = new Map([['Acme', { provider: 'workday', slug: 'a|wd5|A' }], ['Gee', { provider: 'greenhouse', slug: 'g' }]]);
  const state = { 'https://a.wd5.myworkdayjobs.com/A/job/x/extra-done': { ok: true }, 'https://a.wd5.myworkdayjobs.com/A/job/x/extra-waiting': { ok: false, next: now + 1 } };
  const len = { 'open-no-text': -1, 'open-clipped': 9000, 'open-complete': 4000 };
  const plan = planBackfill({ history, boards, state, now, jdInfo: (u) => len[u.split('/').pop()] ?? -1 });
  assert.deepEqual(plan.queue.map((q) => q.row.url.split('/').pop()), ['open-no-text', 'extra-new', 'extra-old', 'open-clipped', 'open-complete']);
  assert.deepEqual(plan.skipped, { status: 1, 'no-board': 1, 'list-carries-description': 1, 'no-scrape': 1, done: 1, waiting: 1 });
  assert.deepEqual(plan.byVendor, { workday: 5 });
  assert.ok(LIST_HAS_DESCRIPTION.has('greenhouse') && !LIST_HAS_DESCRIPTION.has('workday'));
  // --vendors names the vendors explicitly, even one whose list carries descriptions
  assert.equal(planBackfill({ history, boards, state, now, vendors: ['greenhouse'] }).queue.length, 1);
});

test('planBackfill: an open role fetched before texts were kept is fetched once more while its saved text is thin; --retry-failed lifts the wait', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const u = (n) => `https://a.wd5.myworkdayjobs.com/A/job/x/${n}`;
  const history = new Map([row(u('thin-unkept'), 'Acme', 'open'), row(u('thin-kept'), 'Acme', 'open'), row(u('thin-written'), 'Acme', 'open'),
    row(u('full-unkept'), 'Acme', 'open'), row(u('extra-done'), 'Acme', 'extra'), row(u('open-waiting'), 'Acme', 'open')]);
  const boards = new Map([['Acme', { provider: 'workday', slug: 'a|wd5|A' }]]);
  const state = { [u('thin-unkept')]: { ok: true, len: 4600 }, [u('thin-kept')]: { ok: true, len: 4600, jd: 'kept' }, [u('thin-written')]: { ok: true, len: 4600, jd: 'written' },
    [u('full-unkept')]: { ok: true, len: 4600 }, [u('extra-done')]: { ok: true, len: 4600 }, [u('open-waiting')]: { ok: false, tries: 2, next: now + 5 * 864e5 } };
  const len = { 'thin-unkept': 420, 'thin-kept': 420, 'thin-written': 420, 'full-unkept': 4000, 'open-waiting': -1 };
  const jdInfo = (url) => len[url.split('/').pop()] ?? -1;
  const plan = planBackfill({ history, boards, state, now, jdInfo });
  assert.deepEqual(plan.queue.map((q) => q.row.url.split('/').pop()), ['thin-unkept'], 'only the open role whose fetched text was thrown away');
  assert.equal(plan.queue[0].priority, 0);
  assert.equal(plan.skipped.done, 4);
  assert.equal(plan.skipped.waiting, 1);
  const again = planBackfill({ history, boards, state, now, jdInfo, retryFailed: true });
  assert.deepEqual(again.queue.map((q) => q.row.url.split('/').pop()).sort(), ['open-waiting', 'thin-unkept']);
  assert.equal(again.skipped.waiting, 0);
});

test('jdAfterFetch: a missing description is written, a thin one replaced with its header kept, a normal one left alone; contacts stay out', () => {
  const r = { url: 'https://acme.example/jobs/1', company: 'Acme GmbH', title: 'Systems Engineer (m/f/d)', location: 'Bremen', first_seen: '2026-11-02', posted: '2026-10-30T09:00:00Z' };
  const role = 'You design, integrate and verify the payload data handling chain of a small satellite platform. '.repeat(6).trim();   // 580 characters
  // no file yet: the saveJd layout
  const fresh = jdAfterFetch(null, r, role);
  assert.equal(fresh, `# Systems Engineer (m/f/d)\n\n- Company: Acme GmbH\n- Location: Bremen\n- URL: https://acme.example/jobs/1\n- First seen: 2026-11-02\n- Posted: 2026-10-30\n\n${role}\n`);
  // too short to be a description: nothing is written
  assert.equal(jdAfterFetch(null, r, 'See the attached PDF.'), null);
  // a thin saved text is replaced, the header (with lines this module does not write) stays
  const thin = '# Systems Engineer (m/f/d)\n\n- Company: Acme GmbH\n- Location: Bremen\n- URL: https://acme.example/jobs/1\n- First seen: 2026-11-02\n- Department: Avionics\n\nShort teaser of the role.\n';
  const next = jdAfterFetch(thin, r, role);
  assert.ok(next.startsWith('# Systems Engineer (m/f/d)\n\n- Company: Acme GmbH\n'));
  assert.match(next, /- Department: Avionics\n\nYou design, integrate/);
  assert.ok(next.endsWith('platform.\n') && !next.includes('Short teaser'));
  // not clearly longer than what is saved: left alone
  assert.equal(jdAfterFetch(thin.replace('Short teaser of the role.', role.slice(0, 450)), r, role), null);
  // a description of normal length is never replaced, however long the fetched page text is
  const normal = thin.replace('Short teaser of the role.', role + ' ' + role + ' ' + role);
  assert.equal(jdAfterFetch(normal, r, (role + ' ').repeat(12)), null);
  // the contact section of a detail document and a single "Contact:" line never reach the file (invented contact data)
  const withContacts = `${role}\nContact: Erika Beispiel, erika.beispiel@example.org, +49 421 000000\n\nApplication and contact\nApply by e-mail.\nContact: Max Muster, max.muster@example.org`;
  const kept = jdAfterFetch(null, r, withContacts);
  assert.ok(kept.includes('payload data handling'));
  assert.ok(!/Contact:|Application and contact|example\.org|Beispiel|Muster/.test(kept));
  // a long text keeps its beginning and its end (the crawl's clip)
  const long = jdAfterFetch(null, r, 'A'.repeat(6000) + 'B'.repeat(6000));
  assert.ok(long.includes('\n[...]\n') && long.trimEnd().endsWith('B') && long.length < 9300);
});

test('runQueue: budget, one request at a time per host with the delay, hosts in parallel, failures reported not thrown', async () => {
  const queue = [];
  for (const [host, n] of [['h1', 4], ['h2', 2], ['h3', 1]]) for (let i = 0; i < n; i++) queue.push({ host, row: { url: `https://${host}/${i}` } });
  const seen = [];
  const t0 = Date.now();
  const done = [];
  const items = await runQueue(queue, async (it) => {
    seen.push([it.host, Date.now() - t0]);
    if (it.row.url.endsWith('/1')) throw new Error('boom');
    return { ok: true, len: 500 };
  }, { budget: 6, hostDelay: 40, concurrency: 2, onDone: (it, res) => done.push(res.ok) });
  assert.equal(items.length, 6, 'budget');
  assert.equal(done.length, 6);
  assert.equal(done.filter((x) => !x).length, 2, 'the two /1 items failed and were reported');
  const h1 = seen.filter(([h]) => h === 'h1').map(([, t]) => t);
  for (let i = 1; i < h1.length; i++) assert.ok(h1[i] - h1[i - 1] >= 35, `host delay kept between requests to the same host (${h1})`);
  assert.ok(seen.some(([h, t]) => h === 'h2' && t < 35), 'a second host started while the first was waiting');
});

test('nextRetry backs off 1, 7, 30 then 90 days', () => {
  const now = 0;
  assert.deepEqual([1, 2, 3, 4, 9].map((t) => nextRetry(t, now) / 864e5), [1, 7, 30, 90, 90]);
});

test('lockIsActive: alive and fresh holds; 13 h old, dead pid or unparseable content is stale', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const lock = (ageH) => JSON.stringify({ pid: 4242, started: new Date(now - ageH * 3600e3).toISOString() });
  assert.equal(lockIsActive(lock(1), now, () => true), true, 'alive + fresh');
  assert.equal(lockIsActive(lock(13), now, () => true), false, 'alive + 13 h old');
  assert.equal(lockIsActive(lock(1), now, () => false), false, 'dead pid');
  assert.equal(lockIsActive('{not json', now, () => true), false, 'unparseable');
  assert.equal(lockIsActive('{}', now, () => true), false, 'no pid');
});

test('command line: refuses without JOBCRAWL_RAW_DIR; a dry run plans against a real profile and history; one instance per data dir', () => {
  const d = mkdtempSync(join(tmpdir(), 'jobcrawl-backfill-'));
  try {
    const prof = join(d, 'profile'), data = join(d, 'data');
    mkdirSync(prof); mkdirSync(data);
    writeFileSync(join(prof, 'profile.json'), JSON.stringify({ crawl: { companies_file: 'companies.json' } }));
    writeFileSync(join(prof, 'companies.json'), JSON.stringify({ tracked_companies: [
      { name: 'Acme', provider: 'workday', careers_url: 'https://acme.wd5.myworkdayjobs.com/Careers' },
      { name: 'Gee', provider: 'greenhouse', careers_url: 'https://boards.greenhouse.io/gee' }] }));
    writeFileSync(join(data, 'scan-history.tsv'), ['url\tcompany\ttitle\tlocation\tfirst_seen\tlast_seen\tstatus\tposted',
      'https://acme.wd5.myworkdayjobs.com/Careers/job/Berlin/Engineer_R1\tAcme\tEngineer\tBerlin\t2026-10-20\t2026-11-01\textra\t',
      'https://acme.wd5.myworkdayjobs.com/Careers/job/Berlin/Welder_R2\tAcme\tWelder\tBerlin\t2026-10-20\t2026-11-01\topen\t',
      'https://boards.greenhouse.io/gee/jobs/5\tGee\tX\tY\t2026-10-20\t2026-11-01\textra\t', ''].join('\n'));
    const script = resolve(HERE, '..', 'detail-backfill.mjs');
    const env = { ...process.env };
    delete env.JOBCRAWL_RAW_DIR;
    const r1 = spawnSync(process.execPath, [script, '--profile', prof, '--data', data, '--dry-run'], { encoding: 'utf8', env });
    assert.equal(r1.status, 2, r1.stderr);
    assert.match(r1.stderr, /JOBCRAWL_RAW_DIR/);
    const r2 = spawnSync(process.execPath, [script, '--profile', prof, '--data', data, '--dry-run'], { encoding: 'utf8', env: { ...env, JOBCRAWL_RAW_DIR: join(d, 'raw') } });
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /candidates 2 \(open without text 1, extra\/filtered 1/);
    assert.match(r2.stdout, /"list-carries-description":1/);
    assert.match(r2.stdout, /by vendor: workday 2/);
    assert.match(r2.stdout, /result: dry run/);
    const lockFile = join(data, 'detail-backfill.lock');
    assert.ok(!existsSync(lockFile), 'the lock is removed when the run ends');
    // a live lock (this test process's pid, fresh) makes the run skip
    const rawEnv = { ...env, JOBCRAWL_RAW_DIR: join(d, 'raw') };
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    const r3 = spawnSync(process.execPath, [script, '--profile', prof, '--data', data, '--dry-run'], { encoding: 'utf8', env: rawEnv });
    assert.equal(r3.status, 0, r3.stderr);
    assert.match(r3.stdout, new RegExp(`another run is active \\(pid ${process.pid} since `));
    assert.doesNotMatch(r3.stdout, /result: dry run/);
    assert.deepEqual(JSON.parse(readFileSync(lockFile, 'utf8')).pid, process.pid, 'the active lock is left in place');
    // a stale lock (dead pid) is taken over and the normal plan runs
    writeFileSync(lockFile, JSON.stringify({ pid: 999999, started: new Date().toISOString() }));
    const r4 = spawnSync(process.execPath, [script, '--profile', prof, '--data', data, '--dry-run'], { encoding: 'utf8', env: rawEnv });
    assert.equal(r4.status, 0, r4.stderr);
    assert.match(r4.stdout, /taking over a stale lock/);
    assert.match(r4.stdout, /candidates 2 \(open without text 1, extra\/filtered 1/);
    assert.match(r4.stdout, /result: dry run/);
    assert.ok(!existsSync(lockFile), 'the taken-over lock is removed at the end');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
