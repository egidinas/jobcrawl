import test from 'node:test';
import assert from 'node:assert/strict';
import { photonicsTitleSplit } from '../providers.mjs';

test('a dash never names the employer', () => {
  for (const t of ['Team Lead – Manufacturing (m/f/x)', 'Systems Engineer – Integrated Products (d/​m/​f)',
    'Validation Engineer - SOA area', 'Mechanical Engineering Co-op – Winter/Spring 2027', 'Technical Operations Specialist – Rijswijk']) {
    const r = photonicsTitleSplit(t, 'Join our team in Rijswijk. Manufacturing and SOA area work.');
    assert.equal(r.company, null, t);
    assert.equal(r.title, t.replace(/​/g, ''));
  }
});

test('"title | employer" names the employer when the description does', () => {
  const r = photonicsTitleSplit('Team Lead/Lead Engineer – Optical Engineering | NTS Optel', 'About NTS Optel: we build optical modules.');
  assert.deepEqual(r, { title: 'Team Lead/Lead Engineer – Optical Engineering', company: 'NTS Optel' });
});

test('a pipe part that is not an employer stays in the title', () => {
  for (const [t, d] of [['Collaborative R&D | Photonics, Superconducting & RF Technologies', 'photonics, superconducting & rf technologies'],
    ['Engineer | Photonic Systems (all genders)', 'photonic systems (all genders)'], ['Engineer | Acme Lasers', 'no employer named here']]) {
    assert.equal(photonicsTitleSplit(t, d).company, null, t);
  }
});
