// Role atlas: a network map of the board, drawn the way maps of science are drawn (jobcrawl/map/atlas.py builds the layout):
// roles linked to their nearest roles by meaning, grouped by community detection (regions and finer neighbourhoods),
// and placed on the plane by relaxing that network (UMAP). Labels name each group by its distinctive title words, fields
// and the statements it leans to. Roles newer than the layout are placed at the mean position of their nearest mapped roles.
// Nothing is uploaded; no model download unless a CV is read.
import { loadConfig, dataUrl, roleLink, companyLink, defaultScope, modelCache, L, esc, isDe, pick } from './app.js';
import { makeIndex, tasteScores, tasteWeight } from './match.js';
import * as PF from './profile.js';
const cfg = await loadConfig();
PF.setPersonas(cfg.personas);
const K = PF.keys();
const mount = document.getElementById('atlas-mount'); if (!mount) throw new Error('no #atlas-mount');
// the scopes of config.json, in order: a role's scope bits (match-attrs.json) follow this order
const scopeOpts = cfg.scopes.map((x, k) => `<option value="${k}"${k === defaultScope() ? ' selected' : ''}>${L(x.label.en, x.label.de)}</option>`).join('');
const fieldLabel = (id) => { const f = (cfg.fields || []).find((x) => x.id === id); return f ? pick(f.label.en, f.label.de) : id; };
const ANY = (() => { const k = cfg.scopes.findIndex((x) => x.match && x.match.any); return k < 0 ? cfg.scopes.length - 1 : k; })();   // the scope with every role: the whole-map layout
const perScope = cfg.atlas_maps === 'per_scope';   // web.atlas_maps: a separate map per region filter (else one map, filters hide what is outside)
const loadRatings = () => { try { return JSON.parse(localStorage.getItem(K.ratings) || '{}'); } catch (e) { return {}; } };
const saveRatings = (r) => { try { localStorage.setItem(K.ratings, JSON.stringify(r)); } catch (e) { /* kept for this page only */ } };
let ratings = loadRatings();

