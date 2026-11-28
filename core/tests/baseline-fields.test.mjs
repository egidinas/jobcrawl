// Reproductions of the first armed shadow cycle on the NUC (2026-11-28 00:11, greenhouse family): 2,432 'changed' and 64 'departed'
// right after the baseline import. Causes: (1) the import kept untrimmed legacy fields and no description hash, and the legacy history
// keeps the fields of the FIRST sighting, so the first live read "changed" them; (2) the import made every non-gone row open, including
// filtered/extra rows the board had stopped listing long ago, and the first-miss rule then departed them, which the legacy crawl never
// does for such rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRun, normaliseItem } from '../delta/board-delta.mjs';
import { baselineState, importBaseline } from '../route/baseline.mjs';
import { runShadow } from '../route/shadow-hook.mjs';
import { openBoard, readEvents } from '../state/board-store.mjs';
import { postingId } from '../id.mjs';
import { compareBoard } from '../route/parity.mjs';

const U = (n) => `https://job-boards.greenhouse.io/acme/jobs/${n}`;
const row = (n, o = {}) => ({ url: U(n), company: 'Acme', title: `Engineer ${n}`, location: 'Munich', first_seen: '2026-11-01', last_seen: '2026-11-27', status: 'open', posted: '2026-10-30', ...o });
const live = (n, o = {}) => ({ url: U(n), title: `Engineer ${n}`, location: 'Munich', postedAt: '2026-10-30T10:00:00Z', description: `<p>Job ${n}</p>`, ...o });
const NOW = new Date('2026-11-28T00:11:00Z');

test('baseline and live read share one normaliser (trim, date part)', () => {
  const s = baselineState('Acme', [row(1, { title: ' Engineer 1', location: 'Munich ' })]);
  const p = s.postings[postingId(U(1))];
  assert.deepEqual({ title: p.title, location: p.location, posted: p.posted }, { title: 'Engineer 1', location: 'Munich', posted: '2026-10-30' });
  assert.deepEqual({ title: normaliseItem(live(1)).title, posted: normaliseItem(live(1)).posted }, { title: 'Engineer 1', posted: '2026-10-30' });
});

test('first live sighting of baseline postings refreshes silently: no changed burst (whitespace, first-sighting titles, unknown hash)', () => {
  const s = baselineState('Acme', [row(1, { title: ' Engineer 1' }), row(2, { title: 'Old title kept by the legacy history', location: 'Germany' }), row(3)]);
  const r = applyRun(s, { ok: true, items: [live(1), live(2, { title: 'Head of Flight Test', location: 'Munich, Bavaria, Germany' }), live(3)] }, { board: 'Acme', now: NOW });
  assert.deepEqual(r.events.map((e) => e.op), ['board-ok']);
  assert.equal(r.events[0].refreshed, 3);
  const p2 = r.state.postings[postingId(U(2))];
  assert.equal(p2.title, 'Head of Flight Test', 'the record now holds the live fields');
  assert.ok(p2.dh, 'description hash filled in');
  // and from now on a real change is a change
  const r2 = applyRun(r.state, { ok: true, items: [live(1), live(2, { title: 'Head of Flight Test (All Genders)', location: 'Munich, Bavaria, Germany' }), live(3)] }, { board: 'Acme', now: new Date('2026-11-28T01:00:00Z') });
  assert.deepEqual(r2.events.filter((e) => e.op === 'changed').map((e) => e.fields), [['title']]);
});

test('a description hash that was unknown is never a change', () => {
  let r = applyRun(null, { ok: true, items: [{ url: U(1), title: 'A' }] }, { board: 'Acme', now: NOW });
  r = applyRun(r.state, { ok: true, items: [{ url: U(1), title: 'A', description: 'now with text' }] }, { board: 'Acme', now: NOW });
  assert.deepEqual(r.events.map((e) => e.op), ['board-ok']);
});

