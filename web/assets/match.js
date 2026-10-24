// "Match me": ranks the open roles against pasted text, in the visitor's browser. No server, nothing leaves the device.
// Two signals: keywords (BM25F over title x3 + description) and, when the model has been loaded, meaning (cosine on 256-number vectors).
// They are combined by reciprocal rank fusion. Roles without a vector still take part through their keywords.

const TOK = /[a-zäöüß0-9][a-zäöüß0-9+#.\-]+/g;
export function tokens(t) {
  const out = [];
  for (let w of String(t).toLowerCase().match(TOK) || []) {
    w = w.replace(/^[.\-]+|[.\-]+$/g, '');
    if (w.length < 2 || w.length > 26) continue;
    out.push(w);
    if (w.includes('-')) for (const p of w.split('-')) if (p.length > 1) out.push(p);      // "do-178c" is found as itself and by its parts
  }
  return out;
}

export async function loadIndex(base, glossary = [], fetcher = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + ' ' + r.status); return r; })) {
  // the vectors, neighbours and duplicate groups are optional here: without them the index still ranks by keywords
  const [bm, at, vj, vec, graph, nb] = await Promise.all([
    fetcher(base + 'match-bm25.json').then((r) => r.json()), fetcher(base + 'match-attrs.json').then((r) => r.json()),
    fetcher(base + 'match-vec.json').then((r) => r.json()).catch(() => null), fetcher(base + 'match-vec.bin').then((r) => r.arrayBuffer()).then((b) => new Int8Array(b)).catch(() => null),
    fetcher(base + 'role-graph.json').then((r) => r.json()).catch(() => null), fetcher(base + 'role-nb.bin').then((r) => r.arrayBuffer()).then((b) => new Uint16Array(b)).catch(() => null)]);
  return makeIndex(bm, vec ? vj : null, at, vec, graph && nb ? { ...graph, nb } : null, glossary);
}

export function makeIndex(bm, vj, at, vec, graph = null, glossary = []) {
  // vector rows are looked up by role id, so a board that changed since the vectors were built only costs the new roles their meaning scores
  const row = new Map(); if (vj && vj.ids) vj.ids.forEach((id, r) => row.set(id, r));
  const vrow = new Int32Array(bm.n).fill(-1); if (bm.ids) bm.ids.forEach((id, i) => { const r = row.get(id); if (r !== undefined) vrow[i] = r; });
  const ix = { n: bm.n, avgdl: bm.avgdl, len: bm.len, idf: bm.idf, post: bm.post, vec, dim: vj ? vj.dim : 0, mean: vj ? Float32Array.from(vj.mean) : null, vrow, attrs: at.a, scopes: at.scopes, levels: at.levels, regions: at.regions || [], fields: at.fields || [], langs: at.langs || null, langDirs: vj && vj.lang_dirs ? vj.lang_dirs.map((d) => Float32Array.from(d)) : null, ids: bm.ids || [], translate: buildTranslate(glossary) };
  // neighbours and near-duplicates (jobcrawl/index/neighbours.py), by board position
  ix.dupKey = new Int32Array(ix.n).fill(-1); ix.dupSize = new Uint16Array(ix.n).fill(1); ix.nbOf = () => []; ix.dupsOf = () => [];
  if (graph && vj) {
    const boardOf = new Int32Array(vj.ids.length).fill(-1); for (let i = 0; i < ix.n; i++) if (vrow[i] >= 0) boardOf[vrow[i]] = i;
    graph.dup.forEach((g, k) => { const bi = g.map((r) => boardOf[r]).filter((i) => i >= 0); for (const i of bi) { ix.dupKey[i] = k; ix.dupSize[i] = bi.length; } });
    const K = graph.k;
    ix.nbOf = (i) => { const r = vrow[i]; if (r < 0) return []; const out = []; for (let q = 0; q < K; q++) { const j = graph.nb[r * K + q]; if (j === 65535 || boardOf[j] < 0) continue; out.push({ i: boardOf[j], sim: graph.sim[r * K + q] / 100 }); } return out; };
    ix.dupsOf = (i) => { const k = ix.dupKey[i]; if (k < 0) return []; const out = []; for (const r of graph.dup[k]) { const b = boardOf[r]; if (b >= 0 && b !== i) out.push(b); } return out; };
  }
  return ix;
}

