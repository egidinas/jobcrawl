// The streaming history reader (crawler/history-read.mjs) builds exactly the Map the old whole-file loadHistory built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistoryFile } from '../history-read.mjs';
import { writeHistoryFile } from '../history-write.mjs';

const HEADER = ['url', 'company', 'title', 'location', 'first_seen', 'last_seen', 'status', 'posted'];
function oldLoad(file) {                    // crawl.mjs loadHistory() before 2026-11-28, verbatim apart from the file argument
  const map = new Map();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const row = Object.fromEntries(line.split('\t').map((v, i) => [HEADER[i], v]));
    map.set(row.url, row);
  }
  return map;
}
const same = (a, b) => { assert.equal(a.size, b.size); assert.deepEqual([...a.keys()], [...b.keys()]); assert.deepEqual([...a.values()], [...b.values()]); };

test('824,000 rows: the streamed map equals the old whole-file read (keys, order, every field)', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'jcx-hr-')), 'h.tsv');
  const m = new Map();
  for (let i = 0; i < 824000; i++) {
    const url = `https://jobs.example-${i % 6000}.com/p/${i}`;
    m.set(url, { url, company: `Firma ${i % 6000} – Ünternehmen 😀`, title: `Senior Engineer (m/w/d) № ${i}`, location: i % 11 ? 'München' : '', first_seen: '2026-10-01', last_seen: '2026-11-28', status: 'open', posted: i % 13 ? '2026-09-30' : '' });
  }
  writeHistoryFile(f, HEADER, m.values());
  same(readHistoryFile(f, HEADER), oldLoad(f));
});

test('edge cases at tiny block sizes: CRLF, lone CR, BOM, blank lines, no final newline, extra and missing tabs, multi-byte across blocks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcx-hr2-'));
  const texts = [
    '﻿url\tcompany\ttitle\tlocation\tfirst_seen\tlast_seen\tstatus\tposted\r\nhttps://a/1\tÄ😀\tT\tL\t1\t2\topen\t\r\n\r\n   \nhttps://a/2\tB\tlone\rCR\tL\t1\t2\textra\t3\textra-field\nhttps://a/3\tC',
    'header only',
    '',
    'h\nhttps://x/1\t𝔘𝔫𝔦\t😀😀😀\t\t\t\t\t\n',
    'h\r\nhttps://x/dup\tA\r\nhttps://x/dup\tB\r\n',
  ];
  for (const [k, t] of texts.entries()) {
    const f = join(dir, `h${k}.tsv`);
    writeFileSync(f, t);
    for (const blockSize of [1, 2, 3, 5, 7, 64, 1 << 20]) same(readHistoryFile(f, HEADER, { blockSize }), oldLoad(f));
  }
});

test('a missing file gives an empty map', () => {
  assert.equal(readHistoryFile(join(tmpdir(), 'jcx-no-such-history.tsv'), HEADER).size, 0);
});
