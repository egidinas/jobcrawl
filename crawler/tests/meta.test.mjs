import test from 'node:test';
import assert from 'node:assert/strict';
import { metaOf } from '../providers.mjs';

test('metaOf keeps what the board states and drops empty values', () => {
  assert.equal(metaOf({ departments: [], teams: [''], remote: null }), undefined);
  assert.deepEqual(metaOf({ departments: ['R&D', 'R&D'], employment: ' FullTime ', remote: false, hybrid: true }), { departments: 'R&D', employment: 'FullTime', hybrid: true });
  assert.deepEqual(metaOf({ custom: [['Region', 'EMEA']] }), { custom: ['Region: EMEA'] });
});