const K1 = 1.2, B = 0.75;
/** Keyword scores for every role. A pasted CV is long, so only the most distinctive terms (idf x count) are used. */
// English <-> German words, so the keyword half also finds postings written in the other language (each query word also
// searches its counterpart, at 0.7 of its weight). The pairs come from the profile's glossary ([en, de] per pair, config.json).
/** Translation map for the glossary pairs: a word -> its counterpart (either direction). */
export function buildTranslate(pairs) {
  const T = new Map();
  for (const [en, de] of pairs || []) { const a = en.toLowerCase(), b = de.toLowerCase(); if (a !== b) { T.set(a, b); if (!T.has(b)) T.set(b, a); } }
  return T;
}
export function bm25(ix, text, maxTerms = 60) {
  const qtf = new Map(); for (const w of tokens(text)) if (ix.idf[w] !== undefined) qtf.set(w, (qtf.get(w) || 0) + 1);
  for (const [w, c] of [...qtf]) { const t = ix.translate && ix.translate.get(w); if (t && ix.idf[t] !== undefined && !qtf.has(t)) qtf.set(t, c * 0.49); }      // sqrt(0.49) = 0.7 of the weight
  const terms = [...qtf].map(([w, c]) => [w, ix.idf[w] * Math.sqrt(c)]).sort((a, b) => b[1] - a[1]).slice(0, maxTerms);
  const score = new Float32Array(ix.n), why = new Array(ix.n);
  for (const [w, wt] of terms) {
    const p = ix.post[w]; if (!p) continue;
    for (let k = 0; k < p.length; k += 2) {
      const i = p[k], f = p[k + 1], s = ix.idf[w] * f * (K1 + 1) / (f + K1 * (1 - B + B * ix.len[i] / ix.avgdl)) * (wt / ix.idf[w]);
      score[i] += s; (why[i] || (why[i] = [])).push([w, s]);
    }
  }
  return { score, terms: terms.map((t) => t[0]), why };
}

/** A model embedding (768 numbers) as a query in the index space: first `dim` numbers, minus the index mean, without the
 *  language directions the stored vectors were cleared of (jobcrawl/text/langfix.py), unit length. */
export function queryVec(ix, emb) {
  const d = ix.dim, q = new Float32Array(d); for (let k = 0; k < d; k++) q[k] = emb[k] - ix.mean[k];
  for (const D of ix.langDirs || []) { let t = 0; for (let k = 0; k < d; k++) t += q[k] * D[k]; for (let k = 0; k < d; k++) q[k] -= t * D[k]; }
  let nn = 0; for (let k = 0; k < d; k++) nn += q[k] * q[k]; nn = Math.sqrt(nn) || 1; for (let k = 0; k < d; k++) q[k] /= nn; return q;
}
/** Language calibration: postings in German, French or Spanish still score a little lower against most queries than English
 *  ones about the same work. Each language's scores are shifted so its top 5 % sit where the English top 5 % sit.
 *  (Measured: English queries brought 21 % German postings into the top 30 of roles in Germany, where 44 % are German;
 *  with the language directions removed 28 %, with this calibration on top 33 %.) Scores at or below floor are left alone. */
export function calibrate(ix, score, floor = -1.5) {
  if (!ix.langs || ix.attrs[0] === undefined || ix.attrs[0][5] === undefined) return score;
  const by = ix.langs.map(() => []); for (let i = 0; i < ix.n; i++) if (score[i] > floor) by[ix.attrs[i][5]].push(score[i]);
  const p95 = (a) => { if (a.length < 20) return null; const b = Float32Array.from(a).sort(); return b[Math.floor(b.length * 0.95)]; }, ref = p95(by[0]);
  if (ref === null) return score; const shift = by.map((a, l) => { const p = l ? p95(a) : null; return p === null ? 0 : ref - p; });
  for (let i = 0; i < ix.n; i++) if (score[i] > floor) score[i] += shift[ix.attrs[i][5]];
  return score;
}