const style = document.createElement('style');
style.textContent = `
.atlas-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;margin-inline:calc(50% - min(820px,50vw - 24px))}
.atlas-bar{display:flex;gap:10px 16px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px}
.atlas-bar label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
.atlas-bar select{padding:7px 8px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font:inherit;font-size:14px}
.atlas-views button,.atlas-fields button,.atlas-side button.sm,.atlas-shape button.sm{all:unset;cursor:pointer;font-size:13px;padding:5px 11px;border:1px solid var(--line);border-radius:14px;color:var(--muted)}
.atlas-views button[aria-pressed=true],.atlas-fields button[aria-pressed=true]{border-color:var(--accent-text);color:var(--accent-text);font-weight:600}
.atlas-views{display:flex;gap:6px;flex-wrap:wrap}.atlas-fields{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.atlas-stage{user-select:none;-webkit-user-select:none;position:relative;border:1px solid var(--line);border-radius:10px;background:var(--panel);overflow:hidden}
.atlas-stage canvas{display:block;width:100%;height:auto;touch-action:none;cursor:grab}
.atlas-stage:fullscreen{border-radius:0;border:0;width:100vw;height:100vh;display:flex;align-items:center;justify-content:center}
.atlas-stage:-webkit-full-screen{border-radius:0;border:0;width:100vw;height:100vh;display:flex;align-items:center;justify-content:center}
.atlas-zoom{position:absolute;right:8px;top:8px;display:flex;flex-direction:column;gap:4px}.atlas-zoom button{all:unset;cursor:pointer;width:30px;height:30px;text-align:center;line-height:30px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font-size:16px}.atlas-zoom button:focus-visible{outline:2px solid var(--accent)}
.atlas-area{border:1px solid var(--line);border-radius:8px;padding:8px 12px;background:var(--panel);font-size:13px;display:flex;flex-wrap:wrap;align-items:baseline;gap:3px 16px}.atlas-area b{font-size:14px}.atlas-area .lean{color:var(--muted)}
.atlas-side{display:flex;flex-direction:column;gap:10px;min-width:0}
.atlas-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}.atlas-list>li:not(.atlas-item){grid-column:1/-1}
.atlas-item{border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:var(--paper);min-width:0}
.atlas-item .t{font-weight:600;overflow-wrap:anywhere;font-size:14px;color:var(--ink);text-decoration:none}.atlas-item .t:hover{color:var(--accent-text);text-decoration:underline}
.atlas-item .m{font-size:12.5px;color:var(--muted)}
.atlas-new{font-size:11px;padding:0 6px;border-radius:8px;border:1px solid currentColor;margin-left:6px;opacity:.85}
.atlas-pop{position:absolute;z-index:2;width:240px;max-width:calc(100% - 12px);box-sizing:border-box;display:flex;flex-direction:column;gap:5px;padding:9px 30px 10px 11px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font-size:13px;box-shadow:0 6px 18px rgba(0,0,0,.28)}
.atlas-pop[hidden]{display:none}.atlas-pop .t{font-weight:600;font-size:14px;overflow-wrap:anywhere;color:var(--ink);text-decoration:none}.atlas-pop a.t:hover{color:var(--accent-text);text-decoration:underline}
.atlas-pop .m{font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}.atlas-pop .atlas-vote{margin-top:2px}
.atlas-pop-x{all:unset;cursor:pointer;position:absolute;right:6px;top:4px;width:22px;height:22px;text-align:center;line-height:22px;font-size:16px;color:var(--muted)}.atlas-pop-x:focus-visible{outline:2px solid var(--accent)}
.atlas-vote{display:inline-flex;gap:2px;margin-top:4px}.atlas-vote button{all:unset;cursor:pointer;font-size:13px;padding:2px 8px;border:1px solid var(--line);border-radius:5px;color:var(--muted)}.atlas-vote button.on{background:var(--accent);color:var(--btn-fg,#fff);border-color:var(--accent)}
.atlas-item .hd{all:unset;cursor:pointer;font-weight:600;overflow-wrap:anywhere;font-size:14px;color:var(--ink);display:block}.atlas-item .hd:hover{color:var(--accent-text)}.atlas-item .hd::after{content:'▾';margin-left:6px;color:var(--muted);font-weight:400}.atlas-item.open .hd::after{content:'▴'}.atlas-item .snip{font-size:12.5px;color:var(--muted);margin-top:3px;overflow-wrap:anywhere}.atlas-item .more{display:none;flex-direction:column;gap:8px;margin-top:8px}.atlas-item.open .more{display:flex}.atlas-item.open .snip{display:none}.atlas-item .facts{display:flex;gap:4px 12px;flex-wrap:wrap;font-size:12.5px;color:var(--muted)}.atlas-item .txt{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13.5px;line-height:1.5;max-height:22em;overflow:auto;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}.atlas-item .links{display:flex;gap:12px;flex-wrap:wrap;font-size:13.5px}.co-roles{margin:0;padding-left:18px;font-size:13.5px}
.atlas-badge-tracked{display:inline-flex;align-items:center;font-size:11px;padding:1px 6px;border-radius:10px;background:rgba(46,160,67,0.15);color:#3fb950;font-weight:600;margin-left:6px;border:1px solid rgba(46,160,67,0.3);vertical-align:middle}
.atlas-tag-tier{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;color:#fff;font-weight:600;margin-left:6px;vertical-align:middle}
.co-has-roles{color:var(--accent-text);font-weight:600}
.co-no-roles{color:var(--muted);font-style:italic}
.atlas-shape{border:1px solid var(--line);border-radius:10px;background:var(--panel);margin-bottom:12px}.atlas-shape>summary{cursor:pointer;padding:10px 14px;list-style:none}.atlas-shape>summary::-webkit-details-marker{display:none}
.shape-body{padding:0 14px 14px;display:flex;flex-direction:column;gap:12px}.prefs{display:grid;grid-template-columns:1fr auto 1fr;gap:6px 10px;align-items:center;font-size:13px}
.prefs .pa{text-align:right}.prefs .pb{text-align:left}.pref5{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}.pref5 button{all:unset;cursor:pointer;width:26px;height:24px;text-align:center;border-right:1px solid var(--line);color:var(--muted);font-size:12px}.pref5 button:last-child{border-right:0}.pref5 button.on{background:var(--accent);color:var(--btn-fg,#fff)}.pref5 button:focus-visible{outline:2px solid var(--accent)}
@media(max-width:600px){.prefs{grid-template-columns:1fr}.prefs .pa,.prefs .pb{text-align:left}}
.shape-cv{display:flex;flex-direction:column;gap:6px}.shape-cv textarea{width:100%;min-height:80px;box-sizing:border-box;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font:inherit;font-size:13px}
.personas{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px}.personas button{all:unset;cursor:pointer;font-size:12.5px;padding:4px 10px;border:1px solid var(--line);border-radius:12px;color:var(--muted)}.personas button[aria-pressed=true]{border-color:var(--accent-text);color:var(--accent-text);font-weight:600}.personas button:focus-visible{outline:2px solid var(--accent)}
.shape-save{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
.shape-toggle{font-size:13px;display:flex;gap:6px;align-items:center}
.atlas-note{font-size:12.5px;color:var(--muted)}
.atlas-scrub{display:flex;gap:6px 10px;align-items:center;flex-wrap:wrap;padding:7px 10px;border-top:1px solid var(--line);background:var(--panel);font-size:13px;color:var(--ink)}
.atlas-scrub[hidden]{display:none}
.atlas-scrub button{all:unset;cursor:pointer;width:28px;height:26px;text-align:center;line-height:26px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font-size:12px}.atlas-scrub button:focus-visible{outline:2px solid var(--accent)}
.atlas-scrub input[type=range]{flex:1 1 200px;min-width:120px;margin:0;accent-color:var(--accent)}
.atlas-scrub label{display:flex;gap:5px;align-items:center;font-size:12.5px;color:var(--muted);white-space:nowrap}
.tl-label{white-space:nowrap;font-variant-numeric:tabular-nums;min-width:12em}
.atlas-stage:fullscreen .atlas-scrub,.atlas-stage:-webkit-full-screen .atlas-scrub{position:absolute;left:0;right:0;bottom:0;border-top:0;background:color-mix(in srgb,var(--panel) 72%,transparent)}
.atlas-area .chg{display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--muted);flex-wrap:wrap;width:100%}
.atlas-chart{width:120px;height:24px;flex:none}
.co-logo{height:28px;width:auto;max-width:84px;object-fit:contain;vertical-align:middle;margin-right:8px;border-radius:4px}
`;
document.head.appendChild(style);
mount.innerHTML = `<div class="atlas-bar">
<div class="atlas-views" id="atlas-mode" role="group"><button type="button" data-m="roles" aria-pressed="true">${L('Roles', 'Stellen')}</button><button type="button" data-m="companies" aria-pressed="false">${L('Companies', 'Firmen')}</button></div>
<label>${L('Where', 'Wo')}<select id="atlas-scope">${scopeOpts}</select></label>
<label>${L('Lens size', 'Lupengröße')}<select id="atlas-size"><option value="0.05" selected>${L('small', 'klein')}</option><option value="0.09">${L('medium', 'mittel')}</option><option value="0.16">${L('large', 'groß')}</option></select></label>
</div>
<div class="atlas-fields" id="atlas-fields" role="group"></div>
<details class="atlas-shape" id="atlas-shape"><summary><strong>${L('Shape the map to you', 'Die Karte auf Sie zuschneiden')}</strong> <span class="atlas-note">${L('optional: a few statements, your CV, and the roles and companies you mark below', 'optional: ein paar Aussagen, Ihr CV und die Stellen und Firmen, die Sie unten markieren')}</span></summary>
<div class="shape-body"><div class="personas" id="atlas-personas"></div><div class="prefs" id="atlas-prefs"></div>
<div class="shape-cv" id="atlas-cvbox"></div>
<div class="shape-save"><button type="button" class="sm" id="atlas-forget">${L('Forget everything on this device', 'Alles auf diesem Gerät vergessen')}</button> <button type="button" class="sm" id="atlas-save">${L('Save my profile as a file', 'Mein Profil als Datei speichern')}</button> <label class="atlas-note"><input type="checkbox" id="atlas-save-cv"> ${L('include my CV (as numbers)', 'mit CV (als Zahlen)')}</label> <label class="atlas-note">${L('Load a saved profile: ', 'Gespeichertes Profil laden: ')}<input type="file" id="atlas-load" accept=".json,application/json"></label></div>
<label class="shape-toggle"><input type="checkbox" id="atlas-taste" checked> ${L('Show how well each area fits me (bright: close to my profile, faint: far from it)', 'Zeigen, wie gut jeder Bereich zu mir passt (hell: nah an meinem Profil, blass: weit weg)')}</label>
<label class="shape-toggle"><input type="checkbox" id="atlas-all"> ${L('Show every role (otherwise at most three per employer and neighbourhood, so big employers do not crowd the map)', 'Jede Stelle zeigen (sonst höchstens drei je Arbeitgeber und Nachbarschaft, damit große Arbeitgeber die Karte nicht füllen)')}</label></div></details>
<div class="atlas-grid"><div>
<div class="atlas-stage"><canvas id="atlas-cv" width="900" height="640"></canvas><div class="atlas-zoom"><button type="button" id="atlas-zin" aria-label="zoom in">+</button><button type="button" id="atlas-zout" aria-label="zoom out">−</button><button type="button" id="atlas-zreset" aria-label="whole map">⟲</button><button type="button" id="atlas-fs" aria-label="${esc(pick('Full screen', 'Vollbild'))}" title="${esc(pick('Full screen', 'Vollbild'))}">⛶</button><button type="button" id="atlas-save-img" aria-label="${esc(pick('Save as image', 'Als Bild speichern'))}" title="${esc(pick('Save as image', 'Als Bild speichern'))}">⤓</button></div><div class="atlas-scrub" id="atlas-scrub" hidden><button type="button" id="atlas-play" aria-label="${esc(pick('Play', 'Abspielen'))}" title="${esc(pick('Play through time', 'Durch die Zeit abspielen'))}">▶</button><input type="range" id="atlas-time" min="0" max="0" value="0" aria-label="${esc(pick('Time', 'Zeitpunkt'))}"><span class="tl-label" id="atlas-tlabel"></span><label><input type="checkbox" id="atlas-heat"> ${L('Hot and cold spots', 'Wo es wächst und schrumpft')}</label></div></div>
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
// optional company texts for the cards: config company_texts, a file in the data folder ({slug: [text, ...]})
const coRows = cfg.company_texts ? await fetch(dataUrl(cfg.company_texts)).then((r) => r.json()).catch(() => ({})) : {};
const CVEC = await Promise.all([fetch(dataUrl('match/company-vec.json')).then((r) => r.json()), fetch(dataUrl('match/company-vec.bin')).then((r) => r.arrayBuffer())]).then(([j, b]) => ({ slugs: j.slugs, vec: new Int8Array(b) })).catch(() => null);
const LAY = await fetch(dataUrl('match/atlas-layout.json')).then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (!LAY) { $('atlas-status').innerHTML = L('The map layout is not published yet.', 'Das Kartenlayout ist noch nicht veröffentlicht.'); throw new Error('no atlas-layout.json'); }
const pos = new Int32Array(N).fill(-1); have.forEach((i, k) => { pos[i] = k; });
const unit = (v) => { let t = 0; for (let d = 0; d < D; d++) t += v[d] * v[d]; t = Math.sqrt(t) || 1; return Float32Array.from(v, (x) => x / t); };
const vecOf = (i) => X.subarray(pos[i] * D, pos[i] * D + D);
const idIndex = new Map(ix.ids.map((id, i) => [id, i]));
// a role's age in days: its publication date (else the day first seen; match-attrs.json dates), counted from today in local time; Infinity when unknown
const AGE = (() => { const a = new Float64Array(N).fill(Infinity), d = at.dates; if (!d || !d.base || !Array.isArray(d.ago)) return a;
  const [y, m, dd] = d.base.split('-').map(Number), t = new Date(), days = Math.round((Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) - Date.UTC(y, m - 1, dd)) / 864e5);
  for (let i = 0; i < N; i++) { const g = d.ago[i]; if (g >= 0) a[i] = Math.max(0, days + g); } return a; })();
// the weight of a new role: 1 today, 0.45 this week, 0.18 this month, 0 older (drawn as before)
const wAge = (a) => (a < 1 ? 1 : a < 7 ? 0.45 : a < 30 ? 0.18 : 0), wOf = (i) => wAge(AGE[i]);
// the same for the timeline's layer (tlLayer): its entities carry their age (e.a) and weight (e.w) instead of a role index
const wE = (e) => (e.past ? e.w : wOf(e.idx[0])), ageE = (e) => (e.past ? e.a : AGE[e.idx[0]]);
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
  return { kind: 'companies', ents, n: ents.length, regions: C.regions, hoods: C.regions, links: C.links || [] };
}
// per_scope only: one role map per region filter with enough roles (built separately, so a smaller area spreads over the whole map);
// filters without a map of their own use the next larger one and only hide what is outside
const roleMaps = new Map();
let worldMap = null;
function roleMapFor(scope) {
  if (!perScope) return worldMap || (worldMap = roleLayer(LAY.roles, ANY));   // one map: every filter shows the worldwide layout
  for (let s0 = scope; s0 < cfg.scopes.length; s0++) { const name = cfg.scopes[s0].id, R = s0 === ANY ? LAY.roles : (LAY.scopes || {})[name];
    if (R) { if (!roleMaps.has(name)) roleMaps.set(name, roleLayer(R, s0)); return roleMaps.get(name); } }
  return roleLayer();
}
const layers = { roles: roleMapFor(defaultScope()), companies: companyLayer() };
const coEnts = layers.companies.ents.filter((e) => e.vec);

// ---- the role timeline (optional): when each role was on the board. match/role-timeline.json and .bin (16-byte records, little
// endian: x, y, c1, sc, tg, fa, la; times in minutes after t0), the names in role-timeline-names-NNN.json. Without the files: as before.
const DAY = 1440, EMBER = 30 * DAY;   // minutes; a role last seen this long before the scrubbed time still shows, fading
const TLJ = cfg.timeline ? await fetch(dataUrl(cfg.timeline)).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;   // config.json names it when published
const TLBIN = TLJ && TLJ.version === 1 ? await fetch(dataUrl('match/role-timeline.bin')).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null) : null;
const TLN = TLBIN && TLBIN.byteLength === TLJ.n * 16 ? TLJ.n : 0;
const TLX = new Uint16Array(TLN), TLY = new Uint16Array(TLN), TLC = new Uint8Array(TLN), TLS = new Uint8Array(TLN), TLG = new Uint16Array(TLN), TLF = new Uint32Array(TLN), TLL = new Uint32Array(TLN);
if (TLN) { const dv = new DataView(TLBIN); for (let r = 0; r < TLN; r++) { const o = r * 16; TLX[r] = dv.getUint16(o, true); TLY[r] = dv.getUint16(o + 2, true); TLC[r] = dv.getUint8(o + 4); TLS[r] = dv.getUint8(o + 5); TLG[r] = dv.getUint16(o + 6, true); TLF[r] = dv.getUint32(o + 8, true); TLL[r] = dv.getUint32(o + 12, true); } }
// the crawl rounds: the distinct first and last sighting times; times within 30 minutes of each other are one round (its last time)
const TL = (() => { if (!TLN) return null; let end = 0, start = Infinity; for (let r = 0; r < TLN; r++) { end = Math.max(end, TLL[r]); start = Math.min(start, TLF[r]); }
  const tv = new Uint32Array(2 * TLN); tv.set(TLF, 0); tv.set(TLL, TLN); tv.sort(); const rounds = [];
  for (const t of tv) { if (!rounds.length || t - rounds[rounds.length - 1] > 30) rounds.push(t); else rounds[rounds.length - 1] = t; }
  if (rounds.length < 2) return null;   // one crawl round: nothing to scrub
  // the steps: the rounds (span up to 14 days, at most 200 rounds), else days (up to 60), every 2 days (180), weekly (400), monthly
  const S = (end - start) / DAY, t0 = Date.parse(TLJ.t0), kind = S <= 14 && rounds.length <= 200 ? 'round' : S <= 60 || S <= 14 ? 'day' : S <= 180 ? 'day2' : S <= 400 ? 'week' : 'month', steps = [];
  if (kind === 'round') steps.push(...rounds);
  else if (kind === 'month') { const d = new Date(t0 + start * 60000); for (let y = d.getUTCFullYear(), m = d.getUTCMonth(); ; m++) { const t = (Date.UTC(y, m, 1) - t0) / 60000; if (t >= end) break; if (t >= start) steps.push(t); } }
  else { const step = kind === 'day' ? DAY : kind === 'day2' ? 2 * DAY : 7 * DAY; for (let t = start; t < end; t += step) steps.push(t); }
  if (steps[steps.length - 1] !== end) steps.push(end);   // the last step is now
  return { n: TLN, t0, start, end, kind, steps, scopes: TLJ.scopes, fields: TLJ.fields, shard: TLJ.names_shard || 2000 }; })();
// tm: the scrubbed time (minutes after t0); at the end (now) the map is the one without a timeline
const scrub = { idx: TL ? TL.steps.length - 1 : 0, tm: TL ? TL.end : 0 };
let tlLast = null, lastHeat = null, tlTimer = null;

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
const st = { all: false, mode: 'roles', scope: defaultScope(), size: 0.05, fields: new Set(), lens: { x: 0.5, y: 0.5 }, sample: [], open: new Set(), z: { s: 1, cx: 0.5, cy: 0.5 } };
$('atlas-fields').innerHTML = ix.fields.map((f) => `<button type="button" data-f="${esc(f)}" aria-pressed="false">${esc(fieldLabel(f))}</button>`).join('');
let W = 900, H = 640, BW = 900, BH = 640;      // the logical canvas (the stage's size); the map box BW x BH inside it: positions, labels and pointer maps are in these units; the canvas store is k times larger
const cv = $('atlas-cv'), g = cv.getContext('2d'), css = (n, fb = '#888') => getComputedStyle(document.body).getPropertyValue(n).trim() || fb;
const stage = cv.parentElement, fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
// the largest 900:640 box inside W x H, centred: the map is drawn in it, undistorted
function setMap(w, h) { W = w; H = h; const u0 = Math.min(W / 900, H / 640); BW = 900 * u0; BH = 640 * u0; }
// W x H follows the stage: the height is clamp(420 px, the window's height less 140 px, 0.62 x the width); in full screen the stage's own size
function fitView() { const w = Math.round(stage.clientWidth); if (!w) return; const full = fsEl() === stage;
  const h = full ? Math.round(stage.clientHeight) : Math.max(420, Math.min(window.innerHeight - 140, Math.round(w * 0.62)));
  setMap(w, Math.max(1, h)); cv.style.height = H + 'px'; }
// a size change: relayout and redraw; the zoom and the centre stay
let relaid = 0; const relayout = () => { cancelAnimationFrame(relaid); relaid = requestAnimationFrame(() => { const w0 = W, h0 = H; fitView(); if (W !== w0 || H !== h0) draw(); }); };
fitView();
// the backing store follows the screen's pixel density (k = device pixel ratio, at most 3); everything is drawn in logical units
function sizeCanvas() { const k = Math.min(3, window.devicePixelRatio || 1), w = Math.round(W * k), h = Math.round(H * k); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } g.setTransform(cv.width / W, 0, 0, cv.height / H, 0, 0); }
sizeCanvas();
const lay = () => (st.mode === 'roles' && TL && scrub.tm < TL.end ? tlLayer(scrub.tm) : layers[st.mode]);
const roleVisible = (i) => (ix.attrs[i][0] >> st.scope & 1) === 1 && (!st.fields.size || [...st.fields].some((f) => ix.attrs[i][4] >> ix.fields.indexOf(f) & 1));
const visibleRoles = (e) => e.idx.filter(roleVisible);
function tw(r) { if (r.vote !== undefined) return r.vote; const v = []; if (r.role) v.push((r.role - 3) / 2); if (r.interest) v.push((r.interest - 3) / 2); if (r.apply !== undefined) v.push(r.apply); return v.length ? Math.sign(v.reduce((a, b) => a + b, 0)) : null; }
const voteOf = (id) => (ratings[id] ? tw(ratings[id]) : null);
// map units (0..1, from the layout) to canvas pixels and back; s is the zoom, (cx, cy) the map point in the middle of the canvas
const sx = (x) => (x - st.z.cx) * st.z.s * BW + W / 2, sy = (y) => (y - st.z.cy) * st.z.s * BH + H / 2;
const ux = (px) => (px - W / 2) / (st.z.s * BW) + st.z.cx, uy = (py) => (py - H / 2) / (st.z.s * BH) + st.z.cy;
const hue = (c) => (c * 137.508) % 360;      // one colour per region, spread around the colour wheel
// region colours in OKLCH, one hue per region; at a given lightness a hue takes the largest chroma up to the target that is inside
// the sRGB gamut (binary search on C). The themes use lightness bands instead (vivid() below)
const VIVID_C = 0.19;
function oklinear(L, C, h) {
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
}
const inGamut = (L, C, h) => oklinear(L, C, h).every((x) => x >= 0 && x <= 1);
// the largest chroma up to the target that is inside the sRGB gamut at this lightness and hue (binary search when it is clipped)
function maxChroma(L, h, target) { if (inGamut(L, target, h)) return target; let lo = 0, hi = target; for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (inGamut(L, mid, h)) lo = mid; else hi = mid; } return lo; }
function oklch(L, C, h) { return oklinear(L, C, h).map((x) => Math.round(255 * Math.max(0, Math.min(1, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)))); }
// the most vivid colour of a hue within a lightness band: the lightness in [lo, hi] where the gamut allows the most chroma (up to
// `target`). Every hue peaks at its own lightness (yellow near 0.9, blue near 0.45), so one lightness for all would leave most
// hues pastel; a band keeps blues bright enough on black and yellows dark enough on white. Cached per whole degree.
const vividCache = new Map();
function vivid(h, lo, hi, target) {
  const k = Math.round(h) % 360 + '/' + lo + '/' + hi + '/' + target;
  if (!vividCache.has(k)) { const hh = Math.round(h) % 360; let best = [lo, 0];
    for (let L = lo; L <= hi + 1e-9; L += 0.01) { const c = maxChroma(L, hh, target); if (c > best[1] + 1e-4) best = [L, c]; }
    vividCache.set(k, oklch(best[0], best[1], hh)); }
  return vividCache.get(k);
}
// a region's colour: L a number (that lightness, the largest chroma inside the gamut) or a band [lo, hi] (the vivid colour)
const rgbCache = new Map();
const regionRgb = (c, L, target = VIVID_C) => { const k = c + '/' + L + '/' + target; if (!rgbCache.has(k)) { const h = hue(c); rgbCache.set(k, Array.isArray(L) ? vivid(h, L[0], L[1], target) : oklch(L, maxChroma(L, h, target), h)); } return rgbCache.get(k); };
let densAt = () => 1;      // how crowded a point's spot on screen is, relative to a typical spot (set by colourField)
// a group's name: the hand-written key term (atlas-labels.json), else its first two distinctive words
const nameOf = (r) => (r.label ? r.label[isDe() ? 1 : 0] : r.words.slice(0, 2).map((w) => w[0].toUpperCase() + w.slice(1)).join(' & '));
const leanText = (lean) => (lean || []).map(([id, sign]) => { const p = prefDefs.find((q) => q.id === id); return p ? (sign > 0 ? p.a : p.b)[isDe() ? 1 : 0] : ''; }).filter(Boolean);
let vis = [], act = [], fit = null, sel = null, hitG = null;   // sel: the point whose card is open ({k, ly}); hitG: the screen grid of the drawn points
function grid(GW, GH, add) {      // per screen cell: sums of add(k) over visible entities in it
  const A = new Float32Array(GW * GH), Ly = lay();
  Ly.ents.forEach((e, k) => { if (!vis[k]) return; const X0 = sx(e.x) / W, Y0 = sy(e.y) / H; if (X0 < 0 || X0 >= 1 || Y0 < 0 || Y0 >= 1) return; A[Math.floor(Y0 * GH) * GW + Math.floor(X0 * GW)] += add(k); });
  return A;
}
function blur(A, GW, GH, passes) { for (let pass = 0; pass < passes; pass++) { const t = new Float32Array(A.length); for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) { let q = 0, m = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < GW && yy < GH) { q += A[yy * GW + xx]; m++; } } t[y * GW + x] = q / m; } A.set(t); } }
function paint(ctx, A, GW, GH, rgb, alphaOf) {
  const small = document.createElement('canvas'); small.width = GW; small.height = GH; const sg = small.getContext('2d'), img = sg.createImageData(GW, GH);
  for (let k = 0; k < A.length; k++) { img.data[k * 4] = rgb[0]; img.data[k * 4 + 1] = rgb[1]; img.data[k * 4 + 2] = rgb[2]; img.data[k * 4 + 3] = Math.round(255 * alphaOf(A[k])); }
  sg.putImageData(img, 0, 0); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.globalAlpha = 1; ctx.drawImage(small, 0, 0, W, H);
}
// the colour themes. fieldL / pointL / dimL: the lightness bands of the field, the points and the points out of the filter (see
// vivid()); C: the chroma cap. 'light': vivid colour on the page. 'neon': aggressive colour on near black; a wider, fainter
// pass is added on top (so overlapping regions glow) and gives a halo. light: the field multiplied on the page (deep hues on white), dark ink labels on a white halo
const THEMES = {
  light: { C: 0.32, fieldL: [0.42, 0.62], pointL: 0.40, dimL: 0.65, pointA: 0.85, dimA: 0.35, fieldStrength: 1.0, multiply: true, halo: '#ffffff' },
  neon: { C: 0.37, fieldL: [0.52, 0.80], pointL: [0.62, 0.88], dimL: [0.45, 0.65], pointA: 1, fieldStrength: 0.62, glow: { strength: 0.16, extra: 3 }, bg: '#05060a', halo: '#05060a', linkInk: '#ffffff', areaInk: '#ffffff', subInk: '#e6e6f0', tintL: 0.92 },
};
// the theme on screen: neon on a dark page, light otherwise. The page decides in this order: data-theme="light|dark" on the
// root element, data-mode="light|dark" on <body> (a site's own light/dark switch), else the system setting
function themeFor() {
  const r = document.documentElement.dataset.theme, b = document.body && document.body.dataset.mode;
  for (const v of [r, b]) if (v === 'light' || v === 'dark') return v === 'light' ? 'light' : 'neon';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'neon' : 'light';
}
// the display name of an employer or company on the map (labels only; the data keeps the full name): a trailing "(via ...)"
// and a legal form at the end (GmbH, Ltd., S.A.S. ...) are dropped, repeatedly
const LEGAL_END = /[\s,]+(gmbh\s*&\s*co\.?\s*kg|gmbh|mbh|ag|se|kg|pte\.?\s*ltd\.?|ltd\.?|limited|inc\.?|llc|s\.a\.s\.|s\.a\.|sas|sa|b\.v\.|bv|kft\.?|s\.r\.l\.|srl|oy|ab|plc)[\s,.]*$/i;
const shortName = (name) => { const full = String(name || ''); let s = full.replace(/\s*\(via [^)]*\)\s*$/i, '').replace(/[\s,.]+$/, '');
  for (let q = 0; q < 8; q++) { const t = s.replace(LEGAL_END, '').replace(/[\s,.]+$/, ''); if (!t || t === s) break; s = t; }
  return s || full; };
// a label is a list of lines: [{t, fs, face, alpha, color}] (fs in logical px; p is the text scale). Its box: the widest line,
// the lines at 1.15 x their size, and the padding. align 'center': the block centred on (x, y); 'left' / 'right': the block beside
// the anchor (right of it, or left of it), its first line centred on y (so a dot at the anchor marks the first line).
function labelLayout(ctx, lines, x, y, align, p = 1) {
  let wmax = 0, hsum = 0;
  const L = lines.map((ln) => { ctx.font = `${ln.face} ${ln.fs * p}px system-ui, sans-serif`; const w = ctx.measureText(ln.t).width, lh = 1.15 * ln.fs * p; wmax = Math.max(wmax, w); hsum += lh; return { ...ln, F: ln.fs * p, lh }; });
  const padX = (align === 'center' ? 5 : 2) * p, padY = 3 * p, W = wmax + 2 * padX, H = hsum + 2 * padY;
  const x0 = align === 'left' ? x : align === 'right' ? x - W : x - W / 2;
  const top = align === 'center' ? y - H / 2 : y - L[0].lh / 2 - padY;
  let cy = top + padY;
  const out = L.map((ln) => { const c = { ...ln, cy: cy + ln.lh / 2, cx: align === 'left' ? x0 + padX : align === 'right' ? x0 + W - padX : x0 + W / 2 }; cy += ln.lh; return c; });
  return { box: [x0, top, x0 + W, top + H], lines: out, align, p };
}
function labelDraw(ctx, lay, halo) {
  ctx.textBaseline = 'middle'; ctx.textAlign = lay.align; ctx.globalCompositeOperation = 'source-over'; ctx.lineJoin = 'round';
  for (const ln of lay.lines) { ctx.font = `${ln.face} ${ln.F}px system-ui, sans-serif`; ctx.globalAlpha = (ln.alpha ?? 1) * labA; ctx.lineWidth = 4 * lay.p; ctx.strokeStyle = halo; ctx.fillStyle = ln.color;
    ctx.strokeText(ln.t, ln.cx, ln.cy); ctx.fillText(ln.t, ln.cx, ln.cy); }
}
// text wrapped at word boundaries to lines of about `width` characters; at most maxLines: a text that needs more is cut on its
// last line with "…"
function wrapText(s, width, maxLines) {
  const words = String(s || '').split(/\s+/).filter(Boolean), lines = []; let cur = '';
  for (const w of words) { if (cur && (cur + ' ' + w).length > width) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w; }
  if (cur) lines.push(cur);
  // no orphan: a short last word ("I/II", "Lead") stays on the line before when that line overruns the width only a little
  if (lines.length > 1 && lines[lines.length - 1].length <= 5 && (lines[lines.length - 2] + ' ' + lines[lines.length - 1]).length <= width + 6) lines.splice(-2, 2, lines[lines.length - 2] + ' ' + lines[lines.length - 1]);
  if (lines.length > maxLines) { const rest = lines.slice(maxLines - 1).join(' '); lines.length = maxLines - 1; lines.push(cutWords(rest, width)); }
  // a connecting "&" or "+" at a line end moves to the start of the next line ("Test" / "& Verification"); a dangling dash,
  // comma or colon is dropped
  for (let i = 0; i < lines.length - 1; i++) {
    const m = lines[i].match(/\s+([&+])$/); if (m) { lines[i] = lines[i].slice(0, -m[0].length); lines[i + 1] = m[1] + ' ' + lines[i + 1]; }
    lines[i] = lines[i].replace(/[\s,\-–:;\/]+$/, '');
  }
  return lines;
}
// the representative roles of each neighbourhood (the layout's representatives, i.e. the shown roles), the most typical first:
// nearest to the neighbourhood's centre in the embedding. Returns lists[h] = entity indices.
function roleRounds(Ly) {
  const byH = Ly.hoods.map(() => []);
  Ly.ents.forEach((e, k) => { if (!vis[k] || e.hidden || pos[e.idx[0]] < 0) return; byH[e.c2].push(k); });
  return byH.map((ks) => { if (!ks.length) return []; const c = new Float32Array(D);
    ks.forEach((k) => { const v = vecOf(Ly.ents[k].idx[0]); for (let d = 0; d < D; d++) c[d] += v[d]; });
    return ks.map((k) => { const v = vecOf(Ly.ents[k].idx[0]); let s = 0; for (let d = 0; d < D; d++) s += v[d] * c[d]; return [s, k]; }).sort((a, b) => (wOf(Ly.ents[b[1]].idx[0]) - wOf(Ly.ents[a[1]].idx[0])) || (b[0] - a[0])).map((x) => x[1]); });
}
// a role title for a label: gender tags and reference codes out, spaces collapsed, cut at 40 characters on a word boundary
const GENDER_TAG = /(?:[(\[]\s*)?\/?\s*[mwfdxh]\s*\/\s*[mwfdxh](?:\s*\/\s*[mwfdxh])*\s*[)\]]?|[(\[]\s*(?:all\s+genders|gn|\*)\s*[)\]]/gi;
const GENDER_END = /(?:^|[\s,\-–])[mwfdxh]\s*\/\s*[mwfdxh](?:\s*\/\s*[mwfdxh])?\s*$/i;
const REF_CODE = /\(\s*[a-z]{0,3}\d{3,}\s*\)|[\s,\-–]*\b(?:m\s?w\s?d|w\s?m\s?d|f\s?m\s?d|h\s?f|f\s?h|d\s?f\s?m)?\s*\b\d{4,}\s*$/gi;
// the company inside a role label's brackets: its short name without a bracket of its own ("STARK (STARK Defence)" -> "STARK")
const coInLabel = (name) => { const s = shortName(name), t = s.replace(/\s*\([^()]*\)\s*$/, '').trim(); return t || s; };
function cleanTitle(title) {
  let s = String(title || '').replace(GENDER_TAG, ' ').replace(/\s+/g, ' ').trim();
  for (let q = 0; q < 4; q++) { const u = s.replace(GENDER_END, '').replace(REF_CODE, '').replace(/\s+/g, ' ').trim(); if (u === s) break; s = u; }
  return s.replace(/[\s,\-–:;\/]+$/, '').trim();
}
function cutWords(s, n) {
  s = String(s || '').trim(); if (s.length <= n) return s;
  let c = s.slice(0, n); const p = c.lastIndexOf(' '); if (p >= n / 2) c = c.slice(0, p);
  return c.replace(/[\s,.\-–:;\/&]+$/, '') + '…';
}
// with the one map: per region and neighbourhood, the visible roles in it (n) and their mean position (xy), so a filter moves a
// label to where its roles are. A label needs at least `min` visible roles: 6, or 0.4 % of the visible roles.
function visStats(Ly) {
  const group = (key, groups) => { const G = groups.map(() => ({ n: 0, sx: 0, sy: 0 })); Ly.ents.forEach((e, k) => { if (!vis[k]) return; const g = G[e[key]]; if (!g) return; g.n++; g.sx += e.x; g.sy += e.y; });
    return G.map((g, q) => ({ r: groups[q], n: g.n, xy: g.n ? [g.sx / g.n, g.sy / g.n] : groups[q].xy })); };
  return { min: Math.max(6, 0.004 * vis.filter(Boolean).length), reg: group('c1', Ly.regions), hood: Ly.past ? [] : group('c2', Ly.hoods) };
}
// ---- drawing. prepare(T) sets the visible points and the taste fit for the current view; paintMap(ctx, P, o) draws the view on
// any context whose transform maps the logical W x H map onto it. o.screen: the lens, sample and zoom buttons are drawn and kept
// clear (o.names 'few'); an exported image has none of them and names the areas and the role labels or company names ('many').
// o.ff: the colour field's grid factor (finer when zoomed or exported big); o.ts: the text scale.
function prepare(T) {
  const Ly = lay(), roles = st.mode === 'roles', showTaste = !!(taste && $('atlas-taste').checked) && !Ly.past;
  const SCOPE_RANKS = { bavaria: 0, germany: 1, europe: 2, worldwide: 3 };
  if (roles) {
    act = Ly.past ? Ly.ents.map(() => true) : Ly.ents.map((e) => visibleRoles(e).length > 0);
    vis = act;
  } else {
    act = Ly.ents.map((e) => visibleRoles(e).length > 0);
    vis = Ly.ents.map((e) => {
      if (st.fields.size > 0) {
        const matchesVec = ix.fields.some((f, q) => st.fields.has(f) && e.f[q] >= 0.15);
        if (matchesVec) return true;
        const fldStr = (e.field || '').toLowerCase();
        for (const f of st.fields) { if (fldStr.includes(f.toLowerCase())) return true; }
        const co = coRows[e.slug];
        if (co && co[9]) {
          const tags = co[9];
          for (const f of st.fields) {
            const fl = f.toLowerCase();
            if (tags.some((t) => t.toLowerCase().includes(fl))) return true;
          }
        }
        return false;
      }
      return true;
    });
    if (st.scope < cfg.scopes.length - 1) {
      const maxRank = st.scope;
      vis = vis.map((v, k) => {
        if (!v) return false;
        const co = coRows[Ly.ents[k].slug];
        if (!co) return true;
        const r = SCOPE_RANKS[co[12]] ?? 3;
        return r <= maxRank;
      });
    }
  }
  fit = showTaste ? fitOf(Ly) : null;
  // a company's open roles in the filter (cn), their weight (cw: the sum of the roles' age weights) and whether one is new today (cNew)
  const cn = new Int32Array(Ly.n), cw = new Float32Array(Ly.n), cNew = new Uint8Array(Ly.n); let cwMax = 0;
  if (!roles) Ly.ents.forEach((e, k) => { for (const i of visibleRoles(e)) { cn[k]++; cw[k] += wOf(i); if (AGE[i] < 1) cNew[k] = 1; } cwMax = Math.max(cwMax, cw[k]); });
  coN = cn;
  const stat = !roles || !perScope || Ly.past ? visStats(Ly) : null;   // companies: the regions' means over their visible companies, as the roles' neighbourhoods
  // the visible roles by age: today, this week, this month (the legend under the map)
  const fresh = { t: 0, w: 0, m: 0 }; if (roles) Ly.ents.forEach((e, k) => { if (!vis[k] || e.ember || (e.hidden && !st.all)) return; const a = ageE(e); if (a < 1) fresh.t++; else if (a < 7) fresh.w++; else if (a < 30) fresh.m++; });
  return { Ly, roles, showTaste, T, ink: css('--ink'), paper: css('--panel'), stat, fresh, heat: !!(roles && TL && $('atlas-heat').checked), cn, cw, cNew, cwMax };
}
// the label scale on screen: up to 1.5 x with the map's width, up to 1.35 x with the zoom, so the text grows with the map
const fsk = () => Math.max(1, Math.min(1.5, BW / 900)) * Math.min(1.35, st.z.s ** 0.15);
// a new role's star, or a company's star (strength w: a role's age weight, a company's log weight against the heaviest). R: the radius,
// spark: a sparkle. Neon: the region colour with a glow and a white core. Light: a dark core in the region colour, a soft shadow in the
// region colour and an ink ring. a: the alpha (the points fade in and out with a change of view)
function star(ctx, X0, Y0, R, w, c1, spark, T, ink, a) {
  const rgb = regionRgb(c1, T.pointL, T.C), c = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`, hc = T.glow ? rgb : regionRgb(c1, 0.45, T.C);
  ctx.globalAlpha = a;
  // the glow: a soft radial halo in the region colour (a gradient is far cheaper than a canvas shadow on every star)
  const gr = R * (1 + 2.2 * w), gd = ctx.createRadialGradient(X0, Y0, 0, X0, Y0, gr), hs = `${hc[0]},${hc[1]},${hc[2]}`;
  gd.addColorStop(0, `rgba(${hs},${T.glow ? 0.9 : 0.6})`); gd.addColorStop(1, `rgba(${hs},0)`);
  ctx.fillStyle = gd; ctx.beginPath(); ctx.arc(X0, Y0, gr, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(X0, Y0, R, 0, 7);
  if (T.glow) { ctx.fillStyle = c; ctx.fill(); ctx.beginPath(); ctx.arc(X0, Y0, 0.45 * R, 0, 7); ctx.fillStyle = '#ffffff'; ctx.fill(); }   // neon: the region colour with a white core
  else { const core = regionRgb(c1, 0.48, T.C); ctx.fillStyle = `rgb(${core[0]},${core[1]},${core[2]})`; ctx.fill(); ctx.strokeStyle = spark ? ink : '#ffffff'; ctx.lineWidth = spark ? 1.2 : 1; ctx.stroke(); }   // light: a deep region-colour core with a white ring (an ink ring for today's)
  if (spark) { const s = 1.6 * R; ctx.globalAlpha = 0.8 * a; ctx.strokeStyle = T.glow ? '#ffffff' : ink; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X0 - s, Y0); ctx.lineTo(X0 + s, Y0); ctx.moveTo(X0, Y0 - s); ctx.lineTo(X0, Y0 + s); ctx.stroke(); }
  ctx.globalAlpha = a;
}
// the company label: its name and, when it has open roles in the filter, their number: "Name (4)"
const coLabel = (nm, n) => (n ? `${nm} (${n})` : nm);
function paintMap(ctx, P, o) {
  const { Ly, roles, T, ink, paper, stat, cn, cw } = P, screen = o.screen, many = o.names === 'many', zoomed = st.z.s >= 2.2, ff = o.ff || 1, ks = Math.max(1, W * H / (900 * 640));   // ks: the label caps grow with the area
  const light = !!o.noLabels;   // a frame kept for a change of view: the field and the points, no labels
  const ts = screen ? fsk() : (o.ts || 1), zf = Math.min(2.5, Math.sqrt(st.z.s)), dot = 2 * zf;
  const bg = T.bg || paper, halo = T.halo || paper, tintOf = (c) => { const r = regionRgb(c, T.tintL, T.C); return `rgb(${r[0]},${r[1]},${r[2]})`; };
  ctx.globalCompositeOperation = 'source-over';
  if (screen && !T.bg && !T.multiply) ctx.clearRect(0, 0, W, H); else { ctx.globalAlpha = 1; ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
  // links between neighbourhoods (roles) or between regions (companies): the share of neighbour links that cross
  if (Ly.links.length) { const mx = Math.max(...Ly.links.map((l) => l[2])); ctx.strokeStyle = T.linkInk || ink; ctx.lineWidth = 1; const HX = stat ? stat.hood : Ly.hoods;
    for (const [a, b, w] of Ly.links) { if (stat && (!HX[a].n || !HX[b].n)) continue; const pa = HX[a].xy, pb = HX[b].xy; ctx.globalAlpha = T.linkInk ? 0.04 + 0.12 * (w / mx) : 0.05 + 0.25 * (w / mx); ctx.beginPath(); ctx.moveTo(sx(pa[0]), sy(pa[1])); ctx.lineTo(sx(pb[0]), sy(pb[1])); ctx.stroke(); } }
  // a soft colour field behind the points: each region's colour, blended where regions meet, stronger where points are dense
  const fo = { strength: T.fieldStrength, L: T.fieldL, C: T.C, ff, op: T.multiply ? 'multiply' : 'source-over' };
  if (T.glow) { colourField(ctx, Ly, fo); colourField(ctx, Ly, { ...fo, strength: T.glow.strength, extra: T.glow.extra, additive: true }); }
  else colourField(ctx, Ly, fo);
  // hot and cold spots: after the colour field, before the points; an area keeps its colour and only gets brighter or dimmer
  if (P.heat) heatField(ctx, ff, T, bg);
  let shown = 0; const hot = [], buckets = new Map();
  // a company's dot: by its open roles (1.6 + 1.1 sqrt(n), at most 5.5), 1.3 for a company with none
  const rcOf = (k) => (cn[k] ? Math.min(5.5, 1.6 + 1.1 * Math.sqrt(cn[k])) : 1.3) * zf;
  // a star's strength: a role's age weight; a company's log weight against the heaviest company
  const starOf = (k) => (roles ? wE(Ly.ents[k]) : cw[k] > 0 ? Math.log1p(cw[k]) / Math.log1p(P.cwMax) : 0);
  // companies with no open role in the filter: small faint dots, drawn first, no rings
  if (!roles) Ly.ents.forEach((e, k) => { if (cn[k] || !vis[k]) return; const X0 = sx(e.x), Y0 = sy(e.y); if (X0 < -5 || Y0 < -5 || X0 > W + 5 || Y0 > H + 5) return;
    const rgb = regionRgb(e.c1, T.dimL, T.C); ctx.globalAlpha = T.dimA ?? 0.28; ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; ctx.beginPath(); ctx.arc(X0, Y0, rcOf(k), 0, 7); ctx.fill(); });
  Ly.ents.forEach((e, k) => { if (!roles && !cn[k]) return; if (!vis[k]) return; if (act[k] && !e.ember) shown++; if (e.hidden && !st.all) return;
    const X0 = sx(e.x), Y0 = sy(e.y); if (X0 < -5 || Y0 < -5 || X0 > W + 5 || Y0 > H + 5) return;
    if (e.ember) { ctx.globalAlpha = e.ea; ctx.fillStyle = 'rgb(190,120,60)'; ctx.fillRect(X0 - dot / 2, Y0 - dot / 2, dot, dot); return; }   // a role last seen before the scrubbed time: a dim warm ember
    const sv = starOf(k);
    if (sv > 0) { hot.push([k, sv]); return; }   // new roles, and companies with some: drawn after the others, on top
    // crowded spots get fainter points so a dense cluster does not glare; sparse ones keep full strength
    const a = (act[k] ? T.pointA : 0.45) * Math.min(1, 1 / Math.sqrt(densAt(X0, Y0))) * (fit ? 0.12 + 0.88 * fit[k] : 1) * (P.heat ? 0.45 : 1);
    if (a <= 0.003) return;
    const rgb = regionRgb(e.c1, act[k] ? T.pointL : T.dimL, T.C);
    if (roles) {   // the role points go into one path per colour and alpha (a fill each, not one per point)
      const q = Math.round(a * 20), key = `${e.c1}|${act[k] ? 1 : 0}|${q}`; let b = buckets.get(key);
      if (!b) buckets.set(key, b = { q, rgb, p: new Path2D() }); b.p.rect(X0 - dot / 2, Y0 - dot / 2, dot, dot); return; }
    // a company with open roles: a dot by its number of roles; on neon a thin ring in its colour, on light none
    ctx.globalAlpha = a; ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.beginPath(); ctx.arc(X0, Y0, rcOf(k), 0, 7); ctx.fill();
    if (!T.multiply) { ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.4)`; ctx.lineWidth = 1.2; ctx.stroke(); } });
  for (const b of buckets.values()) { if (!b.q) continue; ctx.globalAlpha = b.q / 20; ctx.fillStyle = `rgb(${b.rgb[0]},${b.rgb[1]},${b.rgb[2]})`; ctx.fill(b.p); }
  // the new roles and the companies with some, on top
  if (hot.length) for (const [k, sv] of hot) { const e = Ly.ents[k], X0 = sx(e.x), Y0 = sy(e.y), base = roles ? dot : rcOf(k); star(ctx, X0, Y0, base * (1 + 1.6 * sv), sv, e.c1, roles ? sv >= 1 : !!P.cNew[k], T, ink, 1); }
  // the point whose card is open: a ring (on screen only)
  if (screen && sel && sel.ly === Ly && vis[sel.k]) {
    const e = Ly.ents[sel.k], R = (roles ? dot * (1 + 1.6 * wE(e)) : rcOf(sel.k) * (1 + 1.6 * starOf(sel.k))) + 4;
    ctx.globalAlpha = 1; ctx.strokeStyle = T.linkInk || ink; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(sx(e.x), sy(e.y), R, 0, 7); ctx.stroke();
  }
  Ly.ents.forEach((e) => { const v = voteOf(e.id); if (!v) return; const col = v > 0 ? '#2fb36b' : '#d9534f', x = sx(e.x), y = sy(e.y); ctx.globalAlpha = 1; ctx.fillStyle = col; ctx.strokeStyle = halo; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill(); ctx.stroke(); });
  // keep: the frame so far (the field and the points, no labels) is copied for a change of view: it is that change's frame before
  if (o.keep) { const k = base || (base = { c: document.createElement('canvas') }); k.c.width = ctx.canvas.width; k.c.height = ctx.canvas.height; k.c.getContext('2d').drawImage(ctx.canvas, 0, 0); k.z = { ...st.z }; }
  const counts = { areas: 0, roles: 0, companies: 0, lens: 0, fresh: 0 };
  // labels, largest first. A label is drawn only where its box fits inside the map, clear of the lens and the zoom buttons (on
  // screen) and of every label already placed; otherwise it is left out. Areas first, then role labels or company names.
  if (!light) {
  const boxes = screen ? [[W - 56, 0, W, 180]] : [], lr = st.size * BW + 6, lcx = sx(st.lens.x), lcy = sy(st.lens.y);
  const place = (lines, cands, free) => { for (const [x, y, a] of cands) { const lay = labelLayout(ctx, lines, x, y, a, ts), b = lay.box;
      if (b[0] < 4 || b[1] < 4 || b[2] > W - 4 || b[3] > H - 4) continue;
      if (screen && !free) { const nx = Math.max(b[0], Math.min(lcx, b[2])), ny = Math.max(b[1], Math.min(lcy, b[3])); if (Math.hypot(nx - lcx, ny - lcy) < lr) continue; }
      if (boxes.some((q) => !(b[2] < q[0] || b[0] > q[2] || b[3] < q[1] || b[1] > q[3]))) continue;
      boxes.push(b); labelDraw(ctx, lay, halo); return b; } return false; };
  const ENT_FS = 9;   // employer and company names: 9 px (about 72 % of the neighbourhood names, never below 9)
  // the regions and neighbourhoods as { r, n, xy }: with the one map, the visible roles and their mean position (see visStats)
  const regs = stat ? stat.reg.filter((g) => g.n >= stat.min) : Ly.regions.map((r) => ({ r, n: r.n, xy: r.xy })), hoods = stat ? stat.hood.filter((g) => g.n >= stat.min) : Ly.hoods.map((r) => ({ r, n: r.n, xy: r.xy }));
  const byN = (list, sub) => list.map((g) => ({ ...g, sub })).sort((a, b) => b.n - a.n);
  // areas: regions at full view, neighbourhoods when zoomed in (or, in an image, always, after the regions, in a smaller weight)
  const areas = many ? [...byN(regs, false), ...(roles ? byN(hoods, true) : [])] : byN(roles && zoomed && !Ly.past ? hoods : regs, false);
  // area names first: they win over any single role or company label
  const areaInk = (sub) => (T.areaInk ? (sub ? T.subInk : T.areaInk) : ink);
  for (const { r, n, xy, sub } of areas) {
    if (counts.areas >= Math.round((many ? 400 : 24) * ks) || (!r.words.length && !r.label)) continue;
    const fs = sub ? Math.round(Math.max(9, Math.min(12, 6 + Math.sqrt(n) * 0.22))) : Math.round(Math.max(11, Math.min(18, 7 + Math.sqrt(n) * 0.33)));
    const lines = wrapText(nameOf(r), roles ? 16 : 20, roles ? 2 : 3).map((t) => ({ t, fs, face: sub ? '500' : '600', alpha: 1, color: areaInk(sub) }));   // company groups have long names
    if (place(lines, [[sx(xy[0]), sy(xy[1]), 'center']])) counts.areas++;
  }
  // the roles and companies in the lens are labelled at any zoom (roles: newest first, then nearest the lens centre; companies: most open
  // roles first). On screen the other new roles follow, newest first. They come after the area names and fit around them, and may lie
  // inside the lens. A role title is used once; in the lens the same title at the same company is skipped.
  const rL = st.size * BW, ccx = sx(st.lens.x), ccy = sy(st.lens.y), lensCap = many ? 40 : Math.round(12 * ks), newCap = Math.round(8 * ks);
  const d2 = (k) => (sx(Ly.ents[k].x) - ccx) ** 2 + (sy(Ly.ents[k].y) - ccy) ** 2, inMap = (X0, Y0) => X0 >= 0 && Y0 >= 0 && X0 <= W && Y0 <= H;
  const seenT = new Set(), seenC = new Set(), labelled = new Set();
  const byAge = (a, b) => { const x = AGE[Ly.ents[a].idx[0]], y = AGE[Ly.ents[b].idx[0]]; return x !== y ? (x < y ? -1 : 1) : d2(a) - d2(b); };
  const cand = (X0, Y0, lines) => { const b = labelLayout(ctx, lines, 0, 0, 'center', ts).box, hh = (b[3] - b[1]) / 2; return [[X0 + 6 * ts, Y0, 'left'], [X0 - 6 * ts, Y0, 'right'], [X0, Y0 - 6 * ts - hh, 'center'], [X0, Y0 + 6 * ts + hh, 'center']]; };
  // a role's label: its title (up to 2 lines of about 26 characters, "✦ " before the first line when new today), then its company in brackets
  const roleLines = (title, row, col, pre = '') => { const ls = wrapText(title, 26, 2).map((t) => ({ t, fs: ENT_FS, face: 'italic 400', alpha: 0.9, color: col })); ls[0].t = pre + ls[0].t;
    return ls.concat([{ t: `(${cutWords(coInLabel(row[2]), 28)})`, fs: ENT_FS * 0.9, face: 'italic 400', alpha: 0.8, color: col }]); };
  const roleLab = (k, free) => { const e = Ly.ents[k], row = rows[e.idx[0]], title = cleanTitle(row[1]), X0 = sx(e.x), Y0 = sy(e.y), col = T.tintL ? tintOf(e.c1) : ink;
    if (!title) return false; const lines = roleLines(title, row, col, wOf(e.idx[0]) >= 1 ? '✦ ' : '');
    if (!place(lines, cand(X0, Y0, lines), free)) return false;
    seenT.add(title.toLowerCase()); labelled.add(k); ctx.globalAlpha = 0.95; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X0, Y0, 2.4 * ts, 0, 7); ctx.fill(); return true; };
  if (roles && !Ly.past) {
    const pool = []; Ly.ents.forEach((e, k) => { if (vis[k] && !(e.hidden && !st.all) && d2(k) <= rL * rL) pool.push(k); }); pool.sort(byAge);
    for (const k of pool) { if (counts.lens >= lensCap) break; const e = Ly.ents[k], row = rows[e.idx[0]], title = cleanTitle(row[1]), tk = title.toLowerCase() + '|' + row[2];
      if (!title || !inMap(sx(e.x), sy(e.y)) || seenC.has(tk)) continue; if (roleLab(k, true)) { seenC.add(tk); counts.lens++; } }
    if (screen) { const fresh = []; Ly.ents.forEach((e, k) => { if (vis[k] && !(e.hidden && !st.all) && wOf(e.idx[0]) > 0 && !labelled.has(k) && inMap(sx(e.x), sy(e.y))) fresh.push(k); }); fresh.sort(byAge);
      for (const k of fresh) { if (counts.fresh >= newCap) break; const t = cleanTitle(rows[Ly.ents[k].idx[0]][1]).toLowerCase(); if (!t || seenT.has(t)) continue; if (roleLab(k, false)) counts.fresh++; } }
  } else if (!roles) {
    // the companies in the lens, with their open roles in brackets (a company with none: its name only)
    const pool = []; Ly.ents.forEach((e, k) => { if (vis[k] && e.name && !(e.hidden && !st.all) && d2(k) <= rL * rL) pool.push(k); });
    pool.sort((a, b) => cn[b] - cn[a] || d2(a) - d2(b));
    for (const k of pool) { if (counts.lens >= lensCap) break; const e = Ly.ents[k], X0 = sx(e.x), Y0 = sy(e.y), nm = shortName(e.name);
      if (!nm || !inMap(X0, Y0) || seenC.has(nm)) continue; const col = T.tintL ? tintOf(e.c1) : ink, lines = wrapText(coLabel(nm, cn[k]), 22, 2).map((t) => ({ t, fs: ENT_FS, face: 'italic 400', alpha: 0.9, color: col }));
      if (place(lines, cand(X0, Y0, lines), true)) { seenC.add(nm); counts.lens++; } }
  }
  // roles (roles map): one representative role per neighbourhood, the most typical first, in rounds across the neighbourhoods
  // (the first of every neighbourhood, then the second of each, ...) so the labels spread over the map; each label is the role's
  // title and its company in brackets, beside a small dot marker at the role's own position. A title is used once.
  if (roles && !Ly.past && (many || zoomed)) {
    const cap = Math.round((many ? 120 : 14) * ks), lists = roleRounds(Ly), order = [...Ly.hoods.keys()].sort((x, y) => (stat ? stat.hood[y].n - stat.hood[x].n : Ly.hoods[y].n - Ly.hoods[x].n));
    rounds: for (let r = 0; ; r++) { let any = false;
      for (const h of order) { const list = lists[h]; if (r >= list.length) continue; any = true;
        if (counts.roles >= cap) break rounds;
        const e = Ly.ents[list[r]], X0 = sx(e.x), Y0 = sy(e.y); if (X0 < 0 || Y0 < 0 || X0 > W || Y0 > H) continue;
        const row = rows[e.idx[0]], title = cleanTitle(row[1]), key = title.toLowerCase(); if (!title || seenT.has(key)) continue;
        const col = T.tintL ? tintOf(e.c1) : ink;
        // the title (up to 2 lines of about 26 characters), then the company in brackets on its own line: a little smaller and dimmer
        const lines = roleLines(title, row, col);
        if (place(lines, [[X0 + 6 * ts, Y0, 'left'], [X0 - 6 * ts, Y0, 'right']])) { seenT.add(key); counts.roles++; ctx.globalAlpha = 0.95; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X0, Y0, 2.4 * ts, 0, 7); ctx.fill(); } }
      if (!any) break; }
  }
  // companies (companies map): next to their dot, right of it or else left, the companies with most open roles first; the companies
  // with none are labelled in the lens only
  if (!roles && (many || zoomed)) {
    const order = Ly.ents.map((e, k) => k).filter((k) => vis[k] && Ly.ents[k].name && cn[k] > 0).sort((a, b) => cn[b] - cn[a]);
    for (const k of order) { if (counts.companies >= Math.round((many ? 300 : 15) * ks)) break; const e = Ly.ents[k], X0 = sx(e.x), Y0 = sy(e.y); if (X0 < 0 || Y0 < 0 || X0 > W || Y0 > H) continue;
      const nm = shortName(e.name); if (seenC.has(nm)) continue; seenC.add(nm);
      const col = T.tintL ? tintOf(e.c1) : ink, rr = rcOf(k) + 3, lines = wrapText(coLabel(nm, cn[k]), 22, 2).map((t) => ({ t, fs: ENT_FS, face: 'italic 400', alpha: 0.9, color: col }));
      if (place(lines, [[X0 + rr, Y0, 'left'], [X0 - rr, Y0, 'right']])) counts.companies++; }
  }
  }
  if (screen) {   // the lens and the sampled points
    const r = st.size * BW, lx = sx(st.lens.x), ly = sy(st.lens.y); ctx.globalAlpha = 1; ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.arc(lx, ly, r, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = ink; st.sample.forEach((k) => { const e = Ly.ents[k]; if (!e) return; ctx.beginPath(); ctx.arc(sx(e.x), sy(e.y), 4, 0, 7); ctx.fill(); });
  }
  return { shown, counts };
}

function draw() {
  sizeCanvas();
  if (anim && anim.setting) { prepare(THEMES[themeFor()]); return; }   // a change of view is setting the view: its frames come from the bitmaps (see viewChange)
  if (anim && anim.light) { tweenDraw(); return; }
  const T = THEMES[themeFor()], P = prepare(T), ff = Math.min(3, Math.max(1, Math.sqrt(st.z.s))), res = paintMap(g, P, { screen: true, names: 'few', ff, ts: 1, keep: true }), Ly = P.Ly;
  const unitEn = P.roles ? 'roles' : 'companies', unitDe = P.roles ? 'Stellen' : 'Firmen', showTaste = P.showTaste;
  if (TL) tlShow(); buildHit(Ly); if (sel && (sel.ly !== Ly || !vis[sel.k] || (Ly.ents[sel.k].hidden && !st.all))) hidePop();
  if (sel) { const e = Ly.ents[sel.k], X = sx(e.x), Y = sy(e.y); if (X < 0 || Y < 0 || X > W || Y > H) hidePop(); else placePop(X, Y); }
  const fr = P.fresh, legend = P.roles && fr.t + fr.w + fr.m ? `  ✦ ${L('new today', 'neu heute')} ${fr.t} · ${L('this week', 'diese Woche')} ${fr.w} · ${L('this month', 'diesen Monat')} ${fr.m}` : '';
  $('atlas-status').innerHTML = L(`${res.shown.toLocaleString()} ${unitEn} shown${P.roles && Ly.placed ? ` (${Ly.placed} newer roles placed next to their nearest neighbours)` : ''}. Colours are regions of closely linked ${unitEn}; lines join neighbourhoods that share many links. Drag the dashed lens to sample an area, drag elsewhere to move the map, zoom with + and − or the mouse wheel.${showTaste ? '  Brightness shows how well an area fits your profile; with little to go on the contrast is low.' : ''}`,
    `${res.shown.toLocaleString('de-DE')} ${unitDe} gezeigt${P.roles && Ly.placed ? ` (${Ly.placed} neuere Stellen neben ihren nächsten Nachbarn platziert)` : ''}. Farben sind Regionen eng verbundener ${unitDe}; Linien verbinden Nachbarschaften mit vielen gemeinsamen Verbindungen. Die gestrichelte Lupe ziehen, um einen Bereich zu sehen, daneben ziehen, um die Karte zu verschieben, mit + und − oder dem Mausrad zoomen.${showTaste ? '  Die Helligkeit zeigt, wie gut ein Bereich zu Ihrem Profil passt; solange wenig bekannt ist, ist der Kontrast gering.' : ''}`) + legend;
}
// ---- motion. A change of view (fit, zoom, reset, scope, field, mode) is shown as two bitmaps: the frame before and the frame after, each
// drawn once without labels (snapshot). Over 300 ms the new one fades in over the old; over 420 ms the zoom tweens (a frame of the tween
// only draws the two bitmaps under the current transform). At the end the full draw with its labels. Reduced motion: at once. setView
// (the export) never animates.
const MOTION = { view: 420, fade: 300 }, noMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeIO = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
function stopAnim() { if (!anim) return; cancelAnimationFrame(animRaf); if (anim.z1) st.z = { ...anim.z1 }; anim = null; }
// the frame as it is at zoom z: the field and the points (no labels), on a canvas of the stage's pixel size; the state is the current one
function snapshot(z) { const c = document.createElement('canvas'), keep = { ...st.z }; c.width = cv.width; c.height = cv.height; const x = c.getContext('2d');
  st.z = { ...z }; x.setTransform(cv.width / W, 0, 0, cv.height / H, 0, 0);
  try { const T = THEMES[themeFor()], P = prepare(T); paintMap(x, P, { screen: true, names: 'few', ff: Math.min(3, Math.max(1, Math.sqrt(z.s))), ts: 1, noLabels: true }); }
  finally { st.z = keep; }
  return { c, z: { ...z } }; }
// set() changes the view and the filters (its redraws only prepare, the frames come from the bitmaps); then the zoom tweens from the view
// before to the new one, and the two frames cross-fade
// the filters that decide the points: a change of them needs the frame after (a zoom alone does not)
const stateKey = () => [st.mode, st.scope, [...st.fields].sort().join(), layers.roles];
function viewChange(set) {
  const z0 = { ...st.z }, wasAnim = !!anim; stopAnim(); st.z = z0;
  if (noMotion()) { set(); return; }
  // the frame before: the last full frame when it is at this zoom (no new render), else rendered now
  const old = !wasAnim && base && base.z.s === z0.s && base.z.cx === z0.cx && base.z.cy === z0.cy ? base : snapshot(z0), k0 = stateKey();
  anim = { setting: true, z0, z1: null, old, nw: null, t0: 0, f: 0, light: true };
  set(); anim.z1 = { ...st.z }; if (stateKey().some((v, i) => v !== k0[i])) anim.nw = snapshot(anim.z1); st.z = { ...z0 };
  anim.setting = false; anim.t0 = performance.now(); animRaf = requestAnimationFrame(tweenStep); draw();
}
function tweenStep(now) {
  const A = anim; if (!A || A.setting) return;
  const t = now - A.t0, p = Math.min(1, t / MOTION.view), e = easeIO(p);
  st.z = { s: A.z0.s * (A.z1.s / A.z0.s) ** e, cx: A.z0.cx + (A.z1.cx - A.z0.cx) * e, cy: A.z0.cy + (A.z1.cy - A.z0.cy) * e };
  A.f = Math.min(1, t / MOTION.fade); A.light = p < 1;
  if (!A.light) { anim = null; st.z = { ...A.z1 }; draw(); return; }
  draw(); animRaf = requestAnimationFrame(tweenStep);
}
// a frame of the tween: the old bitmap, then the new one fading in over it, each under the current view (a bitmap made at zoom q is drawn
// at the scale and the offset that take its zoom and centre to the current ones)
function tweenDraw() { const A = anim; g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.clearRect(0, 0, cv.width, cv.height); g.setTransform(cv.width / W, 0, 0, cv.height / H, 0, 0);
  blit(A.old, 1); if (A.nw && A.f > 0) blit(A.nw, A.f); g.globalAlpha = 1; }
function blit(S, alpha) { const a = st.z.s / S.z.s, ox = W / 2 * (1 - a) + (S.z.cx - st.z.cx) * st.z.s * BW, oy = H / 2 * (1 - a) + (S.z.cy - st.z.cy) * st.z.s * BH;
  g.globalAlpha = alpha; g.imageSmoothingEnabled = true; g.drawImage(S.c, ox, oy, a * W, a * H); }
// the current view as a PNG Blob, on the theme's background with a margin of 4 % of the width on every side; the logical W x H
// frame (the stage's size, or frame: [w, h] for a fixed one) is fitted into the rest at one uniform scale. The image is 900 * scale
// wide. Fonts are drawn at scale * textScale px (default 0.6 for the 'many' names).
let lastRender = null;
async function renderImage({ scale = 4, names = 'many', theme = 'neon', textScale, frame } = {}) {
  const keep = [W, H, BW, BH]; if (frame) setMap(frame[0], frame[1]);
  try {
    const T = THEMES[theme] || THEMES.neon, P = prepare(T); P.paper = css('--panel', '#fff');
    const cw = Math.round(900 * scale), ch = Math.round(900 * scale * H / W), m = 0.04 * cw;
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const ctx = c.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.fillStyle = T.bg || P.paper; ctx.fillRect(0, 0, cw, ch);
    const u = Math.min((cw - 2 * m) / W, (ch - 2 * m) / H), ox = (cw - u * W) / 2, oy = (ch - u * H) / 2;
    ctx.setTransform(u, 0, 0, u, ox, oy);
    const ts = (textScale ?? (names === 'many' ? 0.6 : 1)) * scale / u;
    const res = paintMap(ctx, P, { screen: false, names, ff: Math.min(4, scale / 1.5), ts });
    lastRender = { scale, names, theme, mode: st.mode, width: cw, height: ch, mapScale: u, shown: res.shown, ...res.counts };
    return await new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('the image could not be made'))), 'image/png'));
  } finally { [W, H, BW, BH] = keep; }
}
async function saveImage() {
  const btn = $('atlas-save-img'), title = btn.title; btn.disabled = true; btn.title = pick('Rendering…', 'Wird erstellt …');
  try { const blob = await renderImage({ scale: 5 }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = st.mode === 'roles' ? 'atlas-roles.png' : 'atlas-companies.png';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } finally { btn.disabled = false; btn.title = title; }
}
// the stage's own full screen (the browser's, Esc leaves it); a refused request is ignored
function toggleFs() { try { const on = fsEl() === stage; const p = on ? (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen?.()) : (stage.requestFullscreen ? stage.requestFullscreen() : stage.webkitRequestFullscreen?.()); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not allowed here */ } }
// the stage resized, or the window, or full screen changed: the map follows (see fitView)
new ResizeObserver(relayout).observe(stage); window.addEventListener('resize', relayout);
document.addEventListener('fullscreenchange', relayout); document.addEventListener('webkitfullscreenchange', relayout);
// switch the view (for the export script and the page): mode 'roles' or 'companies', scope the index of config.json's scopes
function setView({ mode = st.mode, scope = st.scope } = {}) {
  stopAnim(); st.mode = mode; st.scope = scope; st.open.clear(); st.sample = [];
  mount.querySelectorAll('#atlas-mode button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.m === mode)));
  $('atlas-scope').value = String(scope); layers.roles = roleMapFor(scope); fitOrWhole(); resample();
}
// the page's colour scheme changed: redraw in the other theme
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => draw());
// a site's own switch: redraw when the root's data-theme or the body's data-mode changes
const themeWatch = new MutationObserver(() => draw());
themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
if (document.body) themeWatch.observe(document.body, { attributes: true, attributeFilter: ['data-mode'] });
// how well each point fits the visitor's profile, 0..1: its rank among the visible points by taste score (the best fifth near 1).
// With few signals the contrast is reduced, so a thin profile only tints the map.
function fitOf(Ly) {
  const n = Ly.n, sc = new Float32Array(n).fill(-9), order = [];
  Ly.ents.forEach((e, k) => { if (!vis[k] || !e.idx.length) return; let best = -9; for (const i of e.idx) best = Math.max(best, taste.pos[i] - taste.pen[i]); sc[k] = best; order.push(k); });
  order.sort((a, b) => sc[a] - sc[b]); const out = new Float32Array(n).fill(0.25), contrast = Math.min(1, 0.4 + taste.signals / 15);
  order.forEach((k, r) => { const p = Math.pow((r + 1) / order.length, 2.2); out[k] = (1 - contrast) * 0.6 + contrast * p; });
  return out;
}
// a soft colour field behind the points: each region's colour, blended where regions meet, stronger where points are dense.
// o.strength; o.L and o.C: the colours' lightness and chroma target; o.ff: the grid factor (the grid is ff times finer and the blur
// passes ff*ff more, so the softness stays the same in map units); o.extra: more blur passes (a wider glow); o.additive: 'lighter'; o.op: the blend mode; o.alpha: the layer's alpha (a change of view cross-fades it)
let lastField = null, coN = null, anim = null, animRaf = 0, labA = 1, base = null;   // base: the last full frame without labels (see paintMap's keep)   // coN: the open roles of each company in the filter (prepare)
function colourField(ctx, Ly, o) {
  const f = o.ff || 1, GW = Math.round(96 * f * W / BW), GH = Math.round(68 * f * H / BH);
  // regions are mixed as hue directions (unit vectors around the OKLCH wheel), not as RGB: an RGB average of two hues is greyer
  // than either. Each cell then takes the vivid colour of its mixed hue, so borders between regions stay saturated.
  const A = new Float32Array(GW * GH), B = new Float32Array(GW * GH), N = new Float32Array(GW * GH), C0 = new Float32Array(GW * GH), W0 = new Float32Array(GW * GH);   // W0: the weighted count
  Ly.ents.forEach((e, k) => { if (!vis[k]) return; const X0 = sx(e.x) / W, Y0 = sy(e.y) / H; if (X0 < 0 || X0 >= 1 || Y0 < 0 || Y0 >= 1) return;
    const h = hue(e.c1) * Math.PI / 180, q = Math.floor(Y0 * GH) * GW + Math.floor(X0 * GW), w = fit ? 0.08 + fit[k] * fit[k] : 1, wt = Ly.kind === 'companies' ? 0.25 + Math.sqrt(coN[k]) : 1;   // a company weighs 0.25 + sqrt(its open roles), a role 1
    A[q] += Math.cos(h) * w; B[q] += Math.sin(h) * w; N[q] += w; C0[q]++; W0[q] += wt; });
  const raw = Float32Array.from(C0), nz = [...raw].filter((x) => x > 0).sort((a, b) => a - b), typical = nz.length ? nz[Math.floor(nz.length / 2)] : 1;
  densAt = (px, py) => { const q = Math.min(GH - 1, Math.max(0, Math.floor(py / H * GH))) * GW + Math.min(GW - 1, Math.max(0, Math.floor(px / W * GW))); return Math.max(1, raw[q] / typical); };
  const passes = Math.max(1, Math.round((4 + Math.min(4, Math.round(Math.log2(st.z.s + 1))) + (o.extra || 0)) * f * f)); for (const X of [A, B, N, C0, W0]) blur(X, GW, GH, passes);
  // the soft coverage: the weighted density against its 95th percentile (d = 1 is a dense area), coverage = 1 - exp(-2.5 d): dense areas are rich,
  // sparse ones thin, with no flat plateau
  const ramp = Ly.kind === 'companies' ? [2.5, 1.2] : [10, 0.7];   // roles: dense areas saturate, only the sparse edges thin; companies: the steeper ramp
  const dz = [...W0].filter((x) => x > 1e-3).sort((a, b) => a - b); if (!dz.length) return; const q95 = dz[Math.min(dz.length - 1, Math.floor(dz.length * 0.95))] || 1e-3;
  const band = Array.isArray(o.L) ? o.L : [o.L, o.L];
  const small = document.createElement('canvas'); small.width = GW; small.height = GH; const sg = small.getContext('2d'), img = sg.createImageData(GW, GH);
  for (let q = 0; q < N.length; q++) { const n = N[q]; if (n < 1e-4) continue;
    const coverage = 1 - Math.exp(-ramp[0] * W0[q] / q95), match = fit ? Math.min(1, 0.15 + 1.2 * n / Math.max(C0[q], 1e-6)) : 1;
    // where opposite hues cancel out (the mixed direction is short) the cell fades instead of turning grey
    const len = Math.hypot(A[q], B[q]) / n, h = (Math.atan2(B[q], A[q]) * 180 / Math.PI + 360) % 360, c = vivid(h, band[0], band[1], o.C);
    img.data[q * 4] = c[0]; img.data[q * 4 + 1] = c[1]; img.data[q * 4 + 2] = c[2]; img.data[q * 4 + 3] = Math.round(255 * o.strength * coverage ** ramp[1] * match * Math.min(1, 0.35 + len)); }
  sg.putImageData(img, 0, 0); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.globalAlpha = o.alpha ?? 1;
  ctx.globalCompositeOperation = o.additive ? 'lighter' : (o.op || 'source-over'); ctx.drawImage(small, 0, 0, W, H); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  if (!o.additive) lastField = { small, GW, GH, z: { ...st.z } };      // the main layer, which the hot and cold spots brighten
}
// favoured / pushed-away field: per screen cell, the share of entities in the top of your taste (green) and under a penalty (red);
// the fewer signals there are, the more it is blurred, so a thin profile shows as a soft haze and sharpens as you mark more
function drawTaste(Ly) {
  const n = Ly.n, fav = new Float32Array(n), dis = new Float32Array(n), GW = Math.round(72 * W / BW), GH = Math.round(51 * H / BH);
  const ent = (k) => { const e = Ly.ents[k]; const sc = e.idx.map((i) => [taste.pos[i] - taste.pen[i], taste.pen[i]]).sort((a, b) => b[0] - a[0]).slice(0, 3); return [sc.reduce((t, x) => t + x[0], 0) / sc.length, sc.reduce((t, x) => t + x[1], 0) / sc.length]; };
  const vals = []; for (let k = 0; k < n; k++) if (vis[k]) { if (!Ly.ents[k].idx.length) { fav[k] = -9; continue; } const [s0, p] = ent(k); fav[k] = s0; dis[k] = p; vals.push(s0); }
  vals.sort((a, b) => a - b); const cut = vals[Math.floor(vals.length * 0.85)] ?? 0, topv = vals[vals.length - 1] ?? 1;
  const G = grid(GW, GH, (k) => (taste.positive ? Math.max(0, Math.min(1, (fav[k] - cut) / Math.max(1e-6, topv - cut))) : 0)), R = grid(GW, GH, (k) => Math.min(1, Math.max(0, dis[k] - 0.02) / 0.1)), C = grid(GW, GH, () => 1);
  const passes = 2 + Math.max(0, 5 - Math.floor(taste.signals / 3)); blur(G, GW, GH, passes); blur(R, GW, GH, passes); blur(C, GW, GH, passes);
  for (const [A, rgb] of [[G, [47, 179, 107]], [R, [217, 83, 79]]]) {
    let mx = 0; for (let k = 0; k < A.length; k++) { A[k] = C[k] > 0.02 ? A[k] / C[k] : 0; mx = Math.max(mx, A[k]); } if (mx <= 0) continue;
    for (let k = 0; k < A.length; k++) A[k] /= Math.max(mx, 0.25);
    paint(g, A, GW, GH, rgb, (a) => Math.min(0.75, Math.pow(a, 0.8) * 0.75));
  }
}
function inLens() {
  const Ly = lay(), r = st.size * BW, lx = sx(st.lens.x), ly = sy(st.lens.y), out = [];
  Ly.ents.forEach((e, k) => { if (!vis[k]) return; const dx = sx(e.x) - lx, dy = sy(e.y) - ly; if (dx * dx + dy * dy <= r * r) out.push(k); });
  return out;
}
// what the lens is on: the neighbourhood most of its points belong to, with its words, fields and leanings
function renderArea(pool) {
  const Ly = lay(); if (Ly.past && pool.length) return renderPastArea(pool, Ly); if (!pool.length) { $('atlas-area').innerHTML = `<span class="atlas-note">${L('Move the lens onto the map.', 'Die Lupe auf die Karte ziehen.')}</span>`; return; }
  const c = new Map(); pool.forEach((k) => c.set(Ly.ents[k].c2, (c.get(Ly.ents[k].c2) || 0) + 1)); const h = Ly.hoods[[...c].sort((a, b) => b[1] - a[1])[0][0]];
  const hk = [...c].sort((a, b) => b[1] - a[1])[0][0], total = Ly.ents.filter((e, k) => e.c2 === hk && (perScope || vis[k])).length;
  const reg = Ly.regions[Ly.ents[pool[0]].c1], lean = leanText(h.lean);
  $('atlas-area').innerHTML = `<span class="atlas-note">${L('This area', 'Dieser Bereich')}${st.mode === 'roles' && reg && reg !== h ? ' · ' + esc(nameOf(reg)) : ''}</span><b>${esc(nameOf(h))}</b><span class="atlas-note">${esc(h.words.join(' · '))}</span>`
    + `<span>${h.fields.length ? esc(h.fields.map(fieldLabel).join(', ')) + ' · ' : ''}${total.toLocaleString()} ${st.mode === 'roles' ? L('roles in the neighbourhood', 'Stellen in der Nachbarschaft') : L('companies in the group', 'Firmen in der Gruppe')}, ${pool.length} ${L('in the lens', 'in der Lupe')}</span>`
    + (lean.length ? `<span class="lean">${L('Leans to: ', 'Neigt zu: ')}${esc(lean.join(' · '))}</span>` : '') + (TL ? tlAreaHtml(pool) : '');
}
let rngState = 7; const rnd = () => (rngState = (rngState * 16807) % 2147483647) / 2147483647;
// the view on the visible roles (one map): the 2nd to 98th percentile of their positions (outliers left out), 6 % padding on each
// side, zoomed so that box fills the map box; the lens moves to its centre. Fewer than 10 visible roles: the whole map
function fitTo() {
  const Ly = lay(), xs = [], ys = [];
  Ly.ents.forEach((e, k) => { if (Ly.past || (st.mode === 'roles' ? visibleRoles(e).length : (vis && vis[k]))) { xs.push(e.x); ys.push(e.y); } });
  if (xs.length < 5) { st.z = { s: 1, cx: 0.5, cy: 0.5 }; st.lens = { x: 0.5, y: 0.5 }; return; }
  const pct = (a, p) => { const q = [...a].sort((u, v) => u - v); return q[Math.min(q.length - 1, Math.floor(p * q.length))]; };
  const x0 = pct(xs, 0.02), x1 = pct(xs, 0.98), y0 = pct(ys, 0.02), y1 = pct(ys, 0.98);
  const bw = (x1 - x0) * 1.12, bh = (y1 - y0) * 1.12, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  // the lens goes to the visible point nearest the middle: on a map of separate islands the middle itself can be empty
  let best = 0, bd = Infinity; xs.forEach((x, i) => { const d = (x - cx) ** 2 + (ys[i] - cy) ** 2; if (d < bd) { bd = d; best = i; } });
  st.z = { s: Math.max(1, Math.min(24, 1 / bw, 1 / bh)), cx, cy }; st.lens = { x: xs[best], y: ys[best] };
}
// the view after a filter or a switch: fitted to the visible roles or companies (one map), else the whole map (as per_scope always did)
const fitOrWhole = () => { if (!perScope) fitTo(); else st.z = { s: 1, cx: 0.5, cy: 0.5 }; };
function resample() {
  draw();   // refreshes which entities are visible under the current filters
  const Ly = lay(), pool = inLens(), per = new Map(); pool.forEach((k) => { const c = st.mode === 'roles' ? (Ly.past ? '' : rows[Ly.ents[k].idx[0]][2]) : Ly.ents[k].name; per.set(c, (per.get(c) || 0) + 1); });
  // weighted draw without replacement: roles by 1/sqrt(roles of that employer in the lens), at most 2 per employer; companies all alike
  const out = [], taken = new Map(), w = pool.map((k) => (st.mode === 'roles' && !Ly.past ? 1 / Math.sqrt(per.get(rows[Ly.ents[k].idx[0]][2])) : 1));
  for (let n = 0, guard = 0; n < 8 && pool.length && guard < 200; n++, guard++) {
    let tot = 0; w.forEach((x) => { tot += x; }); if (tot <= 0) break; let t = rnd() * tot, q = 0; for (; q < w.length - 1; q++) { t -= w[q]; if (t <= 0) break; }
    const c = st.mode === 'roles' && !Ly.past ? rows[Ly.ents[pool[q]].idx[0]][2] : ''; if (st.mode === 'roles' && !Ly.past && (taken.get(c) || 0) >= 2) { w[q] = 0; n--; continue; } taken.set(c, (taken.get(c) || 0) + 1); out.push(pool[q]); w[q] = 0;
  }
  st.sample = out; renderArea(pool); renderList(); draw();
}
// ---- the cards: a role or a company, closed (a few lines) or open (everything we hold)
const levelName = (k) => { const b = cfg.levels.find((x) => x.code === ix.levels[k]); return b ? pick(b.label.en, b.label.de) : ''; };
const shards = new Map();
const shard = (id) => { const k = id.slice(0, 2); if (!shards.has(k)) shards.set(k, fetch(dataUrl('jobs-desc-' + k + '.json')).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))); return shards.get(k); };
const voteHtml = (id) => `<div class="atlas-vote">${[[-1, '▼'], [0, '●'], [1, '▲']].map(([x, gl]) => `<button type="button" data-v="${x}" class="${ratings[id] && ratings[id].vote === x ? 'on' : ''}" aria-pressed="${ratings[id] && ratings[id].vote === x}">${gl}</button>`).join('')}</div>`;
const snip = (t, n) => { t = (t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n).replace(/\s\S*$/, '') + '…' : t; };
// the badge of a new role in the lens list: "new today", "this week", "this month" (none when older or unknown)
const newBadge = (i) => { const a = AGE[i], t = a < 1 ? L('new today', 'neu heute') : a < 7 ? L('this week', 'diese Woche') : a < 30 ? L('this month', 'diesen Monat') : ''; return t ? ` <span class="atlas-new">${t}</span>` : ''; };
function cardHtml(k) {
  const e = lay().ents[k], open = st.open.has(e.id);
  if (e.past) return tlCardHtml(k, e);
  if (st.mode === 'roles') { const i = e.idx[0], r = rows[i], reg = ix.regions[ix.attrs[i][3]] || '';
    return `<li class="atlas-item${open ? ' open' : ''}" data-k="${k}" data-id="${e.id}"><button type="button" class="hd" aria-expanded="${open}">${esc(r[1])}${newBadge(i)}</button><div class="m">${esc(r[2])}${reg ? ' · ' + esc(reg) : ''}${ix.attrs[i][1] ? ' · ' + esc(levelName(ix.attrs[i][1])) : ''}</div><div class="snip"></div><div class="more"></div>${voteHtml(e.id)}</li>`; }
  const co = coRows[e.slug] || [e.about || ''];
  const desc = (isDe() && co[1]) ? co[1] : (co[0] || co[2] || e.about || '');
  const archName = (isDe() && co[4]) ? co[4] : (co[3] || '');
  const archCol = co[5] || '#64748b';
  const loc = co[6] || '';
  const carUrl = co[7] || '';
  const webUrl = co[8] || '';
  const tags = co[9] || [];
  const tracked = !!co[11];
  const vr = visibleRoles(e);
  const flds = ix.fields.map((f, q) => [f, e.f[q]]).filter((x) => x[1] >= 0.25).sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => fieldLabel(x[0]));
  const facts = [loc && `📍 ${loc}`, archName && `🏛 ${archName}`, tracked && `✓ ${L('Tracked ATS', 'Überwachtes Portal')}`, ...tags.slice(0, 3).map((t) => `#${t}`)].filter(Boolean);

  return `<li class="atlas-item${open ? ' open' : ''}" data-k="${k}" data-id="${e.id}">`
    + `<button type="button" class="hd" aria-expanded="${open}"><img class="co-logo" src="assets/company/${esc(e.slug)}.png" alt="" loading="lazy" onerror="this.remove()">${esc(e.name)}${archName ? ` <span class="atlas-tag-tier" style="background:${archCol}">${esc(archName)}</span>` : ''}${tracked ? ` <span class="atlas-badge-tracked">● ${L('Tracked', 'Überwacht')}</span>` : ''}</button>`
    + `<div class="m">${loc ? esc(loc) + ' · ' : ''}${vr.length ? `<span class="co-has-roles">${vr.length} ${L('open roles', 'offene Stellen')}</span>` : `<span class="co-no-roles">${L('No current vacancies', 'Keine aktuellen Vakanzen')}</span>`}${flds.length ? ' · ' + esc(flds.join(', ')) : (e.field ? ' · ' + esc(e.field) : '')}</div>`
    + `<div class="snip">${esc(snip(desc, 170))}</div>`
    + `<div class="more">`
    + (facts.length ? `<div class="facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div>` : '')
    + (desc ? `<div class="txt" tabindex="0">${esc(desc)}</div>` : '')
    + `<div class="links">${companyLink(e.slug) ? `<a class="link" href="${companyLink(e.slug)}">${L('Company page →', 'Firmenseite →')}</a>` : ''}${carUrl ? `<a class="link" href="${esc(carUrl)}" target="_blank" rel="noopener">${L('Careers page ↗', 'Karriereseite ↗')}</a>` : (webUrl ? `<a class="link" href="${esc(webUrl)}" target="_blank" rel="noopener">${L('Website ↗', 'Webseite ↗')}</a>` : '')}</div>`
    + (vr.length ? `<div class="atlas-note" style="margin-top:6px;"><strong>${L('Open roles here:', 'Offene Stellen hier:')}</strong><ul class="co-roles">${vr.slice(0, 12).map((i) => `<li><a class="link" href="${roleLink(ix.ids[i])}">${esc(rows[i][1])}</a>${ix.attrs[i][1] ? ' · ' + esc(levelName(ix.attrs[i][1])) : ''}</li>`).join('')}${vr.length > 12 ? `<li class="atlas-note">+ ${vr.length - 12} ${L('more roles', 'weitere Stellen')}</li>` : ''}</ul></div>` : `<p class="atlas-note" style="margin-top:6px;">${L('No open roles on the board right now.', 'Derzeit keine offenen Stellen auf dem Board.')}</p>`)
    + `</div>${voteHtml(e.id)}</li>`;
}
async function fillRole(li) {
  const e = lay().ents[+li.dataset.k]; if (e.past) return tlFill(li, e); if (st.mode !== 'roles') return; const id = e.id, d = (await shard(id))[id], box = li.querySelector('.more'), i = e.idx[0], row = rows[i];
  li.querySelector('.snip').textContent = d && d.x ? snip(d.x.replace(/^Back to all jobs\s*/i, ''), 200) : '';
  if (!li.classList.contains('open') || box.dataset.ready) return; box.dataset.ready = '1';
  const text = d && d.x ? d.x.replace(/\n{3,}/g, '\n\n').trim() : '';
  box.innerHTML = `<div class="facts">${[d && d.l, d && d.r, d && (d.tg || []).join(' · '), d && d.d && 'listed ' + d.d].filter(Boolean).map((f) => `<span>${esc(f)}</span>`).join('')}</div>`
    + (text ? `<div class="txt" tabindex="0">${esc(text)}</div>` : `<p class="atlas-note">${L('No description was saved for this role.', 'Für diese Stelle wurde keine Beschreibung gespeichert.')}</p>`)
    + (() => { const dups = ix.dupsOf(i), nb = ix.nbOf(i).slice(0, 5);
        return (dups.length ? `<p class="atlas-note">${L(`Also listed ${dups.length} more time${dups.length > 1 ? 's' : ''}`, `Noch ${dups.length}-mal ausgeschrieben`)}: ${dups.slice(0, 4).map((j) => esc(rows[j][2] + (ix.regions[ix.attrs[j][3]] ? ' · ' + ix.regions[ix.attrs[j][3]] : ''))).join(', ')}</p>` : '')
          + (nb.length ? `<div class="atlas-note">${L('Similar roles:', 'Ähnliche Stellen:')}<ul class="co-roles">${nb.map((x) => `<li><a class="link" href="${roleLink(ix.ids[x.i])}">${esc(rows[x.i][1])}</a> · ${esc(rows[x.i][2])}</li>`).join('')}</ul></div>` : ''); })()
    + `<div class="links"><a class="link" href="${roleLink(id)}">${cfg.role_url ? L('Full role page →', 'Ganze Stellenseite →') : L('Details in the job list →', 'Details in der Stellenliste →')}</a>${d && companyLink(d.cs) ? `<a class="link" href="${companyLink(d.cs)}">${L('About ' + row[2] + ' →', 'Über ' + row[2] + ' →')}</a>` : ''}<a class="link" href="${esc(row[3])}" target="_blank" rel="noopener">${L('Apply ↗', 'Bewerben ↗')}</a></div>`;
}
function renderList() {
  $('atlas-list').innerHTML = st.sample.map(cardHtml).join('') || `<li class="atlas-note">${L('Nothing in the lens with these filters. Move it or make it larger.', 'Nichts in der Lupe mit diesen Filtern. Verschieben oder vergrößern Sie sie.')}</li>`;
  $('atlas-list').querySelectorAll('.atlas-item').forEach(fillRole);
}
// ---- the timeline: the scrubber, the map at a past time, the hot and cold spots, the cards of past roles
const nameShards = new Map();
// a record's title and company, from its names shard (loaded when first needed; the card fills in when it arrives)
function tlNamesOf(r) { const s = Math.floor(r / TL.shard), k = String(s).padStart(3, '0'); if (!nameShards.has(k)) nameShards.set(k, fetch(dataUrl('match/role-timeline-names-' + k + '.json')).then((x) => (x.ok ? x.json() : [])).catch(() => [])); return nameShards.get(k).then((a) => a[r - s * TL.shard] || ['', '']); }
const isoWeek = (d) => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 4)); return 1 + Math.round(((t - y) / 864e5 - 3 + ((y.getUTCDay() + 6) % 7)) / 7); };
// a time (minutes after t0) as a date, with the time of day when asked; UTC, like the data
const tlDate = (t, time = false) => new Intl.DateTimeFormat(isDe() ? 'de-DE' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}), timeZone: 'UTC' }).format(new Date(TL.t0 + t * 60000));
// the scrubber's label: "26 Oct 2026, 14:00" (rounds), "26 Oct 2026" (days), "Week 44, 2026", "October 2026"
const tlLabel = (t) => { const d = new Date(TL.t0 + t * 60000), k = TL.kind; return k === 'week' ? `${pick('Week', 'KW')} ${isoWeek(d)}, ${d.getUTCFullYear()}` : k === 'month' ? new Intl.DateTimeFormat(isDe() ? 'de-DE' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d) : tlDate(t, k === 'round'); };
const tlDates = (e) => `${pick('first seen', 'erstmals gesehen')} ${tlDate(e.fa)} · ${e.la >= TL.end ? pick('still listed', 'noch ausgeschrieben') : `${pick('last seen', 'zuletzt gesehen')} ${tlDate(e.la)}`}`;
// the atlas's filters on a record: its scope bit (the Where filter) and its field bits (the chips; any of them)
const tlFilt = () => { let m = 0; for (const f of st.fields) { const q = TL.fields.indexOf(f); if (q >= 0) m |= 1 << q; } const b = cfg.scopes[st.scope] ? TL.scopes.indexOf(cfg.scopes[st.scope].id) : -1; return { bit: b, on: st.fields.size > 0, mask: m }; };
const tlOk = (r, f) => (f.bit < 0 || (TLS[r] >> f.bit & 1) === 1) && (!f.on || (TLG[r] & f.mask) !== 0);
// the new and gone counts look back 4 weeks (or half the span when it is shorter)
const tlWin = () => Math.min(28 * DAY, (TL.end - TL.start) / 2);
// the map at a time: the records on the board then, and the embers (last seen up to 30 days before). A layer like the roles layer,
// read from the timeline: its entities have no role index, carry their first and last seen times, their age and weight
function tlLayer(tm) { const key = tm + '|' + st.scope + '|' + [...st.fields].join(), f = tlFilt(); if (tlLast && tlLast.key === key) return tlLast.ly;
  const ents = []; for (let r = 0; r < TLN; r++) { const fa = TLF[r], la = TLL[r]; if (fa > tm || TLX[r] === 0xFFFF || la < tm - EMBER || !tlOk(r, f)) continue; const live = la >= tm, a = (tm - fa) / DAY;
    ents.push({ id: 'tl:' + r, rec: r, past: true, idx: [], x: TLX[r] / 65535, y: TLY[r] / 65535, c1: TLC[r], c2: 0, fa, la, a, w: live ? wAge(a) : 0, ember: !live, ea: live ? 1 : 0.5 * (1 - (tm - la) / EMBER) }); }
  const ly = { kind: 'roles', past: true, ents, n: ents.length, regions: LAY.roles.regions, hoods: [], links: [], placed: 0 }; tlLast = { key, ly }; return ly; }
