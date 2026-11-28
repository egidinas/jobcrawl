// jobcrawl ledger-shadow: per-cycle same-fetch parity of the shadow store into the ledger; each legacy fetch counts once; three
// consecutive passes make a board eligible for the cut-over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyRun } from '../delta/board-delta.mjs';
import { commitRun, openBoard } from '../state/board-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NO_NET = join(mkdtempSync(join(tmpdir(), 'jcx-nonet4-')), 'nonet.mjs');
writeFileSync(NO_NET, "globalThis.fetch = () => { process.exit(99); };\nimport dns from 'node:dns'; dns.lookup = () => { process.exit(99); };\n");
const cli = (args) => spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(NO_NET).href, join(ROOT, 'cli', 'jobcrawl.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, JOBCRAWL_ROUTING: '' }, input: '' });
const U = (n) => `https://boards.greenhouse.io/acme/jobs/${n}`;

test('ledger-shadow records one pass per legacy fetch; three in a row make the board eligible; a mismatch resets it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcx-ls-'));
  const store = join(dir, 'store'), lcFile = join(dir, 'state.json'), ledger = join(dir, 'ledger.json'), routing = join(dir, 'routing.json');
  writeFileSync(routing, JSON.stringify({ schema: 'routing/v1', providers: { greenhouse: 'shadow' } }));
  writeFileSync(join(dir, 'companies.json'), JSON.stringify({ tracked_companies: [{ name: 'Acme', provider: 'greenhouse', slug: 'acme' }] }));
  const cycle = (k, shadowUrls, legacyUrls) => {
    const fetchAt = Date.UTC(2026, 10, 28, k, 0, 0), readAt = fetchAt + 15 * 60000;   // the hook runs after the crawl, ~15 min later
    const r = applyRun(openBoard(store, 'Acme'), { ok: true, items: shadowUrls.map((u) => ({ url: u, title: 'T' })) }, { board: 'Acme', now: new Date(readAt) });
    commitRun(store, 'Acme', r.state, r.events);
    writeFileSync(lcFile, JSON.stringify({ urls: Object.fromEntries(legacyUrls.map((u) => [u, ['Acme', '2026-11-28', 0, fetchAt]])) }));
    const out = cli(['ledger-shadow', '--shadow', store, '--lifecycle', lcFile, '--ledger', ledger, '--routing', routing, '--companies', join(dir, 'companies.json'), '--json']);
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  mkdirSync(store, { recursive: true });
  let r = cycle(1, [U(1), U(2)], [U(1), U(2)]);
  assert.deepEqual(r.verdicts, { pass: 1 });
  // the same fetch again: not recorded twice
  const again = cli(['ledger-shadow', '--shadow', store, '--lifecycle', lcFile, '--ledger', ledger, '--routing', routing, '--json']);
  assert.equal(JSON.parse(again.stdout).recorded, 0);
  r = cycle(2, [U(1), U(2), U(3)], [U(1), U(2), U(3)]);
  assert.equal(r.ledger.eligible, 0);
  r = cycle(3, [U(1), U(3)], [U(1), U(3)]);
  assert.equal(r.ledger.eligible, 1, 'three consecutive same-fetch passes');
  const L = JSON.parse(readFileSync(ledger, 'utf8'));
  assert.equal(L.boards.Acme.route, 'shadow', 'provider route from --companies');
  r = cycle(4, [U(1)], [U(1), U(9)]);
  assert.deepEqual(r.verdicts, { fail: 1 });
  assert.equal(r.ledger.eligible, 0, 'a mismatch resets eligibility');
});
