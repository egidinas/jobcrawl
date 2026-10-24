// Role atlas: a network map of the board, drawn the way maps of science are drawn (jobcrawl/map/atlas.py builds the layout):
// roles linked to their nearest roles by meaning, grouped by community detection (regions and finer neighbourhoods),
// and placed on the plane by relaxing that network (UMAP). Labels name each group by its distinctive title words, fields
// and the statements it leans to. Roles newer than the layout are placed at the mean position of their nearest mapped roles.
// Nothing is uploaded; no model download unless a CV is read.
import { loadConfig, dataUrl, roleLink, storageKey, L, esc, isDe, pick } from './app.js';
import { makeIndex, tasteScores, tasteWeight } from './match.js';
import * as PF from './profile.js';
const cfg = await loadConfig();
PF.setPersonas(cfg.personas);
const K = PF.keys();
const mount = document.getElementById('atlas-mount'); if (!mount) throw new Error('no #atlas-mount');
// the scopes of config.json, in order: a role's scope bits (match-attrs.json) follow this order
const scopeOpts = cfg.scopes.map((x, k) => `<option value="${k}"${k === 0 ? ' selected' : ''}>${L(x.label.en, x.label.de)}</option>`).join('');
const ANY = (() => { const k = cfg.scopes.findIndex((x) => x.match && x.match.any); return k < 0 ? cfg.scopes.length - 1 : k; })();   // the scope with every role: the whole-map layout
const loadRatings = () => { try { return JSON.parse(localStorage.getItem(K.ratings) || '{}'); } catch (e) { return {}; } };
const saveRatings = (r) => { try { localStorage.setItem(K.ratings, JSON.stringify(r)); } catch (e) { /* kept for this page only */ } };
let ratings = loadRatings();

const style = document.createElement('style');
style.textContent = `
.atlas-grid{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:18px;align-items:start}
@media(max-width:900px){.atlas-grid{grid-template-columns:1fr}}
.atlas-bar{display:flex;gap:10px 16px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px}
.atlas-bar label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
.atlas-bar select{padding:7px 8px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font:inherit;font-size:14px}
.atlas-views button,.atlas-fields button,.atlas-side button.sm,.atlas-shape button.sm{all:unset;cursor:pointer;font-size:13px;padding:5px 11px;border:1px solid var(--line);border-radius:14px;color:var(--muted)}
.atlas-views button[aria-pressed=true],.atlas-fields button[aria-pressed=true]{border-color:var(--accent-text);color:var(--accent-text);font-weight:600}
.atlas-views{display:flex;gap:6px;flex-wrap:wrap}.atlas-fields{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.atlas-stage{user-select:none;-webkit-user-select:none;position:relative;border:1px solid var(--line);border-radius:10px;background:var(--panel);overflow:hidden}
.atlas-stage canvas{display:block;width:100%;height:auto;touch-action:none;cursor:grab}
.atlas-zoom{position:absolute;right:8px;top:8px;display:flex;flex-direction:column;gap:4px}.atlas-zoom button{all:unset;cursor:pointer;width:30px;height:30px;text-align:center;line-height:30px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font-size:16px}.atlas-zoom button:focus-visible{outline:2px solid var(--accent)}
.atlas-area{border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:var(--panel);font-size:13px;display:flex;flex-direction:column;gap:3px}.atlas-area b{font-size:14px}.atlas-area .lean{color:var(--muted)}
.atlas-side{display:flex;flex-direction:column;gap:10px;min-width:0}
.atlas-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.atlas-item{border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:var(--paper);min-width:0}
.atlas-item .t{font-weight:600;overflow-wrap:anywhere;font-size:14px;color:var(--ink);text-decoration:none}.atlas-item .t:hover{color:var(--accent-text);text-decoration:underline}
.atlas-item .m{font-size:12.5px;color:var(--muted)}
.atlas-vote{display:inline-flex;gap:2px;margin-top:4px}.atlas-vote button{all:unset;cursor:pointer;font-size:13px;padding:2px 8px;border:1px solid var(--line);border-radius:5px;color:var(--muted)}.atlas-vote button.on{background:var(--accent);color:var(--btn-fg,#fff);border-color:var(--accent)}
.atlas-item .hd{all:unset;cursor:pointer;font-weight:600;overflow-wrap:anywhere;font-size:14px;color:var(--ink);display:block}.atlas-item .hd:hover{color:var(--accent-text)}.atlas-item .hd::after{content:'▾';margin-left:6px;color:var(--muted);font-weight:400}.atlas-item.open .hd::after{content:'▴'}.atlas-item .snip{font-size:12.5px;color:var(--muted);margin-top:3px;overflow-wrap:anywhere}.atlas-item .more{display:none;flex-direction:column;gap:8px;margin-top:8px}.atlas-item.open .more{display:flex}.atlas-item.open .snip{display:none}.atlas-item .facts{display:flex;gap:4px 12px;flex-wrap:wrap;font-size:12.5px;color:var(--muted)}.atlas-item .txt{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13.5px;line-height:1.5;max-height:22em;overflow:auto;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}.atlas-item .links{display:flex;gap:12px;flex-wrap:wrap;font-size:13.5px}.co-roles{margin:0;padding-left:18px;font-size:13.5px}
.atlas-shape{border:1px solid var(--line);border-radius:10px;background:var(--panel);margin-bottom:12px}.atlas-shape>summary{cursor:pointer;padding:10px 14px;list-style:none}.atlas-shape>summary::-webkit-details-marker{display:none}
.shape-body{padding:0 14px 14px;display:flex;flex-direction:column;gap:12px}.prefs{display:grid;grid-template-columns:1fr auto 1fr;gap:6px 10px;align-items:center;font-size:13px}
.prefs .pa{text-align:right}.prefs .pb{text-align:left}.pref5{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}.pref5 button{all:unset;cursor:pointer;width:26px;height:24px;text-align:center;border-right:1px solid var(--line);color:var(--muted);font-size:12px}.pref5 button:last-child{border-right:0}.pref5 button.on{background:var(--accent);color:var(--btn-fg,#fff)}.pref5 button:focus-visible{outline:2px solid var(--accent)}
@media(max-width:600px){.prefs{grid-template-columns:1fr}.prefs .pa,.prefs .pb{text-align:left}}
.shape-cv{display:flex;flex-direction:column;gap:6px}.shape-cv textarea{width:100%;min-height:80px;box-sizing:border-box;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font:inherit;font-size:13px}
.personas{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px}.personas button{all:unset;cursor:pointer;font-size:12.5px;padding:4px 10px;border:1px solid var(--line);border-radius:12px;color:var(--muted)}.personas button[aria-pressed=true]{border-color:var(--accent-text);color:var(--accent-text);font-weight:600}.personas button:focus-visible{outline:2px solid var(--accent)}
.shape-save{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
.shape-toggle{font-size:13px;display:flex;gap:6px;align-items:center}
.atlas-note{font-size:12.5px;color:var(--muted)}
`;
document.head.appendChild(style);
mount.innerHTML = `<div class="atlas-bar">
<div class="atlas-views" id="atlas-mode" role="group"><button type="button" data-m="roles" aria-pressed="true">${L('Roles', 'Stellen')}</button><button type="button" data-m="companies" aria-pressed="false">${L('Companies', 'Firmen')}</button></div>
<label>${L('Where', 'Wo')}<select id="atlas-scope">${scopeOpts}</select></label>
<label>${L('Lens size', 'Lupengröße')}<select id="atlas-size"><option value="0.05">${L('small', 'klein')}</option><option value="0.09" selected>${L('medium', 'mittel')}</option><option value="0.16">${L('large', 'groß')}</option></select></label>
</div>
<div class="atlas-fields" id="atlas-fields" role="group"></div>
<details class="atlas-shape" id="atlas-shape"><summary><strong>${L('Shape the map to you', 'Die Karte auf Sie zuschneiden')}</strong> <span class="atlas-note">${L('optional: a few statements, your CV, and the roles and companies you mark below', 'optional: ein paar Aussagen, Ihr CV und die Stellen und Firmen, die Sie unten markieren')}</span></summary>
<div class="shape-body"><div class="personas" id="atlas-personas"></div><div class="prefs" id="atlas-prefs"></div>
<div class="shape-cv" id="atlas-cvbox"></div>
<div class="shape-save"><button type="button" class="sm" id="atlas-forget">${L('Forget everything on this device', 'Alles auf diesem Gerät vergessen')}</button> <button type="button" class="sm" id="atlas-save">${L('Save my profile as a file', 'Mein Profil als Datei speichern')}</button> <label class="atlas-note"><input type="checkbox" id="atlas-save-cv"> ${L('include my CV (as numbers)', 'mit CV (als Zahlen)')}</label> <label class="atlas-note">${L('Load a saved profile: ', 'Gespeichertes Profil laden: ')}<input type="file" id="atlas-load" accept=".json,application/json"></label></div>
<label class="shape-toggle"><input type="checkbox" id="atlas-taste" checked> ${L('Show how well each area fits me (bright: close to my profile, faint: far from it)', 'Zeigen, wie gut jeder Bereich zu mir passt (hell: nah an meinem Profil, blass: weit weg)')}</label>
<label class="shape-toggle"><input type="checkbox" id="atlas-all"> ${L('Show every role (otherwise at most three per employer and neighbourhood, so big employers do not crowd the map)', 'Jede Stelle zeigen (sonst höchstens drei je Arbeitgeber und Nachbarschaft, damit große Arbeitgeber die Karte nicht füllen)')}</label></div></details>
<div class="atlas-grid"><div>
<div class="atlas-stage"><canvas id="atlas-cv" width="900" height="640"></canvas><div class="atlas-zoom"><button type="button" id="atlas-zin" aria-label="zoom in">+</button><button type="button" id="atlas-zout" aria-label="zoom out">−</button><button type="button" id="atlas-zreset" aria-label="whole map">⟲</button></div></div>
<p class="atlas-note" id="atlas-status">${L('Loading the roles…', 'Lade die Stellen …')}</p></div>
<div class="atlas-side"><div class="atlas-area" id="atlas-area"></div><div class="atlas-bar" style="margin:0"><strong>${L('In the lens', 'In der Lupe')}</strong><button type="button" class="sm" id="atlas-shuffle">${L('Another sample', 'Andere Stichprobe')}</button></div>
<ul class="atlas-list" id="atlas-list"></ul>
<p class="atlas-note">${L('Big employers do not crowd the sample: roles are drawn with a weight that falls with the number of roles the employer has in the lens. ▲ more like this, ● ignore, ▼ less like this. Marks stay on this device and carry over to Match me.', 'Große Arbeitgeber verdrängen die Stichprobe nicht: Die Auswahl gewichtet nach der Zahl der Stellen des Arbeitgebers in der Lupe. ▲ mehr davon, ● ignorieren, ▼ weniger davon. Markierungen bleiben auf diesem Gerät und gelten auch in „Passende Stellen für mich“.')}</p></div></div>`;
const $ = (id) => mount.querySelector('#' + id);

