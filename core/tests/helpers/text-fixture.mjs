// Two replayed reads with real-looking descriptions (HTML, odd whitespace): the second changes one description and drops a posting.
const D1 = '<div><h2>Senior Thermal Engineer (m/w/d)</h2>\n<p>At Acme Space we build satellites that link the world.   You will design, analyse and test the thermal control system of our\nspacecraft and run thermal vacuum campaigns.</p>\n<ul><li>Degree in mechanical or aerospace engineering</li><li>Five years of spacecraft thermal design</li></ul></div>';
const D2 = 'Lead the assembly, integration and test of our flight hardware in Munich.\n\n' + 'You coordinate suppliers, write procedures and run vibration tests. '.repeat(30);
const mk = (d1, drop = false) => [
  { url: 'https://boards.greenhouse.io/acme/jobs/401', title: 'Senior Thermal Engineer (m/w/d)', location: 'Oberpfaffenhofen, Germany', postedAt: '2026-11-02', description: d1 },
  { url: 'https://boards.greenhouse.io/acme/jobs/402', title: 'AIT Manager', location: 'Munich, Germany', postedAt: '2026-11-03', description: D2 },
  ...(drop ? [] : [{ url: 'https://boards.greenhouse.io/acme/jobs/403', title: 'Quality Lead', location: 'Munich, Germany', postedAt: '2026-11-04' }]),
];
export const RUNS = [
  { now: '2026-11-20T06:00:00.000Z', run: { ok: true, items: mk(D1), complete: true, emptyOk: true } },
  { now: '2026-11-21T06:00:00.000Z', run: { ok: true, items: mk(D1.replace('Five', 'Eight'), true), complete: true, emptyOk: true } },
];
