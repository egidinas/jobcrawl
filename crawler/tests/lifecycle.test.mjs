// node --test crawler/tests/lifecycle.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLifecycle, lifecycleMode } from '../lifecycle.mjs';

const quiet = () => {};
const clock = (iso) => { let t = Date.parse(iso); return () => new Date(t += 1000); };
const events = (dir) => {
  const root = join(dir, 'lifecycle', 'events');
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((d) => readdirSync(join(root, d)).flatMap((f) => readFileSync(join(root, d, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l))));
};
const M = { provider: 'greenhouse', host: 'boards.greenhouse.io' };

test('mode: off unless shadow or on', () => {
  assert.equal(lifecycleMode({}), 'off');
  assert.equal(lifecycleMode({ MADE_LIFECYCLE: 'SHADOW' }), 'shadow');
  assert.equal(lifecycleMode({ MADE_LIFECYCLE: 'yes' }), 'off');
  assert.equal(openLifecycle(mkdtempSync(join(tmpdir(), 'lc-')), { mode: 'off', log: quiet }), null);
});

test('seen: first ever, first of the day, after a miss; misses only from complete fetches of the same board', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-'));
  let lc = openLifecycle(dir, { mode: 'shadow', now: clock('2026-11-20T08:00:00Z'), log: quiet });
  lc.fetched('B', M, ['u1', 'u2']);
  lc.fetched('B', M, ['u1', 'u2']);                        // same day, no miss: no new seen lines
  lc.fetched('B', M, ['u1'], { complete: false, cls: 'INCOMPLETE' });   // partial: no miss for u2
  lc.skippedOrFailed('B', M, 'HTTP_5XX');                  // failed: nothing
  lc.fetched('B', M, ['u1']);                              // complete: u2 missed (n 1)
  lc.fetched('C', M, []);                                  // another board: u1/u2 untouched
  lc.fetched('B', M, ['u1', 'u2']);                        // u2 back: seen after a miss
  lc.flush();
  let ev = events(dir);
  const k = (kind) => ev.filter((e) => e.kind === kind);
  assert.deepEqual(k('seen').map((e) => [e.url, !!e.first, e.after_misses ?? 0]), [['u1', true, 0], ['u2', true, 0], ['u2', false, 1]]);
  assert.deepEqual(k('missed').map((e) => [e.url, e.n]), [['u2', 1]]);
  assert.equal(k('fetch').length, 7);
  assert.deepEqual(k('fetch').map((e) => e.complete), [true, true, false, false, true, true, true]);
  // next day: first sighting of the day is written again; state survived the flush
  lc = openLifecycle(dir, { mode: 'shadow', now: clock('2026-11-21T08:00:00Z'), log: quiet });
  lc.fetched('B', M, ['u1']);
  lc.fetched('B', M, ['u1']);
  lc.flush();
  ev = events(dir);
  assert.deepEqual(ev.filter((e) => e.kind === 'seen' && e.ts.startsWith('2026-11-21')).map((e) => e.url), ['u1']);
  assert.deepEqual(ev.filter((e) => e.kind === 'missed' && e.ts.startsWith('2026-11-21')).map((e) => [e.url, e.n]), [['u2', 1], ['u2', 2]]);
});

test('suspect: a board that listed more than 5 and now lists under half is flagged, misses carry the flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-'));
  const lc = openLifecycle(dir, { mode: 'shadow', now: clock('2026-11-20T08:00:00Z'), log: quiet });
  const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  lc.fetched('B', M, all);
  lc.fetched('B', M, ['a']);
  lc.fetched('B', M, [], { complete: true, emptyOk: true });   // the provider said empty on purpose: not suspect
  lc.flush();
  const ev = events(dir);
  const f = ev.filter((e) => e.kind === 'fetch');
  assert.equal(f[1].suspect, true);
  assert.equal(f[2].suspect, undefined);
  assert.ok(ev.filter((e) => e.kind === 'missed' && e.fetch_id === f[1].fetch_id).every((e) => e.suspect));
});

test('dry flush writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-'));
  const lc = openLifecycle(dir, { mode: 'shadow', log: quiet });
  lc.fetched('B', M, ['u']);
  lc.flush({ dry: true });
  assert.equal(existsSync(join(dir, 'lifecycle')), false);
});
