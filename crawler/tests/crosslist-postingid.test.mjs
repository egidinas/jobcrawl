// Posting-id rule of crosslist.mjs / postingkey.mjs.   Run: node --test crawler/tests/crosslist-postingid.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { postingKey, keysMatch, textPostingKeys } from '../postingkey.mjs';
import { isCrossListing, samePostingId, setApplyKeys } from '../crosslist.mjs';

const boards = new Set(['Space Capital']);
const agg = (url, title = 'Engineer', company = 'Acme (via Space Capital)', location = 'Berlin') => ({ url, company, title, location });
const dir = (url, title = 'Engineer', company = 'Acme', location = 'Berlin') => ({ url, company, title, location });
const same = (a, b) => samePostingId(a, b, boards);

test('postingKey: known vendors', () => {
  const k = (u) => { const x = postingKey(u); return x && `${x.vendor}|${x.ns}|${x.id}`; };
  assert.equal(k('https://amazon.jobs/jobs/10489336'), 'amazon|amazon|10489336');
  assert.equal(k('https://www.amazon.jobs/en/jobs/10489336/senior-optical-comm'), 'amazon|amazon|10489336');
  assert.equal(k('https://www.amazon.jobs/de-de/jobs/10489336/x'), 'amazon|amazon|10489336');
  assert.equal(k('https://boards.greenhouse.io/spacex/jobs/8656960002'), 'greenhouse|spacex|8656960002');
  assert.equal(k('https://job-boards.eu.greenhouse.io/arx/jobs/4996193101'), 'greenhouse|arx|4996193101');
  assert.equal(k('https://ionq.com/job?gh_jid=6005910004'), 'greenhouse||6005910004');
  assert.equal(k('https://jobs.lever.co/CesiumAstro/e92be773-e19c-4587-a591-945c8b84aab1'), 'lever|cesiumastro|e92be773-e19c-4587-a591-945c8b84aab1');
  assert.equal(k('https://jobs.ashbyhq.com/the-exploration-company/f14bf54e-8d41-4cd0-8b01-28222c342966'), 'ashby|the-exploration-company|f14bf54e-8d41-4cd0-8b01-28222c342966');
  assert.equal(k('https://micron.wd1.myworkdayjobs.com/External/job/San-Jose-CA/Senior-PCIe-Engineer_JR80373-1'), 'workday|micron|jr80373');
  assert.equal(k('https://turo.wd12.myworkdayjobs.com/en-US/Turo_careers/job/Arizona/Manager_R-102741'), 'workday|turo|r102741');
  assert.equal(k('https://jobs.smartrecruiters.com/CERN/744000154674740-some-title'), 'smartrecruiters|cern|744000154674740');
  assert.equal(k('https://blackwave.jobs.personio.de/job/2328102?language=en'), 'personio|blackwave|2328102');
  assert.equal(k('https://apply.workable.com/acme/j/499A922EF1/'), 'workable|acme|499a922ef1');
  assert.equal(k('https://apply.workable.com/j/499A922EF1'), 'workable||499a922ef1');
  assert.equal(k('https://dcubed.teamtailor.com/jobs/8381369-production-manager'), 'teamtailor|dcubed|8381369');
  assert.equal(k('https://join.com/companies/acme/1234567-some-role'), 'join|acme|1234567');
  assert.equal(k('https://astroscale.bamboohr.com/careers/665'), 'bamboohr|astroscale|665');
  assert.equal(k('https://iaziqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/UberCareers/requisitions/preview/1569'), 'oracle|iaziqy.fa.ocs.oraclecloud.com|1569');
  assert.equal(k('https://careers.edgegroup.ae/job/ARE-Senior-Engineer/733487622/'), 'successfactors|careers.edgegroup.ae|733487622');
  assert.equal(k('https://careers.stengg.com/job/Electrical-System-Design-Engineer/13022-en_GB/'), 'successfactors|careers.stengg.com|13022');
  assert.equal(k('https://recruiting.ultipro.ca/MAC5000MCDW/JobBoard/664818ff-3594-4bec-9f30-3394e59e19f3/OpportunityDetail?opportunityId=0a1b2c3d-1111-2222-3333-444455556666'), 'ultipro|mac5000mcdw|0a1b2c3d-1111-2222-3333-444455556666');
  assert.equal(k('https://careers-soitec.icims.com/jobs/3448/facilities-senior-manager/job'), 'icims|careers-soitec.icims.com|3448');
  assert.equal(k('https://x.eightfold.ai/careers?pid=563012345&domain=x.com'), 'eightfold|x.eightfold.ai|563012345');
  assert.equal(k('https://renk-group.softgarden.io/job/60842722/Commercial-PM?jobDbPVId=1'), 'softgarden|renk-group.softgarden.io|60842722');
  assert.equal(k('https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=82153303-7d5a-4833-b767-9cb13&ccId=1&jobId=555'), 'adp|82153303-7d5a-4833-b767-9cb13|555');
});

test('postingKey: no key for unknown or id-less URLs', () => {
  for (const u of ['', 'not a url', 'https://example.com/jobs/123', 'https://amazon.jobs/en/search', 'https://www.amazon.jobs/content/en/how-we-hire/accommodations',
    'https://www.mycareersfuture.gov.sg/job/433f1124ba36afcfa1913a025db9f33e', 'https://boards.greenhouse.io/spacex', 'https://jobs.lever.co/acme', 'ftp://amazon.jobs/jobs/10489336'])
    assert.equal(postingKey(u), null, u);
});

