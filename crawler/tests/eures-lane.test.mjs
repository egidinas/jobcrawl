// The EURES slow lane (crawler/eures-lane.mjs, providers-eures.mjs): the lane stores each board's answer, the crawl reads it and sends
// nothing to europa.eu; a missing or too old answer fails the board instead of serving stale roles; a partial answer marks nothing gone.
// No network: fetch is stubbed and must not be called.   Run: node --test crawler/tests/eures-lane.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eures, setEuresLane, writeLaneAnswer, readLaneAnswer, LANE_MAX_AGE_H } from '../providers-eures.mjs';

test('lane on: the crawl reads the stored answer, sends no request, refuses a missing or stale answer, keeps partial flags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-lane-'));
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('no network in this test'); };
  try {
    setEuresLane(dir);
    await assert.rejects(eures.fetch('radar|de', {}), /eures lane: no answer for this board yet/);
    const jobs = [{ title: 'Radar Engineer', url: 'https://europa.eu/eures/portal/jv-se/jv-details/abc', description: 'full text '.repeat(40) }];
    writeLaneAnswer(dir, 'radar|de', { name: 'EURES: radar', slug: 'radar|de', at: new Date().toISOString(), n: 1, incomplete: false, jobs });
    assert.deepEqual(readLaneAnswer(dir, 'radar|de').jobs, jobs);
    const got = await eures.fetch('radar|de', {});
    assert.equal(got.length, 1);
    assert.equal(got.incomplete, undefined);
    assert.equal(await eures.fetchDescription(got[0]), jobs[0].description, 'the full text of the search answer, no detail request');
    writeLaneAnswer(dir, 'sonar|de', { slug: 'sonar|de', at: new Date().toISOString(), incomplete: true, jobs });
    assert.ok((await eures.fetch('sonar|de', {})).incomplete, 'a partial lane answer stays partial (nothing marked gone)');
    writeLaneAnswer(dir, 'old|de', { slug: 'old|de', at: new Date(Date.now() - (LANE_MAX_AGE_H + 1) * 36e5).toISOString(), jobs });
    await assert.rejects(eures.fetch('old|de', {}), /newest answer is \d+ h old/);
    assert.equal(calls, 0, 'nothing was sent to europa.eu');
  } finally { setEuresLane(null); globalThis.fetch = real; rmSync(dir, { recursive: true, force: true }); }
});