// ---- data
const VECTORS_MISSING = L('The atlas needs the match vectors and the map layout: run jobcrawl embed, jobcrawl map and jobcrawl publish.', 'Die Atlas braucht die Bedeutungsvektoren und das Kartenlayout: jobcrawl embed, jobcrawl map und jobcrawl publish ausführen.');
if (!(await fetch(dataUrl('match/match-vec.json'), { method: 'HEAD' }).catch(() => null))?.ok) { $('atlas-status').innerHTML = VECTORS_MISSING; throw new Error('no match-vec.json in the data folder'); }
const [vj, at, vb, rows] = await Promise.all(['match-vec.json', 'match-attrs.json'].map((f) => fetch(dataUrl('match/' + f)).then((r) => r.json())).concat([fetch(dataUrl('match/match-vec.bin')).then((r) => r.arrayBuffer()), fetch(dataUrl('jobs-index.json')).then((r) => r.json())]));
const graph = await Promise.all([fetch(dataUrl('match/role-graph.json')).then((r) => r.json()), fetch(dataUrl('match/role-nb.bin')).then((r) => r.arrayBuffer())]).then(([g0, b]) => ({ ...g0, nb: new Uint16Array(b) })).catch(() => null);
const ix = makeIndex({ n: rows.length, avgdl: 1, ids: rows.map((r) => r[0]), len: [], idf: {}, post: {} }, vj, at, new Int8Array(vb), graph);
const D = ix.dim, N = ix.n, have = []; for (let i = 0; i < N; i++) if (ix.vrow[i] >= 0) have.push(i);
const X = new Float32Array(have.length * D);
have.forEach((i, k) => { let n = 0; for (let d = 0; d < D; d++) { const x = ix.vec[ix.vrow[i] * D + d]; X[k * D + d] = x; n += x * x; } n = Math.sqrt(n) || 1; for (let d = 0; d < D; d++) X[k * D + d] /= n; });