test('aggregator copy and direct posting with the same id are the same role, even with different text and places', () => {
  const a = agg('https://amazon.jobs/jobs/10489336', 'Senior Optical Communication Engineer, Amazon Leo for Government', 'Amazon Leo (via Space Capital)', 'Redmond, WA, USA | Northridge, OH, USA');
  const d = dir('https://www.amazon.jobs/en/jobs/10489336/senior-optical-comm', 'Senior Optical Communication Engineer, Amazon Leo for Government', 'Amazon', 'Northridge, California');
  assert.ok(same(a, d) && same(d, a));
  assert.ok(isCrossListing('', a, '', d, boards));
  assert.ok(isCrossListing(undefined, d, undefined, a, boards));
  // company-site gh_jid vs Greenhouse board (strong id, no namespace on one side)
  assert.ok(same(agg('https://boards.greenhouse.io/spacex/jobs/8656960002', 'A'), dir('https://www.spacex.com/careers/job?gh_jid=8656960002', 'Totally different title')));
  // title is not needed for strong ids even when the aggregator title differs
  assert.ok(same(agg('https://jobs.lever.co/acme/e92be773-e19c-4587-a591-945c8b84aab1', 'X'), dir('https://jobs.lever.co/ACME/e92be773-e19c-4587-a591-945c8b84aab1', 'Y')));
});

test('negatives: same id on another vendor, other tenant, other namespace', () => {
  assert.equal(same(agg('https://amazon.jobs/jobs/4996193101'), dir('https://job-boards.eu.greenhouse.io/arx/jobs/4996193101')), false);
  assert.equal(same(agg('https://acme.bamboohr.com/careers/665', 'Engineer'), dir('https://other.bamboohr.com/careers/665', 'Engineer')), false);
  assert.equal(same(agg('https://a.wd1.myworkdayjobs.com/s/job/x/T_JR100'), dir('https://b.wd1.myworkdayjobs.com/s/job/x/T_JR100')), false);
  assert.equal(same(agg('https://boards.greenhouse.io/acme/jobs/8656960002'), dir('https://boards.greenhouse.io/other/jobs/8656960002')), false);
  assert.equal(same(agg('https://jobs.smartrecruiters.com/A/744000154674740'), dir('https://jobs.smartrecruiters.com/B/744000154674740')), false);
  assert.equal(same(agg('https://amazon.jobs/jobs/10489336'), dir('https://www.amazon.jobs/en/jobs/10489337/x')), false);
});

test('numeric per-tenant ids without a shared namespace need the same title', () => {
  const a = { vendor: 'icims', id: '3448', ns: '', strong: false }, b = { vendor: 'icims', id: '3448', ns: '', strong: false };
  assert.equal(keysMatch(a, b, false), false);
  assert.equal(keysMatch(a, b, true), true);
  assert.equal(keysMatch({ ...a, ns: 'x' }, { ...b, ns: 'y' }, true), false);
  assert.equal(keysMatch({ ...a, ns: 'x' }, { ...b, ns: 'x' }, false), true);
  assert.equal(keysMatch({ ...a, strong: true }, { ...b, strong: true }, false), true);
  // via URLs: the Workable short link has no company, so it relies on the shortcode being unique
  assert.equal(same(agg('https://apply.workable.com/j/499A922EF1', 'A'), dir('https://apply.workable.com/acme/j/499A922EF1/', 'B')), true);
  // Personio ids are per account: same number on two accounts never merges (namespaces differ)
  assert.equal(same(agg('https://a.jobs.personio.de/job/2328102', 'Same'), dir('https://b.jobs.personio.de/job/2328102', 'Same')), false);
});

test('only aggregator versus direct links; two direct rows or two aggregator rows are left to the old rules', () => {
  assert.equal(same(dir('https://amazon.jobs/jobs/10489336'), dir('https://www.amazon.jobs/en/jobs/10489336/x')), false);
  assert.equal(same(agg('https://amazon.jobs/jobs/10489336'), agg('https://www.amazon.jobs/en/jobs/10489336/x', 'E', 'Y (via Space-Careers)')), false);
  assert.equal(same({ company: 'Space Capital', title: 'E', url: 'https://amazon.jobs/jobs/10489336' }, dir('https://www.amazon.jobs/en/jobs/10489336/x')), true);
});

test('rows with no id match keep the old decision', () => {
  const a = agg('https://example.com/x/1', 'Process Engineer', 'Acme (via Space Capital)', 'Berlin'), d = dir('https://example.com/y/2', 'Process Engineer', 'Acme', 'Berlin');
  assert.equal(isCrossListing('', a, '', d, boards), false);              // no fingerprints, no ids: not a cross-listing
  assert.equal(isCrossListing('', a, 'abc', d, boards), false);
});

test('apply link in an aggregator description', () => {
  const a = agg('https://spaceindividuals.com/job/abc', 'Optics Engineer');
  const d = dir('https://job-boards.greenhouse.io/acme/jobs/7490266', 'Optics Engineer');
  assert.equal(same(a, d), false);
  assert.equal(setApplyKeys(a, 'Apply here: https://job-boards.greenhouse.io/acme/jobs/7490266. Benefits: https://amazon.jobs/en/benefits'), 1);
  assert.equal(same(a, d), true);
  assert.deepEqual(textPostingKeys('no links, https://example.com/a'), []);
  setApplyKeys(a, '');
  assert.equal(same(a, d), false);
});
