// Facts the per-board events do not carry and the resolver needs (row 1.4): the employer name as the board names it ("X (via Board)" on
// aggregators), the description fingerprint (crawler/fingerprint.mjs simhash; delta/v1 `dh` is an exact hash), the apply links of an
// aggregator description (postingkey.mjs textPostingKeys) and the board's own keep/hide verdict (its filters).
// A facts provider is facts(record) -> { company?, fp?, applyText?, kept?, hide? } (undefined fields: unknown). Recorded on the member
// at the time of the observation, never recomputed later.
//   defaultFacts   from the record's posting/v1 fields (hiringOrganization.name, jobcrawl.dedupe.simhash, description,
//                  jobcrawl.meta.kept / meta.hide). The new path's postings carry none of these yet: then the employer is the board's
//                  name, there is no fingerprint (cross-listing by posting key only) and every listed posting is kept.
//   legacyFacts    from a legacy data folder (read-only): scan-history.tsv, simhash-cache.v2.json, jd/ (the replay harness, and the
//                  shadow phase while the per-board path has no filters of its own).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jdFileName } from '../../crawler/jdclean.mjs';

export function defaultFacts(rec) {
  const p = rec?.posting;
  if (!p) return {};
  const meta = p.jobcrawl?.meta ?? {};
  return {
    company: p.hiringOrganization?.name || undefined,
    fp: p.jobcrawl?.dedupe?.simhash || undefined,
    applyText: p.description || undefined,
    kept: meta.kept === false ? false : undefined,
    hide: meta.hide || undefined,
  };
}

const HEADER = ['url', 'company', 'title', 'location', 'first_seen', 'last_seen', 'status', 'posted'];
/** Reads a legacy scan-history.tsv into Map(url -> row), in file order (the legacy Map insertion order). */
export function readHistory(file) {
  const map = new Map();
  if (!existsSync(file)) return map;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const head = lines[0].split('\t');
  const cols = head[0] === 'url' ? head : HEADER;
  for (const line of lines.slice(head[0] === 'url' ? 1 : 0)) {
    if (!line.trim()) continue;
    const v = line.split('\t');
    const row = {};
    cols.forEach((c, i) => { row[c] = v[i] ?? ''; });
    map.set(row.url, row);
  }
  return map;
}

// The description part of a saved job file (crawl.mjs jdBody: a "- First seen:" header block, a blank line, then the text).
export function jdBody(text) {
  const i = text.indexOf('\n- First seen:');
  const end = i < 0 ? -1 : text.indexOf('\n\n', i + 1);
  return end < 0 ? text : text.slice(end + 2);
}

/**
 * Facts from a legacy data folder. opts: { history (Map, else read from <dir>/scan-history.tsv), simhash (object, else
 * <dir>/simhash-cache.v2.json), jdDir (default <dir>/jd), isAggregator(row, board) (apply links are read for aggregator rows only, as
 * crawl.mjs loadApplyKeys), fpWhen(row, board, t, op) (whether the fingerprint was known at that record: the legacy crawl matched a
 * new row only on the description its list answer carried, and read the saved descriptions of older rows; op 'refresh' asks again later), keptFor(row, board, t) -> { kept, hide } | null (a board-specific
 * verdict, or one that changed over time) }. kept: the legacy row is not filtered or extra.
 */
export function legacyFacts(dir, { history = null, simhash = null, jdDir = join(dir, 'jd'), isAggregator = () => false, fpWhen = () => true, keptFor = null } = {}) {
  const hist = history ?? readHistory(join(dir, 'scan-history.tsv'));
  let sim = simhash;
  if (!sim) { try { sim = JSON.parse(readFileSync(join(dir, 'simhash-cache.v2.json'), 'utf8')); } catch { sim = {}; } }
  const facts = (rec) => {
    const url = rec?.posting?.url;
    const row = url ? hist.get(url) : null;
    if (!row) return { ...defaultFacts(rec), kept: true };
    let applyText;
    const known = fpWhen(row, rec.board, rec.t, rec.op);   // the description (fingerprint and apply links) is known at this record
    if (known && isAggregator(row, rec.board)) {
      const f = join(jdDir, jdFileName(url));
      if (existsSync(f)) { try { applyText = jdBody(readFileSync(f, 'utf8')); } catch { /* unreadable: no apply links */ } }
    }
    const hidden = row.status === 'filtered' || row.status === 'extra';
    const own = keptFor?.(row, rec.board, rec.t);            // a board-specific verdict (e.g. an aggregator's "shadowed by the employer ATS")
    const kept = own ? own.kept : !hidden;
    return { company: row.company || undefined, fp: known ? (sim[url] || undefined) : undefined, applyText, kept, hide: kept ? undefined : (own?.hide ?? row.status) };
  };
  facts.history = hist;
  facts.simhash = sim;
  return facts;
}
