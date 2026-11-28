# Running jobcrawl headless

`jobcrawl run` is the unattended command of the new per-board path: no prompts, no UI, no AI in the loop. It reads every board that the
routing sends to `shadow` or `new`, commits each board's deltas to its own store, and can be stopped and restarted at any time.
The live crawl (`crawler/run.mjs`) is not touched by any of this.

```sh
jobcrawl run --profile ./my-board --data /var/lib/jobcrawl --routing routing.json --max-minutes 10 --log-format json
```

Configuration is flags or environment: `JOBCRAWL_PROFILE`, `JOBCRAWL_DATA`, `JOBCRAWL_ROUTING`, `JOBCRAWL_LOG_DIR`, `JOBCRAWL_LOG_FORMAT`
(a flag wins over the variable). A board routed `legacy` (the default, and always when `JOBCRAWL_ROUTE_KILL=1`) is not read.
The data folder must not be a legacy crawl folder (`scan-history.tsv`, `crawl-state.json`).

## Never prompts

`jobcrawl` has no interactive path. A command that lacks a required input fails with exit 2 and names the flag
(`--profile <dir> (or JOBCRAWL_PROFILE) is required`). A closed or absent stdin changes nothing. `--help`, `help` and a call with no
arguments print the usage and exit 0 before any network or file work.

## Exit codes

| code | meaning |
|---|---|
| 0 | ok (also: nothing was due, or the `--max-minutes` budget ended the run and the cycle stays open) |
| 1 | some boards failed (per board in the log and in `run-state.json`) |
| 2 | usage or config error |
| 3 | lock held by another run (`run.lock`, or a board lease for `crawl`/`import`) |
| 4 | state store error (unreadable store, disk full, SQLite lease database or `store.sqlite` busy/locked, wrong `--store` for the folder) |
| 5 | `--strict` health alert (`zero-jobs`, `board-stale`, no boards routed) |
| 130 | interrupted by SIGINT, state consistent |
| 143 | terminated by SIGTERM, state consistent |

With several conditions at once the first row of this order wins: 4, 143/130, 1, 5. In systemd units list `143 130` (and for a
timer-started oneshot `1`) under `SuccessExitStatus=`.

## Stop, restart, resume

- **SIGTERM / SIGINT** stop the run gracefully: the requests in flight are aborted, the board in flight is discarded (its store is not
  touched, so no half-applied read), the lock is released, and the process exits 143 (130). A second signal exits at once.
- **Progress** is kept in `<data>/run-state.json` (replaced atomically after every board). The next `run` continues the open cycle with the
  boards not yet done (`"resumed": true` in the result and the `cycle-start` log line); a finished cycle is followed by a new one.
- **`--max-minutes N`**: no new board starts after N minutes; the cycle stays open and the next start continues it (exit 0).
- **`--every-min N`**: do nothing (exit 0, `not-due` in the log) while the last complete cycle ended less than N minutes ago.
  Together with a 10-minute timer this gives "one cycle per hour, resumed in slices".
- **Locks.** One `run.lock` per data folder (pid, host, expiry; renewed after every board). A dead pid on the same host or an expired lock
  is taken over, a live one gives exit 3. Per-board leases (`leases.sqlite`) still guard each board against another process.
- `--daemon [--interval-min N]` keeps one process looping: a cycle, then a sleep of N minutes (default 60), until a signal arrives.

## Logs

JSON lines, one object per line, flushed per line: `{"t":"2026-11-28T08:00:00.000Z","level":"info","event":"board","board":"Stripe","ok":true,"cls":"ok","ms":812,"open":143,...}`.

- `--log-format json|text` (default `text` on a terminal, `json` otherwise); `--log-file <file>` or `JOBCRAWL_LOG_DIR` (writes
  `<dir>/jobcrawl.jsonl`, and then nothing goes to stderr). Without a file the log goes to **stderr**; stdout stays free.
- `--json` prints one result object on stdout (`{"code":0,"cycle":...,"done":12,"failed":0,...}`) and nothing else.
- Events: `start`, `cycle-start`, `board`, `board-skipped`, `board-discarded`, `budget-hit`, `store-error`, `health-alert`, `signal`,
  `cycle-end`, `daemon-cycle`, `metrics-listening`, `lock-held`, `not-due`, `fatal`, `exit`.

## Health and metrics (opt-in)

`--metrics [host]:port` starts a read-only HTTP endpoint. Without a host it binds **127.0.0.1**; a host such as `0.0.0.0` must be written out.
Only `GET /health` and `GET /metrics` exist.

- `/health` returns `health/v1` JSON: `status` (`ok`, `degraded` when a board of the cycle failed, `stopping` with HTTP 503 during shutdown),
  pid, uptime, the cycle (`id`, `status`, `total`, `done`, `failed`, `failedBoards`) and the end of the last complete cycle.
- `/metrics` returns Prometheus text: `jobcrawl_up`, `jobcrawl_board_runs_total{source,cls}`, `jobcrawl_postings_open`,
  `jobcrawl_cycle_boards{state}`, `jobcrawl_last_cycle_timestamp_seconds`, `jobcrawl_board_next_due_seconds` (daemon),
  `jobcrawl_ai_tokens_total` (always 0 until an AI hook exists). `jobcrawl_bytes_total` is not exported yet: the readers do not count bytes.

In a oneshot run the endpoint lives only while the run does; use the daemon (or the log) for scraping.

## `--strict`

A complete cycle exits 5 when a board that had open postings now reads zero (`zero-jobs`), when a failing board has had no good read for
`--stale-hours` (default 48; `board-stale`), or when no board is routed at all.

## systemd

Examples in `examples/systemd/`:

- `jobcrawl.service`: the daemon (`Restart=on-failure`, `KillSignal=SIGTERM`, `TimeoutStopSec=60`, `MemoryMax=512M`, 143 counts as a clean stop).
  `systemctl --user enable --now jobcrawl.service`.
- `jobcrawl-due.service` + `jobcrawl-due.timer`: a oneshot slice every 10 minutes (`run --max-minutes 10 --every-min 55`) for hosts without a daemon.
  `systemctl --user enable --now jobcrawl-due.timer`.

Edit the three paths (`JOBCRAWL_PROFILE`, `JOBCRAWL_DATA`, `JOBCRAWL_ROUTING`) first. Run `jobcrawl doctor --profile ... --data ... --routing ... --strict` once to check the setup.

## Limits of this release

- Only the new per-board path is run; it does not replace the legacy crawl, and a live read needs the board routed `shadow` or `new`.
- No Dockerfile, alert actions (webhook, exec, flag file) or per-board schedules yet; use the exit code, `--strict` and the log.
- `--replay <recording>` runs from a recording instead of the network (tests, dry runs).
