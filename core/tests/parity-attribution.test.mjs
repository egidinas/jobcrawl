// The 19 real parity failures of 2026-11-28, reproduced: session ids in urls, the same tenant under two board names, aggregator copies,
// postings that appeared after the recording, incomplete recordings, boards the legacy crawl does not read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postingId, normaliseUrl } from '../id.mjs';
import { compareBoard, lifecycleIndex, lifecycleFirstSeen } from '../route/parity.mjs';

const row = (url) => ({ url, title: 'T', location: 'L' });
const open = (urls) => urls.map((u) => ({ id: postingId(u), url: u, title: 'T', location: 'L' }));

test('session ids in the query are not part of the identity (adesso, noris); a numeric sid stays', () => {
  const a = 'https://www.adesso.ch/de_ch/jobs/Business-Developer-de-j2972.html?sid=db1b86dc1a19c5bab8cbe5f2ef2e9c87';
  const b = 'https://www.adesso.ch/de_ch/jobs/Business-Developer-de-j2972.html?sid=0f3c2a9d6e1b4c7a8d9e0f1a2b3c4d5e';
  assert.equal(postingId(a), postingId(b));
  assert.equal(normaliseUrl('https://x.example/job?sid=12345'), 'x.example/job?sid=12345', 'a short numeric sid is kept');
  assert.equal(normaliseUrl('https://x.example/job;x?jsessionid=ABCDEF0123456789ABCDEF0123'), 'x.example/job;x');
});

test('a posting the legacy crawl attributes to another board is shared, not a mismatch (twin tenants, aggregator copies)', () => {
  const urls = ['https://a.example/1', 'https://a.example/2', 'https://esa.example/9'];
  const urlBoard = new Map([[urls[0], 'AVILUS GmbH'], [urls[1], 'AVILUS GmbH'], [urls[2], 'European Space Agency (ESA)']]);
  const c = compareBoard([], open(urls), { sameFetch: true, ownBoard: 'AVILUS', urlBoard });
  assert.equal(c.shared, 3); assert.equal(c.only_new, 0);
});

test('postings the legacy crawl first saw after the new answer are skew, not failures; incomplete answers do not fail on missing postings', () => {
  const recAt = Date.parse('2026-11-28T02:57:00Z');
  const legacy = ['https://h.example/1', 'https://h.example/2', 'https://h.example/new'].map(row);
  const firstSeen = new Map([['https://h.example/new', Date.parse('2026-11-28T03:41:00Z')]]);
  let c = compareBoard(legacy, open(['https://h.example/1', 'https://h.example/2']), { sameFetch: true, ownBoard: 'H', newAt: recAt, firstSeen });
  assert.equal(c.verdict, 'skew'); assert.equal(c.added_since, 1); assert.equal(c.only_legacy, 0);
  c = compareBoard(legacy, open(['https://h.example/1']), { sameFetch: true, ownBoard: 'H', complete: false });
  assert.equal(c.verdict, 'incomplete'); assert.equal(c.incomplete_missing, 2);
  c = compareBoard(legacy, open(['https://h.example/1', 'https://h.example/2']), { sameFetch: true, ownBoard: 'H' });
  assert.equal(c.verdict, 'fail', 'without the evidence it is still a failure');
});

test('lifecycle index and first sightings are read from the state and the events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcx-lci-'));
  mkdirSync(join(dir, 'events', '2026-11-28'), { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ urls: { 'https://h.example/1': ['H', '2026-11-28', 0, 100], 'https://h.example/2': ['H', '2026-11-28', 0, 200], 'https://o.example/1': ['O', '2026-11-28', 0, 50] } }));
  writeFileSync(join(dir, 'events', '2026-11-28', 'ev-1.jsonl'), [
    { ts: '2026-11-28T03:41:00.000Z', kind: 'seen', url: 'https://h.example/2', board: 'H', first: true },
    { ts: '2026-11-28T03:50:00.000Z', kind: 'seen', url: 'https://h.example/1', board: 'H' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const idx = lifecycleIndex(join(dir, 'state.json'));
  assert.deepEqual(idx.fetches.get('H'), { at: 200, urls: ['https://h.example/2'] });
  assert.equal(idx.urlBoard.get('https://o.example/1'), 'O');
  const fs = lifecycleFirstSeen(join(dir, 'events'), ['https://h.example/1', 'https://h.example/2']);
  assert.deepEqual([...fs], [['https://h.example/2', Date.parse('2026-11-28T03:41:00Z')]]);
});