// ---- layers from the network layout
const CVEC = await Promise.all([fetch(dataUrl('match/company-vec.json')).then((r) => r.json()), fetch(dataUrl('match/company-vec.bin')).then((r) => r.arrayBuffer())]).then(([j, b]) => ({ slugs: j.slugs, vec: new Int8Array(b) })).catch(() => null);
const LAY = await fetch(dataUrl('match/atlas-layout.json')).then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (!LAY) { $('atlas-status').innerHTML = L('The map layout is not published yet.', 'Das Kartenlayout ist noch nicht veröffentlicht.'); throw new Error('no atlas-layout.json'); }
const pos = new Int32Array(N).fill(-1); have.forEach((i, k) => { pos[i] = k; });
const unit = (v) => { let t = 0; for (let d = 0; d < D; d++) t += v[d] * v[d]; t = Math.sqrt(t) || 1; return Float32Array.from(v, (x) => x / t); };
const vecOf = (i) => X.subarray(pos[i] * D, pos[i] * D + D);
const idIndex = new Map(ix.ids.map((id, i) => [id, i]));
function roleLayer(R = LAY.roles, scope = ANY) {
  const ents = [], mapped = [];
  R.ids.forEach((id, k) => { const i = idIndex.get(id); if (i !== undefined) { ents.push({ id, idx: [i], x: R.x[k], y: R.y[k], c1: R.c1[k], c2: R.c2[k], hidden: R.rep ? R.rep[k] >= 0 : false }); if (pos[i] >= 0) mapped.push(ents.length - 1); } });
  // roles that came after the layout: the mean position of their 8 nearest mapped roles, and the most common group among them
  // only roles newer than the whole layout (not in the worldwide map) and inside this map's region are placed here
  const inLayout = new Set(LAY.roles.ids); let placed = 0;
  for (const i of have) { if (inLayout.has(ix.ids[i]) || (ix.attrs[i][0] >> scope & 1) !== 1) continue; const v = vecOf(i), best = [];
    for (const k of mapped) { const w = ents[k], u = vecOf(w.idx[0]); let s = 0; for (let d = 0; d < D; d++) s += v[d] * u[d]; if (best.length < 8 || s > best[best.length - 1][0]) { best.push([s, k]); best.sort((a, b) => b[0] - a[0]); if (best.length > 8) best.pop(); } }
    const mode = (f) => { const c = new Map(); best.forEach(([, k]) => c.set(ents[k][f], (c.get(ents[k][f]) || 0) + 1)); return [...c].sort((a, b) => b[1] - a[1])[0][0]; };
    ents.push({ id: ix.ids[i], idx: [i], x: best.reduce((t, [, k]) => t + ents[k].x, 0) / best.length, y: best.reduce((t, [, k]) => t + ents[k].y, 0) / best.length, c1: mode('c1'), c2: mode('c2'), late: true }); placed++; }
  return { kind: 'roles', ents, n: ents.length, regions: R.regions, hoods: R.hoods, links: R.links, placed };
}
function companyLayer() {
  const C = LAY.companies, byCo = new Map(); rows.forEach((r, i) => { if (pos[i] >= 0 && r[4]) { if (!byCo.has(r[4])) byCo.set(r[4], []); byCo.get(r[4]).push(i); } });
  // every catalogue company, also those without open roles (placed from their own profile text); their vector for marks:
  // the centre of their roles, or else their profile vector (company-vec)
  const cv0 = new Map(); if (CVEC) CVEC.slugs.forEach((slug, k) => { const v = new Float32Array(D); for (let d = 0; d < D; d++) v[d] = CVEC.vec[k * D + d]; cv0.set(slug, unit(v)); });
  const ents = C.slugs.map((slug, k) => { const idx = byCo.get(slug) || []; let vec;
    if (idx.length) { const sum = new Float32Array(D); idx.forEach((i) => { const v = vecOf(i); for (let d = 0; d < D; d++) sum[d] += v[d]; }); vec = unit(sum); } else vec = cv0.get(slug) || null;
    return { id: 'co:' + slug, slug, name: C.names ? C.names[k] : (idx.length ? rows[idx[0]][2] : slug), about: C.about ? C.about[k] : '', field: C.field ? C.field[k] : '', idx, vec, x: C.x[k], y: C.y[k], c1: C.c1[k], c2: C.c1[k] }; });
  ents.forEach((e) => { e.f = new Float32Array(ix.fields.length); e.idx.forEach((i) => ix.fields.forEach((f, q) => { if (ix.attrs[i][4] >> q & 1) e.f[q] += 1 / e.idx.length; })); });
  return { kind: 'companies', ents, n: ents.length, regions: C.regions, hoods: C.regions, links: [] };
}
// one role map per region filter with enough roles (built separately, so a smaller area spreads over the whole map);
// filters without a map of their own use the next larger one and only hide what is outside
const roleMaps = new Map();
function roleMapFor(scope) {
  for (let s0 = scope; s0 < cfg.scopes.length; s0++) { const name = cfg.scopes[s0].id, R = s0 === ANY ? LAY.roles : (LAY.scopes || {})[name];
    if (R) { if (!roleMaps.has(name)) roleMaps.set(name, roleLayer(R, s0)); return roleMaps.get(name); } }
  return roleLayer();
}
const layers = { roles: roleMapFor(0), companies: companyLayer() };
const coEnts = layers.companies.ents.filter((e) => e.vec);

// ---- taste: marks, statements and a CV, shared with Match me through this browser's storage (numbers only, never the CV text)
const prefDefs = (await fetch(dataUrl('match/match-prefs.json')).then((r) => (r.ok ? r.json() : { prefs: [] })).catch(() => ({ prefs: [] }))).prefs.map((p) => ({ ...p, v: Float32Array.from(p.v) }));
const getJ = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } };
const setJ = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* this page only */ } };
let prefVals = getJ(K.prefs, {}), cvEmb = getJ(K.cv, null);
let taste = null;
const personaVecs = PF.personaVectors(ix, rows);
function computeTaste() {
  const items = [], extra = [], bad = new Map(), empStars = new Map();
  for (const [id, r] of Object.entries(ratings)) {
    const w = tasteWeight(r);
    if (id.startsWith('co:')) { const slug = id.slice(3), e = coEnts.find((c) => c.slug === slug); if (e && w) { extra.push({ w, vec: e.vec, co: slug }); if (w < 0) bad.set(slug, 1); } continue; }
    const i = idIndex.get(id); if (i === undefined) continue;
    if (w !== null) items.push({ i, w, coW: r.company ? (r.company - 3) / 2 : undefined });
    if (r.company) { const k = rows[i][4]; empStars.set(k, [...(empStars.get(k) || []), r.company]); }
  }
  for (const [k, v] of empStars) { const avg = v.reduce((a, b) => a + b, 0) / v.length; if (avg < 3) bad.set(k, Math.max(bad.get(k) || 0, Math.min(1, (3 - avg) / 2))); }
  for (const x of PF.personaExtras(personaVecs)) extra.push(x);
  const prefs = prefDefs.map((p) => ({ ...p, val: prefVals[p.id] || 0 }));
  const cv = cvEmb && cvEmb.on !== false && cvEmb.v ? cvEmb.v : null;
  const signals = items.filter((x) => x.w).length + extra.length + prefs.filter((p) => p.val).length + (cv ? 3 : 0);
  if (!signals) { taste = null; return; }
  const { space, sc } = tasteScores(ix, { items, extra, cvEmbedding: cv, coKey: (i) => rows[i][4], coupling: 0.15, badCompanies: bad, prefs });
  taste = { pos: sc.pos, pen: sc.pen, positive: space.areas.length > 0 || prefs.some((p) => p.val), signals };
}
function renderPersonas() {
  const chosen = PF.chosenPersonas(), w = PF.personaWeight();
  $('atlas-personas').innerHTML = `<span>${L('Start from (optional, up to two):', 'Ausgangspunkt (optional, bis zu zwei):')}</span>` + PF.personas().filter((p) => personaVecs[p.id]).map((p) => `<button type="button" data-persona="${p.id}" aria-pressed="${chosen.includes(p.id)}">${L(p.label.en, p.label.de)}</button>`).join('')
    + (chosen.length ? ` <span class="atlas-note">${w ? L(`its pull: ${Math.round(w / PF.START_WEIGHT * 100)} %, fading as you mark and explore`, `Sog: ${Math.round(w / PF.START_WEIGHT * 100)} %, schwindet, je mehr Sie markieren und erkunden`) : L('faded: your marks lead now', 'verblasst: jetzt führen Ihre Markierungen')}</span>` : '');
}
function renderPrefs() {
  $('atlas-prefs').innerHTML = prefDefs.length ? prefDefs.map((p) => `<span class="pa">${L(p.a[0], p.a[1])}</span><span class="pref5" data-p="${p.id}" role="group">${[2, 1, 0, -1, -2].map((v) => `<button type="button" data-v="${v}" class="${(prefVals[p.id] || 0) === v && v !== 0 ? 'on' : ''}" aria-pressed="${(prefVals[p.id] || 0) === v}" title="${v === 0 ? (isDe() ? 'egal' : 'no preference') : ''}">${v === 0 ? '·' : Math.abs(v) === 2 ? '●' : '•'}</button>`).join('')}</span><span class="pb">${L(p.b[0], p.b[1])}</span>`).join('')
    : `<span class="atlas-note">${L('No statements published yet.', 'Noch keine Aussagen veröffentlicht.')}</span>`;
}
function renderCv() {
  const has = cvEmb && cvEmb.v;
  $('atlas-cvbox').innerHTML = has
    ? `<label class="shape-toggle"><input type="checkbox" id="atlas-cv-on" ${cvEmb.on !== false ? 'checked' : ''}> ${L('Include my CV (read on this device; only its numbers are kept, not the text)', 'Meinen CV einbeziehen (auf diesem Gerät gelesen; nur seine Zahlen bleiben gespeichert, nicht der Text)')}</label><button type="button" class="sm" id="atlas-cv-forget">${L('Forget my CV', 'CV vergessen')}</button>`
    : `<textarea id="atlas-cv-text" ${`placeholder="${esc(isDe() ? 'Optional: CV oder ein paar Zeilen zu Ihrer Arbeit einfügen' : 'Optional: paste your CV or a few lines about your work')}"`}></textarea><label class="atlas-note">${L('or a CV file (PDF or text, read on this device): ', 'oder eine CV-Datei (PDF oder Text, auf diesem Gerät gelesen): ')}<input type="file" id="atlas-cv-file" accept=".pdf,.txt,.md,application/pdf,text/plain"></label><div><button type="button" class="sm" id="atlas-cv-read">${L('Read it with the model (about 200 MB, once)', 'Mit dem Modell lesen (ca. 200 MB, einmalig)')}</button> <span class="atlas-note" id="atlas-cv-status"></span></div>`;
}
renderPersonas(); renderPrefs(); renderCv(); computeTaste();

