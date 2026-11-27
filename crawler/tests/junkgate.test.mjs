// Junk gate for probation boards (crawler/junkgate.mjs) on list answers shaped like the 2026-11-27 calibration boards, the probation
// hold and the profile switch. No network.   Run: node --test crawler/tests/junkgate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { junkVerdict } from '../junkgate.mjs';
import { probationCycle, newProbation } from '../relevance.mjs';
import { loadProfile } from '../profile.mjs';

const list = (titles, path = (i) => `/page-${i}`) => titles.map((title, i) => ({ title, url: `https://www.acme.example${path(i)}` }));
const PL = { provider: 'paginated_list' };

test('junk: product and navigation pages are held', () => {
  const products = junkVerdict(list(['Map Builder', 'Mobile apps', 'Live Data Maps', 'Data & Content', 'Pricing', 'Customer stories']), PL);
  assert.equal(products.hold, true);
  assert.match(products.reasons.join(), /not_job_like/);
  const projects = junkVerdict(list(['Climate Tipping Points: quantification of tipping potential Visit project', 'Past to Future: palaeo-informed projections Visit project', 'Carbon Farming decision support Visit project']), PL);
  assert.equal(projects.hold, true);
  assert.match(projects.reasons.join(), /junk_titles/);
  const sheets = junkVerdict(list(['Data sheet.pdf', 'Data sheet.pdf', 'Data sheet.pdf', 'Spectrometer S1']), PL);
  assert.equal(sheets.hold, true);
});

test('good: job lists pass, in English, French, Swedish and German, with or without job tokens in the URLs', () => {
  const fr = junkVerdict(list(['Technicien MRO H/F – Auch', 'Electricien cableur aeronautique H/F', 'Manutentionnaire composites H/F', 'Chargé(e) de Projets Méthodes H/F']), PL);
  assert.equal(fr.hold, false, fr.reasons.join());
  const en = junkVerdict(list(['Spontaneous Application', 'Junior Legal Specialist', 'Warehouse Technician', 'Junior Accounting Specialist']), PL);
  assert.equal(en.hold, false, en.reasons.join());
  const se = junkVerdict(list(['CNC-operatör (svarv)', 'Maskinoperatör inom plåtbearbetning', 'Produktionstekniker', 'Säljare'], (i) => `/jobb/${i}`), PL);
  assert.equal(se.hold, false, se.reasons.join());
  const de = junkVerdict(list(['Gruppenleiter*in Integration', 'Bauingenieur*in Modernisierung', 'Kundenberater:in', 'Wissenschaftler (all genders)'], (i) => `/stellen/${i}`), PL);
  assert.equal(de.hold, false, de.reasons.join());
});

test('ATS boards and short answers are never judged', () => {
  assert.equal(junkVerdict(list(['Map Builder', 'Mobile apps', 'Live Data Maps', 'Pricing']), { provider: 'greenhouse' }).hold, false);
  assert.equal(junkVerdict(list(['Map Builder', 'Mobile apps']), PL).hold, false);
});

test('probation: in hold mode a junk board is not promoted by a relevant title; in report mode it is', () => {
  const held = probationCycle(newProbation('2026-11-27'), { ok: true, total: 5, relevant: 1, irrelevant: 4, now: '2026-11-27', junkHold: 'not_job_like (20 %)' });
  assert.equal(held.state, 'probation');
  assert.equal(held.junk_hold, 'not_job_like (20 %)');
  const promoted = probationCycle(held, { ok: true, total: 5, relevant: 1, irrelevant: 4, now: '2026-11-28', junkHold: '' });
  assert.equal(promoted.state, 'promoted');
  assert.equal(promoted.junk_hold, undefined);
});

test('profile: crawl.junk_gate defaults to report and is checked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-junk-'));
  try {
    const write = (crawl) => { writeFileSync(join(dir, 'profile.json'), JSON.stringify({ crawl })); return loadProfile(dir); };
    assert.equal(write({}).junkGate, 'report');
    assert.equal(write({ junk_gate: 'hold' }).junkGate, 'hold');
    assert.throws(() => write({ junk_gate: 'yes' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