// the scrubber: a step is a time; setScrub moves the map there (the last step is now)
function setScrub(i) { if (!TL) return; scrub.idx = Math.max(0, Math.min(TL.steps.length - 1, i)); scrub.tm = TL.steps[scrub.idx]; st.sample = []; rngState = 7; resample(); }
function tlShow() { const sl = $('atlas-time'), n = TL.steps.length - 1; if (sl.max !== String(n)) sl.max = n; if (+sl.value !== scrub.idx) sl.value = scrub.idx; $('atlas-tlabel').textContent = tlLabel(scrub.tm) + (scrub.idx === n ? ' · ' + pick('Now', 'Jetzt') : ''); $('atlas-scrub').hidden = st.mode !== 'roles'; }
function tlStop() { if (tlTimer) { clearInterval(tlTimer); tlTimer = null; } const b = $('atlas-play'); b.textContent = '▶'; b.setAttribute('aria-label', pick('Play', 'Abspielen')); }
// play: one step every 800 ms until the end (from the start when it is at the end already)
function tlPlay() { if (tlTimer) return tlStop(); const n = TL.steps.length - 1; if (scrub.idx >= n) setScrub(0); const b = $('atlas-play'); b.textContent = '❚❚'; b.setAttribute('aria-label', pick('Pause', 'Pause'));
  tlTimer = setInterval(() => { setScrub(scrub.idx + 1); if (scrub.idx >= n) tlStop(); }, 800); }
