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

// ---- review F1 and the missing cases (review_history_stream.md) ----
import * as realFs from 'node:fs';
const small = () => { const m = new Map(); for (let i = 0; i < 2000; i++) { const url = `https://x.example/${i}`; m.set(url, { url, company: 'C', title: `T ${i}`, location: 'L', first_seen: '2026-11-01', last_seen: '2026-11-28', status: 'open', posted: '' }); } return m; };
const goodOld = (dir) => { const f = join(dir, 'h.tsv'); const m = small(); writeHistoryFile(f, HEADER, m.values()); const before = readFileSync(f); m.get('https://x.example/1999').status = 'gone'; return { f, m, before }; };

test('short writes are completed (writeSync writing only part of a buffer)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcx-short-'));
  const { f, m } = goodOld(dir);
  const io = { ...realFs, writeSync: (fd, buf, off = 0, len = buf.length - off) => realFs.writeSync(fd, buf, off, Math.max(1, Math.floor(len / 3))) };
  assert.equal(writeHistoryFile(f, HEADER, m.values(), { io, chunkLines: 50 }).changed, true);
  assert.equal(readFileSync(f, 'utf8'), oldText(m));
});

test('ENOSPC after a short write: the error is raised, the old history is kept, the tmp file removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcx-enospc-'));
  const { f, m, before } = goodOld(dir);
  let calls = 0;
  const io = { ...realFs, writeSync: (fd, buf, off = 0, len = buf.length - off) => {
    if (++calls === 1) return realFs.writeSync(fd, buf, off, Math.floor(len / 2));
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  } };
  assert.throws(() => writeHistoryFile(f, HEADER, m.values(), { io }), /ENOSPC/);
  assert.deepEqual(readFileSync(f), before, 'old history untouched');
  assert.equal(existsSync(`${f}.tmp`), false, 'tmp removed');
});

test('a write that claims success but wrote less is caught by the size check before the rename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcx-lie-'));
  const { f, m, before } = goodOld(dir);
  const io = { ...realFs, writeSync: (fd, buf, off = 0, len = buf.length - off) => { realFs.writeSync(fd, buf, off, Math.max(0, len - 1)); return len; } };
  assert.throws(() => writeHistoryFile(f, HEADER, m.values(), { io }), /expected/);
  assert.deepEqual(readFileSync(f), before);
  assert.equal(existsSync(`${f}.tmp`), false);
});

test('a write that returns 0 does not loop forever', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcx-zero-'));
  const { f, m, before } = goodOld(dir);
  const io = { ...realFs, writeSync: () => 0 };
  assert.throws(() => writeHistoryFile(f, HEADER, m.values(), { io }), /write returned 0/);
  assert.deepEqual(readFileSync(f), before);
});

test('an iterator that throws mid-way keeps the old history and removes the tmp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcx-throw-'));
  const { f, m, before } = goodOld(dir);
  function* rows() { let i = 0; for (const r of m.values()) { if (++i === 1500) throw new Error('boom'); yield { ...r, status: 'x' }; } }
  assert.throws(() => writeHistoryFile(f, HEADER, rows(), { chunkLines: 100 }), /boom/);
  assert.deepEqual(readFileSync(f), before);
  assert.equal(existsSync(`${f}.tmp`), false);
});

test('surrogate pairs, lone surrogates and emoji at line edges: identical bytes at chunk sizes 1, 2, 3 and 7', () => {
  const m = new Map();
  const vals = ['😀 start', 'end 😀', '\uD83D lone high', 'lone low \uDE00', '﻿bom', 'cr\rhere', '', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢'];
  for (let i = 0; i < 40; i++) { const url = `https://u.example/${i}`; m.set(url, { url, company: vals[i % vals.length], title: vals[(i + 3) % vals.length], location: vals[(i + 5) % vals.length], first_seen: '2026-11-01', last_seen: '2026-11-28', status: 'open', posted: i % 2 ? undefined : 0 }); }
  const expected = Buffer.from(oldText(m), 'utf8');
  for (const chunkLines of [1, 2, 3, 7]) {
    const f = join(mkdtempSync(join(tmpdir(), 'jcx-sur-')), 'h.tsv');
    writeHistoryFile(f, HEADER, m.values(), { chunkLines });
    assert.equal(sha(readFileSync(f)), sha(expected), `chunkLines ${chunkLines}`);
    assert.equal(writeHistoryFile(f, HEADER, m.values(), { chunkLines }).changed, false, 'second write is a no-op');
  }
});

test('an old file with Windows line endings is rewritten with the exact new bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcx-crlf-'));
  const f = join(dir, 'h.tsv');
  const m = small();
  writeFileSync(f, oldText(m).replace(/\n/g, '\r\n'));
  assert.equal(writeHistoryFile(f, HEADER, m.values()).changed, true);
  assert.equal(readFileSync(f, 'utf8'), oldText(m));
});
