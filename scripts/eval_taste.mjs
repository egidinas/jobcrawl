// Does rating help discovery? Simulated visitors on the real board, no personal data.
//   node scripts/eval_taste.mjs <data folder> [users per setting] [methods | shape | explore | persona]
// The data folder is one `jobcrawl publish` wrote (config.json for the personas and the glossary, jobs-index.json, match/ with vectors).
// A simulated visitor has 1-3 hidden areas of interest (seed roles); a role appeals by its closeness to the nearest seed.
// "Good" roles: the most appealing ~1% of the board for that visitor. The visitor sees a spread of 12, then rounds of 20 results,
// and marks ▲ what is good, ▼ what is clearly off (half the time, as people skip), nothing otherwise.
// Measured per round: precision@20 (share of good roles), and coverage (share of the hidden areas with a good role in the 20).
// Compared: this ranking (areas + coupling), the same without coupling, and one averaged taste vector (the usual approach).
import fs from 'node:fs';
import { loadIndex, rankByTaste, sampleSpread, roleVec, matchFields } from '../web/assets/match.js';
import { personaVectors, setPersonas, START_WEIGHT, HALF_LIFE } from '../web/assets/profile.js';
const site = process.argv[2] || 'demo/site', USERS = +(process.argv[3] || 150);
const rd = (u) => fs.readFileSync(site + '/' + u.replace(/^\//, ''));
const cfg = fs.existsSync(site + '/config.json') ? JSON.parse(rd('config.json')) : { personas: [], glossary: [] };
setPersonas(cfg.personas);
const ix = await loadIndex('/match/', cfg.glossary, (u) => Promise.resolve({ json: async () => JSON.parse(rd(u)), arrayBuffer: async () => { const b = rd(u); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } }));
const rows = JSON.parse(rd('jobs-index.json')), have = []; for (let i = 0; i < ix.n; i++) if (ix.vrow[i] >= 0) have.push(i);
const V = new Map(have.map((i) => [i, roleVec(ix, i)])), dot = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k] * b[k]; return s; };
let seed = 12345; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const companyOf = (i) => rows[i][2], coKey = (i) => rows[i][4];
const personaVecs = personaVectors(ix, rows);
const prefDefs = JSON.parse(rd('match/match-prefs.json')).prefs.map((p) => ({ ...p, v: Float32Array.from(p.v) }));
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

