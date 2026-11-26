// The pure parts of the free-text search through the Worker (match.js): which text may leave the browser, the request body, and
// the translation of the answer into the panel's result shape (order kept; null = the browser search runs).
//   node --test jobcrawl/web/tests/search_api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { apiQueryLike, apiSearchBody, fromApiAnswer, API_TIMEOUT_MS, API_QUERY_MAX } from '../assets/match.js';

const ix = { scopes: ['a', 'b'], attrs: [[3, 2, 0, 0], [3, 2, 0, 0], [1, 2, 0, 0], [3, 5, 0, 0], [3, 2, 0, 0], [3, 2, 0, 0]], dupKey: [-1, -1, -1, -1, 7, 7], dupSize: [1, 1, 1, 1, 2, 2] };
const idToRow = new Map([['0000000000000000', 0], ['1111111111111111', 1], ['2222222222222222', 2], ['3333333333333333', 3], ['4444444444444444', 4], ['5555555555555555', 5]]);
const ans = (ids, extra = {}) => ({ route: 'nuc_mixed', results: ids.map((j, n) => ({ job_id: String(j).repeat(16), score: 1 - n / 10 })), ...extra });

test('which text may leave the browser: one short line only, never a CV', () => {
  assert.equal(apiQueryLike('systems engineer'), true);
  assert.equal(apiQueryLike('  Wärmeplaner Raumfahrt '), true);
  assert.equal(apiQueryLike('ab'), false);
  assert.equal(apiQueryLike(''), false);
  assert.equal(apiQueryLike(null), false);
  assert.equal(apiQueryLike('line one\nline two'), false);
  assert.equal(apiQueryLike('x '.repeat(30)), false);                       // more than 20 words
  assert.equal(apiQueryLike('a'.repeat(API_QUERY_MAX + 1)), false);
  assert.equal(apiQueryLike('Curriculum vitae of an invented person. '.repeat(10)), false);   // a pasted CV
});

test('request body: model, kind, trimmed text, page language (de or en only), top_k', () => {
  assert.deepEqual(apiSearchBody('  thermal  ', 'de'), { model: 'atlas_v3', text: 'thermal', kind: 'query', lang: 'de', top_k: 50 });
  assert.equal(apiSearchBody('x', 'fr').lang, 'en');
  assert.equal(API_TIMEOUT_MS, 3000);
});

test('answer: the order of the service is kept', () => {
  const r = fromApiAnswer(ans([3, 1, 0]), ix, idToRow, { minLevel: 0, maxLevel: 99 });
  assert.deepEqual(r.results.map((x) => x.i), [3, 1, 0]);
  assert.equal(r.viaNuc, true); assert.equal(r.results[0].dense, true); assert.ok(r.results[0].score > r.results[2].score);
});

test('fallback (null) when it is not the keyword-mixed answer, empty, malformed or unknown to the index', () => {
  assert.equal(fromApiAnswer(null, ix, idToRow), null);
  assert.equal(fromApiAnswer({ results: [{ job_id: '0'.repeat(16), score: 1 }] }, ix, idToRow), null);             // no route: Vectorize answer or old Worker
  assert.equal(fromApiAnswer({ ...ans([0]), route: 'vectorize' }, ix, idToRow), null);
  assert.equal(fromApiAnswer({ route: 'nuc_mixed', results: [] }, ix, idToRow), null);
  assert.equal(fromApiAnswer({ route: 'nuc_mixed' }, ix, idToRow), null);
  assert.equal(fromApiAnswer(ans(['9']), ix, idToRow), null);                                                         // no row of ours
});

test('the panel filters apply: scope, level range, one row per twin group, per employer cap, unknown ids skipped', () => {
  assert.deepEqual(fromApiAnswer(ans([2, 0]), ix, idToRow, { scope: 1 }).results.map((x) => x.i), [0]);          // row 2 is not in scope 1
  assert.deepEqual(fromApiAnswer(ans([3, 0]), ix, idToRow, { maxLevel: 3 }).results.map((x) => x.i), [0]);        // row 3 is level 5
  const t = fromApiAnswer(ans([4, 5, 0]), ix, idToRow);
  assert.deepEqual(t.results.map((x) => x.i), [4, 0]); assert.equal(t.results[0].also, 1);                       // twins fold, the count is kept
  const co = (i) => (i < 2 ? 'acme' : 'other' + i);
  assert.deepEqual(fromApiAnswer(ans([0, 1, 3]), ix, idToRow, { perEmployer: 1, companyOf: co }).results.map((x) => x.i), [0, 3]);
  assert.deepEqual(fromApiAnswer(ans(['9', 1]), ix, idToRow).results.map((x) => x.i), [1]);
});

test('the panel wires the on-device choice and the kill switch (source check)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../assets/match-panel.js', import.meta.url), 'utf8');
  assert.match(src, /const plain = !useModel && textSearchOn\(\) && apiQueryLike\(text\)/);        // a visitor who chose or cached the model stays on the device
  assert.match(src, /const textSearchOn = \(\) => cfg\.text_search_api !== false && window\.MADE_B2_TEXT_SEARCH !== false/);
  assert.match(src, /if \(!textSearchOn\(\)\) return null;/);
  assert.equal((src.match(/\+ 'search'/g) || []).length, 1);                                         // one call site of the Worker
  const prof = JSON.parse(readFileSync(new URL('../../../jobcrawl-profile/profile.json', import.meta.url), 'utf8'));
  assert.equal(prof.web.text_search_api, true);
});
