# Outputs

Three renderers on top of the SQLite store: snapshot NDJSON, JSON Feed 1.1 and RSS 2.0. Code: `core/outputs/` (`fields.mjs` allowlist and records, `source.mjs` readers and bookmarks, `render.mjs` pure renderers). They are reached through `jobcrawl snapshot` and `jobcrawl feed` with `--format`. Without `--format` both commands behave as before.

```
jobcrawl snapshot --data <dir> --format ndjson|jsonfeed|rss [--from delta|resolved] [--status open|departed|all]
                  [--fields a,b] [--out <file>] [--title t] [--link url] [--feed-url url]
jobcrawl feed     --data <dir> --format ndjson|jsonfeed|rss [--from delta|resolved] [--after <cursor> | --consumer <name> [--commit]]
                  [--limit n] [--fields a,b] [--out <file>]
```

## Two streams

| `--from` | reads | cursor for `feed` |
| :-- | :-- | :-- |
| `delta` (default) | the per-board store: posting/v1 snapshot, delta/v1 events | global `event_id` |
| `resolved` | the resolver's resolved/v1 stream (`jobcrawl resolve` first) | resolver `seq` |

`snapshot` shows the current state (the latest resolved record of each id, for `resolved`). `feed` shows the additions after the cursor: added, changed and reappeared postings for `delta`, open records for `resolved`; the latest record of an id wins. Departures are not feed items.

## Bookmarks

`--consumer <name>` reads from the consumer's bookmark; `--commit` moves it to the last record read, after the output file is written. Without `--commit` nothing moves, so a failed publish can be repeated. The delta bookmark is the store's own (`jobcrawl bookmark`); the resolved cursor is kept under `<name>@resolved`, because a resolver `seq` is not an `event_id`. An empty read leaves the bookmark where it was.

## Fields

Default: `title, company, location, url, date_posted, first_seen, excerpt`, plus the stable `id` on every row. The excerpt is plain text, at most 1,200 characters, cut at a word boundary.

Allowed with `--fields`: `title company location url date_posted first_seen last_seen status boards excerpt description`. The full `description` is only emitted when `--fields` names it. Anything private (`match_score`, `fit_verdict`, `keywords`, ratings, notes, contacts, salary and similar names) or unknown makes the command exit 2 with nothing on stdout. Rows are built from the allowlist and never copied from the source record, so a private key on a source record cannot leak either.

Note: the store keeps a content hash, not the description, so rows from the current store have `excerpt: null` until a stage that stores descriptions exists. The `resolved` stream never carries one.

## Formats

- **ndjson**: a header line (`schema: outputs/v1`, `kind`, `from`, `fields`, `count`, `watermark`), then one row per record; feed rows carry `op`.
- **jsonfeed**: JSON Feed 1.1. `id` is the posting id, `authors[0].name` the company, `content_text` the excerpt (or description). Location, status, boards and the seen dates go under `_jobcrawl`.
- **rss**: RSS 2.0 with `dc:creator` (company), `category` (location), `guid isPermaLink="false"` (posting id) and `pubDate` (`date_posted`, else `first_seen`).

Items are newest first, ties by id. `lastBuildDate` is the newest item date, or the run time for an empty feed. The output depends only on the data and `--now <iso>` (default: the current time; the tests fix it), so the same input gives the same bytes.

## Tests

`core/tests/outputs.test.mjs`: field rules, the private-field refusal (CLI and renderers), golden files in `core/tests/golden/outputs/` for all three formats over both streams (`UPDATE_GOLDEN=1` rewrites them), bookmark behaviour, and an end-to-end run from an empty data folder to RSS. `--help` of both commands is covered by the no-network preload test in `route-cli.test.mjs`.