// ---- state, view and drawing
const st = { all: false, mode: 'roles', scope: 0, size: 0.09, fields: new Set(), lens: { x: 0.5, y: 0.5 }, sample: [], open: new Set(), z: { s: 1, cx: 0.5, cy: 0.5 } };
$('atlas-fields').innerHTML = ix.fields.map((f) => `<button type="button" data-f="${esc(f)}" aria-pressed="false">${esc(f)}</button>`).join('');
const cv = $('atlas-cv'), g = cv.getContext('2d'), W = cv.width, H = cv.height, css = (n) => getComputedStyle(document.body).getPropertyValue(n).trim() || '#888';
const lay = () => layers[st.mode];
const roleVisible = (i) => (ix.attrs[i][0] >> st.scope & 1) === 1 && (!st.fields.size || [...st.fields].some((f) => ix.attrs[i][4] >> ix.fields.indexOf(f) & 1));
const visibleRoles = (e) => e.idx.filter(roleVisible);
function tw(r) { if (r.vote !== undefined) return r.vote; const v = []; if (r.role) v.push((r.role - 3) / 2); if (r.interest) v.push((r.interest - 3) / 2); if (r.apply !== undefined) v.push(r.apply); return v.length ? Math.sign(v.reduce((a, b) => a + b, 0)) : null; }
const voteOf = (id) => (ratings[id] ? tw(ratings[id]) : null);
// map units (0..1, from the layout) to canvas pixels and back; s is the zoom, (cx, cy) the map point in the middle of the canvas
const sx = (x) => ((x - st.z.cx) * st.z.s + 0.5) * W, sy = (y) => ((y - st.z.cy) * st.z.s + 0.5) * H;
const ux = (px) => (px / W - 0.5) / st.z.s + st.z.cx, uy = (py) => (py / H - 0.5) / st.z.s + st.z.cy;
const hue = (c) => (c * 137.508) % 360;      // one colour per region, spread around the colour wheel
// region colours of equal perceived lightness and colourfulness (OKLCH), so no hue looks stronger than another
function oklch(L, C, h) {
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  return lin.map((x) => Math.round(255 * Math.max(0, Math.min(1, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055))));
}
const rgbCache = new Map(), regionRgb = (c, L) => { const k = c + '/' + L; if (!rgbCache.has(k)) rgbCache.set(k, oklch(L, 0.13, hue(c))); return rgbCache.get(k); };
let densAt = () => 1;      // how crowded a point's spot on screen is, relative to a typical spot (set by colourField)
// a group's name: the hand-written key term (atlas-labels.json), else its first two distinctive words
const nameOf = (r) => (r.label ? r.label[isDe() ? 1 : 0] : r.words.slice(0, 2).map((w) => w[0].toUpperCase() + w.slice(1)).join(' & '));
const leanText = (lean) => (lean || []).map(([id, sign]) => { const p = prefDefs.find((q) => q.id === id); return p ? (sign > 0 ? p.a : p.b)[isDe() ? 1 : 0] : ''; }).filter(Boolean);
let vis = [], act = [], fit = null;
function grid(GW, GH, add) {      // per screen cell: sums of add(k) over visible entities in it
  const A = new Float32Array(GW * GH), Ly = lay();
  Ly.ents.forEach((e, k) => { if (!vis[k]) return; const X0 = sx(e.x) / W, Y0 = sy(e.y) / H; if (X0 < 0 || X0 >= 1 || Y0 < 0 || Y0 >= 1) return; A[Math.floor(Y0 * GH) * GW + Math.floor(X0 * GW)] += add(k); });
  return A;
}
function blur(A, GW, GH, passes) { for (let pass = 0; pass < passes; pass++) { const t = new Float32Array(A.length); for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) { let q = 0, m = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < GW && yy < GH) { q += A[yy * GW + xx]; m++; } } t[y * GW + x] = q / m; } A.set(t); } }
function paint(A, GW, GH, rgb, alphaOf) {
  const small = document.createElement('canvas'); small.width = GW; small.height = GH; const sg = small.getContext('2d'), img = sg.createImageData(GW, GH);
  for (let k = 0; k < A.length; k++) { img.data[k * 4] = rgb[0]; img.data[k * 4 + 1] = rgb[1]; img.data[k * 4 + 2] = rgb[2]; img.data[k * 4 + 3] = Math.round(255 * alphaOf(A[k])); }
  sg.putImageData(img, 0, 0); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.globalAlpha = 1; g.drawImage(small, 0, 0, W, H);
}
function draw() {
  const Ly = lay(), ink = css('--ink'), paper = css('--panel'), showTaste = taste && $('atlas-taste').checked, roles = st.mode === 'roles';
  act = Ly.ents.map((e) => visibleRoles(e).length > 0); vis = roles ? act : Ly.ents.map(() => true);
  g.clearRect(0, 0, W, H);
  // links between neighbourhoods (share of neighbour links that cross), then the points coloured by region
  if (roles && Ly.links.length) { const mx = Math.max(...Ly.links.map((l) => l[2])); g.strokeStyle = ink; g.lineWidth = 1;
    for (const [a, b, w] of Ly.links) { const A = Ly.hoods[a].xy, B = Ly.hoods[b].xy; g.globalAlpha = 0.05 + 0.25 * (w / mx); g.beginPath(); g.moveTo(sx(A[0]), sy(A[1])); g.lineTo(sx(B[0]), sy(B[1])); g.stroke(); } }
  // a soft colour field behind the points: each region's colour, blended where regions meet, stronger where points are dense
  fit = showTaste ? fitOf(Ly) : null;
  colourField(Ly, 0.42);
  const dot = (roles ? 2 : 5) * Math.min(2.5, Math.sqrt(st.z.s)); let shown = 0;
  Ly.ents.forEach((e, k) => { if (!vis[k]) return; if (act[k]) shown++; if (e.hidden && !st.all) return; const X0 = sx(e.x), Y0 = sy(e.y); if (X0 < -5 || Y0 < -5 || X0 > W + 5 || Y0 > H + 5) return;
    // crowded spots get fainter points so a dense cluster does not glare; sparse ones keep full strength
    const rgb = regionRgb(e.c1, act[k] ? 0.78 : 0.55); g.globalAlpha = (act[k] ? 0.9 : 0.4) * Math.min(1, 1 / Math.sqrt(densAt(X0, Y0))) * (fit ? 0.12 + 0.88 * fit[k] : 1); g.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    if (roles) g.fillRect(X0 - dot / 2, Y0 - dot / 2, dot, dot); else { g.beginPath(); g.arc(X0, Y0, dot / 2, 0, 7); if (act[k]) g.fill(); else { g.strokeStyle = g.fillStyle; g.lineWidth = 1; g.stroke(); } } });
  Ly.ents.forEach((e) => { const v = voteOf(e.id); if (!v) return; const col = v > 0 ? '#2fb36b' : '#d9534f', x = sx(e.x), y = sy(e.y); g.globalAlpha = 1; g.fillStyle = col; g.strokeStyle = paper; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill(); g.stroke(); });
  // group labels: regions at full view, neighbourhoods when zoomed in. A label is drawn only where it fits completely inside
  // the map, clear of the zoom buttons, the lens and every label already placed (larger groups first); otherwise it is left out.
  const groups = (roles && st.z.s >= 2.2 ? Ly.hoods : Ly.regions).map((r, k) => ({ r, k })).sort((a, b) => b.r.n - a.r.n), boxes = [[W - 56, 0, W, 130]];
  const lr = st.size * W + 6, lcx = sx(st.lens.x), lcy = sy(st.lens.y);
  const hitsLens = (b) => { const nx = Math.max(b[0], Math.min(lcx, b[2])), ny = Math.max(b[1], Math.min(lcy, b[3])); return Math.hypot(nx - lcx, ny - lcy) < lr; };
  g.textAlign = 'center'; g.textBaseline = 'middle'; let placed = 0;
  for (const { r } of groups) {
    if ((!r.words.length && !r.label) || placed >= 24) continue; const x = sx(r.xy[0]), y = sy(r.xy[1]);
    const fs = Math.round(Math.max(11, Math.min(18, 7 + Math.sqrt(r.n) * 0.33))), t1 = nameOf(r), t2 = '';
    g.font = `600 ${fs}px system-ui, sans-serif`; const w1 = g.measureText(t1).width; g.font = `400 ${fs - 3}px system-ui, sans-serif`; const w2 = t2 ? g.measureText(t2).width : 0;
    const bw = Math.max(w1, w2) + 10, bh = fs + (t2 ? fs : 0) + 6, box = [x - bw / 2, y - bh / 2, x + bw / 2, y + bh / 2];
    if (box[0] < 4 || box[1] < 4 || box[2] > W - 4 || box[3] > H - 4) continue;
    if (hitsLens(box) || boxes.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
    boxes.push(box); placed++;
    g.globalAlpha = 1; g.lineJoin = 'round'; g.lineWidth = 4; g.strokeStyle = paper; g.fillStyle = ink;
    g.font = `600 ${fs}px system-ui, sans-serif`; const y1 = t2 ? y - fs * 0.45 : y; g.strokeText(t1, x, y1); g.fillText(t1, x, y1);
    if (t2) { g.font = `400 ${fs - 3}px system-ui, sans-serif`; g.globalAlpha = 0.8; g.strokeText(t2, x, y + fs * 0.6); g.fillText(t2, x, y + fs * 0.6); }
  }
  // the lens and the sampled points
  const r = st.size * W, lx = sx(st.lens.x), ly = sy(st.lens.y); g.globalAlpha = 1; g.strokeStyle = ink; g.lineWidth = 2; g.setLineDash([6, 4]); g.beginPath(); g.arc(lx, ly, r, 0, 7); g.stroke(); g.setLineDash([]);
  g.fillStyle = ink; st.sample.forEach((k) => { const e = Ly.ents[k]; g.beginPath(); g.arc(sx(e.x), sy(e.y), 4, 0, 7); g.fill(); });
  const unitEn = roles ? 'roles' : 'companies', unitDe = roles ? 'Stellen' : 'Firmen';
  $('atlas-status').innerHTML = L(`${shown.toLocaleString()} ${unitEn} shown${roles && Ly.placed ? ` (${Ly.placed} newer roles placed next to their nearest neighbours)` : ''}. Colours are regions of closely linked ${unitEn}; lines join neighbourhoods that share many links. Drag the dashed lens to sample an area, drag elsewhere to move the map, zoom with + and − or the mouse wheel.${showTaste ? '  Brightness shows how well an area fits your profile; with little to go on the contrast is low.' : ''}`,
    `${shown.toLocaleString('de-DE')} ${unitDe} gezeigt${roles && Ly.placed ? ` (${Ly.placed} neuere Stellen neben ihren nächsten Nachbarn platziert)` : ''}. Farben sind Regionen eng verbundener ${unitDe}; Linien verbinden Nachbarschaften mit vielen gemeinsamen Verbindungen. Die gestrichelte Lupe ziehen, um einen Bereich zu sehen, daneben ziehen, um die Karte zu verschieben, mit + und − oder dem Mausrad zoomen.${showTaste ? '  Die Helligkeit zeigt, wie gut ein Bereich zu Ihrem Profil passt; solange wenig bekannt ist, ist der Kontrast gering.' : ''}`);
}
// how well each point fits the visitor's profile, 0..1: its rank among the visible points by taste score (the best fifth near 1).
// With few signals the contrast is reduced, so a thin profile only tints the map.
function fitOf(Ly) {
  const n = Ly.n, sc = new Float32Array(n).fill(-9), order = [];
  Ly.ents.forEach((e, k) => { if (!vis[k] || !e.idx.length) return; let best = -9; for (const i of e.idx) best = Math.max(best, taste.pos[i] - taste.pen[i]); sc[k] = best; order.push(k); });
  order.sort((a, b) => sc[a] - sc[b]); const out = new Float32Array(n).fill(0.25), contrast = Math.min(1, 0.4 + taste.signals / 15);
  order.forEach((k, r) => { const p = Math.pow((r + 1) / order.length, 2.2); out[k] = (1 - contrast) * 0.6 + contrast * p; });
  return out;
}
function colourField(Ly, strength) {
  // the colour of each spot is the blend of the region colours there; its strength does not depend on how many points are
  // there: full wherever points are, fading only towards empty space
  const GW = 96, GH = 68, R = new Float32Array(GW * GH), G = new Float32Array(GW * GH), B = new Float32Array(GW * GH), N = new Float32Array(GW * GH), C0 = new Float32Array(GW * GH);
  Ly.ents.forEach((e, k) => { if (!vis[k]) return; const X0 = sx(e.x) / W, Y0 = sy(e.y) / H; if (X0 < 0 || X0 >= 1 || Y0 < 0 || Y0 >= 1) return;
    const c = regionRgb(e.c1, 0.62), q = Math.floor(Y0 * GH) * GW + Math.floor(X0 * GW), w = fit ? 0.08 + fit[k] * fit[k] : 1;
    R[q] += c[0] * w; G[q] += c[1] * w; B[q] += c[2] * w; N[q] += w; C0[q]++; });
  const raw = Float32Array.from(C0), nz = [...raw].filter((x) => x > 0).sort((a, b) => a - b), typical = nz.length ? nz[Math.floor(nz.length / 2)] : 1;
  densAt = (px, py) => { const q = Math.min(GH - 1, Math.max(0, Math.floor(py / H * GH))) * GW + Math.min(GW - 1, Math.max(0, Math.floor(px / W * GW))); return Math.max(1, raw[q] / typical); };
  const passes = 4 + Math.min(4, Math.round(Math.log2(st.z.s + 1))); for (const A of [R, G, B, N, C0]) blur(A, GW, GH, passes);
  const cov = [...C0].filter((x) => x > 1e-3).sort((a, b) => a - b); if (!cov.length) return; const full = cov[Math.floor(cov.length * 0.3)] || 1e-3;
  const small = document.createElement('canvas'); small.width = GW; small.height = GH; const sg = small.getContext('2d'), img = sg.createImageData(GW, GH);
  for (let q = 0; q < N.length; q++) { const n = N[q]; if (n < 1e-4) continue;
    const coverage = Math.min(1, C0[q] / full), match = fit ? Math.min(1, 0.15 + 1.2 * n / Math.max(C0[q], 1e-6)) : 1;
    img.data[q * 4] = R[q] / n; img.data[q * 4 + 1] = G[q] / n; img.data[q * 4 + 2] = B[q] / n; img.data[q * 4 + 3] = Math.round(255 * strength * coverage * coverage * match); }
  sg.putImageData(img, 0, 0); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.globalAlpha = 1; g.drawImage(small, 0, 0, W, H);
}
// favoured / pushed-away field: per screen cell, the share of entities in the top of your taste (green) and under a penalty (red);
// the fewer signals there are, the more it is blurred, so a thin profile shows as a soft haze and sharpens as you mark more
function drawTaste(Ly) {
  const n = Ly.n, fav = new Float32Array(n), dis = new Float32Array(n), GW = 72, GH = 51;
  const ent = (k) => { const e = Ly.ents[k]; const sc = e.idx.map((i) => [taste.pos[i] - taste.pen[i], taste.pen[i]]).sort((a, b) => b[0] - a[0]).slice(0, 3); return [sc.reduce((t, x) => t + x[0], 0) / sc.length, sc.reduce((t, x) => t + x[1], 0) / sc.length]; };
  const vals = []; for (let k = 0; k < n; k++) if (vis[k]) { if (!Ly.ents[k].idx.length) { fav[k] = -9; continue; } const [s0, p] = ent(k); fav[k] = s0; dis[k] = p; vals.push(s0); }
  vals.sort((a, b) => a - b); const cut = vals[Math.floor(vals.length * 0.85)] ?? 0, topv = vals[vals.length - 1] ?? 1;
  const G = grid(GW, GH, (k) => (taste.positive ? Math.max(0, Math.min(1, (fav[k] - cut) / Math.max(1e-6, topv - cut))) : 0)), R = grid(GW, GH, (k) => Math.min(1, Math.max(0, dis[k] - 0.02) / 0.1)), C = grid(GW, GH, () => 1);
  const passes = 2 + Math.max(0, 5 - Math.floor(taste.signals / 3)); blur(G, GW, GH, passes); blur(R, GW, GH, passes); blur(C, GW, GH, passes);
  for (const [A, rgb] of [[G, [47, 179, 107]], [R, [217, 83, 79]]]) {
    let mx = 0; for (let k = 0; k < A.length; k++) { A[k] = C[k] > 0.02 ? A[k] / C[k] : 0; mx = Math.max(mx, A[k]); } if (mx <= 0) continue;
    for (let k = 0; k < A.length; k++) A[k] /= Math.max(mx, 0.25);
    paint(A, GW, GH, rgb, (a) => Math.min(0.75, Math.pow(a, 0.8) * 0.75));
  }
}
function inLens() {
  const Ly = lay(), r = st.size * W, lx = sx(st.lens.x), ly = sy(st.lens.y), out = [];
  Ly.ents.forEach((e, k) => { if (!vis[k]) return; const dx = sx(e.x) - lx, dy = sy(e.y) - ly; if (dx * dx + dy * dy <= r * r) out.push(k); });
  return out;
}
// what the lens is on: the neighbourhood most of its points belong to, with its words, fields and leanings
function renderArea(pool) {
  const Ly = lay(); if (!pool.length) { $('atlas-area').innerHTML = `<span class="atlas-note">${L('Move the lens onto the map.', 'Die Lupe auf die Karte ziehen.')}</span>`; return; }
  const c = new Map(); pool.forEach((k) => c.set(Ly.ents[k].c2, (c.get(Ly.ents[k].c2) || 0) + 1)); const h = Ly.hoods[[...c].sort((a, b) => b[1] - a[1])[0][0]];
  const hk = [...c].sort((a, b) => b[1] - a[1])[0][0], total = Ly.ents.filter((e) => e.c2 === hk).length;
  const reg = Ly.regions[Ly.ents[pool[0]].c1], lean = leanText(h.lean);
  $('atlas-area').innerHTML = `<span class="atlas-note">${L('This area', 'Dieser Bereich')}${st.mode === 'roles' && reg && reg !== h ? ' · ' + esc(nameOf(reg)) : ''}</span><b>${esc(nameOf(h))}</b><span class="atlas-note">${esc(h.words.join(' · '))}</span>`
    + `<span>${h.fields.length ? esc(h.fields.join(', ')) + ' · ' : ''}${total.toLocaleString()} ${st.mode === 'roles' ? L('roles in the neighbourhood', 'Stellen in der Nachbarschaft') : L('companies in the group', 'Firmen in der Gruppe')}, ${pool.length} ${L('in the lens', 'in der Lupe')}</span>`
    + (lean.length ? `<span class="lean">${L('Leans to: ', 'Neigt zu: ')}${esc(lean.join(' · '))}</span>` : '');
}
let rngState = 7; const rnd = () => (rngState = (rngState * 16807) % 2147483647) / 2147483647;
function resample() {
  draw();   // refreshes which entities are visible under the current filters
  const Ly = lay(), pool = inLens(), per = new Map(); pool.forEach((k) => { const c = st.mode === 'roles' ? rows[Ly.ents[k].idx[0]][2] : Ly.ents[k].name; per.set(c, (per.get(c) || 0) + 1); });
  // weighted draw without replacement: roles by 1/sqrt(roles of that employer in the lens), at most 2 per employer; companies all alike
  const out = [], taken = new Map(), w = pool.map((k) => (st.mode === 'roles' ? 1 / Math.sqrt(per.get(rows[Ly.ents[k].idx[0]][2])) : 1));
  for (let n = 0, guard = 0; n < 8 && pool.length && guard < 200; n++, guard++) {
    let tot = 0; w.forEach((x) => { tot += x; }); if (tot <= 0) break; let t = rnd() * tot, q = 0; for (; q < w.length - 1; q++) { t -= w[q]; if (t <= 0) break; }
    const c = st.mode === 'roles' ? rows[Ly.ents[pool[q]].idx[0]][2] : ''; if (st.mode === 'roles' && (taken.get(c) || 0) >= 2) { w[q] = 0; n--; continue; } taken.set(c, (taken.get(c) || 0) + 1); out.push(pool[q]); w[q] = 0;
  }
  st.sample = out; renderArea(pool); renderList(); draw();
}
// ---- the cards: a role or a company, closed (a few lines) or open (everything we hold)
const levelName = (k) => { const b = cfg.levels.find((x) => x.code === ix.levels[k]); return b ? pick(b.label.en, b.label.de) : ''; };
const shards = new Map();
const shard = (id) => { const k = id.slice(0, 2); if (!shards.has(k)) shards.set(k, fetch(dataUrl('jobs-desc-' + k + '.json')).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))); return shards.get(k); };
const voteHtml = (id) => `<div class="atlas-vote">${[[-1, '▼'], [0, '●'], [1, '▲']].map(([x, gl]) => `<button type="button" data-v="${x}" class="${ratings[id] && ratings[id].vote === x ? 'on' : ''}" aria-pressed="${ratings[id] && ratings[id].vote === x}">${gl}</button>`).join('')}</div>`;
const snip = (t, n) => { t = (t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n).replace(/\s\S*$/, '') + '…' : t; };
function cardHtml(k) {
  const e = lay().ents[k], open = st.open.has(e.id);
  if (st.mode === 'roles') { const i = e.idx[0], r = rows[i], reg = ix.regions[ix.attrs[i][3]] || '';
    return `<li class="atlas-item${open ? ' open' : ''}" data-k="${k}" data-id="${e.id}"><button type="button" class="hd" aria-expanded="${open}">${esc(r[1])}</button><div class="m">${esc(r[2])}${reg ? ' · ' + esc(reg) : ''}${ix.attrs[i][1] ? ' · ' + esc(levelName(ix.attrs[i][1])) : ''}</div><div class="snip"></div><div class="more"></div>${voteHtml(e.id)}</li>`; }
  const co = [e.about || ''], vr = visibleRoles(e), flds = ix.fields.map((f, q) => [f, e.f[q]]).filter((x) => x[1] >= 0.25).sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
  return `<li class="atlas-item${open ? ' open' : ''}" data-k="${k}" data-id="${e.id}"><button type="button" class="hd" aria-expanded="${open}">${esc(e.name)}</button><div class="m">${e.idx.length ? `${vr.length} ${L('open roles here', 'offene Stellen hier')}` : L('no open roles on the board right now', 'derzeit keine offenen Stellen auf der Börse')}${flds.length ? ' · ' + esc(flds.join(', ')) : e.field ? ' · ' + esc(e.field) : ''}</div><div class="snip">${esc(snip(co[0], 170))}</div>
<div class="more"><ul class="co-roles">${vr.slice(0, 12).map((i) => `<li><a class="link" href="${roleLink(ix.ids[i])}">${esc(rows[i][1])}</a></li>`).join('')}${vr.length > 12 ? `<li class="atlas-note">+ ${vr.length - 12}</li>` : ''}</ul></div>${voteHtml(e.id)}</li>`;
}
async function fillRole(li) {
  const e = lay().ents[+li.dataset.k]; if (st.mode !== 'roles') return; const id = e.id, d = (await shard(id))[id], box = li.querySelector('.more'), i = e.idx[0], row = rows[i];
  li.querySelector('.snip').textContent = d && d.x ? snip(d.x.replace(/^Back to all jobs\s*/i, ''), 200) : '';
  if (!li.classList.contains('open') || box.dataset.ready) return; box.dataset.ready = '1';
  const text = d && d.x ? d.x.replace(/\n{3,}/g, '\n\n').trim() : '';
  box.innerHTML = `<div class="facts">${[d && d.l, d && d.r, d && (d.tg || []).join(' · '), d && d.d && 'listed ' + d.d].filter(Boolean).map((f) => `<span>${esc(f)}</span>`).join('')}</div>`
    + (text ? `<div class="txt" tabindex="0">${esc(text)}</div>` : `<p class="atlas-note">${L('No description was saved for this role.', 'Für diese Stelle wurde keine Beschreibung gespeichert.')}</p>`)
    + (() => { const dups = ix.dupsOf(i), nb = ix.nbOf(i).slice(0, 5);
        return (dups.length ? `<p class="atlas-note">${L(`Also listed ${dups.length} more time${dups.length > 1 ? 's' : ''}`, `Noch ${dups.length}-mal ausgeschrieben`)}: ${dups.slice(0, 4).map((j) => esc(rows[j][2] + (ix.regions[ix.attrs[j][3]] ? ' · ' + ix.regions[ix.attrs[j][3]] : ''))).join(', ')}</p>` : '')
          + (nb.length ? `<div class="atlas-note">${L('Similar roles:', 'Ähnliche Stellen:')}<ul class="co-roles">${nb.map((x) => `<li><a class="link" href="${roleLink(ix.ids[x.i])}">${esc(rows[x.i][1])}</a> · ${esc(rows[x.i][2])}</li>`).join('')}</ul></div>` : ''); })()
    + `<div class="links"><a class="link" href="${roleLink(id)}">${L('Details in the job list →', 'Details in der Stellenliste →')}</a><a class="link" href="${esc(row[3])}" target="_blank" rel="noopener">${L('Apply ↗', 'Bewerben ↗')}</a></div>`;
}
function renderList() {
  $('atlas-list').innerHTML = st.sample.map(cardHtml).join('') || `<li class="atlas-note">${L('Nothing in the lens with these filters. Move it or make it larger.', 'Nichts in der Lupe mit diesen Filtern. Verschieben oder vergrößern Sie sie.')}</li>`;
  $('atlas-list').querySelectorAll('.atlas-item').forEach(fillRole);
}
// ---- interaction: drag the lens, drag elsewhere to move the map, tap to put the lens there; zoom with buttons or wheel
let drag = null; const touches = new Map(); let pinch = null;
const ptr = (e) => { const b = cv.getBoundingClientRect(); return [(e.clientX - b.left) / b.width * W, (e.clientY - b.top) / b.height * H]; };
cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); touches.set(e.pointerId, ptr(e));
  if (touches.size === 2) { const [a1, b1] = [...touches.values()]; pinch = { d: Math.hypot(a1[0] - b1[0], a1[1] - b1[1]), s: st.z.s }; drag = null; return; }
  const [px, py] = ptr(e), dx = px - sx(st.lens.x), dy = py - sy(st.lens.y);
  drag = Math.hypot(dx, dy) <= st.size * W + 8 ? { kind: 'lens' } : { kind: 'pan', px, py, cx: st.z.cx, cy: st.z.cy, moved: 0 }; });
