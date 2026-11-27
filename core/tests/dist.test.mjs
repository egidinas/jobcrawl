// Distributed interfaces, local implementations: queue (idempotent enqueue, leases, expiry, retry/backoff, dead letter, capability
// matching), artifact store (content addressed, verified), vector packing, idempotent result merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalQueue } from '../dist/queue.mjs';
import { meets } from '../dist/match.mjs';
import { LocalArtifacts, packVector, unpackVector } from '../dist/artifacts.mjs';
import { mergeResult } from '../dist/merge.mjs';
import { validate } from '../schema/validate.mjs';

const crawler = { id: 'nuc-crawl', capabilities: { net: true, cpu_threads: 4 } };
const gpu = { id: '291-embed', capabilities: { gpu: true, vram_gb: 48, cpu_threads: 28, models: ['granite-107m@1'] }, policy: { smoke_measured: { 'embed.posting': { rate: 900 } } } };

test('queue: idempotent by key, newer version replaces a waiting one', () => {
  let t = 1000;
  const q = new LocalQueue(':memory:', { clock: () => t });
  assert.equal(q.enqueue({ key: 'board:a', topic: 'crawl.board', version: 1 }).added, true);
  assert.equal(q.enqueue({ key: 'board:a', topic: 'crawl.board', version: 1 }).added, false);
  assert.equal(q.enqueue({ key: 'board:a', topic: 'crawl.board', version: 2, payload: { v: 2 } }).added, true);
  const [it] = q.lease(crawler, { topics: ['crawl.board'] });
  assert.equal(it.version, 2);
  assert.deepEqual(it.payload, { v: 2 });
  assert.equal(q.lease(crawler, { topics: ['crawl.board'] }).length, 0, 'a leased item is invisible');
});

test('queue: an expired lease (dead worker) makes the item visible again; heartbeat keeps it', () => {
  let t = 0;
  const q = new LocalQueue(':memory:', { clock: () => t });
  q.enqueue({ key: 'k', topic: 'x' });
  const [a] = q.lease(crawler, { topics: ['x'], ttlMs: 1000 });
  t = 900; q.heartbeat(a.leaseId, 1000);
  t = 1500; assert.equal(q.lease(crawler, { topics: ['x'] }).length, 0, 'heartbeat extended it');
  t = 2500; const [b] = q.lease(crawler, { topics: ['x'] });
  assert.equal(b.key, 'k'); assert.equal(b.attempts, 2);
  assert.throws(() => q.ack(a.leaseId), /lease not found/, 'the dead worker cannot ack a lease it lost');
  q.ack(b.leaseId);
  assert.deepEqual(q.stats(), {});
});

test('queue: nack retries with backoff, then dead-letters; redrive puts it back', () => {
  let t = 0;
  const q = new LocalQueue(':memory:', { clock: () => t, backoffMs: 100 });
  q.enqueue({ key: 'k', topic: 'x', maxAttempts: 2 });
  let [a] = q.lease(crawler, { topics: ['x'] });
  assert.deepEqual(q.nack(a.leaseId, 'boom'), { dead: false, retryInMs: 100 });
  t = 50; assert.equal(q.lease(crawler, { topics: ['x'] }).length, 0, 'backoff');
  t = 150; [a] = q.lease(crawler, { topics: ['x'] });
  assert.equal(q.nack(a.leaseId, 'boom again').dead, true);
  assert.deepEqual(q.stats(), { x: { dead: 1 } });
  assert.equal(q.redrive('x'), 1);
  assert.equal(q.lease(crawler, { topics: ['x'] }).length, 1);
});

test('queue: items go only to capable workers; long items need a measured smoke', () => {
  const q = new LocalQueue(':memory:');
  q.enqueue({ key: 'p1', topic: 'embed.posting', requires: { gpu: true, vram_gb: 8, models: ['granite-107m@1'], long: true } });
  assert.equal(q.lease(crawler, { topics: ['embed.posting'] }).length, 0);
  assert.equal(q.lease(gpu, { topics: ['embed.posting'] }).length, 1);
  assert.deepEqual(meets({ capabilities: { gpu: true, vram_gb: 48 } }, { gpu: true, long: true }, 'extract.skills').missing, ['measured smoke for extract.skills']);
});

test('queue: a file-backed queue is shared by two handles (two processes on one machine)', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'jcx-q-')), 'q.sqlite');
  const a = new LocalQueue(f), b = new LocalQueue(f);
  a.enqueue({ key: 'k1', topic: 'x' }); a.enqueue({ key: 'k2', topic: 'x' });
  const ia = a.lease(crawler, { topics: ['x'] }), ib = b.lease(crawler, { topics: ['x'] });
  assert.notEqual(ia[0].key, ib[0].key, 'no item is leased twice');
  a.close(); b.close();
});

test('artifacts: content addressed, duplicate put is a no-op, verified read', () => {
  const s = new LocalArtifacts(mkdtempSync(join(tmpdir(), 'jcx-art-')));
  const r1 = s.put('hello', { type: 'text/plain' }), r2 = s.put(Buffer.from('hello'));
  assert.equal(r1.sha256, r2.sha256);
  assert.equal(s.get(r1).toString(), 'hello');
  assert.deepEqual(validate(r1, 'artifact-ref-v1'), []);
});

test('vectors: float16 and int8 round trips stay close', () => {
  const v = Array.from({ length: 64 }, (_, i) => Math.sin(i) * 0.3);
  for (const dt of ['float16', 'int8']) {
    const p = packVector(v, dt);
    assert.equal(p.data.length, dt === 'int8' ? 64 : 128);
    const back = unpackVector(p);
    const err = Math.max(...v.map((x, i) => Math.abs(x - back[i])));
    assert.ok(err < (dt === 'int8' ? 0.003 : 0.0005), `${dt} max error ${err}`);
  }
});

test('merge: duplicate and stale results never overwrite; provenance kept', () => {
  const t = new Map();
  const r = { subject: 'jc1_x', stage: 'embed@granite-107m.1', version: 2, value: [1], provenance: { worker: '291-embed', host: 'cl25eng291' } };
  assert.equal(mergeResult(t, r), 'stored');
  assert.equal(mergeResult(t, { ...r, value: [9] }), 'duplicate');
  assert.equal(mergeResult(t, { ...r, version: 1 }), 'stale');
  assert.deepEqual([...t.values()][0].value, [1]);
  assert.deepEqual(validate(r, 'result-v1'), []);
  assert.deepEqual(validate({ key: 'b', topic: 'crawl.board', requires: { net: true } }, 'work-item-v1'), []);
  assert.deepEqual(validate(gpu, 'worker-v1'), []);
});
