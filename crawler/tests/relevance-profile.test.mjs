// Relevance lists taken from a profile: nothing is relevant without one, and each profile decides for itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { isRelevantText, isRelevantRole, seedVerdict, useRelevance } from '../relevance.mjs';
import { loadProfile } from '../profile.mjs';

const profileDir = (name) => fileURLToPath(new URL(`../../profiles/${name}`, import.meta.url));

test('no profile loaded: nothing is relevant', () => {
  useRelevance({});
  assert.equal(isRelevantText('Satellite Systems Engineer'), false);
  assert.equal(isRelevantText('Software Engineer'), false);
});

test('minimal profile: software roles relevant, aerospace ones not', () => {
  useRelevance(loadProfile(profileDir('minimal')).relevance);
  assert.equal(isRelevantText('Senior Software Engineer'), true);
  assert.equal(isRelevantText('Backend Developer (m/w/d)'), true);
  assert.equal(isRelevantText('Softwareentwickler Java'), true);
  assert.equal(isRelevantText('Werkstudent Software'), false);          // negative list wins
  assert.equal(isRelevantText('Account Executive, Software'), false);
  assert.equal(isRelevantText('Satellite Systems Engineer'), false);
  assert.equal(isRelevantRole({ title: 'Engineer', department: 'Software Platform' }), true);
  useRelevance({});
});

test('aerospace profile: the reference lists, incl. word: and German entries', () => {
  useRelevance(loadProfile(profileDir('aerospace')).relevance);
  assert.equal(isRelevantText('Space Engineer'), true);
  assert.equal(isRelevantText('Workspace Manager'), false);             // word:space does not match inside a word
  assert.equal(isRelevantText('Prüfer Luftfahrt'), true);               // accent-insensitive German entries
  assert.equal(isRelevantText('Search Engine Specialist'), false);      // negative list
  assert.equal(isRelevantText('Software Engineer'), false);
  useRelevance({});
});

test('seeding gate (ported from catalogue-gate.test.mjs): sector signal decides', () => {
  useRelevance(loadProfile(profileDir('aerospace')).relevance);
  assert.equal(seedVerdict('SILITH TECHNOLOGY PTE. LTD.', [{ title: 'Photonics Engineer' }]), null);
  assert.equal(seedVerdict('ACME PTE. LTD.', [{ title: 'Accountant' }]), 'no sector signal');
  assert.equal(seedVerdict('RECRUIT EXPERT PTE. LTD.', [{ title: 'Optics Engineer' }]), 'recruitment agency (name)');
  useRelevance({});
});
