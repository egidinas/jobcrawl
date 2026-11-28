// Streaming writer for <data>/scan-history.tsv (heap incident 2026-11-28: the crawl ran out of its ~2.1 GB heap in saveHistory, which
// built the whole ~170 MB text as one string, flattened it for the write and read the old file back as another full string to compare).
//
// writeHistoryFile(file, header, rows) writes EXACTLY the bytes the old code wrote:
//   header.join('\t') + '\n' + for each row: header.map((h) => String(row[h] ?? '').replace(/[\t\n]/g, ' ')).join('\t') + '\n'
// but never holds more than one chunk of lines in memory. While the new text matches the existing file byte for byte, nothing is
// written (an unchanged history keeps its mtime, as before, so downstream steps can skip); at the first difference the equal prefix is
// copied from the existing file into <file>.tmp and the rest is written there; the tmp file then replaces the history (rename).
// Returns { changed, bytes, rows }.
import { closeSync, existsSync, fstatSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';

const CHUNK_LINES = 4000;
const COPY = 1 << 20;

export const historyLine = (header, row) => header.map((h) => String(row[h] ?? '').replace(/[\t\n]/g, ' ')).join('\t');

export function writeHistoryFile(file, header, rows, { chunkLines = CHUNK_LINES } = {}) {
  const tmp = `${file}.tmp`;
  let old = existsSync(file) ? openSync(file, 'r') : null;
  const oldSize = old !== null ? fstatSync(old).size : 0;
  let out = null;            // tmp fd once the text differs
  let offset = 0;            // bytes of the new text so far
  let equal = old !== null;  // the new text so far equals the old file's prefix
  const cmp = Buffer.allocUnsafe(COPY);
  const startWriting = () => {
    out = openSync(tmp, 'w');
    // the equal prefix comes from the old file (same bytes), copied in blocks
    for (let pos = 0; pos < offset;) {
      const n = readSync(old, cmp, 0, Math.min(COPY, offset - pos), pos);
      if (n <= 0) throw new Error(`history: short read copying the prefix of ${file}`);
      writeSync(out, cmp, 0, n);
      pos += n;
    }
  };
  const emit = (text) => {
    const buf = Buffer.from(text, 'utf8');
    if (equal) {
      let same = offset + buf.length <= oldSize;
      for (let p = 0; same && p < buf.length;) {
        const want = Math.min(COPY, buf.length - p);
        const n = readSync(old, cmp, 0, want, offset + p);
        if (n !== want || cmp.compare(buf, p, p + n, 0, n) !== 0) same = false;
        p += n;
      }
      if (same) { offset += buf.length; return; }
      equal = false;
      startWriting();
    } else if (out === null) startWriting();
    writeSync(out, buf);
    offset += buf.length;
  };
  let n = 0;
  try {
    let parts = [header.join('\t') + '\n'];
    for (const row of rows) {
      parts.push(historyLine(header, row) + '\n');
      n++;
      if (parts.length >= chunkLines) { emit(parts.join('')); parts = []; }
    }
    if (parts.length) emit(parts.join(''));
    if (equal && offset === oldSize) {        // unchanged: nothing written, mtime kept
      closeSync(old); old = null;
      return { changed: false, bytes: offset, rows: n };
    }
    if (out === null) startWriting();         // the new text is a strict prefix of the old file (rows removed at the end)
    closeSync(out); out = null;
    if (old !== null) { closeSync(old); old = null; }
    renameSync(tmp, file);
    return { changed: true, bytes: offset, rows: n };
  } catch (e) {
    if (out !== null) try { closeSync(out); } catch {}
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  } finally {
    if (old !== null) try { closeSync(old); } catch {}
  }
}

