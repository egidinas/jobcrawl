// Raw capture: keeps every response the crawler receives from a job feed, byte for byte, so the board can be rebuilt from
// first-party data at any time (descriptions with their HTML structure and every field a provider sends, not only the ones
// the crawler extracts today). Off unless JOBCRAWL_RAW_DIR is set.
//
// It wraps the global fetch of the crawl process, so every provider is covered without touching provider code, including
// the ones that call fetch directly. Bodies are stored once per content (gzipped, named by their SHA-256), so an unchanged
// board between two crawls costs one index line; every response gets a line in a daily index for replay:
//   <dir>/objects/ab/<sha256>.gz          the response body as received
//   <dir>/index/<yyyy-mm-dd>.jsonl        {t, url, method, status, ct, bytes, sha256, new, req}  (req: POST body, up to 16 KB)
// A failure to capture never fails the crawl; it is counted and reported in the summary line.
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { appendFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const CAPTURE = /json|html|xml|text|javascript/i;
const stats = { responses: 0, new: 0, bytes: 0, newBytes: 0, errors: 0, skipped: 0 };
let installed = false;

export function rawCaptureStats() {
  return { ...stats };
}

function requestBody(init) {
  const b = init?.body;
  if (b == null) return undefined;
  const s = typeof b === 'string' ? b : b instanceof URLSearchParams ? b.toString() : undefined;
  return s === undefined ? '[non-text body]' : s.length > 16384 ? s.slice(0, 16384) + '[...]' : s;
}

function store(dir, entry, body) {
  const sha = createHash('sha256').update(body).digest('hex');
  const sub = join(dir, 'objects', sha.slice(0, 2));
  const obj = join(sub, `${sha}.gz`);
  const fresh = !existsSync(obj);
  if (fresh) {
    mkdirSync(sub, { recursive: true });
    const tmp = `${obj}.tmp`;
    writeFileSync(tmp, gzipSync(body));
    renameSync(tmp, obj);
    stats.new++;
    stats.newBytes += body.length;
  }
  stats.responses++;
  stats.bytes += body.length;
  const day = new Date().toISOString().slice(0, 10);
  mkdirSync(join(dir, 'index'), { recursive: true });
  appendFileSync(join(dir, 'index', `${day}.jsonl`), JSON.stringify({ ...entry, bytes: body.length, sha256: sha, new: fresh }) + '\n');
}

/** Wrap globalThis.fetch so that every successful text/JSON/HTML/XML response is stored under dir. Returns false if dir is unset. */
export function installRawCapture(dir = process.env.JOBCRAWL_RAW_DIR) {
  if (!dir || installed) return Boolean(dir && installed);
  installed = true;
  mkdirSync(dir, { recursive: true });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const res = await origFetch(input, init);
    try {
      const ct = res.headers.get('content-type') || '';
      if (res.ok && (CAPTURE.test(ct) || !ct)) {
        const body = Buffer.from(await res.clone().arrayBuffer());
        const url = typeof input === 'string' ? input : input?.url ?? String(input);
        store(dir, { t: new Date().toISOString(), url, method: (init?.method || input?.method || 'GET').toUpperCase(), status: res.status, ct, req: requestBody(init) }, body);
      } else {
        stats.skipped++;
      }
    } catch {
      stats.errors++;
    }
    return res;
  };
  return true;
}

/** One line for the crawl log. */
export function rawCaptureSummary() {
  const mb = (n) => (n / 1e6).toFixed(1);
  return `raw capture: ${stats.responses} responses (${mb(stats.bytes)} MB), ${stats.new} new bodies stored (${mb(stats.newBytes)} MB before gzip), `
    + `${stats.skipped} not captured (error status or binary), ${stats.errors} capture errors`;
}