test('baseline: rows older than the board\'s last read day are departed, not open; they are not departed again, and come back as reappeared', () => {
  const rows = [row(1), row(2, { status: 'filtered', last_seen: '2026-10-19' }), row(3, { status: 'extra', last_seen: '2026-11-24' })];
  const s = baselineState('Acme', rows);
  assert.deepEqual(Object.values(s.postings).map((p) => p.status).sort(), ['departed', 'departed', 'open']);
  assert.equal(s.baseline.last_day, '2026-11-27');
  let r = applyRun(s, { ok: true, items: [live(1)] }, { board: 'Acme', now: NOW });
  assert.deepEqual(r.events.map((e) => e.op), ['board-ok'], 'no departure burst');
  r = applyRun(r.state, { ok: true, items: [live(1), live(2)] }, { board: 'Acme', now: new Date('2026-11-28T01:00:00Z') });
  assert.deepEqual(r.events.map((e) => e.op), ['reappeared', 'board-ok']);
});

test('legacy departure rule: open rows on the first complete miss, extra/dup after the 3-day sweep, filtered never by a miss', () => {
  const status = { [U(1)]: 'gone', [U(2)]: 'extra', [U(3)]: 'filtered', [U(4)]: 'open' };
  const rules = { mode: 'legacy', statusOf: (u) => status[u], sweepDays: 3 };
  let r = applyRun(null, { ok: true, items: [live(1), live(2), live(3), live(4), live(5)] }, { board: 'Acme', now: NOW, rules });
  r = applyRun(r.state, { ok: true, items: [live(5)] }, { board: 'Acme', now: new Date('2026-11-28T02:00:00Z'), rules, guard: { minOpen: 99, keepRatio: 0, confirm: 1 } });
  const dep = r.events.filter((e) => e.op === 'departed').map((e) => e.id).sort();
  assert.deepEqual(dep, [postingId(U(1)), postingId(U(4))].sort(), 'legacy-closed and open rows go; extra and filtered stay');
  r = applyRun(r.state, { ok: true, items: [live(5)] }, { board: 'Acme', now: new Date('2026-12-01T03:00:00Z'), rules, guard: { minOpen: 99, keepRatio: 0, confirm: 1 } });
  assert.deepEqual(r.events.filter((e) => e.op === 'departed').map((e) => e.id), [postingId(U(2))], 'extra goes in the sweep; filtered never');
});

test('shadow hook uses the crawl history for the legacy rule; import + first cycle give no changed/departed burst', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcx-bf-')), store = mkdtempSync(join(tmpdir(), 'jcx-bf-store-'));
  const hist = join(dir, 'scan-history.tsv');
  const rows = [row(1, { title: ' Engineer 1' }), row(2, { status: 'extra' }), row(3, { status: 'filtered', last_seen: '2026-10-19' })];
  writeFileSync(hist, 'url\tcompany\ttitle\tlocation\tfirst_seen\tlast_seen\tstatus\tposted\n' + rows.map((r) => [r.url, r.company, r.title, r.location, r.first_seen, r.last_seen, r.status, r.posted].join('\t')).join('\n') + '\n');
  await importBaseline({ historyFile: hist, root: store, boards: ['Acme'] });
  const rf = join(dir, 'routing.json');
  writeFileSync(rf, JSON.stringify({ schema: 'routing/v1', providers: { greenhouse: 'shadow' } }));
  const history = new Map(rows.map((r) => [r.url, { url: r.url, company: r.company, status: r.status }]));   // the crawl's row shape
  const s = await runShadow({ dataDir: dir, companies: [{ name: 'Acme', provider: 'greenhouse' }], results: [{ r: { provider: 'greenhouse' }, jobs: [live(1)] }],
    history, env: { JOBCRAWL_SHADOW: '1', JOBCRAWL_ROUTING: rf, JOBCRAWL_SHADOW_DATA: store }, log: () => {} });
  assert.equal(s.shadowed, 1);
  assert.deepEqual(s.ops, { 'board-ok': 1 }, 'no changed, no departed: job 2 is an extra row (sweep), job 3 was already departed');
  assert.equal(openBoard(store, 'Acme').postings[postingId(U(2))].status, 'open');
});

test('parity counts as listed only the rows of the last read day of the board (stale filtered rows are not a mismatch)', () => {
  const legacy = [row(1), row(3, { status: 'filtered', last_seen: '2026-10-19' })];
  const r = applyRun(null, { ok: true, items: [live(1)] }, { board: 'Acme', now: NOW });
  const c = compareBoard(legacy, Object.entries(r.state.postings).filter(([, p]) => p.status === 'open').map(([id, p]) => ({ id, ...p })));
  assert.equal(c.verdict, 'pass');
});
