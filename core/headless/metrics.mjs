// Opt-in metrics and health endpoint: Prometheus text on /metrics, health/v1 JSON on /health. Off unless --metrics is given.
// Binds 127.0.0.1 unless a host is named explicitly; never serves anything but these two read-only paths.
import { createServer } from 'node:http';

export const HEALTH_SCHEMA = 'health/v1';
const ESC = { '\\': '\\\\', '"': '\\"', '\n': '\\n' };
const esc = (v) => String(v).replace(/[\\"\n]/g, (c) => ESC[c]);
const lbl = (o) => { const e = Object.entries(o); return e.length ? `{${e.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : ''; };

/** "9464", ":9464" or "host:9464" -> { host, port }; the host defaults to 127.0.0.1. Throws on a bad port. */
export function parseListen(spec) {
  const m = /^(?:(\[[^\]]+\]|[^:]*):)?(\d+)$/.exec(String(spec ?? '').trim());
  if (!m) throw new Error(`--metrics expects [host]:port (got "${spec}")`);
  const port = Number(m[2]);
  if (port > 65535) throw new Error(`--metrics port out of range: ${port}`);
  return { host: (m[1] || '127.0.0.1').replace(/^\[|\]$/g, ''), port };
}

/** In-memory counters and gauges shared by the run loop and the endpoint. */
export function createMetrics({ now = () => Date.now() } = {}) {
  const runs = new Map();   // "provider\0cls" -> count
  const m = { startedAt: now(), up: 1, stopping: false, postingsOpen: 0, nextDueAt: null, lastCycleAt: null,
    cycle: { id: null, status: 'idle', total: 0, done: 0, failed: 0, failedBoards: [] }, aiTokens: 0 };
  return {
    state: m,
    boardRun(provider, cls) { const k = `${provider ?? 'unknown'}\0${cls}`; runs.set(k, (runs.get(k) ?? 0) + 1); },
    set(k, v) { m[k] = v; },
    setCycle(c) { Object.assign(m.cycle, c); },
    prometheus() {
      const L = [];
      const g = (name, help, type, rows) => { L.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`); for (const [labels, v] of rows) L.push(`${name}${lbl(labels)} ${v}`); };
      g('jobcrawl_up', '1 while the process is running', 'gauge', [[{}, m.stopping ? 0 : 1]]);
      g('jobcrawl_board_runs_total', 'board runs by source and outcome class (ok or the error class)', 'counter',
        [...runs].map(([k, v]) => { const [source, cls] = k.split('\0'); return [{ source, cls }, v]; }));
      g('jobcrawl_postings_open', 'open postings in the store after the last committed board', 'gauge', [[{}, m.postingsOpen]]);
      g('jobcrawl_cycle_boards', 'boards in the current cycle by state', 'gauge',
        [[{ state: 'total' }, m.cycle.total], [{ state: 'done' }, m.cycle.done], [{ state: 'failed' }, m.cycle.failed]]);
      g('jobcrawl_last_cycle_timestamp_seconds', 'unix time the last cycle ended', 'gauge', [[{}, m.lastCycleAt ? Math.round(m.lastCycleAt / 1000) : 0]]);
      if (m.nextDueAt != null) g('jobcrawl_board_next_due_seconds', 'seconds until the next cycle (daemon)', 'gauge', [[{}, Math.max(0, Math.round((m.nextDueAt - now()) / 1000))]]);
      g('jobcrawl_ai_tokens_total', 'AI hook tokens used (0 while no AI hook is configured)', 'counter', [[{}, m.aiTokens]]);
      return L.join('\n') + '\n';
    },
    health() {
      const status = m.stopping ? 'stopping' : m.cycle.failed ? 'degraded' : 'ok';
      return { schema: HEALTH_SCHEMA, status, pid: process.pid, started: new Date(m.startedAt).toISOString(), uptime_s: Math.round((now() - m.startedAt) / 1000),
        cycle: { ...m.cycle, failedBoards: m.cycle.failedBoards.slice(0, 20) }, last_cycle_end: m.lastCycleAt ? new Date(m.lastCycleAt).toISOString() : null };
    },
  };
}

/** Starts the server. Returns { port, host, close() }. */
export async function serveMetrics(metrics, { host = '127.0.0.1', port }) {
  const srv = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }).end(); return; }
    if (path === '/health') { const h = metrics.health(); res.writeHead(h.status === 'stopping' ? 503 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(h)); }
    else if (path === '/metrics') res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }).end(metrics.prometheus());
    else res.writeHead(404).end();
  });
  await new Promise((ok, bad) => { srv.once('error', bad); srv.listen(port, host, ok); });
  return { host, port: srv.address().port, close: () => new Promise((ok) => { srv.close(() => ok()); srv.closeAllConnections?.(); }) };
}
