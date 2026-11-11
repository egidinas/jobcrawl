// Descriptions that the list call of a source does not carry: the Oracle Recruiting Cloud detail call, the UKG Pro (UltiPro) detail
// page, and the helpers that write a fetched text into the description store (crawler/jdclean.mjs). Invented texts only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { oracleDetailUrl, oracleDescriptionOf, ultiproDescriptionOf, pageDescriptionOf, providers } from '../providers.mjs';
import { jdBody, jdHeader, jdDocument, clipDescription, stripContactSection } from '../jdclean.mjs';

test('oraclecloud: the detail call of a posting is built from its URL and the board slug', () => {
  const api = 'https://acme.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22300001%22,siteNumber=CX_1';
  assert.equal(oracleDetailUrl('https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions/preview/300001/'), api);
  assert.equal(oracleDetailUrl('https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/300001/?utm=x'), api);
  // the slug of the board (origin|site) wins over what the URL says
  assert.equal(oracleDetailUrl('https://careers.acme.example/hcmUI/CandidateExperience/de/sites/Other/job/300001', 'https://acme.fa.us2.oraclecloud.com|CX_1'), api);
  assert.equal(oracleDetailUrl('https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions'), '', 'a list page has no posting id');
  assert.equal(oracleDetailUrl(''), '');
  assert.equal(typeof providers.oraclecloud.fetchDescription, 'function', 'the crawl and the backfill use the detail call');
});

test('oraclecloud: the answer gives the posting text, then responsibilities and qualifications', () => {
  const json = { items: [{ Id: '300001', Title: 'Thermal Engineer',
    ShortDescriptionStr: 'Thermal design of satellite structures.',
    ExternalDescriptionStr: '<p>You own the thermal design of a satellite platform &amp; its payload.</p><ul><li>Analysis</li><li>Test</li></ul>',
    ExternalResponsibilitiesStr: '<p>Run the thermal balance test campaign.</p>',
    ExternalQualificationsStr: '<p>Degree in aerospace engineering.</p>',
    CorporateDescriptionStr: '<p>About the company.</p>' }] };
  const t = oracleDescriptionOf(json);
  assert.match(t, /^You own the thermal design of a satellite platform & its payload\./);
  assert.match(t, /Analysis[\s\S]*Test/);
  assert.match(t, /\n\nResponsibilities\nRun the thermal balance test campaign\.\n\nQualifications\nDegree in aerospace engineering\.$/);
  assert.ok(!t.includes('<') && !t.includes('About the company'));
  // only the short description is filled
  assert.equal(oracleDescriptionOf({ items: [{ ShortDescriptionStr: '<b>Short</b> text.' }] }), 'Short text.');
  // not found, an error answer, nothing
  assert.equal(oracleDescriptionOf({ items: [] }), '');
  assert.equal(oracleDescriptionOf({}), '');
  assert.equal(oracleDescriptionOf(null), '');
});

test('ultipro: the posting text is read from the script object of the detail page', () => {
  const posting = '<p>You integrate the avionics of a launch vehicle upper stage.</p><p>Requirements: five years in "space" hardware; C/C++.</p>';
  const detail = { Id: 'a1b2', Title: 'Avionics Engineer', Locations: [{ Id: 'x', Description: 'Plant 2' }], Description: posting, JobCategoryName: 'Engineering' };
  // the page writes the object as JSON with < and > as \u003c and \u003e
  const literal = JSON.stringify(detail).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const html = `<html><head><script>var x = {"Description":"not the posting, it stands before the object"};</script></head><body><div id="Opportunity"></div>`
    + `<script>var opportunity = new US.Opportunity.CandidateOpportunityDetail(${literal});</script></body></html>`;
  assert.ok(!html.includes('<p>You integrate'), 'the fixture carries the text only as an escaped string, like the real page');
  const t = ultiproDescriptionOf(html);
  assert.match(t, /^You integrate the avionics of a launch vehicle upper stage\./);
  assert.match(t, /five years in "space" hardware; C\/C\+\+\.$/);
  assert.ok(!t.includes('<') && !t.includes('Plant 2') && !t.includes('not the posting'));
  assert.equal(pageDescriptionOf(html), '', 'the generic page reader finds nothing on such a page: that is why the provider reads it');
  assert.equal(ultiproDescriptionOf('<html><body>Sign in</body></html>'), '');
  assert.equal(ultiproDescriptionOf(''), '');
  assert.equal(typeof providers.ultipro.fetchDescription, 'function');
});

test('description files: body, header, document layout and the long-text cut', () => {
  const r = { url: 'https://acme.example/jobs/1', company: 'Acme GmbH', title: 'Engineer', location: '', first_seen: '2026-11-02', posted: '' };
  const doc = jdDocument(r, '  The role text.  ');
  assert.equal(doc, '# Engineer\n\n- Company: Acme GmbH\n- Location: ?\n- URL: https://acme.example/jobs/1\n- First seen: 2026-11-02\n\nThe role text.\n');
  assert.equal(jdBody(doc), 'The role text.');
  assert.equal(jdHeader(doc), '# Engineer\n\n- Company: Acme GmbH\n- Location: ?\n- URL: https://acme.example/jobs/1\n- First seen: 2026-11-02');
  assert.equal(jdBody('- a list item first\nand text'), '- a list item first\nand text', 'a text without the header is its own body');
  assert.equal(jdHeader('no header here'), '');
  assert.equal(jdBody('# Engineer\n\n- Company: Acme GmbH\n\n'), '', 'a file with a header only has no text');
  assert.equal(clipDescription('x'.repeat(9000)).length, 9000);
  const cut = clipDescription('a'.repeat(8000) + 'b'.repeat(4000));
  assert.equal(cut.length, 8999);
  assert.ok(cut.startsWith('a'.repeat(7492) + '\n[...]\n') && cut.endsWith('b'.repeat(1500)));
});

test('stripContactSection: the appended contact section and "Contact:" lines go, the role text stays (invented contact data)', () => {
  const role = 'Aufgaben: Auslegung der Nutzlast.\nProfil: Studium der Raumfahrttechnik.';
  const section = 'Application and contact\nApply by e-mail.\nContact: Erika Beispiel, Recruiting, erika.beispiel@example.org, +49 89 000000\nApplication deadline: 2026-12-01';
  assert.equal(stripContactSection(`${role}\n\n${section}`), role);
  assert.equal(stripContactSection(section), '');
  assert.equal(stripContactSection(`${role}\n\nContact: Max Muster, max.muster@example.org`), role);
  assert.equal(stripContactSection(`${role}\n  Application and contact  \nmore`), role);
  const sentence = 'Details on application and contact persons follow.\nContact with customers is part of the role.';
  assert.equal(stripContactSection(sentence), sentence, 'the words inside a sentence are not the heading');
  assert.equal(stripContactSection(null), '');
});
