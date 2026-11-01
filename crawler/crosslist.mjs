// Decides whether two postings are the same role listed twice (direct ATS plus aggregator, or a reposted requisition).
// A similar job description alone is not enough: one employer reuses the same boilerplate for different roles
// (Die Attach / Wire Bond / Assembly process engineers) and for the same role in different cities, and a search must
// keep those. Two postings are one role only when the description fingerprints match AND the titles match AND the
// employer matches (or one side is an aggregator that may name the employer differently) AND the places overlap.
import { isDuplicate } from './fingerprint.mjs';
import { postingKey, textPostingKeys, keysMatch } from './postingkey.mjs';

const UMLAUT_RE = /[äöüßÄÖÜ]/g;
const UMLAUT_MAP = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss', 'Ä': 'ae', 'Ö': 'oe', 'Ü': 'ue' };
const norm = (s) => String(s ?? '').replace(UMLAUT_RE, (ch) => UMLAUT_MAP[ch] || ch).replace(/[\u2011\u2013\u2014]/g, '-').replace(/\u00a0/g, ' ').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

const GENDER_TAGS = /\(?\b(?:[mwfdxg]\s*\/\s*){1,3}[mwfdxgn]\b\)?|\(?\ball genders\)?|\(?\bgn\b\)?|\(?\bdiv(?:erse)?\b\)?/g;
export const canonTitle = (t) => norm(t).replace(GENDER_TAGS, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/ {2,}/g, ' ');

const tokens = (s) => new Set(s.split(" ").filter(Boolean));
// A level word on one side only means a different role (Senior vs. non-senior, Head of vs. Manager).
const LEVEL = new Set(["senior", "sr", "staff", "principal", "lead", "head", "director", "junior", "jr", "intern", "vp", "chief", "manager", "associate", "ii", "iii", "iv"]);
function titleMatch(a, b) {
  const x = canonTitle(a), y = canonTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const tx = tokens(x), ty = tokens(y);
  for (const t of LEVEL) if (tx.has(t) !== ty.has(t)) return false;
  let both = 0;
  for (const t of tx) if (ty.has(t)) both++;
  return both / (tx.size + ty.size - both) >= 0.8;
}

const LEGAL = new Set(['gmbh', 'mbh', 'ag', 'se', 'kg', 'co', 'pte', 'ltd', 'limited', 'llc', 'l', 'c', 'inc', 'corp', 'corporation', 'sa', 'sas', 'srl', 'sarl', 'bv', 'nv', 'ab', 'oy', 'plc', 'gesellschaft']);
const canonCache = new Map();
export function canonCompany(c) {
  const key = String(c ?? '');
  if (canonCache.has(key)) return canonCache.get(key);
  const out = canonCompanyUncached(key);
  canonCache.set(key, out);
  return out;
}
// One employer under several registered names (the catalogue's `aliases`): the long forms collapse onto the short canonical name so the
// strict sameEmployer test ("a star" vs "a star research entities", "mda" vs "mda space") sees one employer. Exact canonical forms only.
const EMPLOYER_ALIAS = new Map([
  ['a star research entities', 'a star'], ['a star agency for science technology and research', 'a star'], ['agency for science technology and research', 'a star'],
  ['mda space', 'mda'], ['mda space ltd', 'mda'],
  ['national university of singapore nus', 'national university of singapore'],
  ['nanyang technological university ntu', 'nanyang technological university'],
  ['pangea propulsion', 'pangea aerospace'],
  ['sii germany', 'sii deutschland'],
  ['dsi aerospace technologie', 'dsi aerospace'],
  ['vast space', 'vast'],
  ['magazino jungheinrich robotics', 'magazino'],
  ['bundesamt fuer kartographie und geodaesie bkg', 'bundesamt fuer kartographie und geodaesie'],
  ['deutsches zentrum fuer luft und raumfahrt', 'dlr'],
  ['euspa european union agency for the space programme', 'euspa'],
]);
function canonCompanyUncached(c) {
  const t = norm(String(c ?? '').replace(/\s*\(via [^)]*\)\s*$/i, '')).replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !LEGAL.has(w)).join(' ');
  return EMPLOYER_ALIAS.get(t) ?? t;
}
// "anduril" and "anduril industries" are the same employer: one name is a whole-word prefix of the other.
function sameCompany(a, b) {
  const x = canonCompany(a), y = canonCompany(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y + ' ') || y.startsWith(x + ' ');
}

// Strict identity for the "employer ATS is ground truth" rule, which drops roles: equal canonical names, or one name is a prefix of the other
// where the prefix is at least five characters and only generic words follow ("ohb" and "ohb system" qualify only through the longer
// base; "apex" must not swallow "apex group"). Looser matching stays with sameCompany for deciding cross-listings.
const HARMLESS = new Set(['system', 'systems', 'space', 'group', 'technologies', 'technology', 'industries', 'international', 'aerospace', 'defence', 'defense', 'deutschland', 'germany', 'europe', 'holding']);
export function sameEmployer(a, b) {
  const x = canonCompany(a), y = canonCompany(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 5 || !long.startsWith(short + ' ')) return false;
  return long.slice(short.length + 1).split(' ').every((w) => HARMLESS.has(w));
}

