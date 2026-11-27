// Per-board state and deltas: grace rule, idempotent replay, failed reads, guard, schema conformance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRun, isComplete, LEGACY_RULES, SWEEP_RULES, openPostings } from '../delta/board-delta.mjs';
import { commitRun, lease, openBoard, readEvents, snapshot, boardKey } from '../state/board-store.mjs';
import { postingId, normaliseUrl } from '../id.mjs';
import { deltaMatchesDiff, compareBoard } from '../route/parity.mjs';
import { validate } from '../schema/validate.mjs';

const H = 3600e3;
const at = (h) => new Date(Date.UTC(2026, 10, 1) + h * H);
const job = (n, extra = {}) => ({ url: `https://jobs.example.com/p/${n}`, title: `Engineer ${n}`, location: 'Munich', ...extra });
const ok = (items, extra = {}) => ({ ok: true, items, ...extra });
const B = 'Example GmbH';

test('ids are stable across tracking parameters, fragments and www', () => {
  assert.equal(postingId('https://www.Jobs.example.com/p/1/?utm_source=x#top'), postingId('https://jobs.example.com/p/1'));
  assert.notEqual(postingId('https://jobs.example.com/p/1'), postingId('https://jobs.example.com/p/2'));
  assert.match(postingId('https://jobs.example.com/p/1'), /^jc1_[a-z2-7]{32}$/);
  assert.equal(normaliseUrl('https://x.de/a/?b=2&a=1&utm_medium=m'), 'x.de/a?a=1&b=2');
});

test('first read adds every posting; an unchanged read only says board-ok', () => {
  let { state, events } = applyRun(null, ok([job(1), job(2)]), { board: B, now: at(0) });
  assert.deepEqual(events.map((e) => e.op), ['added', 'added', 'board-ok']);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  ({ state, events } = applyRun(state, ok([job(1), job(2)]), { board: B, now: at(1) }));
  assert.deepEqual(events.map((e) => e.op), ['board-ok']);
  assert.equal(events[0].seq, 4);
});

test('a changed title is a changed event naming the field', () => {
  let { state } = applyRun(null, ok([job(1)]), { board: B, now: at(0) });
  const { events } = applyRun(state, ok([job(1, { title: 'Senior Engineer 1' })]), { board: B, now: at(1) });
  assert.equal(events[0].op, 'changed');
  assert.deepEqual(events[0].fields, ['title']);
});

test('departure needs k complete misses AND the floor; failed and partial reads never count', () => {
  let { state } = applyRun(null, ok([job(1), job(2)]), { board: B, now: at(0) });
  const rules = { mode: 'misses', k: 3, floorH: 24 };
  let r = applyRun(state, { ok: false, error: { cls: 'TIMEOUT_TLS' } }, { board: B, now: at(1), rules });
  assert.deepEqual(r.events.map((e) => e.op), ['board-failed']);
  r = applyRun(r.state, ok([job(1)], { complete: false }), { board: B, now: at(2), rules });
  assert.equal(r.state.postings[postingId(job(2).url)].misses, 0, 'a partial read counts no miss');
  for (const h of [3, 4]) r = applyRun(r.state, ok([job(1)]), { board: B, now: at(h), rules });
  assert.equal(r.state.postings[postingId(job(2).url)].misses, 2);
  r = applyRun(r.state, ok([job(1)]), { board: B, now: at(5), rules });
  assert.ok(!r.events.some((e) => e.op === 'departed'), '3 misses but only 5 h since last seen: the floor holds it');
  r = applyRun(r.state, ok([job(1)]), { board: B, now: at(25), rules });
  assert.deepEqual(r.events.filter((e) => e.op === 'departed').map((e) => e.id), [postingId(job(2).url)]);
  r = applyRun(r.state, ok([job(1), job(2)]), { board: B, now: at(26), rules });
  assert.equal(r.events[0].op, 'reappeared');
});

test('an empty answer without emptyOk is not complete; with emptyOk it is', () => {
  assert.equal(isComplete({ ok: true, items: [] }), false);
  assert.equal(isComplete({ ok: true, items: [], emptyOk: true }), true);
  assert.equal(isComplete({ ok: true, items: new Array(500).fill(job(1)) }), false, 'a capped count is never complete');
  assert.equal(isComplete({ ok: true, items: [job(1), job(2)] }, 2), false, 'max_jobs reached is never complete');
});

test('the legacy rule closes on the first complete miss; the age (sweep) rule after 3 days unseen', () => {
  let r = applyRun(null, ok([job(1), job(2)]), { board: B, now: at(0), rules: LEGACY_RULES });
  r = applyRun(r.state, { ok: false, error: { cls: 'DNS' } }, { board: B, now: at(1), rules: LEGACY_RULES });
  assert.ok(!r.events.some((e) => e.op === 'departed'), 'a failed read departs nothing');
  r = applyRun(r.state, ok([job(1)], { complete: false }), { board: B, now: at(2), rules: LEGACY_RULES });
  assert.ok(!r.events.some((e) => e.op === 'departed'), 'a partial read departs nothing');
  r = applyRun(r.state, ok([job(1)]), { board: B, now: at(3), rules: LEGACY_RULES });
  assert.equal(r.events.filter((e) => e.op === 'departed').length, 1, 'first complete miss');
  let s2 = applyRun(null, ok([job(1), job(2)]), { board: B, now: at(0), rules: SWEEP_RULES });
  s2 = applyRun(s2.state, ok([job(1)]), { board: B, now: at(71), rules: SWEEP_RULES });
  assert.ok(!s2.events.some((e) => e.op === 'departed'));
  s2 = applyRun(s2.state, ok([job(1)]), { board: B, now: at(73), rules: SWEEP_RULES });
  assert.equal(s2.events.filter((e) => e.op === 'departed').length, 1);
});

