// Retention of the full job descriptions (<data>/jd/<sha1(url)[:10]>.md). A description is removed once its role has not been seen for
// more than crawl.jd_keep_days days (default 90; 0 = keep forever): its history row is not 'open' (gone, dup, filtered, extra ...) and
// its last_seen is more than that many days before the run date. Open roles are never touched, files that belong to no history row
// are left alone, and nothing is removed when the history is empty. The history rows themselves are never changed here. Node 22, no network.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DAY = 864e5;

/** File name of a role's saved description: the first 10 hex digits of sha1(url) plus .md. */
export const jdFileName = (url) => createHash('sha1').update(url).digest('hex').slice(0, 10) + '.md';

/**
 * Removes the description files of roles not seen for more than keepDays days (dryRun: counts them and deletes nothing).
 * history: Map url -> row (as the crawler's loadHistory returns it); today: YYYY-MM-DD of the run.
 * Result: { removed: [{ name, bytes }], kept (.md files left in the folder), bytes (of the removed files), skipped ('' or why nothing was checked) }.
 */
export function cleanJd({ history, jdDir, keepDays, today, dryRun = false }) {
  const result = { removed: [], kept: 0, bytes: 0, skipped: '' };
  const files = existsSync(jdDir) ? readdirSync(jdDir).filter((n) => n.endsWith('.md')) : [];
  result.kept = files.length;
  if (!existsSync(jdDir)) return { ...result, skipped: 'no jd folder' };
  if (!(keepDays > 0)) return { ...result, skipped: 'jd_keep_days is 0: cleanup off' };
  if (!history || history.size === 0) return { ...result, skipped: 'history empty' };
  // A file name qualifies only when every history row with that name qualifies (names are hashes of the URL, so this is a safety net).
  const qualifies = new Map();
  for (const row of history.values()) {
    if (!row?.url) continue;
    const name = jdFileName(row.url);
    const old = /^\d{4}-\d{2}-\d{2}$/.test(row.last_seen ?? '') && (Date.parse(today) - Date.parse(row.last_seen)) / DAY > keepDays;
    qualifies.set(name, (qualifies.get(name) ?? true) && row.status !== 'open' && old);
  }
  for (const name of files) {
    if (qualifies.get(name) !== true) continue;
    const path = join(jdDir, name);
    try {
      const bytes = statSync(path).size;
      if (!dryRun) unlinkSync(path);
      result.removed.push({ name, bytes });
      result.bytes += bytes;
    } catch { /* could not be removed: it stays and is counted as kept */ }
  }
  result.kept = files.length - result.removed.length;
  return result;
}
