// Versioning and graceful failure: old producer -> new consumer and back, replay of an old log through upcasters, mixed-version fleet
// routing, unknown types passed through, stage failures that never stop the pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrap, makeReader, parseSchema } from '../compat/envelope.mjs';
import { advertise, negotiate, canHandle, satisfies } from '../compat/handshake.mjs';
import { runStage, degraded } from '../compat/graceful.mjs';
import { mergeResult } from '../dist/merge.mjs';
import { LocalQueue } from '../dist/queue.mjs';
import { applyRun } from '../delta/board-delta.mjs';
import { validate } from '../schema/validate.mjs';

const readerV1 = makeReader({ accept: { delta: { major: 1 } } });
const ev = applyRun(null, { ok: true, items: [{ url: 'https://x.example/p/1', title: 'A' }] }, { board: 'B', now: new Date(0) }).events[0];

test('envelope: CloudEvents 1.0 with schema and producer versions; validates', () => {
  const m = wrap('delta/v1', ev, { type: 'io.jobcrawl.delta.added', subject: ev.id });
  assert.deepEqual(validate(m, 'envelope-v1'), []);
  assert.equal(m.dataschema, 'https://github.com/egidinas/jobcrawl/schemas/delta-v1.schema.json');
  assert.match(m.jcproducer, /^@egidinas\/jobcrawl@/);
  assert.match(ev.producer, /^@egidinas\/jobcrawl@/, 'bare log lines carry the producer too');
  assert.deepEqual(parseSchema('delta/v12'), { name: 'delta', major: 12 });
});

test('tolerant reader: a newer producer adding fields within v1 is read by an old consumer', () => {
  const m = wrap('delta/v1', { ...ev, salary_hint: 'new optional field' }, { producer: '@egidinas/jobcrawl@0.5.0' });
  const r = readerV1(m);
  assert.equal(r.status, 'ok');
  assert.equal(r.data.id, ev.id);
});

test('a newer MAJOR, an unknown schema or a malformed one is passed through as unsupported, never thrown', () => {
  assert.equal(readerV1(wrap('delta/v2', { x: 1 })).status, 'unsupported');
  assert.match(readerV1(wrap('delta/v2', { x: 1 })).reason, /newer than this reader/);
  assert.equal(readerV1(wrap('alert/v1', {})).status, 'unsupported');
  assert.equal(readerV1({ hello: 'world' }).status, 'unsupported');
  assert.equal(readerV1({ hello: 'world' }).message.hello, 'world', 'the original message is kept for storage and pass-through');
});

test('replay of an old log through upcasters (v1 -> v2 consumer), defaults filled for missing optional fields', () => {
  const readerV2 = makeReader({ accept: { delta: { major: 2, defaults: { lang: null } } },
    upcasters: { 'delta/v1': (d) => ({ ...d, schema: 'delta/v2', posting_id: d.id }) } });
  const oldLog = [ev, wrap('delta/v1', ev)];
  for (const line of oldLog) {
    const r = readerV2(line);
    assert.equal(r.status, 'ok');
    assert.equal(r.schema, 'delta/v2');
    assert.deepEqual(r.upcast, ['v2']);
    assert.equal(r.data.posting_id, ev.id);
    assert.equal(r.data.lang, null);
  }
  const noUp = makeReader({ accept: { delta: { major: 2 } } });
  assert.equal(noUp(ev).status, 'unsupported', 'without an upcaster an old major is reported, not guessed');
});

test('mixed-version fleet: work needing a newer schema or feature goes only to workers that advertise it', () => {
  const coord = advertise({ schemas: { delta: [1, 2], result: [1] }, features: ['x', 'y'] });
  const oldW = { id: 'old', capabilities: { cpu_threads: 4 }, advertisement: advertise({ producer: 'jc@0.1.0', schemas: { delta: [1], result: [1] }, features: ['x'] }) };
  const newW = { id: 'new', capabilities: { cpu_threads: 4 }, advertisement: advertise({ producer: 'jc@0.2.0', schemas: { delta: [1, 2], result: [1] }, features: ['x', 'y'] }) };
  assert.deepEqual(negotiate(coord, oldW.advertisement), { schemas: { delta: 1, result: 1 }, features: ['x'] });
  assert.deepEqual(canHandle(oldW.advertisement, { schemas: { delta: 2 } }).missing, ['delta/v2']);
  const q = new LocalQueue(':memory:');
  q.enqueue({ key: 'needs-v2', topic: 'enrich', requires: { schemas: { delta: 2 }, features: ['y'] } });
  q.enqueue({ key: 'plain', topic: 'enrich' });
  const a = q.lease(oldW, { topics: ['enrich'], n: 5 });
  assert.deepEqual(a.map((x) => x.key), ['plain'], 'the old worker gets only what it understands');
  const b = q.lease(newW, { topics: ['enrich'], n: 5 });
  assert.deepEqual(b.map((x) => x.key), ['needs-v2']);
  assert.equal(satisfies('0.2.1', '>=0.1.0 <0.3.0'), true);
  assert.equal(satisfies('@egidinas/jobcrawl@0.3.0', '>=0.1.0 <0.3.0'), false);
});

test('graceful: missing, disabled or failing stages yield a status, the pipeline goes on; ok later upgrades it', async () => {
  const input = { subject: 'jc1_x', version: 3 };
  const results = [
    await runStage(null, input),
    await runStage({ id: 'embed', version: '1', run: () => [1] }, input, { available: false }),
    await runStage({ id: 'extract', version: '2', run: () => 1 }, input, { enabled: false }),
    await runStage({ id: 'geo', version: '1', run: () => { throw new Error('gazetteer pack missing'); } }, input),
  ];
  assert.deepEqual(results.map((r) => r.status), ['unsupported', 'unsupported', 'skipped', 'failed']);
  for (const r of results) assert.deepEqual(validate(r, 'result-v1'), [], r.stage);
  const d = degraded(results);
  assert.equal(d['geo@1'].failed, 1);
  assert.deepEqual(d['geo@1'].reasons, ['gazetteer pack missing']);
  const t = new Map();
  assert.equal(mergeResult(t, results[1]), 'stored');
  const ok = await runStage({ id: 'embed', version: '1', run: () => [1, 2] }, input);
  assert.equal(mergeResult(t, ok), 'upgraded', 'the capability appeared: ok replaces unsupported');
  assert.equal(mergeResult(t, results[1]), 'duplicate', 'a late non-ok never replaces ok');
});
