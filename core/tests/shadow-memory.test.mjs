// Regression test for the 2026-11-28 heap incident: the armed crawl ran out of its ~2.1 GB heap at saveHistory because the shadow input
// pinned the crawl's whole history and every board's answer. The probe builds a production-size picture (500,000 history rows, 5,000
// boards with descriptions) under the crawl's effective heap limit and measures the capture, the release and the hook's peak.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('shadow capture keeps a few MB, does not pin the crawl objects, and the hook peak stays small (500k-row history, 2096 MB heap)', () => {
  const r = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=2096', '--no-warnings', join(ROOT, 'bench', 'shadow-heap-probe.mjs'), '--synthetic', '500000'],
    { encoding: 'utf8', timeout: 240000 });
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout.trim().split('\n').at(-1));
  console.log(`heap probe: ${JSON.stringify(m)}`);
  assert.equal(m.routed_boards, 40); assert.equal(m.shadowed, 40); assert.equal(m.failed, 0); assert.equal(m.low_memory, 0);
  assert.ok(m.capture_retained_mb < 25, `capture retained ${m.capture_retained_mb} MB`);
  assert.ok(m.released_mb >= 0.7 * m.picture_mb, `released ${m.released_mb} MB of a ${m.picture_mb} MB picture: the capture must not pin the crawl's objects`);
  assert.ok(m.hook_peak_delta_mb < 64, `hook peak +${m.hook_peak_delta_mb} MB`);
});