test('mass departure is held until confirmed', () => {
  const ten = Array.from({ length: 10 }, (_, i) => job(i));
  const rules = { mode: 'misses', k: 1, floorH: 0 };
  let r = applyRun(null, ok(ten), { board: B, now: at(0), rules });
  r = applyRun(r.state, ok([job(0)]), { board: B, now: at(1), rules });
  assert.equal(r.events.at(-1).held, 9);
  r = applyRun(r.state, ok([job(0)]), { board: B, now: at(2), rules });
  assert.equal(r.events.at(-1).held, 9);
  r = applyRun(r.state, ok([job(0)]), { board: B, now: at(3), rules });
  assert.equal(r.events.filter((e) => e.op === 'departed').length, 9, 'the third consistent read confirms');
});

test('delta of two full reads equals their set difference', () => {
  const A = [job(1), job(2), job(3)], Bv = [job(2), job(3), job(4), job(5)];
  const rules = { mode: 'misses', k: 1, floorH: 0 };
  const r1 = applyRun(null, ok(A), { board: B, now: at(0), rules });
  const r2 = applyRun(r1.state, ok(Bv), { board: B, now: at(1), rules });
  const m = deltaMatchesDiff(A, Bv, r2.events);
  assert.ok(m.ok, JSON.stringify(m));
});

test('store: commit, replay from a watermark, crash repair, lease, snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jcx-store-'));
  let s = openBoard(root, B);
  let r = applyRun(s, ok([job(1), job(2)]), { board: B, now: at(0) });
  commitRun(root, B, r.state, r.events);
  r = applyRun(openBoard(root, B), ok([job(1), job(3)]), { board: B, now: at(1) });
  commitRun(root, B, r.state, r.events);
  const all = [...readEvents(root)];
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual([...readEvents(root, { [B]: 3 })].map((e) => e.seq), [4, 5], 'replay after a watermark');
  // a crash after appending events but before the state rename: the extra events are cut on open
  appendFileSync(join(root, 'boards', boardKey(B), 'events.ndjson'), JSON.stringify({ schema: 'delta/v1', board: B, seq: 6, op: 'added' }) + '\n');
  openBoard(root, B);
  assert.deepEqual([...readEvents(root)].map((e) => e.seq), [1, 2, 3, 4, 5]);
  const rel = await lease(root, B, 60e3);
  assert.ok(rel);
  assert.equal(await lease(root, B, 60e3), null, 'a second run cannot take a held lease');
  rel();
  const rel2 = await lease(root, B, 60e3);
  assert.ok(rel2, 'released lease can be taken');
  rel2();
  const snap = [...snapshot(root)];
  assert.equal(snap[0].schema, 'snapshot/v1');
  assert.equal(snap[0].watermarks[B], 5);
  assert.equal(snap.length - 1, 3, 'open postings 1, 2, 3 (2 has one miss only)');
});

test('expired lease is taken over', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jcx-lease-'));
  let t = 0;
  const now = () => t;
  assert.ok(await lease(root, B, 1000, now));
  t = 5000;
  assert.ok(await lease(root, B, 1000, now));
});

test('events, states, snapshot headers and postings validate against the schemas', () => {
  const r = applyRun(null, ok([job(1)]), { board: B, now: at(0) });
  for (const e of r.events) assert.deepEqual(validate(e, 'delta-v1'), [], e.op);
  assert.deepEqual(validate(r.state, 'board-state-v1'), []);
  const root = mkdtempSync(join(tmpdir(), 'jcx-snap-'));
  commitRun(root, B, r.state, r.events);
  const [head, p] = [...snapshot(root)];
  assert.deepEqual(validate(head, 'snapshot-v1'), []);
  assert.deepEqual(validate(p, 'posting-v1'), []);
  assert.ok(validate({ schema: 'delta/v1' }, 'delta-v1').length > 0, 'the validator does reject');
});

test('parity: identical sets pass; a missing posting fails; tracking params still match', () => {
  const legacy = [{ url: 'https://jobs.example.com/p/1?utm_source=a', title: 'Engineer 1', location: 'Munich' }, { url: job(2).url, title: 'Engineer 2', location: 'Munich' }];
  const r = applyRun(null, ok([job(1), job(2)]), { board: B, now: at(0) });
  assert.equal(compareBoard(legacy, openPostings(r.state)).verdict, 'pass');
  const r2 = applyRun(null, ok([job(1)]), { board: B, now: at(0) });
  const c = compareBoard(legacy, openPostings(r2.state));
  assert.equal(c.verdict, 'fail');
  assert.equal(c.only_legacy, 1);
});