const REGION_WORDS = new Set(["europe", "emea", "worldwide", "global", "anywhere", "international"]);
const MODE_WORDS = new Set(["remote", "hybrid", "onsite", "on site"]);
// Countries and regions say little on their own: Berlin and Munich are both "Germany" but are different postings.
const GENERIC = new Set(["germany", "deutschland", "bavaria", "bayern", "united states", "usa", "us", "united kingdom", "uk", "netherlands", "france", "italy", "spain", "portugal", "finland", "switzerland", "austria", "slovenia", "poland", "greece", "belgium", "luxembourg", "denmark", "sweden", "norway", "uae", "united arab emirates", "japan", "taiwan", "china", "australia", "new zealand", "india", "canada"]);
const CITY_ALIAS = { munchen: "munich", muenchen: "munich", koln: "cologne", nurnberg: "nuremberg" };
function placeSegments(loc) {
  return norm(loc).split(/[,;/|]|\band\b/).map((p) => p.replace(/\b(?:greater|area|region|metropolitan|bei|near)\b/g, ' ').replace(/[^a-z? ]+/g, ' ').trim().replace(/ {2,}/g, ' ')).filter(Boolean).map((p) => CITY_ALIAS[p] ?? p);
}
export function locationsOverlap(a, b) {
  const x = placeSegments(a).filter((p) => !MODE_WORDS.has(p)), y = placeSegments(b).filter((p) => !MODE_WORDS.has(p));
  if (!x.length || !y.length || x.includes("?") || y.includes("?")) return true;
  if (x.every((p) => REGION_WORDS.has(p)) || y.every((p) => REGION_WORDS.has(p))) return true;
  const sx = x.filter((p) => !GENERIC.has(p)), sy = y.filter((p) => !GENERIC.has(p));
  if (sx.length && sy.length) return sx.some((p) => sy.includes(p));
  return x.some((p) => y.includes(p));
}

/** A cheap grouping key for "probably the same role" when no description is at hand: employer, title and first specific place. */
export function listingKey(row) {
  const segs = placeSegments(row.location).filter((p) => !MODE_WORDS.has(p));
  return `${canonCompany(row.company)}|${canonTitle(row.title)}|${segs.find((p) => !GENERIC.has(p) && !REGION_WORDS.has(p)) ?? segs[0] ?? ''}`;
}

/** Names of the aggregator boards in companies.json, and the "(via X)" suffix the providers add to employer names. */
// eures: the EURES portal aggregates the national public employment services, so its copy of a role an employer lists on its own ATS
// is a cross-listing (providers-eures.mjs suffixes employers "(via EURES)").
export const AGGREGATOR_PROVIDERS = new Set(['spacecareers', 'spacecapital', 'spaceindividuals', 'jobsinphotonics', 'mycareersfuture', 'linkedin', 'eures']);
export const isAggregatorRow = (row, boardNames) => /\(via /i.test(row.company ?? '') || boardNames.has(row.company);

// Posting-id rule. The keys of a row are its URL's key plus the keys of employer-ATS apply links found in its description (aggregator rows only).
const applyKeys = new WeakMap();
/** Remember the ATS apply links an aggregator row's description names. Returns how many keys were found. */
export function setApplyKeys(row, text) {
  const ks = textPostingKeys(text);
  if (ks.length) applyKeys.set(row, ks); else applyKeys.delete(row);
  return ks.length;
}
const keyCache = new Map();
const cachedKey = (url) => {
  if (typeof url !== 'string') return null;
  if (keyCache.has(url)) return keyCache.get(url);
  if (keyCache.size > 100000) keyCache.clear();
  const k = postingKey(url);
  keyCache.set(url, k);
  return k;
};
export const rowPostingKeys = (row) => {
  const own = cachedKey(row?.url);
  const extra = (row && applyKeys.get(row)) || [];
  return own ? [own, ...extra] : extra;
};
/** The same posting on the same ATS (exact id, see postingkey.mjs), one copy an aggregator's and the other the employer's own. */
export function samePostingId(rowA, rowB, boardNames = new Set()) {
  if (isAggregatorRow(rowA, boardNames) === isAggregatorRow(rowB, boardNames)) return false;
  const ka = rowPostingKeys(rowA);
  if (!ka.length) return false;
  const kb = rowPostingKeys(rowB);
  const sameTitle = canonTitle(rowA.title) !== '' && canonTitle(rowA.title) === canonTitle(rowB.title);
  return ka.some((a) => kb.some((b) => keysMatch(a, b, sameTitle)));
}

/**
 * Same role listed twice? `fpA`/`fpB` are the description fingerprints (fingerprint.mjs); rows are history rows.
 * Same employer is required unless one side is an aggregator.
 * An aggregator copy and the employer's own ATS posting with the same exact posting id (postingkey.mjs) are the same role
 * whatever the descriptions and places say; fingerprints may then be empty.
 */
export function isCrossListing(fpA, rowA, fpB, rowB, boardNames) {
  if (samePostingId(rowA, rowB, boardNames)) return true;
  if (!fpA || !fpB) return false;
  if (!isDuplicate(fpA, fpB)) return false;
  if (!titleMatch(rowA.title, rowB.title)) return false;
  if (!(sameCompany(rowA.company, rowB.company) || isAggregatorRow(rowA, boardNames) || isAggregatorRow(rowB, boardNames))) return false;
  return locationsOverlap(rowA.location, rowB.location);
}