/** Meaning scores from a model embedding of the query (768 numbers, the "search result | query:" prompt). */
export function dense(ix, emb) {
  const d = ix.dim, q = queryVec(ix, emb);
  const score = new Float32Array(ix.n).fill(-2);
  for (let i = 0; i < ix.n; i++) { if (ix.vrow[i] < 0) continue; let s = 0, nn = 0; const o = ix.vrow[i] * d; for (let k = 0; k < d; k++) { s += ix.vec[o + k] * q[k]; nn += ix.vec[o + k] * ix.vec[o + k]; } score[i] = s / (Math.sqrt(nn) || 1); }
  return calibrate(ix, score);
}

export function ranksOf(score, ok) {
  const idx = []; for (let i = 0; i < score.length; i++) if (ok(i) && score[i] > (score.floorValue ?? -1.5)) idx.push(i);
  idx.sort((a, b) => score[b] - score[a] || a - b); const r = new Map(); idx.forEach((i, k) => r.set(i, k + 1)); return r;
}

/** The scope index to filter by: the given one, else the widest (the last of the index's scopes: every role is in it). */
const widest = (ix, scope) => (scope === null || scope === undefined ? ix.scopes.length - 1 : scope);

/** Filters: scope (the index of the scope in config.json; a role in a narrow scope also counts for the wider ones; default: the widest,
 *  the last one), level range, employer cap. */
export function rank(ix, { text = '', embedding = null, scope = null, minLevel = 0, maxLevel = 99, perEmployer = 2, top = 20, companyOf = null, mode = 'auto', must = null } = {}) {
  const inScope = widest(ix, scope), ok = (i) => (ix.attrs[i][0] >> inScope & 1) === 1 && ix.attrs[i][1] >= minLevel && ix.attrs[i][1] <= maxLevel && (!must || must[i] > 0);
  const kw = bm25(ix, text), lists = [];
  const kwScore = Float32Array.from(kw.score, (s) => (s > 0 ? s : -2)); kwScore.floorValue = 0; lists.push(ranksOf(kwScore, ok));
  let useDense = embedding && ix.dim && mode !== 'keywords';
  if (useDense) { const ds = dense(ix, embedding); ds.floorValue = -1.5; lists.push(ranksOf(ds, ok)); }
  const fused = new Map();
  for (const r of lists) for (const [i, k] of r) fused.set(i, (fused.get(i) || 0) + 1 / (60 + k));
  const order = [...fused].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map((x) => x[0]), out = [], per = new Map(), seenDup = new Set();
  for (const i of order) {
    const dk = ix.dupKey ? ix.dupKey[i] : -1; if (dk >= 0) { if (seenDup.has(dk)) continue; }      // the same job listed again: shown once
    const c = companyOf ? companyOf(i) : ''; if (c && (per.get(c) || 0) >= perEmployer) continue; per.set(c, (per.get(c) || 0) + 1);
    if (dk >= 0) seenDup.add(dk);
    out.push({ i, also: ix.dupSize ? ix.dupSize[i] - 1 : 0, score: fused.get(i), why: (kw.why[i] || []).sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => x[0]), dense: useDense });
    if (out.length >= top) break;
  }
  return { results: out, terms: kw.terms, usedModel: !!useDense };
}