function averaged(items, skip) {      // baseline: one taste vector = mean of liked minus a quarter of the mean of disliked
  const q = new Float32Array(ix.dim), add = (list, w) => { for (const x of list) { const v = V.get(x.i); for (let k = 0; k < ix.dim; k++) q[k] += w * v[k] / list.length; } };
  add(items.filter((x) => x.w > 0), 1); add(items.filter((x) => x.w < 0), -0.25);
  const sc = have.filter((i) => !skip.has(i)).map((i) => [i, dot(V.get(i), q)]).sort((a, b) => b[1] - a[1]), out = [], per = new Map();
  for (const [i] of sc) { const c = companyOf(i); if ((per.get(c) || 0) >= 2) continue; per.set(c, (per.get(c) || 0) + 1); out.push(i); if (out.length >= 20) break; }
  return out;
}
function simulate(nAreas, method, shape = '') {
  const seeds = []; while (seeds.length < nAreas) { const i = have[Math.floor(rnd() * have.length)]; if (seeds.every((s) => dot(V.get(s), V.get(i)) < 0.25)) seeds.push(i); }
  const appeal = new Map(have.map((i) => [i, Math.max(...seeds.map((s) => dot(V.get(s), V.get(i))))]));
  const near = new Map(have.map((i) => [i, seeds.reduce((b, s, k) => (dot(V.get(s), V.get(i)) > dot(V.get(seeds[b]), V.get(i)) ? k : b), 0)]));
  const sorted = [...appeal.values()].sort((a, b) => b - a), good = sorted[Math.floor(have.length * 0.01)], bad = sorted[Math.floor(have.length * 0.6)];
  const items = [], skip = new Set(), rec = [];
  // pre-shaping, as a visitor would give it before rating anything:
  //  fields: the board field chips of the visitor's own areas (they know their fields);
  //  cv: a text that sits between their areas, with as much noise as signal (a CV is about the past, not exactly the wish);
  //  statements: answers that agree with where their areas lie on each statement (rounded, so often "no preference").
  let must = null, cv = null, prefs = [];
  if (shape.includes('fields')) { const names = new Set(); seeds.forEach((s) => ix.fields.forEach((f, k) => { if (ix.attrs[s][4] >> k & 1) names.add(f); })); if (names.size) must = matchFields(ix, [...names]); }
  if (shape.includes('cv')) { const q = new Float32Array(ix.dim); seeds.forEach((s) => V.get(s).forEach((x, k) => { q[k] += x; })); let n = 0; q.forEach((x) => { n += x * x; }); n = Math.sqrt(n);
    const z = Float32Array.from(q, () => gauss()); let m = 0; z.forEach((x) => { m += x * x; }); m = Math.sqrt(m); cv = Array.from(q, (x, k) => x / n + z[k] / m + ix.mean[k]); }
  if (shape.includes('statements')) prefs = prefDefs.map((p) => { const z = seeds.reduce((t, s) => t + (V.get(s).reduce((a, x, k) => a + x * p.v[k], 0) - p.mu) / p.sd, 0) / seeds.length; return { ...p, val: Math.max(-2, Math.min(2, Math.round(z))) }; });
  // persona: the visitor picks the starting point closest to their first interest (as a person would pick their own field)
  let persona = null;
  if (shape.includes('persona')) { let best = -9; for (const [id, v] of Object.entries(personaVecs)) { const s0 = V.get(seeds[0]).reduce((a, x, k) => a + x * v[k], 0); if (s0 > best) { best = s0; persona = v; } } }
  const personaExtra = () => { const w = START_WEIGHT * Math.pow(0.5, items.length / HALF_LIFE); return persona && w >= 0.03 ? [{ w, vec: persona }] : []; };
  const liked = () => items.filter((x) => x.w > 0).length, shaped = () => !!(cv || prefs.some((p) => p.val) || personaExtra().length);
  const okShape = (i) => !skip.has(i) && (!must || liked() >= 3 || must[i] > 0);
  const rate = (list) => { for (const i of list) { skip.add(i); const u = appeal.get(i); if (u >= good) items.push({ i, w: 1 }); else if (u < bad && rnd() < 0.5) items.push({ i, w: -1 }); } };
  const measure = (list) => { const g = list.filter((i) => appeal.get(i) >= good); rec.push([g.length / Math.max(1, list.length), new Set(g.map((i) => near.get(i))).size / nAreas]); };
  const spread = sampleSpread(ix, okShape, 12, rnd); measure(spread); rate(spread);
  for (let round = 1; round <= 4; round++) {
    let list;
    if (method === 'random') list = Array.from({ length: 20 }, () => have[Math.floor(rnd() * have.length)]);
    else if (!liked() && !shaped()) list = sampleSpread(ix, okShape, 20, rnd);          // nothing liked yet and nothing else to go on: another spread
    else if (method === 'average') list = averaged(items, skip);
    else list = rankByTaste(ix, { items, skip, companyOf, top: 20, perEmployer: 2, coKey: method === 'areas' ? coKey : null, cvEmbedding: cv, prefs, must: must && liked() < 3 ? must : null, explore: shape.includes('explore') ? 4 : 0, rng: rnd, extra: personaExtra() }).results.map((r) => r.i);
    measure(list); rate(list);
  }
  return rec;
}
console.log(`${have.length} roles with vectors; ${USERS} simulated visitors per setting; "good" = the visitor's top 1% (about ${Math.round(have.length * 0.01)} roles)\n`);
const runs = process.argv[4] === 'persona' ? [['areas', ''], ['areas', 'persona'], ['areas', 'persona+statements'], ['areas', 'cv']] : process.argv[4] === 'explore' ? [['areas', ''], ['areas', 'explore'], ['areas', 'statements'], ['areas', 'statements+explore']] : process.argv[4] === 'shape'
  ? [['areas', ''], ['areas', 'fields'], ['areas', 'statements'], ['areas', 'cv'], ['areas', 'fields+statements'], ['areas', 'fields+cv+statements']]
  : [['random', ''], ['average', ''], ['nocouple', ''], ['areas', '']];
for (const nAreas of [1, 2, 3]) {
  console.log(`hidden areas of interest: ${nAreas}`);
  for (const [method, shape] of runs) {
    seed = 777 + nAreas;      // the same visitors for every method
    const all = Array.from({ length: USERS }, () => simulate(nAreas, method, shape));
    const m = (r, k) => (all.reduce((t, x) => t + x[r][k], 0) / USERS * 100).toFixed(0).padStart(3);
    console.log(`  ${(method + (shape ? ' + ' + shape : '')).padEnd(32)} precision@20 by round (0 = first spread): ${[0, 1, 2, 3, 4].map((r) => m(r, 0) + '%').join(' ')}   coverage: ${[1, 2, 3, 4].map((r) => m(r, 1) + '%').join(' ')}`);
  }
}
