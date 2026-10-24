// node --test crawler/tests   (no network, no data dir; simulates cycles by calling the state-update function)
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { isRelevantText, isRelevantRole, probationCycle, newProbation, makeEmployerIndex, protectedFromHistory, strictVerdict, PROBATION_CYCLES, useRelevance } from '../relevance.mjs';
import { loadProfile } from '../profile.mjs';

// The relevance lists come from the reference profile (the tests below are written for it).
useRelevance(loadProfile(fileURLToPath(new URL('../../profiles/aerospace', import.meta.url))).relevance);

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok -', name); };
const cyc = (st, o) => probationCycle(st, { ok: true, total: 0, relevant: 0, irrelevant: 0, now: '2026-10-22', ...o });

ok('relevance list: titles', () => {
  for (const t of ['Satellite Systems Engineer', 'GNC Engineer', 'FPGA Developer', 'Luftfahrttechniker (m/w/d)', 'Prüfingenieur', 'Triebwerksmechaniker', 'RF Engineer', 'Photonics Engineer', 'Test Engineer', 'Fertigungsplaner', 'DO-178C Software Engineer'])
    assert.ok(isRelevantText(t), t);
  for (const t of ['Account Executive', 'Recruiter', 'Software Engineer', 'HR Business Partner', 'Search Engine Marketing Manager', 'Flight Attendant', 'Accountant'])
    assert.ok(!isRelevantText(t), t);   // "Engineer" must not match "engine"
  assert.ok(isRelevantRole({ title: 'Senior Manager', department: 'Space Systems' }));
  assert.ok(!isRelevantRole({ title: 'Senior Manager', department: 'Finance' }));
});

ok('(ii) irrelevant-only company is disabled at the 5th successful cycle, not before', () => {
  const st = newProbation('d');
  for (let i = 1; i <= 6; i++) {
    cyc(st, { total: 4, irrelevant: 4 });
    if (i < PROBATION_CYCLES) assert.equal(st.state, 'probation', `cycle ${i}`);
  }
  assert.equal(st.state, 'disabled'); assert.equal(st.probation_disabled, true); assert.equal(st.wrong_streak, 5);   // 6th cycle ignored once disabled
  assert.match(st.reason, /WRONG jobs/);
});

ok('(iii) zero jobs for 10 cycles is never pruned', () => {
  const st = newProbation('d');
  for (let i = 0; i < 10; i++) cyc(st, { total: 0 });
  assert.equal(st.state, 'probation'); assert.equal(st.wrong_streak, 0); assert.equal(st.cycles_ok, 0);
});

ok('empty and failed cycles neither count nor reset the streak', () => {
  const st = newProbation('d');
  for (let i = 0; i < 3; i++) cyc(st, { total: 2, irrelevant: 2 });
  cyc(st, { total: 0 }); cyc(st, { ok: false, total: 9, irrelevant: 9 }); cyc(st, { total: 0 });
  assert.equal(st.wrong_streak, 3); assert.equal(st.state, 'probation');
  cyc(st, { total: 1, irrelevant: 1 }); assert.equal(st.state, 'probation');
  cyc(st, { total: 1, irrelevant: 1 }); assert.equal(st.state, 'disabled');
});

ok('(i) one relevant role promotes; promoted is never pruned', () => {
  const st = newProbation('d');
  cyc(st, { total: 3, irrelevant: 3 }); cyc(st, { total: 3, irrelevant: 2, relevant: 1 });
  assert.equal(st.state, 'promoted');
  for (let i = 0; i < 20; i++) cyc(st, { total: 5, irrelevant: 5 });
  assert.equal(st.state, 'promoted'); assert.equal(st.probation_disabled, false);
});

ok('(iv) protected is promoted immediately and never pruned', () => {
  const st = newProbation('d');
  for (let i = 0; i < 12; i++) cyc(st, { total: 5, irrelevant: 5, protectedNow: true });
  assert.equal(st.state, 'protected'); assert.equal(st.wrong_streak, 0);
  const d = newProbation('d'); for (let i = 0; i < 5; i++) cyc(d, { total: 1, irrelevant: 1 });
  assert.equal(d.state, 'disabled'); cyc(d, { total: 1, irrelevant: 1, protectedNow: true }); assert.equal(d.state, 'protected');   // became protected later
});

ok('re-enable resets the streak', () => {
  const st = newProbation('d');
  for (let i = 0; i < 5; i++) cyc(st, { total: 1, irrelevant: 1 });
  assert.equal(st.state, 'disabled');
  st.reenable = true; cyc(st, { total: 1, irrelevant: 1 });
  assert.equal(st.state, 'probation'); assert.equal(st.wrong_streak, 1); assert.equal(st.reenable, undefined);
});

ok('protected set: aggregator suffixes count, MyCareersFuture does not', () => {
  const p = protectedFromHistory([{ company: 'OHB SE (via Space Individuals)' }, { company: 'Foo GmbH (via Jobs-in-Photonics)' }, { company: 'RN CARE PTE. LTD. (via MyCareersFuture)' }, { company: 'Plain Inc' }]);
  assert.deepEqual(p, ['OHB SE', 'Foo GmbH']);
});

ok('Singapore strict gate', () => {
  const idx = makeEmployerIndex(['A*STAR Research Entities', 'ST Engineering', 'Kratos Communications Singapore']);
  const job = (employer, title, extra = {}) => ({ title, company: `${employer} (via MyCareersFuture)`, sg: { employer, hiring: '', ssic: [], skills: [], onBehalf: false, ...extra } });
  assert.equal(strictVerdict(job('A*STAR RESEARCH ENTITIES', 'Accounts Executive'), idx), null);
  assert.equal(strictVerdict(job('ST ENGINEERING AEROSPACE LTD.', 'Planner'), idx), null);
  assert.ok(strictVerdict(job('RN CARE PTE. LTD.', 'Satellite Engineer'), idx));
  assert.ok(strictVerdict(job('RECRUIT EXPERT PTE. LTD.', 'Optics Engineer'), idx));
  assert.ok(strictVerdict(job('OAKTREE CONSULTING', 'RF Engineer'), idx));
  assert.ok(strictVerdict(job('ACME PTE. LTD.', 'RF Engineer', { ssic: ['78104'] }), idx));
  assert.ok(strictVerdict(job('ACME PTE. LTD.', 'RF Engineer', { onBehalf: true }), idx));
  assert.equal(strictVerdict(job('ACME PTE. LTD.', 'RF Engineer'), idx), null);                                  // relevant title
  assert.equal(strictVerdict(job('ACME PTE. LTD.', 'Accountant', { ssic: ['26110'] }), idx), null);             // semiconductor SSIC
  assert.ok(strictVerdict(job('ACME PTE. LTD.', 'Accountant', { ssic: ['56101'] }), idx));                      // restaurant
  assert.equal(strictVerdict(job('ACME PTE. LTD.', 'Accountant'), idx, 'off'), null);                           // per-entry override
});
console.log(`${n} tests passed`);
