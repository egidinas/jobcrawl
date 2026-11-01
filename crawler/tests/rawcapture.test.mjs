// Raw capture: every text response is stored once per content and indexed; the caller still reads the response; errors and
// binary bodies are not stored; a POST body is kept in the index for replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installRawCapture, rawCaptureStats } from '../rawcapture.mjs';

test('raw capture stores bodies once, indexes every response and leaves responses readable', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/jobs.json') { res.setHeader('content-type', 'application/json'); res.end('{"jobs":[{"id":1,"content":"<p>Build <b>rockets</b></p>"}]}'); }
    else if (req.url === '/job.html') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<h2>About the role</h2><ul><li>Test</li></ul>'); }
    else if (req.url === '/gql') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(`{"echo":${JSON.stringify(b)}}`); }); }
    else if (req.url === '/logo.png') { res.setHeader('content-type', 'image/png'); res.end(Buffer.from([137, 80, 78, 71])); }
    else { res.statusCode = 404; res.setHeader('content-type', 'text/html'); res.end('missing'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'rawcap-'));
  assert.equal(installRawCapture(dir), true);
  try {
    const j1 = await (await fetch(`${base}/jobs.json`)).json();
    const j2 = await (await fetch(`${base}/jobs.json`)).json();           // same content again: one object, two index lines
    assert.equal(j1.jobs[0].id, 1);
    assert.deepEqual(j1, j2);
    assert.match(await (await fetch(`${base}/job.html`)).text(), /About the role/);
    const g = await (await fetch(`${base}/gql`, { method: 'POST', body: '{"query":"{ jobs { id } }"}' })).json();
    assert.match(g.echo, /jobs/);
    assert.equal((await fetch(`${base}/missing`)).status, 404);
    assert.equal((await (await fetch(`${base}/logo.png`)).arrayBuffer()).byteLength, 4);
  } finally {
    server.close();
  }
  const day = readdirSync(join(dir, 'index'))[0];
  const lines = readFileSync(join(dir, 'index', day), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 4, 'json twice, html, post; not the 404 or the png');
  assert.deepEqual(lines.map((l) => l.new), [true, false, true, true]);
  assert.equal(lines[0].sha256, lines[1].sha256);
  assert.equal(lines[3].method, 'POST');
  assert.match(lines[3].req, /jobs \{ id \}/);
  const obj = join(dir, 'objects', lines[0].sha256.slice(0, 2), `${lines[0].sha256}.gz`);
  assert.match(gunzipSync(readFileSync(obj)).toString(), /<b>rockets<\/b>/, 'the HTML inside the JSON is kept as received');
  const s = rawCaptureStats();
  assert.equal(s.responses, 4);
  assert.equal(s.new, 3);
  assert.equal(s.skipped, 2);
  assert.equal(s.errors, 0);
});
