// Free-space check for the crawler's data folder (profile key crawl.min_free_mb). A crawl that fills the disk leaves half-written
// files behind, so the crawler refuses to start below the limit. Node 22 only; no network.
import { statfsSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const MB = 1024 * 1024;

/** Free space in MB available to the user on the filesystem holding dir (the nearest existing parent when dir does not exist yet). */
export function freeMb(dir) {
  let p = resolve(dir);
  while (!existsSync(p)) {
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  const s = statfsSync(p);
  return (Number(s.bavail) * Number(s.bsize)) / MB;
}

/** null when the folder has at least minMb free (or minMb is 0); otherwise a message saying how much is free. */
export function checkDisk(dir, minMb) {
  if (!minMb) return null;
  const free = Math.floor(freeMb(dir));
  if (free >= minMb) return null;
  return `only ${free} MB free on ${resolve(dir)} (crawl.min_free_mb is ${minMb}): nothing crawled, free some space first`;
}