// the region most of the pool belongs to (-1: none)
function domC1(pool) { const Ly = lay(), m = new Map(); pool.forEach((k) => { const c = Ly.ents[k].c1; m.set(c, (m.get(c) || 0) + 1); }); return m.size ? [...m].sort((a, b) => b[1] - a[1])[0][0] : -1; }
// one region at the scrubbed time: new and gone in the window, and 12 weekly bins (newest first) of new minus gone
function tlChange(c) { const f = tlFilt(), tm = scrub.tm, win = tlWin(), wk = 7 * DAY, bins = Array.from({ length: 12 }, () => ({ n: 0, g: 0 })); let nw = 0, gw = 0;
  for (let r = 0; r < TLN; r++) { const fa = TLF[r], la = TLL[r]; if (TLC[r] !== c || fa > tm || !tlOk(r, f)) continue;
    const kn = Math.floor((tm - fa) / wk); if (kn < 12) bins[kn].n++; if (tm - fa < win) nw++;
    if (la <= tm && la < TL.end) { const kg = Math.floor((tm - la) / wk); if (kg < 12) bins[kg].g++; if (tm - la < win) gw++; } }
  return { nw, gw, bins: bins.slice(0, Math.max(1, Math.min(12, Math.floor((TL.end - TL.start) / wk)))) }; }
