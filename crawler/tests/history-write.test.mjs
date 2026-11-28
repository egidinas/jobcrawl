// The streaming history writer (crawler/history-write.mjs) writes exactly the bytes the old saveHistory wrote, keeps the mtime of an
// unchanged history, and handles a changed middle, removed tail rows, a missing file and awkward field contents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHistoryFile } from '../history-write.mjs';

const HEADER = ['url', 'company', 'title', 'location', 'first_seen', 'last_seen', 'status', 'posted'];
// the old implementation, verbatim (crawl.mjs saveHistory before 2026-11-28), returning the text it wrote
const oldText = (map) => [HEADER.join('\t'), ...[...map.values()].map((r) => HEADER.map((h) => String(r[h] ?? '').replace(/[\t\n]/g, ' ')).join('\t'))].join('\n') + '\n';
const sha = (b) => createHash('sha256').update(b).digest('hex');

function bigMap(n, salt = '') {
  const m = new Map();
  for (let i = 0; i < n; i++) {
    const url = `https://jobs.example-${i % 6000}.com/p/${i}${salt}`;
    m.set(url, { url, company: i % 3 ? `Firma ${i % 6000} – Ünternehmen` : `Board ${i % 6000} (via EURES)`, title: i % 997 === 0 ? 'Tab\there and\nnewline' : `Senior Engineer (m/w/d) № ${i}`,
      location: i % 11 ? 'München, Bayern' : '', first_seen: '2026-10-01', last_seen: i % 2 ? '2026-11-27' : '2026-11-28', status: ['open', 'extra', 'filtered', 'dup', 'gone'][i % 5],
      ...(i % 13 ? { posted: '2026-09-30' } : {}) });
  }
  return m;
}

test('824,000 rows: the streamed file is byte-identical to the old full-string write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcx-hist-'));
  const map = bigMap(824000);
  const expected = Buffer.from(oldText(map), 'utf8');
  const f = join(dir, 'scan-history.tsv');
  const r = writeHistoryFile(f, HEADER, map.values());
  assert.equal(r.changed, true); assert.equal(r.rows, 824000);
  const got = readFileSync(f);
  assert.equal(got.length, expected.length);
  assert.equal(sha(got), sha(expected));
  assert.equal(existsSync(`${f}.tmp`), false);
});

test('an unchanged history is not rewritten (mtime kept); changed middle, removed tail and grown history are written exactly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcx-hist2-'));
  const f = join(dir, 'h.tsv');
  const map = bigMap(30000);
  writeHistoryFile(f, HEADER, map.values(), { chunkLines: 777 });
  const past = new Date('2026-01-01T00:00:00Z');
  utimesSync(f, past, past);
  assert.equal(writeHistoryFile(f, HEADER, map.values(), { chunkLines: 500 }).changed, false);
  assert.equal(statSync(f).mtimeMs, past.getTime(), 'mtime kept');
  // a change in the middle
  const k = [...map.keys()][15000];
  map.get(k).status = 'gone';
  assert.equal(writeHistoryFile(f, HEADER, map.values(), { chunkLines: 333 }).changed, true);
  assert.equal(readFileSync(f, 'utf8'), oldText(map));
  // rows removed at the end (the new text is a prefix of the old file)
  const keys = [...map.keys()];
  for (const key of keys.slice(-100)) map.delete(key);
  assert.equal(writeHistoryFile(f, HEADER, map.values()).changed, true);
  assert.equal(readFileSync(f, 'utf8'), oldText(map));
  // rows added at the end
  map.set('https://new.example/x', { url: 'https://new.example/x', company: 'New', title: 'T', location: '', first_seen: '2026-11-28', last_seen: '2026-11-28', status: 'open', posted: '' });
  assert.equal(writeHistoryFile(f, HEADER, map.values()).changed, true);
  assert.equal(readFileSync(f, 'utf8'), oldText(map));
});

test('a missing file is created; an empty history writes only the header', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcx-hist3-'));
  const f = join(dir, 'h.tsv');
  assert.equal(writeHistoryFile(f, HEADER, new Map().values()).changed, true);
  assert.equal(readFileSync(f, 'utf8'), HEADER.join('\t') + '\n');
  writeFileSync(f, 'garbage that is longer than the header line ...........................................\n');
  assert.equal(writeHistoryFile(f, HEADER, new Map().values()).changed, true);
  assert.equal(readFileSync(f, 'utf8'), HEADER.join('\t') + '\n');
});
