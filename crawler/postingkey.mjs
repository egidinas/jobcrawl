// Exact posting identity for known applicant tracking systems (ATS), used by crosslist.mjs to recognise an aggregator copy of a role
// the employer lists on its own ATS. Dependency free, pure functions, no I/O.
//
// postingKey(url) -> { vendor, id, ns, strong } | null
//   vendor  which ATS (host-normalised: www, locale and slug segments are ignored)
//   id      the posting id, lower-cased
//   ns      the company / tenant namespace the id lives in ('' when the URL does not carry one, e.g. a gh_jid query on a company site)
//   strong  true when the id is globally unique within the vendor (uuid, long numeric, hash), so a missing namespace is acceptable;
//           false for per-tenant counters (small integers, slugs): those only match with the same namespace or the same title
//
// keysMatch(a, b, sameTitle) decides whether two keys name the same posting.

const lc = (s) => String(s ?? '').toLowerCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const key = (vendor, id, ns = '', strong = false) => {
  id = lc(id).trim();
  return id ? { vendor, id, ns: lc(ns).trim(), strong } : null;
};
const seg = (path) => path.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
const LOCALE = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i;

/** @returns {{vendor:string,id:string,ns:string,strong:boolean}|null} */
export function postingKey(url) {
  let u;
  try { u = new URL(String(url ?? '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = lc(u.hostname).replace(/^www\./, '');
  const p = seg(u.pathname);
  const q = (n) => u.searchParams.get(n) ?? '';
  let m;

  // Amazon: /jobs/<id> and /<locale>/jobs/<id>/<slug>
  if (h === 'amazon.jobs' || h.endsWith('.amazon.jobs')) {
    const i = p[0] === 'jobs' ? 0 : LOCALE.test(p[0] ?? '') && p[1] === 'jobs' ? 1 : -1;
    if (i >= 0 && /^\d{5,}$/.test(p[i + 1] ?? '')) return key('amazon', p[i + 1], 'amazon', true);
    return null;
  }
  // Greenhouse: board URLs, the embed form and the gh_jid query that company sites carry on their own pages.
  if (/^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/.test(h)) {
    if (p[0] === 'embed') { const t = q('token'); return /^\d+$/.test(t) ? key('greenhouse', t, q('for'), t.length >= 7) : null; }
    const j = p.indexOf('jobs');
    if (j >= 1 && /^\d+$/.test(p[j + 1] ?? '')) return key('greenhouse', p[j + 1], p[0], p[j + 1].length >= 7);
    if (/^\d+$/.test(q('gh_jid'))) return key('greenhouse', q('gh_jid'), p[0] !== 'embed' ? p[0] : '', q('gh_jid').length >= 7);
    return null;
  }
  if (/^\d{4,}$/.test(q('gh_jid'))) return key('greenhouse', q('gh_jid'), '', q('gh_jid').length >= 7);
  if (UUID.test(q('ashby_jid'))) return key('ashby', q('ashby_jid'), '', true);
  // Lever / Ashby / Rippling: /<company>/<uuid>
  if (/^jobs(?:\.eu)?\.lever\.co$/.test(h)) return UUID.test(p[1] ?? '') ? key('lever', p[1], p[0], true) : null;
  if (h === 'jobs.ashbyhq.com') return UUID.test(p[1] ?? '') ? key('ashby', p[1], p[0], true) : null;
  if (h === 'ats.rippling.com') { const j = p.indexOf('jobs'); return j >= 1 && UUID.test(p[j + 1] ?? '') ? key('rippling', p[j + 1], p[0], true) : null; }
  // Workday: tenant.wdN.myworkdayjobs.com/[locale/]site/job/<location>/<title>_<REQ>[-n]; the requisition id is per tenant.
  if ((m = h.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/))) {
    const last = p[p.length - 1] ?? '';
    const r = last.match(/_([A-Za-z]{0,4}-?\d{3,})(?:-\d{1,2})?$/);
    return r && p.includes('job') ? key('workday', r[1].replace('-', ''), m[1], false) : null;
  }
  // SmartRecruiters: /<company>/<id>[-slug]
  if (h === 'jobs.smartrecruiters.com' || h === 'careers.smartrecruiters.com') {
    const r = (p[1] ?? '').match(/^(\d{9,})(?:-|$)/);
    return r ? key('smartrecruiters', r[1], p[0], true) : null;
  }
  // Personio: <company>.jobs.personio.<tld>/job/<id>
  if ((m = h.match(/^([a-z0-9-]+)\.jobs\.personio\.(?:de|com)$/))) return p[0] === 'job' && /^\d+$/.test(p[1] ?? '') ? key('personio', p[1], m[1]) : null;
  // Workable: apply.workable.com/<company>/j/<shortcode> or /j/<shortcode>
  if (h === 'apply.workable.com') {
    const j = p.indexOf('j');
    return j >= 0 && /^[0-9a-f]{8,12}$/i.test(p[j + 1] ?? '') ? key('workable', p[j + 1], j >= 1 ? p[0] : '', true) : null;
  }
  // Recruitee: <company>.recruitee.com/o/<slug>
  if ((m = h.match(/^([a-z0-9-]+)\.recruitee\.com$/))) return p[0] === 'o' && p[1] ? key('recruitee', p[1], m[1]) : null;
  // Teamtailor: <company>.teamtailor.com/jobs/<id>-slug
  if ((m = h.match(/^([a-z0-9-]+)\.teamtailor\.com$/))) { const r = p[0] === 'jobs' && (p[1] ?? '').match(/^(\d{5,})(?:-|$)/); return r ? key('teamtailor', r[1], m[1]) : null; }
  // JOIN: join.com/companies/<company>/<id>[-slug]
  if (h === 'join.com') { const r = p[0] === 'companies' && (p[2] ?? '') === 'jobs' ? (p[3] ?? '').match(/^(\d+)(?:-|$)/) : p[0] === 'companies' ? (p[2] ?? '').match(/^(\d+)(?:-|$)/) : null; return r ? key('join', r[1], p[1]) : null; }
  // BambooHR: <company>.bamboohr.com/careers/<id> or /jobs/view.php?id=
  if ((m = h.match(/^([a-z0-9-]+)\.bamboohr\.com$/))) {
    if (p[0] === 'careers' && /^\d+$/.test(p[1] ?? '')) return key('bamboohr', p[1], m[1]);
    if (/^\d+$/.test(q('id')) && p.includes('jobs')) return key('bamboohr', q('id'), m[1]);
    return null;
  }
  // Oracle Cloud (Candidate Experience): .../job/<id> or .../requisitions/preview/<id>; ids repeat across tenants, so the host is the namespace.
  if (h.endsWith('.oraclecloud.com')) {
    const i = Math.max(p.lastIndexOf('job'), p.lastIndexOf('preview'));
    return i >= 0 && /^\d+$/.test(p[i + 1] ?? '') && p.includes('CandidateExperience') ? key('oracle', p[i + 1], h) : null;
  }
  // UltiPro / UKG: recruiting.ultipro.<tld>/<tenant>/JobBoard/<guid>/OpportunityDetail?opportunityId=<uuid>
  if (/(^|\.)ultipro\.[a-z]+$/.test(h)) return UUID.test(q('opportunityId')) ? key('ultipro', q('opportunityId'), p[0], true) : null;
  // ADP: ...?cid=<uuid>&jobId=<n> (WorkforceNow) or c=<uuid> (recruiting.adp.com)
  if (h.endsWith('adp.com')) {
    const id = q('jobId') || q('selectedMenuKey');
    const ns = q('cid') || q('c');
    return /^\d+$/.test(id) && ns ? key('adp', id, ns) : null;
  }
  // iCIMS: <tenant>.icims.com/jobs/<id>/<slug>/job
  if (h.endsWith('.icims.com')) return p[0] === 'jobs' && /^\d+$/.test(p[1] ?? '') ? key('icims', p[1], h) : null;
  // Eightfold: <host>/careers?pid=<n> (also /careers/job/<n>)
  if (/(^|\.)eightfold\.ai$/.test(h) || (p[0] === 'careers' && /^\d{8,}$/.test(q('pid')))) {
    if (/^\d+$/.test(q('pid'))) return key('eightfold', q('pid'), h);
    return p[0] === 'careers' && p[1] === 'job' && /^\d+$/.test(p[2] ?? '') ? key('eightfold', p[2], h) : null;
  }
  // SAP SuccessFactors / RMK career sites: ?career_job_req_id=<n> or /job/<slug>/<id>[-lang]/
  if (/^\d+$/.test(q('career_job_req_id'))) return key('successfactors', q('career_job_req_id'), h);
  if ((m = u.pathname.match(/\/job\/[^/]+\/(\d{5,})(?:-[a-z]{2}_[A-Za-z]{2})?\/?$/))) return key('successfactors', m[1], h);
  // Softgarden: <tenant>.softgarden.io/job/<id>/<slug>
  if (h.endsWith('.softgarden.io')) return p[0] === 'job' && /^\d+$/.test(p[1] ?? '') ? key('softgarden', p[1], h) : null;
  // Gem / Deel / Breezy / Jobvite / JazzHR / Paylocity / Cornerstone
  if (h === 'jobs.gem.com') return p[1] ? key('gem', p[1], p[0], true) : null;
  if (h === 'jobs.deel.com') { const i = p.indexOf('job-details'); return i >= 1 && UUID.test(p[i + 1] ?? '') ? key('deel', p[i + 1], p[0], true) : null; }
  if ((m = h.match(/^([a-z0-9-]+)\.breezy\.hr$/))) return p[0] === 'p' && /^[0-9a-f]{10,}$/i.test(p[1] ?? '') ? key('breezy', p[1], m[1], true) : null;
  if (h === 'jobs.jobvite.com') { const i = p.indexOf('job'); return i >= 1 && /^[A-Za-z0-9]{6,}$/.test(p[i + 1] ?? '') ? key('jobvite', p[i + 1], p[0], true) : null; }
  if ((m = h.match(/^([a-z0-9-]+)\.applytojob\.com$/))) return p[0] === 'apply' && /^[A-Za-z0-9]{8,}$/.test(p[1] ?? '') ? key('jazzhr', p[1], m[1]) : null;
  if (h === 'recruiting.paylocity.com') { const i = p.findIndex((s) => lc(s) === 'details'); return i >= 0 && /^\d+$/.test(p[i + 1] ?? '') ? key('paylocity', p[i + 1]) : null; }
  if (h.endsWith('.csod.com')) { const r = u.pathname.match(/\/requisition\/(\d+)/i); return r ? key('csod', r[1], `${h}|${q('c')}`) : null; }
  return null;
}

/** Posting keys of every ATS URL found in free text (an aggregator description that names the employer's apply link). */
export function textPostingKeys(text, limit = 5) {
  const out = [], seen = new Set();
  for (const raw of String(text ?? '').match(/https?:\/\/[^\s)\]>"'<]+/g) ?? []) {
    const k = postingKey(raw.replace(/[.,;]+$/, ''));
    const sig = k && `${k.vendor}|${k.ns}|${k.id}`;
    if (k && !seen.has(sig)) { seen.add(sig); out.push(k); if (out.length >= limit) break; }
  }
  return out;
}

/**
 * Same posting? Vendor and id must be equal. Two namespaces that are both known must be equal. A missing namespace is accepted only
 * for globally unique ids (`strong`); a per-tenant counter without a shared namespace needs `sameTitle`.
 */
export function keysMatch(a, b, sameTitle = false) {
  if (!a || !b || a.vendor !== b.vendor || a.id !== b.id) return false;
  if (a.ns && b.ns) return a.ns === b.ns;
  return (a.strong && b.strong) || sameTitle;
}
