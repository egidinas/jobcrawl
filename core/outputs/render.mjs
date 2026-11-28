// Outputs (row 2A.2): the renderers. Pure functions from normalised records to text; no clock, no I/O.
// Order is the order of the records given (the readers sort them), so the same input gives the same bytes.
import { project } from './fields.mjs';

export const FORMATS = ['ndjson', 'jsonfeed', 'rss'];
export const OUTPUT_SCHEMA = 'outputs/v1';

const when = (rec) => {
  const s = rec.date_posted || rec.first_seen;
  if (!s) return null;
  const d = new Date(/^\d{4}-\d\d-\d\d$/.test(s) ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
};
const xml = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Newest first by publication date, ties by id: stable whatever order the reader produced. */
const newestFirst = (records) => [...records].sort((a, b) => ((when(b)?.getTime() ?? 0) - (when(a)?.getTime() ?? 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const bodyOf = (row) => row.description ?? row.excerpt ?? null;

/** Snapshot or delta NDJSON: a header line, then one projected row per record. */
export function renderNdjson(records, { fields, from, kind = 'snapshot', watermark = {}, now }) {
  const head = { schema: OUTPUT_SCHEMA, kind, from, t: now.toISOString(), fields, count: records.length, watermark };
  return [head, ...records.map((r) => ({ ...project(r, fields), ...(r.op ? { op: r.op } : {}) }))].map((o) => JSON.stringify(o) + '\n').join('');
}

/** JSON Feed 1.1. Newest first. Location and the other non-standard fields go under `_jobcrawl`. */
export function renderJsonFeed(records, { fields, title = 'jobcrawl postings', link = null, feedUrl = null, now }) {
  const items = newestFirst(records).map((r) => {
    const row = project(r, fields);
    const d = when(r);
    const text = bodyOf(row);
    const ext = {};
    for (const f of ['location', 'status', 'boards', 'last_seen', 'first_seen']) if (f in row && row[f] != null) ext[f] = row[f];
    return { id: r.id, ...(row.url ? { url: row.url } : {}), ...('title' in row ? { title: row.title ?? '' } : {}), ...(text ? { content_text: text } : {}),
      ...(d ? { date_published: d.toISOString() } : {}), ...(row.company ? { authors: [{ name: row.company }] } : {}), ...(Object.keys(ext).length ? { _jobcrawl: ext } : {}) };
  });
  const feed = { version: 'https://jsonfeed.org/version/1.1', title, ...(link ? { home_page_url: link } : {}), ...(feedUrl ? { feed_url: feedUrl } : {}),
    _jobcrawl: { schema: OUTPUT_SCHEMA, generated: now.toISOString(), fields }, items };
  return JSON.stringify(feed, null, 2) + '\n';
}

/** RSS 2.0. Newest first; the company is dc:creator, the location a category; the guid is the stable posting id. */
export function renderRss(records, { fields, title = 'jobcrawl postings', link = 'https://example.invalid/', feedUrl = null, now, description = 'Job postings' }) {
  const rows = newestFirst(records);
  const dates = records.map(when).filter(Boolean).map((d) => d.getTime());
  const built = dates.length ? new Date(Math.max(...dates)) : now;
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">', '<channel>',
    `<title>${xml(title)}</title>`, `<link>${xml(link)}</link>`, `<description>${xml(description)}</description>`,
    ...(feedUrl ? [`<atom:link href="${xml(feedUrl)}" rel="self" type="application/rss+xml"/>`] : []),
    `<lastBuildDate>${built.toUTCString()}</lastBuildDate>`, '<generator>jobcrawl</generator>'];
  for (const r of rows) {
    const row = project(r, fields), d = when(r), text = bodyOf(row);
    lines.push('<item>', `<title>${xml(row.title ?? '')}</title>`, ...(row.url ? [`<link>${xml(row.url)}</link>`] : []),
      `<guid isPermaLink="false">${xml(r.id)}</guid>`, ...(d ? [`<pubDate>${d.toUTCString()}</pubDate>`] : []),
      ...(row.company ? [`<dc:creator>${xml(row.company)}</dc:creator>`] : []), ...(row.location ? [`<category>${xml(row.location)}</category>`] : []),
      ...(text ? [`<description>${xml(text)}</description>`] : []), '</item>');
  }
  lines.push('</channel>', '</rss>');
  return lines.join('\n') + '\n';
}

export function render(format, records, opts) {
  if (format === 'ndjson') return renderNdjson(records, opts);
  if (format === 'jsonfeed') return renderJsonFeed(records, opts);
  if (format === 'rss') return renderRss(records, opts);
  throw new Error(`unknown format "${format}" (${FORMATS.join(', ')})`);
}