// ---- Search space from rated roles (no CV needed, no model download: the vectors of the rated roles are already in the index) ----
// What a rating says about taste: the work (stars), interest (stars) and "would apply" are averaged into one number from -1 (no) to +1 (yes).
// Roles liked (> 0) are grouped into areas by their similarity (leader clustering, threshold TAU: about "among each other's 20 nearest roles");
// a role scores by its closest area, minus a penalty for being close to a disliked role. Several liked areas therefore stay separate.
export const TAU = 0.4, NEG_FLOOR = 0.25, NEG_WEIGHT = 0.6;
const stars = (n) => (n - 3) / 2;
export function tasteWeight(r) {
  const v = []; if (r.role) v.push(stars(r.role)); if (r.interest) v.push(stars(r.interest)); if (r.apply !== undefined) v.push(r.apply);
  const a = v.length ? v.reduce((x, y) => x + y, 0) / v.length : null;
  if (r.vote === undefined) return a;
  // an explicit up / neutral / down decides the direction: neutral takes the role out of the space, up and down count fully unless the stars say how strongly
  if (r.vote === 0) return 0;
  return r.vote * (a !== null && Math.sign(a) === r.vote ? Math.max(Math.abs(a), 0.5) : 1);
}
/** The unit vector of role i (Float32Array), or null when that role has no vector. */
export function roleVec(ix, i) {
  const r = ix.vrow[i]; if (r < 0 || !ix.vec) return null; const d = ix.dim, v = new Float32Array(d); let n = 0;
  for (let k = 0; k < d; k++) { v[k] = ix.vec[r * d + k]; n += v[k] * v[k]; } n = Math.sqrt(n) || 1; for (let k = 0; k < d; k++) v[k] /= n; return v;
}
const dotv = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k] * b[k]; return s; };
/** items: [{i, w, vec}] with w in -1..1. Returns the liked areas (centroids) and the disliked roles. */
export function buildSpace(items, tau = TAU) {
  const areas = [];
  for (const it of items.filter((x) => x.w > 0.05).sort((a, b) => b.w - a.w)) {
    let best = null, bs = tau; for (const a of areas) { const s = dotv(a.c, it.vec); if (s >= bs) { bs = s; best = a; } }
    if (!best) areas.push({ c: Float32Array.from(it.vec), sum: Float32Array.from(it.vec, (x) => x * it.w), members: [it] });
    else { best.members.push(it); for (let k = 0; k < best.sum.length; k++) best.sum[k] += it.vec[k] * it.w; let n = Math.sqrt(dotv(best.sum, best.sum)) || 1; best.c = Float32Array.from(best.sum, (x) => x / n); }
  }
  return { areas, avoid: items.filter((x) => x.w < -0.05) };
}
/** Score of every role for a space: [score, index of the nearest liked role, index of the nearest disliked role]. */
export function scoreSpace(ix, space, hooks = {}) {
  const n = ix.n, score = new Float32Array(n).fill(-2), posA = new Float32Array(n), penA = new Float32Array(n), near = new Int32Array(n).fill(-1), far = new Int32Array(n).fill(-1), d = ix.dim, q = [];
  const cen = space.areas.map((a) => a.c), neg = space.avoid;
  for (let i = 0; i < n; i++) {
    const r = ix.vrow[i]; if (r < 0) continue; const o = r * d; let nn = 0; for (let k = 0; k < d; k++) nn += ix.vec[o + k] * ix.vec[o + k]; nn = Math.sqrt(nn) || 1;
    const sim = (c) => { let s = 0; for (let k = 0; k < d; k++) s += ix.vec[o + k] * c[k]; return s / nn; };
    let pos = -1, pa = -1; cen.forEach((c, a) => { const s0 = sim(c), s = s0 + (hooks.area ? hooks.area(i, a, s0) : 0); if (s > pos) { pos = s; pa = a; } });
    let pen = 0, pf = -1; for (const [xi, x] of neg.entries()) { const s0 = sim(x.vec), p = Math.max(0, s0 - NEG_FLOOR) * Math.abs(x.w) + (hooks.avoid ? hooks.avoid(i, xi, s0) : 0); if (p > pen) { pen = p; pf = x.i; } }
    const flat = hooks.flat ? hooks.flat(i) : 0, tilt = hooks.tilt ? hooks.tilt(i, o, nn) : 0;
    posA[i] = (cen.length ? pos : 0) + tilt; penA[i] = NEG_WEIGHT * pen + flat; score[i] = posA[i] - penA[i]; if (pa >= 0) { near[i] = pa; if (hooks.detail) hooks.detail(i, pa); } far[i] = pf;
  }
  return { score, pos: posA, pen: penA, area: near, avoid: far };
}
// ---- Company coupling: a role and its company are coupled vectors. The coupling lives inside each liked area, not in an average:
// - a company you liked (one of its roles, or the company itself) boosts its OTHER roles, but only those that also lie in that area (gate on the role's own closeness to the area);
// - a company whose centre resembles the companies of the area's liked roles gets a smaller boost, again only for its roles in that area;
// - a disliked role or company works the same way in reverse: roles of that company near the disliked one are pushed down further.
const gate = (s, lo, span) => Math.min(1, Math.max(0, (s - lo) / span));
export const CO_IMPLIED = 0.35;        // a liked role counts this much as a like of its company, in that role's area
export function companyCentres(ix, coKey) {
  const sums = new Map(); for (let i = 0; i < ix.n; i++) { const k = coKey(i); const v = k && roleVec(ix, i); if (!v) continue; const a = sums.get(k) || { s: new Float32Array(ix.dim), n: 0 }; for (let d = 0; d < ix.dim; d++) a.s[d] += v[d]; a.n++; sums.set(k, a); }
  const out = new Map(); for (const [k, a] of sums) { let t = 0; for (const x of a.s) t += x * x; t = Math.sqrt(t) || 1; out.set(k, { c: a.s.map((x) => x / t), n: a.n }); } return out;
}
function coupleHooks(ix, space, coKey, lam, bad0 = new Map()) {
  const cen = companyCentres(ix, coKey), n = ix.n, liked = new Float32Array(n), similar = new Float32Array(n), lamS = lam * 0.3;
  // per area: how much each company is liked there, and the typical company of the area
  const M = space.areas.map((a) => { const m = new Map(), proto = new Float32Array(ix.dim); let any = false;
    for (const mem of a.members) { const k = mem.co !== undefined ? mem.co : (mem.i >= 0 ? coKey(mem.i) : null); if (!k || mem.w <= 0) continue; m.set(k, Math.max(0, (m.get(k) || 0) + (mem.co !== undefined ? mem.w : mem.coW !== undefined ? mem.coW : mem.w * CO_IMPLIED)));
      const c = cen.get(k); if (c) { any = true; for (let d = 0; d < ix.dim; d++) proto[d] += mem.w * c.c[d]; } }
    let t = 0; for (const x of proto) t += x * x; t = Math.sqrt(t) || 1; return { m, proto: any ? proto.map((x) => x / t) : null }; });
  const bad = space.avoid.map((x) => ({ k: x.co !== undefined ? x.co : (x.i >= 0 ? coKey(x.i) : null), w: Math.abs(x.w) * (x.co !== undefined ? 1 : CO_IMPLIED) }));
  const hooks = {
    // a company marked as unwelcome only lowers its roles a little, whatever their area (strength 0..1): a role that fits very well can still come out on top
    flat(i) { const k = coKey(i), b = k && bad0.get(k); return b ? lam * 0.6 * b : 0; },
    area(i, a, s) { const k = coKey(i); if (!k) return 0; const g = gate(s, 0.25, 0.35); if (!g) return 0; const A = M[a];
      let b = Math.min(1, A.m.get(k) || 0); const c = cen.get(k); let sm = 0; if (A.proto && c) sm = gate(dotv(c.c, A.proto), 0.35, 0.4); return lam * b * g + lamS * sm * g * (b ? 0 : 1); },
    avoid(i, d, s) { const k = coKey(i); return k && bad[d].k === k ? lam * bad[d].w * gate(s, 0.25, 0.35) : 0; },
    detail(i, a) { const k = coKey(i); if (!k) return; liked[i] = 0; similar[i] = 0; const A = M[a], c = cen.get(k); const b = Math.min(1, A.m.get(k) || 0); if (b) liked[i] = b; else if (A.proto && c) similar[i] = gate(dotv(c.c, A.proto), 0.35, 0.4); },
  };
  return { hooks, liked, similar };
}
// General statements ("independent work or clear guidelines?"): each is a direction in the meaning space (jobcrawl/index/prefs.py).
// An answer val in -2..2 tilts every role by val/2 * its position along the direction (z-score, capped at 2) * PREF_WEIGHT / 2.
export const PREF_WEIGHT = 0.05;
/** Scores of every role for ratings, marked companies, a CV embedding and statement answers: {space, cp, sc} (sc: score, pos, pen, area, avoid). */
export function tasteScores(ix, { items = [], extra = [], cvEmbedding = null, coKey = null, coupling = 0.15, badCompanies = new Map(), prefs = [] } = {}) {
  const used = items.map((it) => ({ ...it, vec: roleVec(ix, it.i) })).filter((it) => it.vec);
  const space = buildSpace(used.concat(extra.map((x, k) => ({ i: -2 - k, w: x.w, vec: x.vec, co: x.co }))));      // extra: unit vectors that stand for something not on the board as one role, e.g. a company's centre
  if (cvEmbedding && ix.dim) {                      // a pasted CV is one more liked area, at half weight
    const q = queryVec(ix, cvEmbedding);
    space.areas.push({ c: q, sum: q, members: [{ i: -1, w: 0.5, vec: q }] });
  }
  space.unused = items.length - used.length;
  const cp = coKey && coupling > 0 ? coupleHooks(ix, space, coKey, coupling, badCompanies) : null, hooks = cp ? { ...cp.hooks } : {};
  const act = prefs.filter((p) => p.val);
  if (act.length) hooks.tilt = (i, o, nn) => { let t = 0; for (const p of act) { let s = 0; for (let k = 0; k < ix.dim; k++) s += ix.vec[o + k] * p.v[k]; const z = Math.max(-2, Math.min(2, (s / nn - p.mu) / p.sd)); t += PREF_WEIGHT * (p.val / 2) * (z / 2); } return t; };
  const sc = scoreSpace(ix, space, hooks);
  if (space.areas.length) { calibrate(ix, sc.pos, -1e9); for (let i = 0; i < ix.n; i++) if (sc.score[i] > -2) sc.score[i] = sc.pos[i] - sc.pen[i]; }
  return { space, cp, sc };
}
/** Ranked roles from rated roles (and optionally a CV embedding and text). items: [{i, w}]; likedText: the text of the liked roles, for the keyword half. */
export function rankByTaste(ix, { items, cvEmbedding = null, text = '', likedText = '', scope = null, minLevel = 0, maxLevel = 99, perEmployer = 2, top = 200, companyOf = null, skip = new Set(), badCompanies = new Map(), must = null, keywords = 'blend', extra = [], coKey = null, coupling = 0.15, prefs = [], explore = 0, rng = Math.random } = {}) {
  const inScope = widest(ix, scope), ok = (i) => (ix.attrs[i][0] >> inScope & 1) === 1 && ix.attrs[i][1] >= minLevel && ix.attrs[i][1] <= maxLevel && !skip.has(i) && (!must || must[i] > 0);
  const { space, cp, sc } = tasteScores(ix, { items, extra, cvEmbedding, coKey, coupling, badCompanies, prefs });
  const lists = [];
  if (space.areas.length || space.avoid.length || prefs.some((p) => p.val) || (badCompanies && badCompanies.size)) { sc.score.floorValue = -1.5; lists.push(ranksOf(sc.score, ok)); }
  const kwText = (likedText + ' ' + text).trim();
  if (kwText && keywords !== 'off') { const kw = bm25(ix, kwText), kws = Float32Array.from(kw.score, (s) => (s > 0 ? s : -2)); kws.floorValue = 0; lists.push(ranksOf(kws, ok)); }
  const fused = new Map(); for (const r of lists) for (const [i, k] of r) fused.set(i, (fused.get(i) || 0) + 1 / (60 + k));
  const order = [...fused].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map((x) => x[0]), out = [], per = new Map(), seenDup = new Set();
  for (const i of order) {
    const dk = ix.dupKey ? ix.dupKey[i] : -1; if (dk >= 0) { if (seenDup.has(dk)) continue; }      // the same job listed again: shown once
    const c = companyOf ? companyOf(i) : ''; if (c && (per.get(c) || 0) >= perEmployer) continue; per.set(c, (per.get(c) || 0) + 1);
    if (dk >= 0) seenDup.add(dk);
    const a = space.areas[sc.area[i]], nearest = a && a.members.reduce((b, m) => (m.i >= 0 && (!b || dotv(m.vec, roleVec(ix, i) || m.vec) > dotv(b.vec, roleVec(ix, i) || b.vec)) ? m : b), null);
    out.push({ i, also: ix.dupSize ? ix.dupSize[i] - 1 : 0, score: fused.get(i), area: sc.area[i], near: nearest && nearest.i >= 0 ? nearest.i : -1, avoid: sc.avoid[i], sim: sc.score[i], couple: cp ? { liked: cp.liked[i], similar: cp.similar[i] } : null });
    if (out.length >= top) break;
  }
  // exploration: the last few places go to a spread of roles far from everything you liked and not near anything you disliked,
  // so a second or third interest that no rating has touched yet still gets a chance to show up
  if (explore > 0 && out.length) {
    const taken = new Set(out.map((r) => r.i)), far = (i) => ok(i) && !taken.has(i) && sc.pos[i] < 0.25 && sc.pen[i] <= 0;
    const ex = sampleSpread(ix, far, explore, rng), step = Math.max(2, Math.floor(Math.min(20, out.length) / explore));      // one in every `step` of the first 20 places
    ex.forEach((i, k) => { out.splice(Math.min(out.length, step * (k + 1) - 1), 0, { i, score: 0, area: -1, near: -1, avoid: -1, sim: sc.score[i], couple: null, explore: true }); });
    out.length = Math.min(out.length, top);
  }
  return { results: out, areas: space.areas.map((a) => a.members.filter((m) => m.i >= 0).map((m) => m.i)).filter((a) => a.length), areaCount: space.areas.filter((a) => a.members.some((m) => m.i !== -1)).length, avoided: space.avoid.map((x) => x.i), unused: space.unused };
}
/** Roles that contain any of the words in `text` (title or description): a hard narrowing, as 1 / 0 per role. Null for an empty text. */
/** Roles carrying any of the given board field tags (names), as 1 / 0 per role. */
export function matchFields(ix, names) { const m = names.reduce((a, n) => a | (1 << ix.fields.indexOf(n)), 0); return Uint8Array.from(ix.attrs, (a) => ((a[4] || 0) & m ? 1 : 0)); }
export function matchAny(ix, text) { if (!tokens(text).length) return null; const s = bm25(ix, text, 200).score; return Uint8Array.from(s, (x) => (x > 0 ? 1 : 0)); }
/** A spread of roles to start rating from: random roles that pass the filter, then the most different from the ones already picked. */
export function sampleSpread(ix, ok, n = 12, rng = Math.random) {
  const pool = []; for (let tries = 0; pool.length < 400 && tries < 6000; tries++) { const i = Math.floor(rng() * ix.n); if (ix.vrow[i] >= 0 && ok(i) && !pool.includes(i)) pool.push(i); }
  if (!pool.length) return []; const vs = pool.map((i) => roleVec(ix, i)), pick = [0], best = vs.map((v) => dotv(v, vs[0]));
  while (pick.length < Math.min(n, pool.length)) {
    let m = -1, ms = 9; best.forEach((s, k) => { if (!pick.includes(k) && s < ms) { ms = s; m = k; } });
    pick.push(m); vs.forEach((v, k) => { best[k] = Math.max(best[k], dotv(v, vs[m])); });
  }
  return pick.map((k) => pool[k]);
}