// the area panel's line for the lens region: the change over the last 4 weeks, and a small chart of the weekly change (oldest left)
function tlAreaHtml(pool) { const c = domC1(pool); if (c < 0) return ''; const s = tlChange(c), days = Math.round(tlWin() / DAY), nb = s.bins.length, mx = Math.max(1, ...s.bins.map((b) => Math.abs(b.n - b.g))), sl = 120 / nb, bw = sl * 0.6;
  const bars = s.bins.slice().reverse().map((b, i) => { const d = b.n - b.g, h = Math.abs(d) / mx * 11; return d ? `<rect x="${(i * sl + (sl - bw) / 2).toFixed(1)}" y="${(d > 0 ? 12 - h : 12).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" style="fill:var(${d > 0 ? '--accent-text' : '--muted'})"/>` : ''; }).join('');
  return `<div class="chg"><span>${L(`${days === 28 ? 'Last 4 weeks' : `Last ${days} days`}: +${s.nw} first seen, −${s.gw} no longer seen`, `${days === 28 ? 'Letzte 4 Wochen' : `Letzte ${days} Tage`}: +${s.nw} erstmals gesehen, −${s.gw} nicht mehr gesehen`)}</span><svg class="atlas-chart" viewBox="0 0 120 24" role="img" aria-label="${esc(pick('Weekly change', 'Wöchentliche Veränderung'))}"><line x1="0" y1="12" x2="120" y2="12" style="stroke:var(--line)" stroke-width="1"/>${bars}</svg></div>`; }
