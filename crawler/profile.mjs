// Profile loader for the crawler. A profile is a folder with a profile.json (every key: profiles/schema.md) and the files it names.
//
//   --profile <dir>            or the environment variable JOBCRAWL_PROFILE=<dir>
//
// Relative paths in profile.json are resolved against the profile folder. The crawler reads only the crawl keys here.
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export class ProfileError extends Error {}

/** The profile folder named on the command line (--profile <dir>) or in JOBCRAWL_PROFILE, or null. */
export function profileDirFromArgs(args, env = process.env) {
  const i = args.indexOf('--profile');
  if (i >= 0) {
    const v = args[i + 1];
    if (!v || v.startsWith('--')) throw new ProfileError('--profile needs a folder, e.g. --profile profiles/minimal');
    return v;
  }
  return env.JOBCRAWL_PROFILE || null;
}

const strList = (v, key) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ProfileError(`${key} must be a list of strings`);
  return v;
};
const obj = (v, key) => {
  if (v === undefined) return {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ProfileError(`${key} must be an object`);
  return v;
};

/**
 * Loads <dir>/profile.json. Returns null when no folder is given. Throws ProfileError naming the key that is wrong.
 * Result: { dir, file, name, companiesFile, catalogueFile, relevance: {keywords, negative, ssic_deeptech}, titleFilter, locationFilter, dataDir, raw }
 *   titleFilter / locationFilter are null unless the profile sets them (then they replace the filters in companies.json).
 */
export function loadProfile(dirArg) {
  if (!dirArg) return null;
  const dir = resolve(dirArg);
  const file = resolve(dir, 'profile.json');
  if (!existsSync(file)) throw new ProfileError(`no profile.json in ${dir}`);
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new ProfileError(`${file}: not valid JSON (${e.message})`); }
  obj(raw, 'profile.json');
  if (raw.name !== undefined && typeof raw.name !== 'string') throw new ProfileError('name must be a string');
  if (raw.data_dir !== undefined && typeof raw.data_dir !== 'string') throw new ProfileError('data_dir must be a string');
  const crawl = obj(raw.crawl, 'crawl');
  const rel = obj(crawl.relevance, 'crawl.relevance');
  if (crawl.companies_file !== undefined && typeof crawl.companies_file !== 'string') throw new ProfileError('crawl.companies_file must be a string');
  if (crawl.catalogue_file !== undefined && typeof crawl.catalogue_file !== 'string') throw new ProfileError('crawl.catalogue_file must be a string');
  return {
    dir,
    file,
    name: raw.name ?? basename(dir),
    companiesFile: resolve(dir, crawl.companies_file ?? 'companies.json'),
    catalogueFile: crawl.catalogue_file ? resolve(dir, crawl.catalogue_file) : null,
    relevance: {
      keywords: strList(rel.keywords, 'crawl.relevance.keywords'),
      negative: strList(rel.negative, 'crawl.relevance.negative'),
      ssic_deeptech: strList(rel.ssic_deeptech, 'crawl.relevance.ssic_deeptech'),
    },
    titleFilter: crawl.title_filter ?? null,
    locationFilter: crawl.location_filter ?? null,
    dataDir: raw.data_dir ? resolve(dir, raw.data_dir) : null,
    raw,
  };
}

/** Data folder: --data <dir>, else the profile's data_dir, else ./data (relative to the working directory). */
export function resolveDataDir(dataArg, profile) {
  if (dataArg) return resolve(dataArg);
  if (profile?.dataDir) return profile.dataDir;
  return resolve('data');
}

/** The companies.json config with the profile's title/location filters applied when the profile sets them. */
export function applyProfileFilters(cfg, profile) {
  if (!profile) return cfg;
  return {
    ...cfg,
    ...(profile.titleFilter ? { title_filter: profile.titleFilter } : {}),
    ...(profile.locationFilter ? { location_filter: profile.locationFilter } : {}),
  };
}
