// Streaming reader for <data>/scan-history.tsv (follow-up to the 2026-11-28 heap incident). The old loadHistory read the whole file
// (~170 MB, 824k rows) as one string and split it into an array of all lines before building the map; this reads it in 1 MB blocks.
//
// readHistoryFile(file, header) returns exactly the Map the old code built:
//   for (const line of readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
//     if (!line.trim()) continue;
//     const row = Object.fromEntries(line.split('\t').map((v, i) => [header[i], v]));
//     map.set(row.url, row);
//   }
// Lines are split on \n with one trailing \r removed (the same as /\r?\n/; a lone \r stays in the line); the first line (header) is
// skipped; multi-byte characters across block boundaries are decoded with a StringDecoder, the same as a whole-file utf8 read.
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const BLOCK = 1 << 20;

export function readHistoryFile(file, header, { blockSize = BLOCK } = {}) {
  const map = new Map();
  if (!existsSync(file)) return map;
  const fd = openSync(file, 'r');
  const dec = new StringDecoder('utf8');
  const buf = Buffer.allocUnsafe(blockSize);
  let rest = '', first = true;
  const take = (line) => {
    if (first) { first = false; return; }      // the header line
    if (!line.trim()) return;
    const row = Object.fromEntries(line.split('\t').map((v, i) => [header[i], v]));
    map.set(row.url, row);
  };
  try {
    for (let pos = 0; ;) {
      const n = readSync(fd, buf, 0, blockSize, pos);
      if (n <= 0) break;
      pos += n;
      const text = rest + dec.write(buf.subarray(0, n));
      let start = 0;
      for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
        take(text.charCodeAt(nl - 1) === 13 && nl > start ? text.slice(start, nl - 1) : text.slice(start, nl));
        start = nl + 1;
      }
      rest = text.slice(start);
    }
    rest += dec.end();
    take(rest);                                   // the last line (no final newline), or '' (skipped)
  } finally { closeSync(fd); }
  return map;
}
