// The provider registry: every provider is defined once (a second definition of a key in an object literal silently replaces the
// first, which is how four dead copies, join, concludis, factorial and oraclecloud, sat in providers.mjs until 2026-11-07), every
// entry has detect() and fetch(), and the README's provider table is the one scripts/provider_table.mjs generates from the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providers } from '../providers.mjs';
import { providerTable, README_BEGIN, README_END } from '../../scripts/provider_table.mjs';

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function literalKeys(text, opener) {
  const start = text.indexOf(opener);
  assert.ok(start >= 0, `${opener} not found`);
  const end = text.indexOf('\n};', start);
  const keys = [...text.slice(start, end).matchAll(/^ {2}'?([\w-]+)'?: \{/gm)].map((m) => m[1]);
  assert.ok(keys.length > 5, `${opener}: too few keys parsed (${keys.length})`);
  return keys;
}
const dups = (keys) => keys.filter((k, i) => keys.indexOf(k) !== i);

test('providers.mjs defines each provider once', () => {
  assert.deepEqual(dups(literalKeys(src('../providers.mjs'), 'export const providers = {')), []);
});

test('every registered provider has detect() and fetch()', () => {
  for (const [id, p] of Object.entries(providers)) {
    assert.equal(typeof p.detect, 'function', `${id}.detect`);
    assert.equal(typeof p.fetch, 'function', `${id}.fetch`);
  }
});

test('the README provider table is generated from the code (run: node scripts/provider_table.mjs --write)', async () => {
  const readme = src('../../README.md');
  const a = readme.indexOf(README_BEGIN), b = readme.indexOf(README_END);
  assert.ok(a >= 0 && b > a, 'README has the generated block markers');
  assert.equal(readme.slice(a + README_BEGIN.length, b).trim(), (await providerTable()).trim(),
    'README provider table is out of date: node scripts/provider_table.mjs --write');
});
