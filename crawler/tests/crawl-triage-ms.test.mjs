// Triage rows carry the fetch duration (2026-11-25, fix/breaker-per-host C): a real crawl against a local HTTP server, one fast board,
// one board slower than its own budget (timeout_ms) and one board that answers 404. No network beyond 127.0.0.1.
// Also the chain rules: a slow or failing board never stops the crawl (R2), and each one is counted in the triage rows (R3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SLOW_MS = 2500;

const page = (title) => `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'JobPosting', title, datePosted: '2026-11-20',
  description: `<p>We are hiring a ${title} in Berlin.</p>`,
  jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Berlin', addressCountry: 'DE' } },
})}</script></head><body>${title}</body></html>`;

function serve() {
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const m = req.url.match(/^\/(fast|slow)\/(sitemap\.xml|job\/1)$/);
    if (!m) { res.statusCode = 404; return res.end('missing'); }
    const answer = () => {
      if (m[2] === 'sitemap.xml') { res.setHeader('content-type', 'application/xml'); return res.end(`<?xml version="1.0"?><urlset><url><loc>${base}/${m[1]}/job/1</loc></url></urlset>`); }
      res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(page('Systems Engineer'));
    };
    if (m[1] === 'slow' && m[2] === 'sitemap.xml') setTimeout(answer, SLOW_MS); else answer();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const crawl = (args, lifecycle = '') => new Promise((done) => {
  const p = spawn(process.execPath, [resolve(ROOT, 'crawler/crawl.mjs'), ...args], { cwd: ROOT, env: { ...process.env, JOBCRAWL_PROFILE: '', JOBCRAWL_RAW_DIR: '', MADE_LIFECYCLE: lifecycle } });
  let stdout = '', stderr = '';
  p.stdout.on('data', (c) => (stdout += c)); p.stderr.on('data', (c) => (stderr += c));
  p.on('close', (status) => done({ status, stdout, stderr }));
});

for (const lifecycle of ['', 'shadow']) test(`triage rows (lifecycle ${lifecycle || 'off'}): ms (first attempt) and budget_ms per fetched board; a slow and a failing board are counted and do not stop the crawl`, async () => {
  const server = await serve();
  const dir = mkdtempSync(join(tmpdir(), 'jobcrawl-triage-ms-'));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const prof = join(dir, 'profile'), data = join(dir, 'data'), out = join(dir, 'triage.jsonl');
    mkdirSync(prof, { recursive: true }); mkdirSync(data, { recursive: true });
    writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 'fixture', crawl: { companies_file: 'companies.json' } }));
    writeFileSync(join(prof, 'companies.json'), JSON.stringify({
      title_filter: { positive: ['Engineer'], negative: [], seniority_boost: [] },
      location_filter: { allow: ['Berlin'], block_hard: [], allow_unknown: true },
      tracked_companies: [
        { name: 'Fast Co', provider: 'sitemap', slug: `${base}/fast/sitemap.xml`, url_pattern: '/job/' },
        { name: 'Slow Co', provider: 'sitemap', slug: `${base}/slow/sitemap.xml`, url_pattern: '/job/', timeout_ms: 800 },
        { name: 'Gone Co', provider: 'sitemap', slug: `${base}/gone/sitemap.xml`, url_pattern: '/job/' },
      ],
    }));
    const r = await crawl(['--profile', prof, '--data', data, '--triage-out', out], lifecycle);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const rows = Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((t) => [t.board, t]));
    assert.deepEqual(Object.keys(rows).sort(), ['Fast Co', 'Gone Co', 'Slow Co'], 'every board has a triage row');
    assert.equal(rows['Fast Co'].cls, 'OK'); assert.equal(rows['Fast Co'].budget_ms, 35000);
    assert.ok(Number.isInteger(rows['Fast Co'].ms) && rows['Fast Co'].ms >= 0 && rows['Fast Co'].ms < SLOW_MS, JSON.stringify(rows['Fast Co']));
    // the slow board ran into its own budget: its duration is the budget (not the server's delay), the class as before
    assert.equal(rows['Slow Co'].cls, 'TIMEOUT_TLS'); assert.equal(rows['Slow Co'].code, 'timeout'); assert.equal(rows['Slow Co'].budget_ms, 800);
    assert.ok(rows['Slow Co'].ms >= 800 && rows['Slow Co'].ms < SLOW_MS, JSON.stringify(rows['Slow Co']));
    assert.ok(Number.isInteger(rows['Gone Co'].ms) && rows['Gone Co'].cls !== 'OK', JSON.stringify(rows['Gone Co']));
    // the other boards were not held up: the good board's posting is in the history
    assert.match(readFileSync(join(data, 'scan-history.tsv'), 'utf8'), /\/fast\/job\/1\tFast Co\tSystems Engineer/);
    assert.match(r.stdout, /^Scanned 1\/3 companies/m);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
