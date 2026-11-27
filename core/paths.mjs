// Where the new path keeps its own state (phase-1 review, item 3): never inside the crawl's data folder and never inside a git work tree,
// because a data folder is swept into commits on some hosts (the PC's run-daily.ps1 runs `git add -A -- Research/scan`).
// Default home: JOBCRAWL_HOME, else $XDG_STATE_HOME/jobcrawl, else ~/.local/state/jobcrawl. Per data folder a sub-folder named by a hash
// of the data folder's path keeps two crawls apart: <home>/<kind>/<name>-<hash>.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';

export class PlacementError extends Error {}

export function stateHome(env = process.env) {
  if (env.JOBCRAWL_HOME) return resolve(env.JOBCRAWL_HOME);
  return join(env.XDG_STATE_HOME ? resolve(env.XDG_STATE_HOME) : join(homedir(), '.local', 'state'), 'jobcrawl');
}

const inside = (child, parent) => { const r = relative(resolve(parent), resolve(child)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

/** The git work tree a path lies in (the folder holding .git), or null. Walks up from the path (or its nearest existing parent). */
export function gitTreeOf(p) {
  let d = resolve(p);
  for (;;) {
    if (existsSync(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Throws PlacementError when dir is inside dataDir or inside a git work tree. Returns the resolved dir. */
export function checkPlacement(dir, dataDir, what = 'store') {
  const d = resolve(dir);
  if (dataDir && inside(d, dataDir)) throw new PlacementError(`${what} ${d} is inside the crawl data folder ${resolve(dataDir)}; put it outside (JOBCRAWL_HOME or an explicit path)`);
  const g = gitTreeOf(d);
  if (g) throw new PlacementError(`${what} ${d} is inside the git work tree ${g}; put it outside (JOBCRAWL_HOME or an explicit path)`);
  return d;
}

/** The default folder of one kind (shadow, http-cache) for a crawl data folder, outside it. */
export function defaultDir(kind, dataDir, env = process.env) {
  const tag = `${basename(resolve(dataDir)).replace(/[^\w.-]+/g, '_') || 'data'}-${createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 10)}`;
  return join(stateHome(env), kind, tag);
}