// the lens on the past map: the region of most of its roles, and how many were on the board then
function renderPastArea(pool, Ly) { const c = domC1(pool), rg = c < Ly.regions.length ? nameOf(Ly.regions[c]) : pick('Other', 'Andere');
  $('atlas-area').innerHTML = `<span class="atlas-note">${L('This area, then', 'Dieser Bereich, damals')}</span><b>${esc(rg)}</b><span>${pool.length} ${L('in the lens, on the board then', 'in der Lupe, damals ausgeschrieben')}</span>` + tlAreaHtml(pool); }
// a past role in the lens list and on its card: the title and company come from the names shard, read-only (no marks)
function tlCardHtml(k, e) { return `<li class="atlas-item" data-k="${k}" data-id="${e.id}"><div class="t tl-t">…</div><div class="m tl-c"></div><div class="m">${esc(tlDates(e))}</div></li>`; }
function tlFill(host, e) { tlNamesOf(e.rec).then(([t, c]) => { if (host.dataset.id !== e.id) return; const a = host.querySelector('.tl-t'), b = host.querySelector('.tl-c'); if (a) a.textContent = t || pick('(no name saved)', '(kein Name gespeichert)'); if (b) b.textContent = c || ''; }); }
// hot and cold spots: per cell of the colour field's grid, the roles first seen in the window minus those no longer seen, over the roles on
// the board (+10 damps small areas), blurred like the colour field. Warm where the board grows, cool where it shrinks
// a CSS colour as [r, g, b] (the canvas normalises it to #rrggbb or rgba(...))
const rgbOf = (col) => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = col; const v = c.fillStyle; return v[0] === '#' ? [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) : (v.match(/\d+/g) || [0, 0, 0]).slice(0, 3).map(Number); };
function heatField(ctx, ff, T, bg) { const GW = Math.round(96 * ff * W / BW), GH = Math.round(68 * ff * H / BH), n = GW * GH, f = tlFilt(), tm = scrub.tm, win = tlWin();
  const N = new Float32Array(n), G = new Float32Array(n), S = new Float32Array(n);
  for (let r = 0; r < TLN; r++) { const fa = TLF[r], la = TLL[r]; if (fa > tm || TLX[r] === 0xFFFF) continue; const inS = la >= tm, inN = fa > tm - win, inG = la > tm - win && la <= tm && la < TL.end;
    if (!(inS || inN || inG) || !tlOk(r, f)) continue;
    const X0 = sx(TLX[r] / 65535) / W, Y0 = sy(TLY[r] / 65535) / H; if (X0 < 0 || X0 >= 1 || Y0 < 0 || Y0 >= 1) continue;
    const q = Math.floor(Y0 * GH) * GW + Math.floor(X0 * GW); if (inS) S[q]++; if (inN) N[q]++; if (inG) G[q]++; }
  const passes = Math.max(1, Math.round((4 + Math.min(4, Math.round(Math.log2(st.z.s + 1)))) * ff * ff)); for (const X of [N, G, S]) blur(X, GW, GH, passes);
  // the blurred counts are per cell; the blur's area (about (2 passes + 1)^2 cells) turns them into the roles around a cell, so k = 10
  // damps the areas with few roles
  const Ak = (2 * passes + 1) ** 2, sc = new Float32Array(n); for (let q = 0; q < n; q++) sc[q] = (N[q] - G[q]) / (S[q] + 10 / Ak); lastHeat = { GW, GH, sc };
  // growing cells: the colour field's own colour drawn once more on top (added on black, laid over on paper), so the area glows in
  // its hue; shrinking cells: the background laid over, so the area dims. Changes below 0.2 stay as they are.
  const dark = !!T.glow, hot = document.createElement('canvas'), cold = document.createElement('canvas'); hot.width = cold.width = GW; hot.height = cold.height = GH;
  const hg = hot.getContext('2d'), cg = cold.getContext('2d'), hi = hg.createImageData(GW, GH), ci = cg.createImageData(GW, GH), b = rgbOf(bg);
  const base = lastField && lastField.GW === GW && lastField.GH === GH ? lastField.small.getContext('2d').getImageData(0, 0, GW, GH).data : null;
  for (let q = 0; q < n; q++) { const m = Math.abs(sc[q]); if (m < 0.2) continue; const k = Math.min(1, (m - 0.2) / 0.5);
    if (sc[q] > 0) { if (!base) continue; for (let c = 0; c < 3; c++) hi.data[q * 4 + c] = base[q * 4 + c]; hi.data[q * 4 + 3] = Math.round(base[q * 4 + 3] * k * (dark ? 1 : 0.8)); }
    else { for (let c = 0; c < 3; c++) ci.data[q * 4 + c] = +b[c]; ci.data[q * 4 + 3] = Math.round(255 * 0.7 * k); } }
  hg.putImageData(hi, 0, 0); cg.putImageData(ci, 0, 0); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.globalAlpha = 1;
  ctx.drawImage(cold, 0, 0, W, H); ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over'; ctx.drawImage(hot, 0, 0, W, H); ctx.globalCompositeOperation = 'source-over'; }
// the mean hot-and-cold score (last drawn) over the roles of region c on the board at the scrubbed time
function heatMeanOf(c) { if (!lastHeat || !TL) return null; const f = tlFilt(), tm = scrub.tm, { GW, GH, sc } = lastHeat; let s = 0, n = 0;
  for (let r = 0; r < TLN; r++) { if (TLC[r] !== c || TLF[r] > tm || TLL[r] < tm || TLX[r] === 0xFFFF || !tlOk(r, f)) continue;
    const X0 = sx(TLX[r] / 65535) / W, Y0 = sy(TLY[r] / 65535) / H; if (X0 < 0 || X0 >= 1 || Y0 < 0 || Y0 >= 1) continue; s += sc[Math.floor(Y0 * GH) * GW + Math.floor(X0 * GW)]; n++; }
  return n ? s / n : null; }
// ---- interaction: drag the lens, drag elsewhere to move the map, tap to put the lens there; zoom with buttons or wheel
let drag = null; const touches = new Map(); let pinch = null;
const ptr = (e) => { const b = cv.getBoundingClientRect(); return [(e.clientX - b.left) / b.width * W, (e.clientY - b.top) / b.height * H]; };
// the grid of the drawn points (rebuilt in draw): cells of 24 px; hitAt gives the nearest point within 10 px of a screen position, or -1
function buildHit(Ly) { const cs = 24, nx = Math.ceil(W / cs) + 1, ny = Math.ceil(H / cs) + 1, cells = Array.from({ length: nx * ny }, () => []), X = new Float32Array(Ly.n), Y = new Float32Array(Ly.n);
  Ly.ents.forEach((e, k) => { if (!vis[k] || (e.hidden && !st.all)) return; const x = sx(e.x), y = sy(e.y); if (x < -5 || y < -5 || x > W + 5 || y > H + 5) return; X[k] = x; Y[k] = y;
    cells[Math.max(0, Math.min(ny - 1, Math.floor(y / cs))) * nx + Math.max(0, Math.min(nx - 1, Math.floor(x / cs)))].push(k); });
  hitG = { cs, nx, ny, cells, X, Y }; }
function hitAt(px, py) { const h = hitG; if (!h) return -1; let best = -1, bd = 100; const cx = Math.floor(px / h.cs), cy = Math.floor(py / h.cs);
  for (let y = Math.max(0, cy - 1); y <= Math.min(h.ny - 1, cy + 1); y++) for (let x = Math.max(0, cx - 1); x <= Math.min(h.nx - 1, cx + 1); x++) for (const k of h.cells[y * h.nx + x]) { const d = (h.X[k] - px) ** 2 + (h.Y[k] - py) ** 2; if (d < bd) { bd = d; best = k; } }
  return best; }
// hover: a point within 10 px shows its title (the canvas tooltip) and a hand; inside the lens a move cursor, elsewhere a grab
function hover(e) { const [px, py] = ptr(e), k = hitAt(px, py), t = k >= 0 ? (st.mode === 'roles' ? (lay().ents[k].past ? '' : cleanTitle(rows[lay().ents[k].idx[0]][1])) : lay().ents[k].name) : '';
  cv.style.cursor = k >= 0 ? 'pointer' : Math.hypot(px - sx(st.lens.x), py - sy(st.lens.y)) <= st.size * BW + 8 ? 'move' : 'grab'; if (cv.title !== t) cv.title = t; }
// the card of the selected point (on the stage, so it also works in full screen): a role with its title as a link, company, region,
// level, age and the marks; or a company with its name, about text and open roles
const pop = document.createElement('div'); pop.className = 'atlas-pop'; pop.hidden = true; stage.appendChild(pop);
const ageText = (i) => { const a = AGE[i]; return !isFinite(a) ? '' : a < 1 ? pick('new today', 'neu heute') : a < 7 ? pick('new this week', 'neu diese Woche') : a < 30 ? pick('new this month', 'neu diesen Monat') : pick(`${Math.round(a)} days ago`, `vor ${Math.round(a)} Tagen`); };
function popHtml(k) { const e = lay().ents[k], close = `<button type="button" class="atlas-pop-x" aria-label="${esc(pick('Close', 'Schließen'))}">×</button>`;
  if (e.past) return close + `<div class="t tl-t">…</div><div class="m tl-c"></div><div class="m">${esc(tlDates(e))}</div>`;
  if (st.mode === 'roles') { const i = e.idx[0], r = rows[i], reg = ix.regions[ix.attrs[i][3]] || '', age = ageText(i);
    return close + `<a class="t link" href="${roleLink(e.id)}">${esc(r[1])}</a><div class="m">${esc(r[2])}${reg ? ' · ' + esc(reg) : ''}${ix.attrs[i][1] ? ' · ' + esc(levelName(ix.attrs[i][1])) : ''}</div>${age ? `<div class="m">${esc(age)}</div>` : ''}${voteHtml(e.id)}`; }
  const co = coRows[e.slug] || [e.about || ''];
  const desc = (isDe() && co[1]) ? co[1] : (co[0] || co[2] || e.about || '');
  const archName = (isDe() && co[4]) ? co[4] : (co[3] || '');
  const archCol = co[5] || 'var(--accent-text)';
  const loc = co[6] || '';
  const carUrl = co[7] || '';
  const webUrl = co[8] || '';
  const vr = visibleRoles(e);
  const link = companyLink(e.slug);
  return close
    + (link ? `<a class="t link" href="${link}">${esc(e.name)}</a>` : `<div class="t">${esc(e.name)}</div>`)
    + (archName || loc ? `<div class="m" style="margin-top:2px;">${archName ? `<span style="color:${archCol};font-weight:600;">${esc(archName)}</span>` : ''}${loc ? (archName ? ' · ' : '') + esc(loc) : ''}</div>` : '')
    + `<div class="m">${e.idx.length ? `<span class="co-has-roles">${vr.length} ${L('open roles here', 'offene Stellen hier')}</span>` : `<span class="co-no-roles">${L('No open roles on the board right now', 'Derzeit keine offenen Stellen auf der Börse')}</span>`}</div>`
    + (desc ? `<div class="m" style="margin-top:4px;">${esc(snip(desc, 150))}</div>` : '')
    + `<div class="links" style="margin-top:6px;display:flex;gap:12px;font-size:12.5px;">${link ? `<a class="link" href="${link}">${L('Company page →', 'Firmenseite →')}</a>` : ''}${carUrl ? `<a class="link" href="${esc(carUrl)}" target="_blank" rel="noopener">${L('Careers ↗', 'Karriere ↗')}</a>` : (webUrl ? `<a class="link" href="${esc(webUrl)}" target="_blank" rel="noopener">${L('Website ↗', 'Webseite ↗')}</a>` : '')}</div>`
    + voteHtml(e.id); }
function showPop(k) { const Ly = lay(), e = Ly.ents[k]; pop.innerHTML = popHtml(k); pop.dataset.id = e.id; pop.hidden = false; sel = { k, ly: Ly }; if (e.past) tlFill(pop, e); }
function hidePop() { sel = null; pop.hidden = true; }
// the card beside its point (to the right, or to the left when it does not fit), inside the stage
function placePop(X, Y) { const sr = stage.getBoundingClientRect(), cr = cv.getBoundingClientRect(), f = cr.width / W, ox = cr.left - sr.left - stage.clientLeft, oy = cr.top - sr.top - stage.clientTop;
  const x = ox + X * f, y = oy + Y * f, pw = pop.offsetWidth, ph = pop.offsetHeight, sw = stage.clientWidth, sh = stage.clientHeight;
  let l = x + 14; if (l + pw > sw - 6) l = x - 14 - pw; l = Math.max(6, Math.min(l, sw - pw - 6)); const t = Math.max(6, Math.min(y - ph / 2, sh - ph - 6));
  pop.style.left = l + 'px'; pop.style.top = t + 'px'; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sel) { hidePop(); draw(); } });
cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); stopAnim(); touches.set(e.pointerId, ptr(e));
  if (touches.size === 2) { const [a1, b1] = [...touches.values()]; pinch = { d: Math.hypot(a1[0] - b1[0], a1[1] - b1[1]), s: st.z.s }; drag = null; return; }
  const [px, py] = ptr(e), dx = px - sx(st.lens.x), dy = py - sy(st.lens.y);
  drag = Math.hypot(dx, dy) <= st.size * BW + 8 ? { kind: 'lens', px, py, moved: 0 } : { kind: 'pan', px, py, cx: st.z.cx, cy: st.z.cy, moved: 0 }; });
cv.addEventListener('pointermove', (e) => { if (!touches.has(e.pointerId)) { if (e.pointerType === 'mouse' && !e.buttons) hover(e); return; } touches.set(e.pointerId, ptr(e));
  if (pinch && touches.size === 2) { const [a1, b1] = [...touches.values()], d = Math.hypot(a1[0] - b1[0], a1[1] - b1[1]); zoomTo(pinch.s * d / Math.max(pinch.d, 1), (a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2, false); return; }
  if (!drag) return; const [px, py] = ptr(e); drag.moved = Math.max(drag.moved, Math.hypot(px - drag.px, py - drag.py));
  if (drag.kind === 'lens') { st.lens.x = ux(px); st.lens.y = uy(py); } else { st.z.cx = drag.cx - (px - drag.px) / BW / st.z.s; st.z.cy = drag.cy - (py - drag.py) / BH / st.z.s; }
  draw(); });
const endPtr = (e) => { touches.delete(e.pointerId); if (pinch) { if (touches.size < 2) { pinch = null; resample(); } return; }
  if (!drag) return; const [px, py] = ptr(e), tap = drag.moved < 5, k = tap ? hitAt(px, py) : -1, kind = drag.kind; drag = null;
  if (k >= 0) { showPop(k); draw(); return; }   // a tap on a point opens its card; the lens stays where it is
  if (tap) hidePop();
  const moved = kind === 'lens' || tap; if (kind === 'pan' && tap) { st.lens.x = ux(px); st.lens.y = uy(py); }
  if (moved) PF.bumpExplored(); resample(); if (moved) { computeTaste(); renderPersonas(); draw(); } };
cv.addEventListener('pointerup', endPtr); cv.addEventListener('pointercancel', endPtr);
function zoomTo(s1, px, py, then = true) { const x0 = ux(px), y0 = uy(py); st.z.s = Math.max(1, Math.min(24, s1)); if (st.z.s === 1) { st.z.cx = 0.5; st.z.cy = 0.5; } else { st.z.cx = x0 - (px - W / 2) / (st.z.s * BW); st.z.cy = y0 - (py - H / 2) / (st.z.s * BH); } if (then) resample(); else draw(); }
function zoom(f, px = W / 2, py = H / 2) { zoomTo(st.z.s * f, px, py); }
cv.addEventListener('mousedown', (e) => { if (e.detail > 1) e.preventDefault(); });      // a double click zooms; it should not select page text
cv.addEventListener('dblclick', (e) => { e.preventDefault(); const [px, py] = ptr(e); zoom(2, px, py); });
cv.addEventListener('wheel', (e) => { e.preventDefault(); const [px, py] = ptr(e); zoom(e.deltaY < 0 ? 1.25 : 0.8, px, py); }, { passive: false });
$('atlas-zin').addEventListener('click', () => viewChange(() => zoom(1.5, sx(st.lens.x), sy(st.lens.y))));
$('atlas-zout').addEventListener('click', () => viewChange(() => zoom(1 / 1.5, sx(st.lens.x), sy(st.lens.y))));
$('atlas-zreset').addEventListener('click', () => viewChange(() => { fitOrWhole(); resample(); }));
function updateModeHeader() {
  const eyebrow = document.querySelector('.section.atlas .eyebrow');
  const h2 = document.querySelector('.section.atlas h2');
  const intro = document.querySelector('.section.atlas .intro');
  if (st.mode === 'companies') {
    if (eyebrow) eyebrow.textContent = L('ATLAS · COMPANIES BY DOMAIN & CAPABILITIES', 'ATLAS · FIRMEN NACH FACHGEBIET & KOMPETENZEN');
    if (h2) h2.textContent = L('The company atlas', 'Der Firmen-Atlas');
    if (intro) intro.textContent = L(
      'Every employer in the Bavarian aerospace and deep-tech ecosystem is a point. Companies with similar engineering capabilities, subsystems, and focus areas sit together. Move the lens over an area, inspect company profiles, and explore the ecosystem.',
      'Jeder Arbeitgeber im bayerischen Luft- und Raumfahrt- sowie Deep-Tech-Ökosystem ist ein Punkt. Firmen mit ähnlichen technischen Fähigkeiten, Subsystemen und Schwerpunkten liegen beieinander. Verschieben Sie die Lupe, sehen Sie Firmenprofile und entdecken Sie Akteure im Ökosystem.'
    );
  } else {
    if (eyebrow) eyebrow.textContent = L('ATLAS · ROLES BY MEANING', 'ATLAS · STELLEN NACH BEDEUTUNG');
    if (h2) h2.textContent = L('The role atlas', 'Der Stellen-Atlas');
    if (intro) intro.textContent = L(
      'Every open role is a point. Roles with similar work are linked, and that network is relaxed onto the plane, the way maps of science are drawn: regions are groups of closely linked roles, named by what they have in common. Move the lens, see a sample and mark what you like; it feeds Match me. Everything runs in your browser.',
      'Jede offene Stelle ist ein Punkt. Stellen mit ähnlicher Arbeit sind miteinander verbunden, und dieses Netz wird auf die Fläche entspannt, so wie Karten der Wissenschaften gezeichnet werden: Regionen sind Gruppen eng verbundener Stellen, benannt nach dem, was sie gemeinsam haben. Verschieben Sie die Lupe, sehen Sie eine Stichprobe und markieren Sie, was Ihnen gefällt; das fließt in „Passende Stellen für mich“ ein. Alles läuft in Ihrem Browser.'
    );
  }
}
mount.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'atlas-save-img') { saveImage().catch((err) => { $('atlas-status').textContent = err.message || String(err); }); }
  else if (b.id === 'atlas-fs') toggleFs();
  else if (b.closest('#atlas-mode')) viewChange(() => { st.mode = b.dataset.m; mount.querySelectorAll('#atlas-mode button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); updateModeHeader(); st.open.clear(); st.sample = []; fitOrWhole(); resample(); });
  else if (b.closest('#atlas-fields')) viewChange(() => { const f = b.dataset.f; if (st.fields.has(f)) st.fields.delete(f); else st.fields.add(f); b.setAttribute('aria-pressed', String(st.fields.has(f))); if (!perScope) fitTo(); resample(); });
  else if (b.id === 'atlas-shuffle') resample();
  else if (b.id === 'atlas-play') tlPlay();
  else if (b.classList.contains('hd')) { const li = b.closest('li'), id = li.dataset.id, on = li.classList.toggle('open'); b.setAttribute('aria-expanded', String(on)); if (on) st.open.add(id); else st.open.delete(id); fillRole(li); }
  else if (b.classList.contains('atlas-pop-x')) { hidePop(); draw(); }
  else if (b.closest('.atlas-vote')) {
    const host = b.closest('li, .atlas-pop'), id = host.dataset.id, v = +b.dataset.v; ratings = loadRatings(); const r = ratings[id] || {};
    if (r.vote === v) delete r.vote; else r.vote = v; if (Object.keys(r).length) ratings[id] = r; else delete ratings[id]; saveRatings(ratings); computeTaste(); renderPersonas();
    host.querySelector('.atlas-vote').outerHTML = voteHtml(id);   // the same mark in the lens list, if it is listed there
    $('atlas-list').querySelectorAll('li').forEach((x) => { if (x !== host && x.dataset.id === id) x.querySelector('.atlas-vote').outerHTML = voteHtml(id); }); draw();
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
      const m = await loadModel({ modelUrl: cfg.model_url, cacheName: modelCache(), onProgress: (f) => { stat.textContent = (f < 0.97 ? (isDe() ? 'Lade Modell: ' : 'Loading the model: ') + Math.round(f * 100) + ' %' : (isDe() ? 'Starte …' : 'Starting…')); } });
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
  if (e.target.id === 'atlas-taste' || e.target.id === 'atlas-heat') draw();
});
$('atlas-scope').addEventListener('change', (e) => viewChange(() => { st.scope = +e.target.value; const before = layers.roles; layers.roles = roleMapFor(st.scope);
  if (perScope) { if (layers.roles !== before && st.mode === 'roles') { st.sample = []; st.z = { s: 1, cx: 0.5, cy: 0.5 }; } }
  else fitTo();
  resample(); }));
$('atlas-size').addEventListener('change', (e) => { st.size = +e.target.value; resample(); });
if (TL) { $('atlas-time').addEventListener('input', (e) => { tlStop(); setScrub(+e.target.value); }); ['pointerdown', 'keydown'].forEach((ev) => $('atlas-time').addEventListener(ev, () => tlStop())); }
window.addEventListener('storage', () => { ratings = loadRatings(); prefVals = getJ(K.prefs, {}); cvEmb = getJ(K.cv, null); renderPersonas(); renderPrefs(); renderCv(); computeTaste(); draw(); });
fitOrWhole();
resample();
// for scripts (scripts/export_atlas.mjs): the image export and the view switch
window.jobcrawlAtlas = { renderImage, setView, lastRender: () => lastRender, view: () => ({ W, H, BW, BH, z: { ...st.z } }),
  lens: () => ({ x: st.lens.x, y: st.lens.y, size: st.size }), inLens: () => inLens(), pointAt: (k) => { const e = lay().ents[k]; return e ? [sx(e.x), sy(e.y)] : null; },
  timeline: () => (TL ? { steps: TL.steps.length, kind: TL.kind, idx: scrub.idx, tm: scrub.tm, end: TL.end, records: TLN } : null), scrubTo: (i) => { tlStop(); setScrub(i); }, play: () => tlPlay(), heatMean: (c) => heatMeanOf(c), heatOn: (on) => { $('atlas-heat').checked = !!on; draw(); }, layer: () => { const Ly = lay(); return { n: Ly.ents.length, embers: Ly.ents.filter((e) => e.ember).length }; }, heatCells: () => { if (!lastHeat) return null; let mx = 0, big = 0, pos = 0, neg = 0; for (const v of lastHeat.sc) { const m = Math.abs(v); if (m > mx) mx = m; if (m >= 0.05) { big++; if (v > 0) pos++; else neg++; } } return { cells: lastHeat.sc.length, max: +mx.toFixed(3), warm: pos, cool: neg }; } };