cv.addEventListener('pointermove', (e) => { if (!touches.has(e.pointerId)) return; touches.set(e.pointerId, ptr(e));
  if (pinch && touches.size === 2) { const [a1, b1] = [...touches.values()], d = Math.hypot(a1[0] - b1[0], a1[1] - b1[1]); zoomTo(pinch.s * d / Math.max(pinch.d, 1), (a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2, false); return; }
  if (!drag) return; const [px, py] = ptr(e);
  if (drag.kind === 'lens') { st.lens.x = ux(px); st.lens.y = uy(py); } else { drag.moved = Math.max(drag.moved, Math.hypot(px - drag.px, py - drag.py)); st.z.cx = drag.cx - (px - drag.px) / W / st.z.s; st.z.cy = drag.cy - (py - drag.py) / H / st.z.s; }
  draw(); });
const endPtr = (e) => { touches.delete(e.pointerId); if (pinch) { if (touches.size < 2) { pinch = null; resample(); } return; }
  if (!drag) return; const [px, py] = ptr(e); const moved = drag.kind === 'lens' || drag.moved < 5; if (drag.kind === 'pan' && drag.moved < 5) { st.lens.x = ux(px); st.lens.y = uy(py); } drag = null;
  if (moved) PF.bumpExplored(); resample(); if (moved) { computeTaste(); renderPersonas(); draw(); } };
cv.addEventListener('pointerup', endPtr); cv.addEventListener('pointercancel', endPtr);
function zoomTo(s1, px, py, then = true) { const x0 = ux(px), y0 = uy(py); st.z.s = Math.max(1, Math.min(24, s1)); if (st.z.s === 1) { st.z.cx = 0.5; st.z.cy = 0.5; } else { st.z.cx = x0 - (px / W - 0.5) / st.z.s; st.z.cy = y0 - (py / H - 0.5) / st.z.s; } if (then) resample(); else draw(); }
function zoom(f, px = W / 2, py = H / 2) { zoomTo(st.z.s * f, px, py); }
cv.addEventListener('mousedown', (e) => { if (e.detail > 1) e.preventDefault(); });      // a double click zooms; it should not select page text
cv.addEventListener('dblclick', (e) => { e.preventDefault(); const [px, py] = ptr(e); zoom(2, px, py); });
cv.addEventListener('wheel', (e) => { e.preventDefault(); const [px, py] = ptr(e); zoom(e.deltaY < 0 ? 1.25 : 0.8, px, py); }, { passive: false });
$('atlas-zin').addEventListener('click', () => zoom(1.5, sx(st.lens.x), sy(st.lens.y)));
$('atlas-zout').addEventListener('click', () => zoom(1 / 1.5, sx(st.lens.x), sy(st.lens.y)));
$('atlas-zreset').addEventListener('click', () => { st.z = { s: 1, cx: 0.5, cy: 0.5 }; resample(); });
mount.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.closest('#atlas-mode')) { st.mode = b.dataset.m; mount.querySelectorAll('#atlas-mode button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); st.open.clear(); st.sample = []; st.z = { s: 1, cx: 0.5, cy: 0.5 }; resample(); }
  else if (b.closest('#atlas-fields')) { const f = b.dataset.f; if (st.fields.has(f)) st.fields.delete(f); else st.fields.add(f); b.setAttribute('aria-pressed', String(st.fields.has(f))); resample(); }
  else if (b.id === 'atlas-shuffle') resample();
  else if (b.classList.contains('hd')) { const li = b.closest('li'), id = li.dataset.id, on = li.classList.toggle('open'); b.setAttribute('aria-expanded', String(on)); if (on) st.open.add(id); else st.open.delete(id); fillRole(li); }
  else if (b.closest('.atlas-vote')) {
    const li = b.closest('li'), id = li.dataset.id, v = +b.dataset.v; ratings = loadRatings(); const r = ratings[id] || {};
    if (r.vote === v) delete r.vote; else r.vote = v; if (Object.keys(r).length) ratings[id] = r; else delete ratings[id]; saveRatings(ratings); computeTaste(); renderPersonas();
    li.querySelector('.atlas-vote').outerHTML = voteHtml(id); draw();
  }
});
mount.addEventListener('click', async (e) => {
  const pe = e.target.closest('[data-persona]');
  if (pe) { const id = pe.dataset.persona; let c = PF.chosenPersonas(); c = c.includes(id) ? c.filter((x) => x !== id) : [...c, id].slice(-2); PF.choosePersonas(c); renderPersonas(); computeTaste(); draw(); return; }
  if (e.target.closest('#atlas-forget')) { PF.forgetAll(); ratings = {}; prefVals = {}; cvEmb = null; renderPersonas(); renderPrefs(); renderCv(); computeTaste(); resample(); return; }
  if (e.target.closest('#atlas-save')) { PF.saveProfileFile($('atlas-save-cv').checked); return; }
  const pb = e.target.closest('.pref5 button');
  if (pb) { const id = pb.closest('[data-p]').dataset.p, v = +pb.dataset.v; prefVals[id] = prefVals[id] === v ? 0 : v; setJ(K.prefs, prefVals); renderPrefs(); computeTaste(); draw(); return; }
  if (e.target.closest('#atlas-cv-forget')) { cvEmb = null; try { localStorage.removeItem(K.cv); } catch (x) { /* nothing kept */ } renderCv(); computeTaste(); draw(); return; }
  if (e.target.closest('#atlas-cv-read')) {
    const text = $('atlas-cv-text').value.trim(), stat = $('atlas-cv-status'); if (text.length < 20) { stat.innerHTML = L('Paste a few lines first.', 'Bitte zuerst ein paar Zeilen einfügen.'); return; }
    const btn = e.target.closest('#atlas-cv-read'); btn.disabled = true;
    try {
      const { loadModel } = await import('./embed.js');
      const m = await loadModel({ modelUrl: cfg.model_url, onProgress: (f) => { stat.textContent = (f < 0.97 ? (isDe() ? 'Lade Modell: ' : 'Loading the model: ') + Math.round(f * 100) + ' %' : (isDe() ? 'Starte …' : 'Starting…')); } });
      stat.textContent = isDe() ? 'Lese …' : 'Reading…'; const v = await m.embed(text, 512);
      cvEmb = { v: Array.from(v, (x) => Math.round(x * 1e4) / 1e4), on: true }; setJ(K.cv, cvEmb); renderCv(); computeTaste(); draw();
    } catch (err) { stat.textContent = (isDe() ? 'Das Modell lässt sich hier nicht starten: ' : 'The model could not start here: ') + (err.message || err); btn.disabled = false; }
  }
});
mount.addEventListener('change', async (e) => {
  if (e.target.id === 'atlas-cv-file' && e.target.files.length) { const stat = $('atlas-cv-status');
    try { const { fileText } = await import('./pdftext.js'); $('atlas-cv-text').value = await fileText(e.target.files[0]); stat.textContent = isDe() ? 'Gelesen; jetzt mit dem Modell lesen.' : 'Read; now read it with the model.'; }
    catch (err) { stat.textContent = err.message || String(err); } return; }
  if (e.target.id === 'atlas-load' && e.target.files.length) { try { await PF.loadProfileFile(e.target.files[0]); ratings = loadRatings(); prefVals = getJ(K.prefs, {}); cvEmb = getJ(K.cv, null); renderPersonas(); renderPrefs(); renderCv(); computeTaste(); resample(); $('atlas-status').insertAdjacentHTML('afterbegin', L('Profile loaded. ', 'Profil geladen. ')); } catch (err) { $('atlas-status').textContent = err.message || String(err); } return; }
  if (e.target.id === 'atlas-all') { st.all = e.target.checked; draw(); return; }
  if (e.target.id === 'atlas-cv-on') { cvEmb.on = e.target.checked; setJ(K.cv, cvEmb); computeTaste(); draw(); }
  if (e.target.id === 'atlas-taste') draw();
});
$('atlas-scope').addEventListener('change', (e) => { st.scope = +e.target.value; const before = layers.roles; layers.roles = roleMapFor(st.scope); if (layers.roles !== before && st.mode === 'roles') { st.sample = []; st.z = { s: 1, cx: 0.5, cy: 0.5 }; } resample(); });
$('atlas-size').addEventListener('change', (e) => { st.size = +e.target.value; resample(); });
window.addEventListener('storage', () => { ratings = loadRatings(); prefVals = getJ(K.prefs, {}); cvEmb = getJ(K.cv, null); renderPersonas(); renderPrefs(); renderCv(); computeTaste(); draw(); });
resample();
