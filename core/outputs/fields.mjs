// Outputs (row 2A.2): the field allowlist and the normalised record every renderer reads.
// Two inputs give the same record shape: the per-board delta stream (delta/v1 events, snapshot postings) and the resolved/v1 stream.
// Private fields are refused, never emitted: the renderers build each row from the allowlist, never by copying the source record.

import { EXCERPT_CHARS, excerptOf, stripHtml } from '../text.mjs';

/** Every field an output may carry. `description` is the full text and only comes with an explicit --fields that names it. */
export const ALLOWED_FIELDS = ['title', 'company', 'location', 'url', 'date_posted', 'first_seen', 'last_seen', 'status', 'boards', 'excerpt', 'description'];
/** Default: title, company, location, url, dates and an excerpt (design 3.6; never the full description). */
export const DEFAULT_FIELDS = ['title', 'company', 'location', 'url', 'date_posted', 'first_seen', 'excerpt'];
export { EXCERPT_CHARS, excerptOf };

/** Names that belong to the private layer (fit scoring, personal notes). Refused even when asked for. */
const PRIVATE = /(^|[_\-.])(match|fit|score|scores|verdict|keyword|keywords|rating|ratings|private|notes?|contacts?|salary|rank|ranking)([_\-.]|$)/i;

export class FieldError extends Error {}

/** Parses a --fields list ("title,url,excerpt") into the allowlisted fields. Throws FieldError for a private or unknown name. */
export function parseFields(spec) {
  if (spec == null || spec === true || spec === '') return [...DEFAULT_FIELDS];
  const names = String(spec).split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) return [...DEFAULT_FIELDS];
  const out = [];
  for (const n of names) {
    if (PRIVATE.test(n)) throw new FieldError(`field "${n}" is private and is never emitted`);
    if (!ALLOWED_FIELDS.includes(n)) throw new FieldError(`unknown field "${n}" (allowed: ${ALLOWED_FIELDS.join(', ')})`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

const placeOf = (p) => (Array.isArray(p.jobLocation) ? p.jobLocation : p.jobLocation ? [p.jobLocation] : [])
  .map((l) => l?.address?.name ?? l?.name ?? [l?.address?.addressLocality, l?.address?.addressCountry].filter(Boolean).join(', ')).filter(Boolean).join('; ');

/** A posting/v1 (snapshot row or delta event posting) as a normalised record. */
export function fromPosting(p, extra = {}) {
  const jc = p.jobcrawl ?? {};
  const description = p.description ? stripHtml(p.description) : '';
  return { id: jc.id, title: p.title ?? '', company: p.hiringOrganization?.name ?? p.hiringOrganization ?? jc.board ?? '', location: placeOf(p), url: p.url ?? '',
    date_posted: p.datePosted ?? '', first_seen: jc.first_seen ?? '', last_seen: jc.last_seen ?? '', status: jc.status ?? '', boards: jc.board ? [jc.board] : [],
    description, excerpt: jc.excerpt ?? (description ? excerptOf(description) : ''), ...extra };
}

/** A resolved/v1 record as a normalised record (the resolver carries no description). */
export function fromResolved(r, extra = {}) {
  return { id: r.id, title: r.title ?? '', company: r.company ?? '', location: r.location ?? '', url: r.url ?? '', date_posted: '', first_seen: r.first_seen ?? '', last_seen: '',
    status: r.status ?? '', boards: r.boards ?? [], description: '', excerpt: r.excerpt ?? '', ...extra };
}

/** The row to emit: id plus the allowlisted fields, in the requested order. Empty values become null so rows stay uniform. */
export function project(rec, fields) {
  const row = { id: rec.id };
  for (const f of fields) row[f] = rec[f] === '' || rec[f] === undefined ? null : rec[f];
  return row;
}
