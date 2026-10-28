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
.atlas-fieldbox{margin-bottom:10px}.atlas-fieldbox summary{cursor:pointer;font-size:13px;color:var(--text)}.atlas-fieldbox summary>span:first-child{font-weight:600}.atlas-fieldbox[open] summary{margin-bottom:8px}
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
.atlas-seg{display:inline-flex}.atlas-seg button{width:auto;padding:0 10px;white-space:nowrap;border-radius:0;margin-left:-1px}.atlas-seg button:first-child{border-radius:6px 0 0 6px;margin-left:0}.atlas-seg button:last-child{border-radius:0 6px 6px 0}.atlas-seg button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:var(--paper)}.atlas-seg button[hidden]{display:none}
.atlas-scrub input[type=range]{flex:1 1 200px;min-width:120px;margin:0;accent-color:var(--accent)}
.atlas-scrub label{display:flex;gap:5px;align-items:center;font-size:12.5px;color:var(--muted);white-space:nowrap}
.tl-label{white-space:nowrap;font-variant-numeric:tabular-nums;min-width:12em}
.atlas-stage:fullscreen .atlas-scrub,.atlas-stage:-webkit-full-screen .atlas-scrub{position:absolute;left:0;right:0;bottom:0;border-top:0;background:color-mix(in srgb,var(--panel) 72%,transparent)}
.atlas-area .chg{display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--muted);flex-wrap:wrap;width:100%}
.atlas-chart{width:120px;height:24px;flex:none}
.co-logo{height:28px;width:auto;max-width:84px;object-fit:contain;vertical-align:middle;margin-right:8px;border-radius:4px}
.atlas-link-t{display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink);padding-bottom:7px;cursor:pointer}
.atlas-banner{position:absolute;left:8px;top:8px;z-index:3;max-width:calc(100% - 60px);box-sizing:border-box;padding:6px 30px 6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font-size:12.5px;line-height:1.4;box-shadow:0 4px 14px rgba(0,0,0,.2);overflow-wrap:anywhere}.atlas-banner[hidden]{display:none}
.atlas-banner-x{all:unset;cursor:pointer;position:absolute;right:6px;top:4px;width:20px;height:20px;text-align:center;line-height:20px;font-size:15px;color:var(--muted)}.atlas-banner-x:focus-visible{outline:2px solid var(--accent)}
.atlas-pop-go{all:unset;cursor:pointer;align-self:flex-start;margin-top:4px;font-size:12.5px;padding:4px 10px;border:1px solid var(--accent-text);border-radius:12px;color:var(--accent-text)}.atlas-pop-go:focus-visible{outline:2px solid var(--accent)}
`;
document.head.appendChild(style);
mount.innerHTML = `<div class="atlas-bar">
<div class="atlas-views" id="atlas-mode" role="group"><button type="button" data-m="roles" aria-pressed="true">${L('Roles', 'Stellen')}</button><button type="button" data-m="companies" aria-pressed="false">${L('Companies', 'Firmen')}</button>${cfg.geomap ? `<button type="button" data-m="geo" aria-pressed="false">${L('Geography', 'Geografie')}</button>` : ''}</div>
<label>${L('Where', 'Wo')}<select id="atlas-scope">${scopeOpts}</select></label>
<label>${L('Lens size', 'Lupengröße')}<select id="atlas-size"><option value="0.05">${L('small', 'klein')}</option><option value="0.09">${L('medium', 'mittel')}</option><option value="0.16">${L('large', 'groß')}</option><option value="0" selected>${L('off', 'aus')}</option></select></label>
<label class="atlas-link-t"><input type="checkbox" id="atlas-linked" checked> ${L('Linked', 'Verknüpft')}</label>
</div>
<details class="atlas-fieldbox" id="atlas-fieldbox"><summary id="atlas-fields-sum"></summary><div class="atlas-fields" id="atlas-fields" role="group"></div></details>
<details class="atlas-shape" id="atlas-shape"><summary><strong>${L('Shape the map to you', 'Die Karte auf Sie zuschneiden')}</strong> <span class="atlas-note">${L('optional: a few statements, your CV, and the roles and companies you mark below', 'optional: ein paar Aussagen, Ihr CV und die Stellen und Firmen, die Sie unten markieren')}</span></summary>
<div class="shape-body"><div class="personas" id="atlas-personas"></div><div class="prefs" id="atlas-prefs"></div>
<div class="shape-cv" id="atlas-cvbox"></div>
<div class="shape-save"><button type="button" class="sm" id="atlas-forget">${L('Forget everything on this device', 'Alles auf diesem Gerät vergessen')}</button> <button type="button" class="sm" id="atlas-save">${L('Save my profile as a file', 'Mein Profil als Datei speichern')}</button> <label class="atlas-note"><input type="checkbox" id="atlas-save-cv"> ${L('include my CV (as numbers)', 'mit CV (als Zahlen)')}</label> <label class="atlas-note">${L('Load a saved profile: ', 'Gespeichertes Profil laden: ')}<input type="file" id="atlas-load" accept=".json,application/json"></label></div>
<label class="shape-toggle"><input type="checkbox" id="atlas-taste" checked> ${L('Show how well each area fits me (bright: close to my profile, faint: far from it)', 'Zeigen, wie gut jeder Bereich zu mir passt (hell: nah an meinem Profil, blass: weit weg)')}</label>
<label class="shape-toggle"><input type="checkbox" id="atlas-all"> ${L('Show every role (otherwise at most three per employer and neighbourhood, so big employers do not crowd the map)', 'Jede Stelle zeigen (sonst höchstens drei je Arbeitgeber und Nachbarschaft, damit große Arbeitgeber die Karte nicht füllen)')}</label></div></details>
<div class="atlas-grid"><div>
<div class="atlas-stage"><canvas id="atlas-cv" width="900" height="640"></canvas><div class="atlas-zoom"><button type="button" id="atlas-zin" aria-label="zoom in">+</button><button type="button" id="atlas-zout" aria-label="zoom out">−</button><button type="button" id="atlas-zreset" aria-label="whole map">⟲</button><button type="button" id="atlas-fs" aria-label="${esc(pick('Full screen', 'Vollbild'))}" title="${esc(pick('Full screen', 'Vollbild'))}">⛶</button><button type="button" id="atlas-save-img" aria-label="${esc(pick('Save as image', 'Als Bild speichern'))}" title="${esc(pick('Save as image', 'Als Bild speichern'))}">⤓</button></div><div class="atlas-scrub" id="atlas-scrub" hidden><button type="button" id="atlas-play" aria-label="${esc(pick('Play', 'Abspielen'))}" title="${esc(pick('Play through time', 'Durch die Zeit abspielen'))}">▶</button><input type="range" id="atlas-time" min="0" max="0" value="0" aria-label="${esc(pick('Time', 'Zeitpunkt'))}"><span class="tl-label" id="atlas-tlabel"></span><label><input type="checkbox" id="atlas-heat"> ${L('Hot and cold spots', 'Wo es wächst und schrumpft')}</label></div>${cfg.geomap ? `<div class="atlas-scrub" id="atlas-geo" hidden><span>${L('Distortion', 'Verzerrung')}</span><span class="atlas-seg" id="atlas-morph" role="group" aria-label="${esc(pick('Distortion by roles', 'Verzerrung nach Stellen'))}"><button type="button" data-t="0" aria-pressed="false" title="${esc(pick('The true map', 'Die echte Karte'))}">${L('Off', 'Aus')}</button><button type="button" data-t="0.5" aria-pressed="true" title="${esc(pick('Areas follow the roles in part: the unequal spread, with the shapes kept recognisable', 'Flächen folgen den Stellen zum Teil: die ungleiche Verteilung, die Formen bleiben erkennbar'))}">${L('Moderate', 'Mäßig')}</button><button type="button" data-t="1" aria-pressed="false" title="${esc(pick('Every area sized by its share of the roles', 'Jede Fläche nach ihrem Anteil an den Stellen'))}">${L('Full', 'Voll')}</button></span><input type="range" id="atlas-morph-t" min="0" max="1" step="0.005" value="0.5" aria-label="${esc(pick('Distortion, from the true map to areas by roles', 'Verzerrung, von der echten Karte bis zu Flächen nach Stellen'))}"></div>` : ''}</div>
<p class="atlas-note" id="atlas-status">${L('Loading the roles…', 'Lade die Stellen …')}</p></div>
<div class="atlas-side"><div class="atlas-area" id="atlas-area"></div><div class="atlas-bar" style="margin:0"><strong id="atlas-in">${L('In the lens', 'In der Lupe')}</strong><button type="button" class="sm" id="atlas-shuffle">${L('Another sample', 'Andere Stichprobe')}</button></div>
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
const coBy = new Map(layers.companies.ents.map((e) => [e.slug, e]));   // a company's entity by its slug (the link between the views)

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
const st = { all: false, mode: 'roles', scope: defaultScope(), size: 0, fields: new Set(), lens: { x: 0.5, y: 0.5 }, sample: [], open: new Set(), z: { s: 1, cx: 0.5, cy: 0.5 } };
const fieldSum = () => { const on = [...st.fields]; $('atlas-fields-sum').innerHTML = `<span>${L('Fields', 'Fachgebiete')}</span> <span class="atlas-note">${on.length ? esc(on.map(fieldLabel).join(', ')) : L('all (click to narrow the map to some)', 'alle (zum Eingrenzen öffnen)')}</span>`; };
fieldSum();
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
const lay = () => { const Ly = st.mode === 'geo' ? geoLay() : st.mode === 'roles' && TL && scrub.tm < TL.end ? tlLayer(scrub.tm) : layers[st.mode]; if (Ly) { HR = Ly.regions || null; HD = Ly; } return Ly; };
const roleVisible = (i) => (ix.attrs[i][0] >> st.scope & 1) === 1 && (!st.fields.size || [...st.fields].some((f) => ix.attrs[i][4] >> ix.fields.indexOf(f) & 1));
const visibleRoles = (e) => e.idx.filter(roleVisible);
function tw(r) { if (r.vote !== undefined) return r.vote; const v = []; if (r.role) v.push((r.role - 3) / 2); if (r.interest) v.push((r.interest - 3) / 2); if (r.apply !== undefined) v.push(r.apply); return v.length ? Math.sign(v.reduce((a, b) => a + b, 0)) : null; }
const voteOf = (id) => (ratings[id] ? tw(ratings[id]) : null);
// map units (0..1, from the layout) to canvas pixels and back; s is the zoom, (cx, cy) the map point in the middle of the canvas
const sx = (x) => (x - st.z.cx) * st.z.s * BW + W / 2, sy = (y) => (y - st.z.cy) * st.z.s * BH + H / 2;
const ux = (px) => (px - W / 2) / (st.z.s * BW) + st.z.cx, uy = (py) => (py - H / 2) / (st.z.s * BH) + st.z.cy;
// One hue per region. Regions that lie next to each other on the map get neighbouring hues, and the hues are spread evenly over the whole
// wheel: the regions are put on a closed tour of their centres (nearest neighbour, then 2-opt) and the k-th region of the tour gets hue
// 360 k / n. Similar areas so read as related colours, and across the map the colours still vary widely. HR is the layout being drawn.
let HR = null; const hueTabs = new WeakMap();
function hueTable(regs) {
  let t = hueTabs.get(regs); if (t) return t;
  const n = regs.length, P = regs.map((r) => r.xy || [0, 0]), d = (a, b) => Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1]);
  const tour = [0], left = new Set(regs.map((_, i) => i)); left.delete(0);
  while (left.size) { const cur = tour[tour.length - 1]; let b = -1, bd = Infinity; for (const j of left) { const x = d(cur, j); if (x < bd) { bd = x; b = j; } } tour.push(b); left.delete(b); }
  for (let imp = true, pass = 0; imp && pass < 40; pass++) { imp = false;
    for (let i = 0; i < n - 2; i++) for (let j = i + 2; j < n; j++) { const a = tour[i], b = tour[i + 1], c = tour[j], e = tour[(j + 1) % n]; if (a === e) continue;
      if (d(a, c) + d(b, e) < d(a, b) + d(c, e) - 1e-9) { for (let l = i + 1, r = j; l < r; l++, r--) [tour[l], tour[r]] = [tour[r], tour[l]]; imp = true; } } }
  const turns = n >= 16 ? 2 : 1;   // many regions: the wheel is walked twice, so far-apart regions can share a hue and neighbours differ more
  t = new Array(n); tour.forEach((r, k) => { t[r] = (20 + 360 * turns * k / n) % 360; }); hueTabs.set(regs, t); return t;
}
// the geography view keeps the plain wheel (c * 137.508): its colours are a density ramp given as a pseudo region index (hueC)
const hue = (c) => (HR && HD && HD.kind !== 'geo' && Number.isInteger(c) && c < HR.length ? hueTable(HR)[c] : (c * 137.508) % 360);
// Inside a region the hue drifts from one neighbourhood to the next (up to +-45 degrees, by the angle of the neighbourhood around the
// region's centre), so a large region is a spread of related colours and not one flat area. HD is the layout being drawn.
let HD = null; const shiftTabs = new WeakMap();
function hoodShifts(Ly) {
  let t = shiftTabs.get(Ly); if (t) return t;
  const hoods = Ly.hoods || [], reg = new Map(), by = new Map();
  for (const e of Ly.ents) if (e.c2 >= 0 && e.c2 < hoods.length && !reg.has(e.c2)) reg.set(e.c2, e.c1);
  reg.forEach((c, h) => { if (!by.has(c)) by.set(c, []); by.get(c).push(h); });
  t = new Float32Array(hoods.length);
  by.forEach((hs, c) => { const m = hs.length; if (m < 2) return;
    const C0 = (Ly.regions[c] && Ly.regions[c].xy) || [0, 0], S = Math.min(45, 14 + 4 * m), ang = (h) => { const q = hoods[h].xy || C0; return Math.atan2(q[1] - C0[1], q[0] - C0[0]); };
    hs.sort((a, b) => ang(a) - ang(b)); hs.forEach((h, k) => { t[h] = -S + 2 * S * k / (m - 1); }); });
  shiftTabs.set(Ly, t); return t;
}
const hueOf = (e) => { const t = HD && !HD.past && HD.kind !== 'geo' ? hoodShifts(HD) : null; return (hue(e.c1) + (t && e.c2 >= 0 && e.c2 < t.length ? t[e.c2] : 0) + 360) % 360; };
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
const regionRgb = (c, L, target = VIVID_C) => { const h = typeof c === 'object' ? hueOf(c) : hue(c), k = h + '/' + L + '/' + target; if (!rgbCache.has(k)) { rgbCache.set(k, Array.isArray(L) ? vivid(h, L[0], L[1], target) : oklch(L, maxChroma(L, h, target), h)); } return rgbCache.get(k); };
let densAt = () => 1;      // how crowded a point's spot on screen is, relative to a typical spot (set by colourField)
// a group's name: the hand-written key term (atlas-labels.json), else its first two distinctive words
const nameOf = (r) => (r.label ? r.label[isDe() ? 1 : 0] : r.words.slice(0, 2).map((w) => w[0].toUpperCase() + w.slice(1)).join(' & '));
const leanText = (lean) => (lean || []).map(([id, sign]) => { const p = prefDefs.find((q) => q.id === id); return p ? (sign > 0 ? p.a : p.b)[isDe() ? 1 : 0] : ''; }).filter(Boolean);
let vis = [], act = [], fit = null, sel = null, hitG = null, lnk = null;   // lnk: the link to the other view (linkBuild)   // sel: the point whose card is open ({k, ly}); hitG: the screen grid of the drawn points
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
function roleRounds(Ly, lw) {
  const byH = Ly.hoods.map(() => []);
  Ly.ents.forEach((e, k) => { if (!vis[k] || e.hidden || pos[e.idx[0]] < 0) return; byH[e.c2].push(k); });
  return byH.map((ks) => { if (!ks.length) return []; const c = new Float32Array(D);
    ks.forEach((k) => { const v = vecOf(Ly.ents[k].idx[0]); for (let d = 0; d < D; d++) c[d] += v[d]; });
    return ks.map((k) => { const v = vecOf(Ly.ents[k].idx[0]); let s = 0; for (let d = 0; d < D; d++) s += v[d] * c[d]; return [s, k]; }).sort((a, b) => (lw ? lw[b[1]] - lw[a[1]] : 0) || (wOf(Ly.ents[b[1]].idx[0]) - wOf(Ly.ents[a[1]].idx[0])) || (b[0] - a[0])).map((x) => x[1]); });
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
  if (st.mode === 'geo') return prepareGeo(T);
  const Ly = lay(), roles = st.mode === 'roles', showTaste = !!(taste && $('atlas-taste').checked) && !Ly.past;
  if (roles) {
    act = Ly.past ? Ly.ents.map(() => true) : Ly.ents.map((e) => visibleRoles(e).length > 0);
    vis = act;
  } else {
    act = Ly.ents.map((e) => visibleRoles(e).length > 0);
    vis = Ly.ents.map((e) => coFieldsOk(e) && coScopeOk(e));
  }
  fit = showTaste ? fitOf(Ly) : null;
  // a company's open roles in the filter (cn), their weight (cw: the sum of the roles' age weights) and whether one is new today (cNew)
  const cn = new Int32Array(Ly.n), cw = new Float32Array(Ly.n), cNew = new Uint8Array(Ly.n); let cwMax = 0;
  if (!roles) Ly.ents.forEach((e, k) => { for (const i of visibleRoles(e)) { cn[k]++; cw[k] += wOf(i); if (AGE[i] < 1) cNew[k] = 1; } cwMax = Math.max(cwMax, cw[k]); });
  coN = cn;
  const stat = !roles || !perScope || Ly.past ? visStats(Ly) : null;   // companies: the regions' means over their visible companies, as the roles' neighbourhoods
  // the visible roles by age: today, this week, this month (the legend under the map)
  const fresh = { t: 0, w: 0, m: 0 }; if (roles) Ly.ents.forEach((e, k) => { if (!vis[k] || e.ember || (e.hidden && !st.all)) return; const a = ageE(e); if (a < 1) fresh.t++; else if (a < 7) fresh.w++; else if (a < 30) fresh.m++; });
  return { Ly, roles, showTaste, T, ink: css('--ink'), paper: css('--panel'), stat, fresh, heat: !!(roles && TL && $('atlas-heat').checked), cn, cw, cNew, cwMax, lw: linkWeights(Ly) };
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
  const { Ly, roles, T, ink, paper, stat, cn, cw, lw } = P, screen = o.screen, many = o.names === 'many', zoomed = st.z.s >= 2.2, ff = o.ff || 1, ks = Math.max(1, W * H / (900 * 640));   // ks: the label caps grow with the area
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
  // with a link: the whole map's field at 20 %, then the linked points' field where they are over-represented (o.wt), so the colour shows
  // where the selection concentrates, not just where it is (a large selection spreads over most of the map)
  const fl = lw ? { ...fo, strength: fo.strength * 0.2 } : fo;
  if (T.glow) { colourField(ctx, Ly, fl); colourField(ctx, Ly, { ...fl, strength: T.glow.strength, extra: T.glow.extra, additive: true }); }
  else colourField(ctx, Ly, fl);
  if (lw) colourField(ctx, Ly, { ...fo, wt: (k) => lw[k] });
  // hot and cold spots: after the colour field, before the points; an area keeps its colour and only gets brighter or dimmer
  if (P.heat) heatField(ctx, ff, T, bg);
  let shown = 0; const hot = [], buckets = new Map();
  // a company's dot: by its open roles (1.6 + 1.1 sqrt(n), at most 5.5), 1.3 for a company with none
  const rcOf = (k) => (cn[k] ? Math.min(5.5, 1.6 + 1.1 * Math.sqrt(cn[k])) : 1.3) * zf;
  // a star's strength: a role's age weight; a company's log weight against the heaviest company
  const starOf = (k) => (roles ? wE(Ly.ents[k]) : cw[k] > 0 ? Math.log1p(cw[k]) / Math.log1p(P.cwMax) : 0);
  // companies with no open role in the filter: small faint dots, drawn first, no rings
  if (!roles) Ly.ents.forEach((e, k) => { if (cn[k] || !vis[k] || (lw && lw[k] > 0)) return; const X0 = sx(e.x), Y0 = sy(e.y); if (X0 < -5 || Y0 < -5 || X0 > W + 5 || Y0 > H + 5) return;
    const rgb = regionRgb(e, T.dimL, T.C); ctx.globalAlpha = T.dimA ?? 0.28; ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; ctx.beginPath(); ctx.arc(X0, Y0, rcOf(k), 0, 7); ctx.fill(); });
  // the linked points (see linkBuild): a soft halo in the region colour, larger and stronger with the weight
  if (lw) Ly.ents.forEach((e, k) => { if (!(lw[k] > 0) || !vis[k] || (e.hidden && !st.all)) return; const X0 = sx(e.x), Y0 = sy(e.y); if (X0 < -5 || Y0 < -5 || X0 > W + 5 || Y0 > H + 5) return;
    const rgb = regionRgb(e, T.pointL, T.C), R = (roles ? dot : rcOf(k)) * (3 + 6 * lw[k]), gd = ctx.createRadialGradient(X0, Y0, 0, X0, Y0, R), hs = `${rgb[0]},${rgb[1]},${rgb[2]}`;
    gd.addColorStop(0, `rgba(${hs},${0.55 * lw[k]})`); gd.addColorStop(1, `rgba(${hs},0)`); ctx.globalAlpha = 1; ctx.fillStyle = gd; ctx.beginPath(); ctx.arc(X0, Y0, R, 0, 7); ctx.fill(); });
  Ly.ents.forEach((e, k) => { if (!roles && !cn[k] && !(lw && lw[k] > 0)) return; if (!vis[k]) return; if (act[k] && !e.ember) shown++; if (e.hidden && !st.all) return;
    const X0 = sx(e.x), Y0 = sy(e.y); if (X0 < -5 || Y0 < -5 || X0 > W + 5 || Y0 > H + 5) return;
    if (e.ember) { ctx.globalAlpha = e.ea; ctx.fillStyle = 'rgb(190,120,60)'; ctx.fillRect(X0 - dot / 2, Y0 - dot / 2, dot, dot); return; }   // a role last seen before the scrubbed time: a dim warm ember
    const sv = starOf(k), lk = lw ? lw[k] : -1;   // lk: the link's weight (-1: no link; 0: dimmed)
    if (sv > 0) { hot.push([k, sv, lk]); return; }   // new roles, and companies with some: drawn after the others, on top
    // crowded spots get fainter points so a dense cluster does not glare; sparse ones keep full strength
    const a = lk > 0 ? T.pointA : lk === 0 ? 0.25 * (act[k] ? T.pointA : 0.45) : (act[k] ? T.pointA : 0.45) * Math.min(1, 1 / Math.sqrt(densAt(X0, Y0))) * (fit ? 0.12 + 0.88 * fit[k] : 1) * (P.heat ? 0.45 : 1);
    if (a <= 0.003) return;
    const rgb = regionRgb(e, act[k] || lk > 0 ? T.pointL : T.dimL, T.C);
    if (roles) {   // the role points go into one path per colour and alpha (a fill each, not one per point)
      const q = Math.round(a * 20), key = `${Math.round(hueOf(e))}|${act[k] ? 1 : 0}|${q}`; let b = buckets.get(key);
      if (!b) buckets.set(key, b = { q, rgb, p: new Path2D() }); b.p.rect(X0 - dot / 2, Y0 - dot / 2, dot, dot); return; }
    // a company with open roles: a dot by its number of roles; on neon a thin ring in its colour, on light none
    ctx.globalAlpha = a; ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.beginPath(); ctx.arc(X0, Y0, rcOf(k), 0, 7); ctx.fill();
    if (!T.multiply) { ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.4)`; ctx.lineWidth = 1.2; ctx.stroke(); } });
  // light theme: the linked points get a ring in a deep shade of their region colour, so they stand out on white
  if (lw && T.multiply) Ly.ents.forEach((e, k) => { if (!(lw[k] > 0) || !vis[k] || (e.hidden && !st.all)) return; const X0 = sx(e.x), Y0 = sy(e.y); if (X0 < -5 || Y0 < -5 || X0 > W + 5 || Y0 > H + 5) return;
    const rgb = regionRgb(e, 0.35, T.C); ctx.globalAlpha = 1; ctx.strokeStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(X0, Y0, (roles ? dot * 1.6 : rcOf(k)) + 1.5, 0, 7); ctx.stroke(); });
  for (const b of buckets.values()) { if (!b.q) continue; ctx.globalAlpha = b.q / 20; ctx.fillStyle = `rgb(${b.rgb[0]},${b.rgb[1]},${b.rgb[2]})`; ctx.fill(b.p); }
  // the new roles and the companies with some, on top
  if (hot.length) for (const [k, sv, lk] of hot) { const e = Ly.ents[k], X0 = sx(e.x), Y0 = sy(e.y), base = roles ? dot : rcOf(k); star(ctx, X0, Y0, base * (1 + 1.6 * sv), sv, e, roles ? sv >= 1 : !!P.cNew[k], T, ink, lk === 0 ? 0.25 : 1); }
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
  const boxes = screen ? [[W - 56, 0, W, 180]] : [], lr = lensOn() ? st.size * BW + 6 : 0, lcx = sx(st.lens.x), lcy = sy(st.lens.y);
  // pad: an opportunistic label (a representative or a new role's title) needs that much free space around it, twice that around
  // area names, so it only appears where the map has room; area names and lens labels pass 0
  // what a name must keep clear of, besides the other names and the lens: the bright points (new roles, stars, linked points; never covered, except by
  // an area's name, where it counts against the position) and, as a cost, the crowd of points under it. Every candidate is scored (points per grid
  // cell under it, 4 per bright point, a little more for each step down the list) and the best is drawn; o2.self is the point the name belongs to.
  const CELL2 = 24 * ts, gw2 = Math.ceil(W / CELL2) + 1, gh2 = Math.ceil(H / CELL2) + 1, grid2 = new Uint16Array(gw2 * gh2), bright = [];
  Ly.ents.forEach((e, k) => { if (!vis[k]) return; const X0 = sx(e.x), Y0 = sy(e.y); if (X0 < 0 || Y0 < 0 || X0 >= W || Y0 >= H) return; grid2[Math.floor(Y0 / CELL2) * gw2 + Math.floor(X0 / CELL2)]++;
    const w = roles ? wE(e) : starOf(k); if (w > 0) bright.push([X0, Y0, (roles ? dot * (1 + 1.6 * w) : rcOf(k) * (1 + 1.6 * w)) + 2 * ts]); });
  const crowd = (b) => { let c = 0, n = 0; for (let gy = Math.max(0, Math.floor(b[1] / CELL2)); gy <= Math.min(gh2 - 1, Math.floor(b[3] / CELL2)); gy++) for (let gx = Math.max(0, Math.floor(b[0] / CELL2)); gx <= Math.min(gw2 - 1, Math.floor(b[2] / CELL2)); gx++) { c += grid2[gy * gw2 + gx]; n++; } return n ? c / n : 0; };
  const hitBright = (b, self) => { let n = 0; for (const q of bright) { if (self && Math.abs(q[0] - self[0]) < 1 && Math.abs(q[1] - self[1]) < 1) continue; if (!(q[0] + q[2] < b[0] || q[0] - q[2] > b[2] || q[1] + q[2] < b[1] || q[1] - q[2] > b[3])) n++; } return n; };
  const place = (lines, cands, free, pad = 0, o2 = {}) => { let best = null;
    cands.forEach(([x, y, a], idx) => { const lay = labelLayout(ctx, lines, x, y, a, ts), b = lay.box;
      if (b[0] < 4 || b[1] < 4 || b[2] > W - 4 || b[3] > H - 4) return;
      if (screen && !free) { const nx = Math.max(b[0], Math.min(lcx, b[2])), ny = Math.max(b[1], Math.min(lcy, b[3])); if (Math.hypot(nx - lcx, ny - lcy) < lr) return; }
      if (boxes.some((q) => { const m = pad * (q.area ? 2 : 1); return !(b[2] + m < q[0] || b[0] - m > q[2] || b[3] + m < q[1] || b[1] - m > q[3]); })) return;
      const hb = hitBright(b, o2.self); if (hb && !o2.soft) return;
      const sc = crowd(b) + 4 * hb + (o2.step ?? 0.15) * idx; if (!best || sc < best.sc) best = { lay, b, sc }; });
    if (!best) return false; boxes.push(best.b); labelDraw(ctx, best.lay, halo); return best.b; };
  const OPP = screen ? 8 * ts : 0;   // the free margin for opportunistic labels on screen (images stay dense)
  const ENT_FS = 9;   // employer and company names: 9 px (about 72 % of the neighbourhood names, never below 9)
  // the regions and neighbourhoods as { r, n, xy }: with the one map, the visible roles and their mean position (see visStats)
  const regs = stat ? stat.reg.filter((g) => g.n >= stat.min) : Ly.regions.map((r) => ({ r, n: r.n, xy: r.xy })), hoods = stat ? stat.hood.filter((g) => g.n >= stat.min) : Ly.hoods.map((r) => ({ r, n: r.n, xy: r.xy }));
  const byN = (list, sub) => list.map((g) => ({ ...g, sub })).sort((a, b) => (b.lens ? 1 : 0) - (a.lens ? 1 : 0) || b.n - a.n);
  // an area can lie in several separate patches, and its mean position then falls between them: each area is named at its dense
  // patches instead (local maxima of its points on a coarse screen grid, up to 3, well apart; the main patch at full size)
  const patches = (list, key, groups) => { if (!stat) return list; const GW = 32, GH = Math.max(8, Math.round(32 * H / W)), byG = new Map();
    Ly.ents.forEach((e, k) => { if (!vis[k]) return; const X0 = sx(e.x), Y0 = sy(e.y); if (X0 < 0 || Y0 < 0 || X0 >= W || Y0 >= H) return; let g = byG.get(e[key]);
      if (!g) { g = { c: new Float32Array(GW * GH), x: new Float32Array(GW * GH), y: new Float32Array(GW * GH) }; byG.set(e[key], g); }
      const q = Math.floor(Y0 / H * GH) * GW + Math.floor(X0 / W * GW); g.c[q]++; g.x[q] += X0; g.y[q] += Y0; });
    const out = []; for (const g0 of list) { const g = byG.get(groups.indexOf(g0.r)); if (!g) { out.push(g0); continue; }
      const S = new Float32Array(GW * GH), at = (x, y) => (x < 0 || y < 0 || x >= GW || y >= GH ? 0 : g.c[y * GW + x]);
      for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) { let t = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) t += at(x + dx, y + dy); S[y * GW + x] = t; }
      const pk = []; for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) { const v = S[y * GW + x]; if (v < Math.max(stat.min, 0.15 * g0.n)) continue; let top = true;
        for (let dy = -1; dy <= 1 && top; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if ((dx || dy) && xx >= 0 && yy >= 0 && xx < GW && yy < GH && S[yy * GW + xx] > v) { top = false; break; } }
        if (top) pk.push([v, x, y]); }
      pk.sort((a, b) => b[0] - a[0]); const kept = []; for (const p of pk) { if (kept.length >= 3) break; if (kept.every((o) => Math.hypot(o[1] - p[1], o[2] - p[2]) >= 6)) kept.push(p); }
      if (!kept.length) { out.push(g0); continue; }
      kept.forEach(([v, x, y], i) => { let n = 0, X = 0, Y = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= GW || yy >= GH) continue; const q = yy * GW + xx; n += g.c[q]; X += g.x[q]; Y += g.y[q]; }
        out.push({ ...g0, n: i ? v : g0.n, xy: [ux(X / n), uy(Y / n)] }); }); }
    return out; };
  // areas: regions at full view, neighbourhoods when zoomed in (or, in an image, always, after the regions, in a smaller weight)
  const regP = patches(regs, 'c1', Ly.regions);
  // on screen the area that holds most of the lens's points is named in the lens, first of all (at the mean of those points)
  if (screen && stat && lensOn()) { const lr2 = (st.size * BW) ** 2, lx = sx(st.lens.x), ly = sy(st.lens.y), by = new Map();
    Ly.ents.forEach((e, k) => { if (!vis[k]) return; const X0 = sx(e.x), Y0 = sy(e.y); if ((X0 - lx) ** 2 + (Y0 - ly) ** 2 > lr2) return; const g = by.get(e.c1) || { n: 0, x: 0, y: 0 }; g.n++; g.x += e.x; g.y += e.y; by.set(e.c1, g); });
    const top = [...by].sort((a, b) => b[1].n - a[1].n)[0], R0 = top && Ly.regions[top[0]];
    if (R0 && top[1].n >= 3) regP.unshift({ r: R0, n: Math.max(top[1].n, stat.min), xy: [top[1].x / top[1].n, top[1].y / top[1].n], lens: true }); }
  const areas = many ? [...byN(regP, false), ...(roles ? byN(hoods, true) : [])] : byN(roles && zoomed && !Ly.past ? hoods : regP, false);
  // area names first: they win over any single role or company label
  const areaInk = (sub) => (T.areaInk ? (sub ? T.subInk : T.areaInk) : ink);
  for (const { r, n, xy, sub } of areas) {
    if (counts.areas >= Math.round((many ? 400 : 24) * ks) || (!r.words.length && !r.label)) continue;
    const fs = sub ? Math.round(Math.max(9, Math.min(12, 6 + Math.sqrt(n) * 0.22))) : Math.round(Math.max(11, Math.min(18, 7 + Math.sqrt(n) * 0.33)));
    const lines = wrapText(nameOf(r), roles ? 16 : 20, roles ? 2 : 3).map((t) => ({ t, fs, face: sub ? '500' : '600', alpha: 1, color: areaInk(sub) }));   // company groups have long names
    const X0 = sx(xy[0]), Y0 = sy(xy[1]), dy = 1.4 * fs * ts * lines.length;   // the patch centre, else just above or below it
    // area names may sit inside the lens (free): placed first, the lens's own labels fit around them
    const ring = []; for (const f of [1, 2]) for (let q = 0; q < 8; q++) ring.push([X0 + Math.cos(q * Math.PI / 4) * f * dy * 1.7, Y0 + Math.sin(q * Math.PI / 4) * f * dy, 'center']);
    const ab = place(lines, [[X0, Y0, 'center'], [X0, Y0 - dy, 'center'], [X0, Y0 + dy, 'center'], ...ring], true, 0, { soft: true, step: 0.8 }); if (ab) { ab.area = true; counts.areas++; }
  }
  // the roles and companies in the lens are labelled at any zoom (roles: newest first, then nearest the lens centre; companies: most open
  // roles first). On screen the other new roles follow, newest first. They come after the area names and fit around them, and may lie
  // inside the lens. A role title is used once; in the lens the same title at the same company is skipped.
  const rL = st.size * BW, ccx = sx(st.lens.x), ccy = sy(st.lens.y), lensCap = many ? 40 : Math.round(12 * ks), newCap = Math.round(8 * ks);
  const d2 = (k) => (sx(Ly.ents[k].x) - ccx) ** 2 + (sy(Ly.ents[k].y) - ccy) ** 2, inMap = (X0, Y0) => X0 >= 0 && Y0 >= 0 && X0 <= W && Y0 <= H;
  const seenT = new Set(), seenC = new Set(), labelled = new Set();
  const byAge = (a, b) => { const x = AGE[Ly.ents[a].idx[0]], y = AGE[Ly.ents[b].idx[0]]; return x !== y ? (x < y ? -1 : 1) : d2(a) - d2(b); };
  const cand = (X0, Y0, lines) => { const b = labelLayout(ctx, lines, 0, 0, 'center', ts).box, hh = (b[3] - b[1]) / 2, out = [];
    for (const g of [6, 14]) { const d = g * ts, e = d * 0.72; out.push([X0 + d, Y0, 'left'], [X0 - d, Y0, 'right'], [X0, Y0 - d - hh, 'center'], [X0, Y0 + d + hh, 'center'],
      [X0 + e, Y0 - e - hh * 0.5, 'left'], [X0 - e, Y0 - e - hh * 0.5, 'right'], [X0 + e, Y0 + e + hh * 0.5, 'left'], [X0 - e, Y0 + e + hh * 0.5, 'right']); }
    return out; };
  // a role's label: its title (up to 2 lines of about 26 characters, "✦ " before the first line when new today), then its company in brackets
  const roleLines = (title, row, col, pre = '') => { const ls = wrapText(title, 26, 2).map((t) => ({ t, fs: ENT_FS, face: 'italic 400', alpha: 0.9, color: col })); ls[0].t = pre + ls[0].t;
    return ls.concat([{ t: `(${cutWords(coInLabel(row[2]), 28)})`, fs: ENT_FS * 0.9, face: 'italic 400', alpha: 0.8, color: col }]); };
  const roleLab = (k, free) => { const e = Ly.ents[k], row = rows[e.idx[0]], title = cleanTitle(row[1]), X0 = sx(e.x), Y0 = sy(e.y), col = T.tintL ? tintOf(e) : ink;
    if (!title) return false; const lines = roleLines(title, row, col, wOf(e.idx[0]) >= 1 ? '✦ ' : '');
    if (!place(lines, cand(X0, Y0, lines), free, free ? 0 : OPP, { self: [X0, Y0] })) return false;
    seenT.add(title.toLowerCase()); labelled.add(k); ctx.globalAlpha = 0.95; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X0, Y0, 2.4 * ts, 0, 7); ctx.fill(); return true; };
  if (roles && !Ly.past) {
    const pool = []; Ly.ents.forEach((e, k) => { if (rL > 0 && vis[k] && !(e.hidden && !st.all) && d2(k) <= rL * rL) pool.push(k); }); pool.sort(byAge);
    for (const k of pool) { if (counts.lens >= lensCap) break; const e = Ly.ents[k], row = rows[e.idx[0]], title = cleanTitle(row[1]), tk = title.toLowerCase() + '|' + row[2];
      if (!title || !inMap(sx(e.x), sy(e.y)) || seenC.has(tk)) continue; if (roleLab(k, true)) { seenC.add(tk); counts.lens++; } }
    if (screen) { const fresh = []; Ly.ents.forEach((e, k) => { if (vis[k] && !(e.hidden && !st.all) && wOf(e.idx[0]) > 0 && !labelled.has(k) && inMap(sx(e.x), sy(e.y))) fresh.push(k); }); fresh.sort(byAge);
      for (const k of fresh) { if (counts.fresh >= newCap) break; const t = cleanTitle(rows[Ly.ents[k].idx[0]][1]).toLowerCase(); if (!t || seenT.has(t)) continue; if (roleLab(k, false)) counts.fresh++; } }
  } else if (!roles) {
    // the companies in the lens, with their open roles in brackets (a company with none: its name only)
    const pool = []; Ly.ents.forEach((e, k) => { if (rL > 0 && vis[k] && e.name && !(e.hidden && !st.all) && d2(k) <= rL * rL) pool.push(k); });
    pool.sort((a, b) => cn[b] - cn[a] || d2(a) - d2(b));
    for (const k of pool) { if (counts.lens >= lensCap) break; const e = Ly.ents[k], X0 = sx(e.x), Y0 = sy(e.y), nm = shortName(e.name);
      if (!nm || !inMap(X0, Y0) || seenC.has(nm)) continue; const col = T.tintL ? tintOf(e) : ink, lines = wrapText(coLabel(nm, cn[k]), 22, 2).map((t) => ({ t, fs: ENT_FS, face: 'italic 400', alpha: 0.9, color: col }));
      if (place(lines, cand(X0, Y0, lines), true, 0, { self: [X0, Y0] })) { seenC.add(nm); counts.lens++; } }
  }
  // roles (roles map): one representative role per neighbourhood, the most typical first, in rounds across the neighbourhoods
  // (the first of every neighbourhood, then the second of each, ...) so the labels spread over the map; each label is the role's
  // title and its company in brackets, beside a small dot marker at the role's own position. A title is used once.
  if (roles && !Ly.past && (many || zoomed)) {
    const cap = Math.round((many ? 120 : 14) * ks), lists = roleRounds(Ly, lw), order = [...Ly.hoods.keys()].sort((x, y) => (stat ? stat.hood[y].n - stat.hood[x].n : Ly.hoods[y].n - Ly.hoods[x].n));
    rounds: for (let r = 0; ; r++) { let any = false;
      for (const h of order) { const list = lists[h]; if (r >= list.length) continue; any = true;
        if (counts.roles >= cap) break rounds;
        const e = Ly.ents[list[r]], X0 = sx(e.x), Y0 = sy(e.y); if (X0 < 0 || Y0 < 0 || X0 > W || Y0 > H) continue;
        const row = rows[e.idx[0]], title = cleanTitle(row[1]), key = title.toLowerCase(); if (!title || seenT.has(key)) continue;
        const col = T.tintL ? tintOf(e) : ink;
        // the title (up to 2 lines of about 26 characters), then the company in brackets on its own line: a little smaller and dimmer
        const lines = roleLines(title, row, col);
        if (place(lines, cand(X0, Y0, lines), false, OPP, { self: [X0, Y0] })) { seenT.add(key); counts.roles++; ctx.globalAlpha = 0.95; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X0, Y0, 2.4 * ts, 0, 7); ctx.fill(); } }
      if (!any) break; }
  }
  // companies (companies map): next to their dot, right of it or else left, the companies with most open roles first; the companies
  // with none are labelled in the lens only
  if (!roles && (many || zoomed)) {
    const order = Ly.ents.map((e, k) => k).filter((k) => vis[k] && Ly.ents[k].name && (cn[k] > 0 || (lw && lw[k] > 0))).sort((a, b) => (lw ? lw[b] - lw[a] : 0) || cn[b] - cn[a]);
    for (const k of order) { if (counts.companies >= Math.round((many ? 300 : 15) * ks)) break; const e = Ly.ents[k], X0 = sx(e.x), Y0 = sy(e.y); if (X0 < 0 || Y0 < 0 || X0 > W || Y0 > H) continue;
      const nm = shortName(e.name); if (seenC.has(nm)) continue; seenC.add(nm);
      const col = T.tintL ? tintOf(e) : ink, rr = rcOf(k) + 3, lines = wrapText(coLabel(nm, cn[k]), 22, 2).map((t) => ({ t, fs: ENT_FS, face: 'italic 400', alpha: 0.9, color: col }));
      if (place(lines, cand(X0, Y0, lines), false, OPP, { self: [X0, Y0] })) counts.companies++; }
  }
  }
  if (screen) {   // the lens and the sampled points
    const r = st.size * BW, lx = sx(st.lens.x), ly = sy(st.lens.y); ctx.globalAlpha = 1; if (lensOn()) { ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.arc(lx, ly, r, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
    ctx.fillStyle = ink; st.sample.forEach((k) => { const e = Ly.ents[k]; if (!e) return; ctx.beginPath(); ctx.arc(sx(e.x), sy(e.y), 4, 0, 7); ctx.fill(); });
  }
  return { shown, counts };
}

// ---- geography (optional: config geomap, one file for every scope). The shapes (countries, states) with their roles, the places with
// open roles and the companies, each at its true position (t = 0) or at its cartogram position (t = 1, by roles: an area's size follows
// its roles). The shapes' box at t is fitted to the map box (aspect kept, centred); every entity then takes the map units of the other views.
let GEO = null, geoLoading = null;
const geo = { t: 0.5, to: 0.5, mod: true, raf: 0, morph: false, lays: new Map() };   // t: 0 the true map, 0.5 the moderate map, 1 by roles; mod: the file has the moderate map; morph: an animation runs (no labels meanwhile), heading to `to`
const geoHue = (q) => 240 + 170 * q, hueC = (h) => Math.round(h) / 137.508;   // the density ramp: deep blue (few), magenta, amber (many); hueC: a region index whose hue() is h (for star())
const STATE_DE = { 'DE-BW': 'Baden-Württemberg', 'DE-BY': 'Bayern', 'DE-BE': 'Berlin', 'DE-BB': 'Brandenburg', 'DE-HB': 'Bremen', 'DE-HH': 'Hamburg', 'DE-HE': 'Hessen', 'DE-MV': 'Mecklenburg-Vorpommern', 'DE-NI': 'Niedersachsen', 'DE-NW': 'Nordrhein-Westfalen', 'DE-RP': 'Rheinland-Pfalz', 'DE-SL': 'Saarland', 'DE-SN': 'Sachsen', 'DE-ST': 'Sachsen-Anhalt', 'DE-SH': 'Schleswig-Holstein', 'DE-TH': 'Thüringen' };
let deNames = null;
// a shape's name: countries in German through the browser's region names, the German states from the table above
const geoNameOf = (s) => { if (!isDe()) return s.name; if (s.kind === 'state') return STATE_DE[s.id] || s.name; try { deNames = deNames || new Intl.DisplayNames(['de'], { type: 'region' }); return deNames.of(s.id) || s.name; } catch (e) { return s.name; } };
// a company passes the field chips (any chip: its profile vector, its field text or its tags) and the Where scope (its rank in the scope order)
const SCOPE_RANKS = { bavaria: 0, germany: 1, europe: 2, worldwide: 3 };
function coFieldsOk(e) { if (!st.fields.size) return true; if (ix.fields.some((f, q) => st.fields.has(f) && e.f[q] >= 0.15)) return true;
  const fldStr = (e.field || '').toLowerCase(); for (const f of st.fields) { if (fldStr.includes(f.toLowerCase())) return true; }
  const co = coRows[e.slug]; if (co && co[9]) { for (const f of st.fields) { const fl = f.toLowerCase(); if (co[9].some((t) => t.toLowerCase().includes(fl))) return true; } }
  return false; }
function coScopeOk(e) { if (st.scope >= cfg.scopes.length - 1) return true; const co = coRows[e.slug]; if (!co) return true; return (SCOPE_RANKS[co[12]] ?? 3) <= st.scope; }
// the file: read on the first use of the view, once
function geoLoad() { if (!geoLoading) geoLoading = fetch(dataUrl(cfg.geomap)).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((j) => { GEO = j && j.version === 1 ? j : null; geo.lays.clear();
  geo.mod = !!(GEO && Object.values(GEO.scopes || {}).some((S) => S.moderate)); if (!geo.mod && geo.t === 0.5) geo.t = geo.to = 1;
  const mb = document.querySelector('#atlas-morph [data-t="0.5"]'); if (mb) mb.hidden = !geo.mod; geoMarks(); return GEO; }); return geoLoading; }
// a scope's layer: its shapes (q: the density rank, -1 with no role), its places (q: the rank by roles) and its companies (the catalogue entity
// with the geo position, so the company cards work); coAt: the companies at each place, within 1.2 % of the box (by their geo position)
function geoLayer(sid) { if (geo.lays.has(sid)) return geo.lays.get(sid);
  const S = (GEO && GEO.scopes && GEO.scopes[sid]) || {};
  const shapes = (S.shapes || []).map((s) => { let a = 0; for (const r of s.rings) { let q = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) q += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); a += Math.abs(q) / 2; } return { ...s, area: a, q: -1, path: null, pr: [], lx: 0, ly: 0 }; });
  const dens = shapes.filter((s) => s.roles > 0).sort((a, b) => a.roles / a.area - b.roles / b.area); dens.forEach((s, i) => { s.q = dens.length > 1 ? i / (dens.length - 1) : 0.5; });
  const places = (S.places || []).map((p) => ({ id: 'pl:' + p.id, place: true, name: p.name, n: p.n, idx: [], slug: null, c1: 0, c2: 0, gx: p.x, gy: p.y, hx: p.mx ?? (p.x + p.cx) / 2, hy: p.my ?? (p.y + p.cy) / 2, kx: p.cx, ky: p.cy, x: 0, y: 0 }));
  const byN = [...places].sort((a, b) => a.n - b.n); byN.forEach((e, i) => { e.q = byN.length > 1 ? i / (byN.length - 1) : 0.5; });
  const cos = (S.companies || []).map((c) => { const e = coBy.get(c.slug), base = e ? { ...e } : { id: 'co:' + c.slug, slug: c.slug, name: c.slug, about: '', field: '', idx: [], vec: null, c1: 0, c2: 0, f: new Float32Array(ix.fields.length) }; return { ...base, gx: c.x, gy: c.y, hx: c.mx ?? (c.x + c.cx) / 2, hy: c.my ?? (c.y + c.cy) / 2, kx: c.cx, ky: c.cy, x: 0, y: 0 }; });
  const coAt = new Map(); cos.forEach((c, j) => { let best = -1, bd = 0.012 ** 2; places.forEach((p, i) => { const d = (p.gx - c.gx) ** 2 + (p.gy - c.gy) ** 2; if (d < bd) { bd = d; best = i; } }); if (best >= 0) { if (!coAt.has(best)) coAt.set(best, []); coAt.get(best).push(places.length + j); } });
  const V = []; if (shapes.length) shapes.forEach((s) => s.rings.forEach((r) => r.forEach((v) => V.push(v[0], v[1], v[4] ?? (v[0] + v[2]) / 2, v[5] ?? (v[1] + v[3]) / 2, v[2], v[3])))); else [...places, ...cos].forEach((e) => V.push(e.gx, e.gy, e.hx, e.hy, e.kx, e.ky));
  const Lg = { kind: 'geo', sid, shapes, ents: [...places, ...cos], n: places.length + cos.length, coAt, nMax: Math.max(1, ...places.map((p) => p.n)), V: Float64Array.from(V), key: '', pkey: '', fit: null };
  geo.lays.set(sid, Lg); return Lg; }
// a coordinate at t from its true (a), moderate (m) and full (k) value: 0 to 0.5 true to moderate, 0.5 to 1 moderate to full
const geoAt = (a, m, k, t) => (t <= 0.5 ? a + (m - a) * 2 * t : m + (k - m) * (2 * t - 1));
const geoLay = () => { const sc = cfg.scopes[st.scope], Lg = geoLayer(sc ? sc.id : ''); geoSync(Lg); return Lg; };
// the layer at the morph t, fitted to the map box BW x BH: the box of the shapes at t (of the places when there are none), its centre and one
// scale for both axes (94 % of the box, aspect kept); every entity takes its position in map units (see sx and sy)
function geoSync(Lg) { const t = geo.t, key = t + '|' + BW + '|' + BH; if (Lg.key === key) return; Lg.key = key;
  const V = Lg.V; let X0 = Infinity, X1 = -Infinity, Y0 = Infinity, Y1 = -Infinity;
  for (let i = 0; i < V.length; i += 6) { const x = geoAt(V[i], V[i + 2], V[i + 4], t), y = geoAt(V[i + 1], V[i + 3], V[i + 5], t); if (x < X0) X0 = x; if (x > X1) X1 = x; if (y < Y0) Y0 = y; if (y > Y1) Y1 = y; }
  if (X0 === Infinity) { X0 = Y0 = 0; X1 = Y1 = 1; }
  const f = Lg.fit = { mx: (X0 + X1) / 2, my: (Y0 + Y1) / 2, p: Math.min(BW * 0.94 / Math.max(X1 - X0, 1e-9), BH * 0.94 / Math.max(Y1 - Y0, 1e-9)) };
  for (const e of Lg.ents) { const x = geoAt(e.gx, e.hx, e.kx, t), y = geoAt(e.gy, e.hy, e.ky, t); e.x = 0.5 + (x - f.mx) * f.p / BW; e.y = 0.5 + (y - f.my) * f.p / BH; } }
// the shapes as paths in screen pixels at the view and t (cached until one changes); s.pr: their rings in pixels (for the lens: which shape it is
// over); s.lx, s.ly: the label point (the middle of the largest ring)
function geoPaths(Lg) { const key = [geo.t, W, H, BW, BH, st.z.s, st.z.cx, st.z.cy].join('|'); if (Lg.pkey === key) return; Lg.pkey = key;
  const t = geo.t, f = Lg.fit, X = (x) => sx(0.5 + (x - f.mx) * f.p / BW), Y = (y) => sy(0.5 + (y - f.my) * f.p / BH);
  for (const s of Lg.shapes) { const path = new Path2D(); s.pr = []; let big = null;
    for (const r of s.rings) { const q = []; for (const v of r) q.push(X(geoAt(v[0], v[4] ?? (v[0] + v[2]) / 2, v[2], t)), Y(geoAt(v[1], v[5] ?? (v[1] + v[3]) / 2, v[3], t))); if (!q.length) continue;
      path.moveTo(q[0], q[1]); for (let i = 2; i < q.length; i += 2) path.lineTo(q[i], q[i + 1]); path.closePath(); s.pr.push(q); if (!big || q.length > big.length) big = q; }
    s.path = path; s.lx = s.ly = 0; s.ar = 0;
    if (big) { const [lx, ly, ar] = labelPoint(big); s.lx = lx; s.ly = ly; s.ar = ar; } } }
// the label point of a shape's largest ring (a flat px list): the area-weighted centroid when it lies inside the ring, else the sample of a
// 12 x 12 grid inside the ring that is farthest from its edge (the edge's vertices, at most 64). Also the ring's on-screen area
function labelPoint(q) { const n = q.length / 2; let A = 0, cx = 0, cy = 0, a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n, x0 = q[2 * i], y0 = q[2 * i + 1], x1 = q[2 * j], y1 = q[2 * j + 1], cr = x0 * y1 - x1 * y0; A += cr; cx += (x0 + x1) * cr; cy += (y0 + y1) * cr; a = Math.min(a, x0); c = Math.max(c, x0); b = Math.min(b, y0); d = Math.max(d, y0); }
  const ar = Math.abs(A) / 2; if (!ar) return [(a + c) / 2, (b + d) / 2, 0];
  const gx = cx / (3 * A), gy = cy / (3 * A); if (inRings([q], gx, gy)) return [gx, gy, ar];
  const step = Math.max(1, Math.floor(n / 64)), ev = []; for (let i = 0; i < n; i += step) ev.push(q[2 * i], q[2 * i + 1]);
  let best = [(a + c) / 2, (b + d) / 2], bd = -1;
  for (let i = 1; i <= 12; i++) for (let j = 1; j <= 12; j++) { const x = a + (c - a) * i / 13, y = b + (d - b) * j / 13; if (!inRings([q], x, y)) continue;
    let m = Infinity; for (let k = 0; k < ev.length; k += 2) m = Math.min(m, (ev[k] - x) ** 2 + (ev[k + 1] - y) ** 2); if (m > bd) { bd = m; best = [x, y]; } }
  return [best[0], best[1], ar]; }
// is the point inside the rings (even-odd: holes and islands count as the rings give them)
const inRings = (rings, x, y) => { let c = false; for (const q of rings) for (let i = 0, j = q.length - 2; i < q.length; j = i, i += 2) { const xi = q[i], yi = q[i + 1], xj = q[j], yj = q[j + 1]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const geoShapeAt = (Lg, X, Y) => Lg.shapes.find((s) => s.pr.length && inRings(s.pr, X, Y)) || null;
// a shape's fill: its density colour in the theme's band (vivid), grey when it has no role
const geoShapeRgb = (s, T) => (s.q >= 0 ? vivid(geoHue(s.q), T.fieldL[0], T.fieldL[1], T.C) : (T.glow ? [26, 28, 36] : [226, 228, 234]));
// the companies at a place (their catalogue entities)
const placeCos = (k) => { const Lg = lay(); return (Lg.coAt.get(k) || []).map((j) => Lg.ents[j]); };
// a place in the lens: its name, its open roles and the companies located there (the data gives no city per role: a place card, not a role list)
function placeCardHtml(k, e) { const cs = placeCos(k); return `<li class="atlas-item" data-k="${k}" data-id="${e.id}"><div class="t">${esc(e.name)}</div><div class="m">${e.n.toLocaleString()} ${L('open roles here', 'offene Stellen hier')} · ${cs.length} ${L('companies here', 'Firmen hier')}</div>${cs.length ? `<div class="m">${cs.slice(0, 6).map((c) => esc(shortName(c.name))).join(' · ')}${cs.length > 6 ? ` · +${cs.length - 6}` : ''}</div>` : ''}</li>`; }
// the geography's marks for this view: the places always (their counts are all their roles), the companies by the chips and the Where scope
function prepareGeo(T) { const Lg = geoLay(), n = Lg.n, cn = new Int32Array(n), cw = new Float32Array(n), cNew = new Uint8Array(n);
  act = Lg.ents.map((e) => e.place || visibleRoles(e).length > 0); vis = Lg.ents.map((e) => e.place || (coFieldsOk(e) && coScopeOk(e)));
  Lg.ents.forEach((e, k) => { if (!e.place) cn[k] = visibleRoles(e).length; }); fit = null;
  return { Ly: Lg, roles: false, geo: true, T, ink: css('--ink'), paper: css('--panel'), stat: null, fresh: { t: 0, w: 0, m: 0 }, heat: false, cn, cw, cNew, cwMax: 0, lw: linkWeights(Lg) }; }
// the geography's paint: the shapes in their colours (a thin ink outline), the companies as small dots (a linked one with a halo), the places on top
// like the stars, then the names: the shapes' first, the places' after them (in the lens first, then the biggest)
function paintGeo(ctx, P, o) {
  const { Ly: Lg, T, ink, paper, lw, cn } = P, screen = o.screen, many = o.names === 'many', light = !!o.noLabels, ts = screen ? fsk() : (o.ts || 1), zf = Math.min(2.5, Math.sqrt(st.z.s)), ks = Math.max(1, W * H / (900 * 640)), zoomed = st.z.s >= 2.2;
  const bg = T.bg || paper, halo = T.halo || paper, inBox = (X, Y) => X >= -5 && Y >= -5 && X <= W + 5 && Y <= H + 5;
  ctx.globalCompositeOperation = 'source-over';
  if (screen && !T.bg && !T.multiply) ctx.clearRect(0, 0, W, H); else { ctx.globalAlpha = 1; ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
  geoPaths(Lg);
  ctx.globalCompositeOperation = T.multiply ? 'multiply' : 'source-over'; ctx.globalAlpha = T.glow ? 0.82 : 1;
  for (const s of Lg.shapes) { const c = geoShapeRgb(s, T); ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.fill(s.path, 'evenodd'); }
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 0.35; ctx.strokeStyle = ink; ctx.lineWidth = 0.6; for (const s of Lg.shapes) ctx.stroke(s.path);
  // the companies: tiny dots, one path per style and colour (a company with an open role in the filter: a larger, brighter dot); the linked
  // ones (lw > 0) get a halo; the rest of a link (lw 0) is dimmed to a quarter
  const dots = new Map(), linked = []; let nCo = 0;
  Lg.ents.forEach((e, k) => { if (e.place || !vis[k]) return; const X0 = sx(e.x), Y0 = sy(e.y); if (!inBox(X0, Y0)) return; nCo++;
    const w = lw ? lw[k] : -1; if (w > 0) { linked.push(k); return; }
    const on = cn[k] > 0, lit = on && T.multiply, a = (on ? (lit ? 0.8 : 0.6) : (T.dimA ?? 0.28)) * (w === 0 ? 0.25 : 1), r = (on ? 1.6 : 1.3) * zf, rgb = regionRgb(e.c1, on ? (lit ? 0.55 : T.pointL) : T.dimL, T.C), key = rgb.join(',') + '|' + a.toFixed(3) + '|' + r.toFixed(2);
    let b = dots.get(key); if (!b) dots.set(key, b = { rgb, a, r, p: new Path2D() }); b.p.moveTo(X0 + r, Y0); b.p.arc(X0, Y0, r, 0, 7); });
  for (const b of dots.values()) { ctx.globalAlpha = b.a; ctx.fillStyle = `rgb(${b.rgb[0]},${b.rgb[1]},${b.rgb[2]})`; ctx.fill(b.p); }
  for (const k of linked) { const e = Lg.ents[k], X0 = sx(e.x), Y0 = sy(e.y), hs = regionRgb(e.c1, T.pointL, T.C).join(','), r = (1.6 + 1.1 * Math.sqrt(cn[k] || 1)) * zf, R = r * (3 + 4 * lw[k]), gd = ctx.createRadialGradient(X0, Y0, 0, X0, Y0, R);
    gd.addColorStop(0, `rgba(${hs},${0.55 * lw[k]})`); gd.addColorStop(1, `rgba(${hs},0)`); ctx.globalAlpha = 1; ctx.fillStyle = gd; ctx.beginPath(); ctx.arc(X0, Y0, R, 0, 7); ctx.fill();
    ctx.fillStyle = `rgb(${hs})`; ctx.beginPath(); ctx.arc(X0, Y0, r, 0, 7); ctx.fill(); }
  // the places: a dot sized by its open roles (1.5 to 7 px) in its density colour, like the stars; the big ones last, on top
  const rOf = (e) => (1.5 + 5.5 * (Math.sqrt(e.n) - 1) / Math.max(1e-9, Math.sqrt(Lg.nMax) - 1)) * zf, pl = [];
  Lg.ents.forEach((e, k) => { if (e.place && vis[k]) { const X0 = sx(e.x), Y0 = sy(e.y); if (inBox(X0, Y0)) pl.push(k); } });
  pl.sort((a, b) => Lg.ents[a].n - Lg.ents[b].n);
  for (const k of pl) { const e = Lg.ents[k]; star(ctx, sx(e.x), sy(e.y), rOf(e), 0.2 + 0.6 * e.q, hueC(geoHue(e.q)), false, T, ink, 1); }
  ctx.globalAlpha = 1;
  if (o.keep) { const kf = base || (base = { c: document.createElement('canvas') }); kf.c.width = ctx.canvas.width; kf.c.height = ctx.canvas.height; kf.c.getContext('2d').drawImage(ctx.canvas, 0, 0); kf.z = { ...st.z }; }
  const counts = { areas: 0, places: pl.length, companies: nCo, lens: 0, fresh: 0 };
  if (!light) {
    const boxes = screen ? [[W - 56, 0, W, 180]] : [], lr = st.size * BW, lcx = sx(st.lens.x), lcy = sy(st.lens.y), inl = (e) => lr > 0 && (sx(e.x) - lcx) ** 2 + (sy(e.y) - lcy) ** 2 <= lr * lr, OPP = screen ? 8 * ts : 0;
    // what a name must keep clear of: the other names, every place's dot (hotspots: the big ones), and, as a soft cost, the companies' dots
    const pdots = pl.map((k) => { const e = Lg.ents[k]; return { k, x: sx(e.x), y: sy(e.y), r: rOf(e), n: e.n }; });
    const nMed = pdots.length ? pdots.map((q) => q.n).sort((x, y) => x - y)[pdots.length >> 1] : 0;
    const CELL = 24 * ts, gw = Math.ceil(W / CELL) + 1, gh = Math.ceil(H / CELL) + 1, grid = new Uint16Array(gw * gh);
    Lg.ents.forEach((e, k) => { if (e.place || !vis[k]) return; const X0 = sx(e.x), Y0 = sy(e.y); if (X0 >= 0 && Y0 >= 0 && X0 < W && Y0 < H) grid[Math.floor(Y0 / CELL) * gw + Math.floor(X0 / CELL)]++; });
    const dotsIn = (b) => { let c = 0; for (let gy = Math.max(0, Math.floor(b[1] / CELL)); gy <= Math.min(gh - 1, Math.floor(b[3] / CELL)); gy++) for (let gx = Math.max(0, Math.floor(b[0] / CELL)); gx <= Math.min(gw - 1, Math.floor(b[2] / CELL)); gx++) c += grid[gy * gw + gx]; return c; };
    const hitDot = (b, skip, minN, m) => pdots.some((q) => q.k !== skip && q.n >= minN && !(q.x + q.r + m < b[0] || q.x - q.r - m > b[2] || q.y + q.r + m < b[1] || q.y - q.r - m > b[3]));
    // the candidates are tried in order; the best is the one on the fewest company dots (a little more for each step down the list), and none
    // that touches another name, the controls, the lens, or a place's dot (o2.minN: only the places with at least that many roles)
    const place = (lines, cands, free, pad = 0, o2 = {}) => { let best = null;
      cands.forEach(([x, y, a], idx) => { const lg = labelLayout(ctx, lines, x, y, a, ts), b = lg.box;
        if (b[0] < 4 || b[1] < 4 || b[2] > W - 4 || b[3] > H - 4) return;
        if (screen && !free) { const nx = Math.max(b[0], Math.min(lcx, b[2])), ny = Math.max(b[1], Math.min(lcy, b[3])); if (Math.hypot(nx - lcx, ny - lcy) < lr) return; }
        if (boxes.some((q) => { const m = pad * (q.area ? 2 : 1); return !(b[2] + m < q[0] || b[0] - m > q[2] || b[3] + m < q[1] || b[1] - m > q[3]); })) return;
        if (hitDot(b, o2.skip, o2.minN || 0, 2 * ts)) return;
        const c = dotsIn(b); if (c > (o2.maxDots ?? 1e9)) return;
        const sc = c + 0.2 * idx; if (!best || sc < best.sc) best = { lg, b, sc }; });
      if (!best) return false; boxes.push(best.b); labelDraw(ctx, best.lg, halo); return best.b; };
    // the shapes' names first, the largest first (only shapes with roles); they win over the places' names, and keep off the bigger places
    for (const s of Lg.shapes.filter((x) => x.roles > 0).sort((a, b) => b.roles - a.roles)) { if (counts.areas >= Math.round((many ? 60 : 24) * ks)) break;
      const fs = Math.round(Math.max(11, Math.min(18, 7 + Math.sqrt(s.roles) * 0.33))), lines = wrapText(geoNameOf(s), 16, 2).map((t) => ({ t, fs, face: '600', alpha: 1, color: T.areaInk || ink })), dy = 1.4 * fs * ts * lines.length;
      const lb = labelLayout(ctx, lines, 0, 0, 'center', ts).box; if (s.ar < 1.5 * (lb[2] - lb[0]) * (lb[3] - lb[1])) continue;   // a shape too small for its name: none
      const cands = [[s.lx, s.ly, 'center'], [s.lx, s.ly - dy, 'center'], [s.lx, s.ly + dy, 'center']];
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const q of s.pr) for (let j = 0; j < q.length; j += 2) { if (q[j] < x0) x0 = q[j]; if (q[j] > x1) x1 = q[j]; if (q[j + 1] < y0) y0 = q[j + 1]; if (q[j + 1] > y1) y1 = q[j + 1]; }
      const step = Math.max(10 * ts, (lb[2] - lb[0]) / 2), lat = [];
      const tm = ctx.getTransform();   // the point is in device pixels, the path is drawn through the transform
      for (let y = y0; y <= y1; y += step * 0.6) for (let x = x0; x <= x1; x += step) if (ctx.isPointInPath(s.path, tm.a * x + tm.e, tm.d * y + tm.f, 'evenodd')) lat.push([x, y, 'center']);
      lat.sort((p1, p2) => Math.hypot(p1[0] - s.lx, p1[1] - s.ly) - Math.hypot(p2[0] - s.lx, p2[1] - s.ly)); cands.push(...lat.slice(0, 40));
      const ab = place(lines, cands, true, 0, { minN: Math.max(nMed, 1) }); if (ab) { ab.area = true; counts.areas++; } }
    // the places' names: those in the lens first, then the biggest; the size of a name and its weight follow the place's roles; each needs room
    // around it (OPP), keeps clear of every dot (its own excepted) and of crowds of company dots, as the other views' names do
    const cap = Math.round((many ? 120 : zoomed ? 40 : 16) * ks), order = pl.slice().sort((a, b) => (inl(Lg.ents[b]) - inl(Lg.ents[a])) || Lg.ents[b].n - Lg.ents[a].n);
    let named = 0;
    for (const k of order) { if (named >= cap) break; const e = Lg.ents[k], X0 = sx(e.x), Y0 = sy(e.y), r = rOf(e), free = inl(e), hh = 6 * ts, big = Math.sqrt(e.n / Lg.nMax);
      const fs = Math.round(9.5 + 4.5 * big), lines = wrapText(e.name, 20, 1).map((t) => ({ t, fs, face: big > 0.5 ? '700' : big > 0.2 ? '600' : '500', alpha: 0.78 + 0.22 * big, color: T.subInk || ink }));
      const cands = [];   // eight directions at four distances from the dot, the nearest first
      for (const gap of [3, 9, 18, 30]) { const g = r + gap * ts, d = g * 0.72;
        cands.push([X0 + g, Y0, 'left'], [X0 - g, Y0, 'right'], [X0, Y0 - g - hh, 'center'], [X0, Y0 + g + hh, 'center'],
          [X0 + d, Y0 - d - hh * 0.5, 'left'], [X0 - d, Y0 - d - hh * 0.5, 'right'], [X0 + d, Y0 + d + hh * 0.5, 'left'], [X0 - d, Y0 + d + hh * 0.5, 'right']); }
      if (place(lines, cands, free, free ? 0 : OPP, { skip: k, maxDots: big > 0.3 ? 1e9 : 6 })) named++; }
  }
  if (screen) {   // the lens, its sample and the open point's ring
    const r = st.size * BW, lx = sx(st.lens.x), ly = sy(st.lens.y); ctx.globalAlpha = 1; if (lensOn()) { ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.arc(lx, ly, r, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
    ctx.fillStyle = ink; st.sample.forEach((k) => { const e = Lg.ents[k]; if (!e) return; ctx.beginPath(); ctx.arc(sx(e.x), sy(e.y), 4, 0, 7); ctx.fill(); });
    if (sel && sel.ly === Lg && vis[sel.k]) { const e = Lg.ents[sel.k]; ctx.strokeStyle = T.linkInk || ink; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(sx(e.x), sy(e.y), (e.place ? rOf(e) : 3) + 4, 0, 7); ctx.stroke(); } }
  return { shown: pl.length + nCo, counts };
}
// the view's painter: the geography, or the atlas's own (roles, companies)
const paintAny = (ctx, P, o) => (P.geo ? paintGeo(ctx, P, o) : paintMap(ctx, P, o));
// the area panel in the geography: the shape under the lens, and the places and companies in the lens
function renderGeoArea(pool) { const Lg = lay(), s = lensOn() ? geoShapeAt(Lg, sx(st.lens.x), sy(st.lens.y)) : null, pls = pool.filter((k) => Lg.ents[k].place), cos = pool.length - pls.length, n = pls.reduce((t, k) => t + Lg.ents[k].n, 0);
  $('atlas-area').innerHTML = `<span class="atlas-note">${L('This area', 'Dieser Bereich')}</span>`
    + (s ? `<b>${esc(geoNameOf(s))}</b><span class="atlas-note">${s.roles.toLocaleString()} ${L('roles in it', 'Stellen darin')}</span>` : lensOn() ? `<span class="atlas-note">${L('No area under the lens', 'Keine Fläche unter der Lupe')}</span>` : `<b>${L('The map in view', 'Die Karte im Blick')}</b>`)
    + `<span>${pls.length} ${L('places', 'Orte')} · ${n.toLocaleString()} ${L('open roles in them', 'offene Stellen darin')} · ${cos} ${lensOn() ? L('companies in the lens', 'Firmen in der Lupe') : L('companies in view', 'Firmen im Blick')}</span>`; }
// the status line of the geography: what is shown, and the morph and the lens in brief
function geoStatus(res, P) { const Lg = P.Ly, c = res.counts;
  if (!Lg.shapes.length && !Lg.ents.length) return L('There is no geography for this area in the file.', 'Für diesen Bereich gibt es in der Datei keine Geografie.');
  const link = lnk && lnk.to === 'geo' ? L(' The link lights companies only: the data does not place roles in cities.', ' Die Verknüpfung hebt nur Firmen hervor: die Daten ordnen Stellen keinen Städten zu.') : '';
  return L(`${c.places.toLocaleString()} places and ${c.companies.toLocaleString()} companies shown. Places are sized by their open roles (the filters do not change them). Shapes are coloured by roles per area: blue few, amber many, grey none. Drag the bar under the map to morph from the true map to the map by roles, where each area is sized by its roles. Drag the lens to sample an area; zoom with + and − or the mouse wheel.`,
    `${c.places.toLocaleString('de-DE')} Orte und ${c.companies.toLocaleString('de-DE')} Firmen gezeigt. Orte sind nach ihren offenen Stellen groß (die Filter ändern sie nicht). Flächen sind nach Stellen je Fläche gefärbt: blau wenige, bernstein viele, grau keine. Die Leiste unter der Karte zieht von der echten Karte zur Karte nach Stellen, in der jede Fläche nach ihren Stellen groß ist. Die Lupe ziehen, um einen Bereich zu sehen; mit + und − oder dem Mausrad zoomen.`) + link; }
function geoBar() { const el = $('atlas-geo'); if (el) el.hidden = st.mode !== 'geo'; }
function geoStop() { if (geo.raf) cancelAnimationFrame(geo.raf); geo.raf = 0; geo.morph = false; }
function geoSetT(t) { geo.t = Math.max(0, Math.min(1, t)); geoMarks(); draw(); }
function geoMarks() { const sl = $('atlas-morph-t'); if (sl) sl.value = String(geo.t);
  const at = geo.morph ? geo.to : geo.t;   // the stop it is at, or heading to; none while the slider sits between them
  document.querySelectorAll('#atlas-morph button').forEach((b) => { const on = Math.abs(+b.dataset.t - at) < 0.02; if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on)); }); }
// the morph between the stops, eased (1.2 s for the whole way); at once with reduced motion
function geoPlay(to) {   // animate to t = to (0 the true map, 0.5 moderate, 1 full); with no target, to the next stop (off, moderate, full, off …)
  if (to == null) { const at = geo.morph ? geo.to : geo.t, stops = geo.mod ? [0, 0.5, 1] : [0, 1]; to = stops.find((v) => v > at + 0.02) ?? 0; }
  geoStop(); if (noMotion()) { geoSetT(to); return; }
  const a = geo.t, ms = 1200 * Math.max(0.25, Math.abs(to - a)), t0 = performance.now(), step = (now) => { const p = Math.min(1, (now - t0) / ms); if (p >= 1) { geoStop(); geoSetT(to); return; } geo.raf = requestAnimationFrame(step); geoSetT(a + (to - a) * easeIO(p)); };
  geo.morph = true; geo.to = to; geo.raf = requestAnimationFrame(step); }
// the view of the geography: the whole map, the lens on the biggest place
function fitGeo() { const Lg = lay(), big = Lg.ents.filter((e) => e.place).sort((a, b) => b.n - a.n)[0]; st.z = { s: 1, cx: 0.5, cy: 0.5 }; st.lens = big ? { x: big.x, y: big.y } : { x: 0.5, y: 0.5 }; }

function draw() {
  sizeCanvas();
  if (anim && anim.setting) { prepare(THEMES[themeFor()]); return; }   // a change of view is setting the view: its frames come from the bitmaps (see viewChange)
  if (anim && anim.light) { tweenDraw(); return; }
  const T = THEMES[themeFor()], P = prepare(T), ff = Math.min(3, Math.max(1, Math.sqrt(st.z.s))), res = paintAny(g, P, { screen: true, names: 'few', ff, ts: 1, keep: !geo.morph, noLabels: geo.morph }), Ly = P.Ly;
  const unitEn = P.roles ? 'roles' : 'companies', unitDe = P.roles ? 'Stellen' : 'Firmen', showTaste = P.showTaste;
  if (TL) tlShow(); geoBar(); buildHit(Ly); renderBanner(); if (sel && (sel.ly !== Ly || !vis[sel.k] || (Ly.ents[sel.k].hidden && !st.all))) hidePop();
  if (sel) { const e = Ly.ents[sel.k], X = sx(e.x), Y = sy(e.y); if (X < 0 || Y < 0 || X > W || Y > H) hidePop(); else placePop(X, Y); }
  if (P.geo) { if (!geo.morph) $('atlas-status').innerHTML = geoStatus(res, P); return; }
  const fr = P.fresh, legend = P.roles && fr.t + fr.w + fr.m ?`  ✦ ${L('new today', 'neu heute')} ${fr.t} · ${L('this week', 'diese Woche')} ${fr.w} · ${L('this month', 'diesen Monat')} ${fr.m}` : '';
  $('atlas-status').innerHTML = L(`${res.shown.toLocaleString()} ${unitEn} shown${P.roles && Ly.placed ? ` (${Ly.placed} newer roles placed next to their nearest neighbours)` : ''}. Colours are regions of closely linked ${unitEn}; lines join neighbourhoods that share many links. Drag the dashed lens to sample an area, drag elsewhere to move the map, zoom with + and − or the mouse wheel.${showTaste ? '  Brightness shows how well an area fits your profile; with little to go on the contrast is low.' : ''}`,
    `${res.shown.toLocaleString('de-DE')} ${unitDe} gezeigt${P.roles && Ly.placed ? ` (${Ly.placed} neuere Stellen neben ihren nächsten Nachbarn platziert)` : ''}. Farben sind Regionen eng verbundener ${unitDe}; Linien verbinden Nachbarschaften mit vielen gemeinsamen Verbindungen. Die gestrichelte Lupe ziehen, um einen Bereich zu sehen, daneben ziehen, um die Karte zu verschieben, mit + und − oder dem Mausrad zoomen.${showTaste ? '  Die Helligkeit zeigt, wie gut ein Bereich zu Ihrem Profil passt; solange wenig bekannt ist, ist der Kontrast gering.' : ''}`) + legend;
}
// ---- motion. A change of view (fit, zoom, reset, scope, field, mode) is shown as two bitmaps: the frame before and the frame after, each
// drawn once without labels (snapshot). Over 300 ms the new one fades in over the old; over 420 ms the zoom tweens (a frame of the tween
// only draws the two bitmaps under the current transform). At the end the full draw with its labels. Reduced motion: at once. setView
// (the export) never animates.
const MOTION = { view: 420, fade: 300 }, noMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeIO = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
function stopAnim() { geoStop(); if (!anim) return; cancelAnimationFrame(animRaf); if (anim.z1) st.z = { ...anim.z1 }; anim = null; }
// the frame as it is at zoom z: the field and the points (no labels), on a canvas of the stage's pixel size; the state is the current one
function snapshot(z) { const c = document.createElement('canvas'), keep = { ...st.z }; c.width = cv.width; c.height = cv.height; const x = c.getContext('2d');
  st.z = { ...z }; x.setTransform(cv.width / W, 0, 0, cv.height / H, 0, 0);
  try { const T = THEMES[themeFor()], P = prepare(T); paintAny(x, P, { screen: true, names: 'few', ff: Math.min(3, Math.max(1, Math.sqrt(z.s))), ts: 1, noLabels: true }); }
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
    const res = paintAny(ctx, P, { screen: false, names, ff: Math.min(4, scale / 1.5), ts });
    lastRender = { scale, names, theme, mode: st.mode, width: cw, height: ch, mapScale: u, shown: res.shown, ...res.counts };
    return await new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('the image could not be made'))), 'image/png'));
  } finally { [W, H, BW, BH] = keep; }
}
async function saveImage() {
  const btn = $('atlas-save-img'), title = btn.title; btn.disabled = true; btn.title = pick('Rendering…', 'Wird erstellt …');
  try { const blob = await renderImage({ scale: 5 }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = st.mode === 'roles' ? 'atlas-roles.png' : st.mode === 'geo' ? 'atlas-geography.png' : 'atlas-companies.png';
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
  if (mode === 'geo' && !GEO) return geoLoad().then(() => (GEO ? setView({ mode, scope }) : null));
  stopAnim(); lnk = null; st.mode = mode; st.scope = scope; st.open.clear(); st.sample = [];
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
  const A = new Float32Array(GW * GH), B = new Float32Array(GW * GH), N = new Float32Array(GW * GH), C0 = new Float32Array(GW * GH), W0 = new Float32Array(GW * GH), WA = o.wt ? new Float32Array(GW * GH) : null;   // W0: the weighted count; WA: the same for all points (linked pass)
  Ly.ents.forEach((e, k) => { if (!vis[k]) return; const X0 = sx(e.x) / W, Y0 = sy(e.y) / H; if (X0 < 0 || X0 >= 1 || Y0 < 0 || Y0 >= 1) return;
    const q = Math.floor(Y0 * GH) * GW + Math.floor(X0 * GW), wb = Ly.kind === 'companies' ? 0.25 + Math.sqrt(coN[k]) : 1; if (WA) WA[q] += wb;
    const u = o.wt ? o.wt(k) : 1; if (!(u > 0)) return;   // o.wt (the linked pass): an entity's share, its link weight; 0 adds nothing
    const h = hueOf(e) * Math.PI / 180, w = fit && !o.wt ? 0.08 + fit[k] * fit[k] : 1, wt = wb * u;   // a company weighs 0.25 + sqrt(its open roles), a role 1
    A[q] += Math.cos(h) * w * u; B[q] += Math.sin(h) * w * u; N[q] += w * u; C0[q] += u; W0[q] += wt; });
  const raw = Float32Array.from(C0), nz = [...raw].filter((x) => x > 0).sort((a, b) => a - b), typical = nz.length ? nz[Math.floor(nz.length / 2)] : 1;
  if (!o.wt) densAt = (px, py) => { const q = Math.min(GH - 1, Math.max(0, Math.floor(py / H * GH))) * GW + Math.min(GW - 1, Math.max(0, Math.floor(px / W * GW))); return Math.max(1, raw[q] / typical); };
  const passes = Math.max(1, Math.round((4 + Math.min(4, Math.round(Math.log2(st.z.s + 1))) + (o.extra || 0)) * f * f)); for (const X of [A, B, N, C0, W0]) blur(X, GW, GH, passes); if (WA) blur(WA, GW, GH, passes);
  // linked pass: the selection's share of all points, overall (s0) and per cell; a cell shows the link where its share is above s0
  let s0 = 1; if (WA) { let sl = 0, sa = 0; for (let q = 0; q < W0.length; q++) { sl += W0[q]; sa += WA[q]; } s0 = sa > 0 ? sl / sa : 1; }
  // the soft coverage: the weighted density against its 95th percentile (d = 1 is a dense area), coverage = 1 - exp(-2.5 d): dense areas are rich,
  // sparse ones thin, with no flat plateau
  const ramp = Ly.kind === 'companies' ? [2.5, 1.2] : [10, 0.7];   // roles: dense areas saturate, only the sparse edges thin; companies: the steeper ramp
  const dz = [...W0].filter((x) => x > 1e-3).sort((a, b) => a - b); if (!dz.length) return; const q95 = dz[Math.min(dz.length - 1, Math.floor(dz.length * 0.95))] || 1e-3;
  const band = Array.isArray(o.L) ? o.L : [o.L, o.L];
  const small = document.createElement('canvas'); small.width = GW; small.height = GH; const sg = small.getContext('2d'), img = sg.createImageData(GW, GH);
  for (let q = 0; q < N.length; q++) { const n = N[q]; if (n < 1e-4) continue;
    const lift = WA ? (WA[q] > 1e-6 ? W0[q] / WA[q] / s0 : 0) : 2, coverage = (1 - Math.exp(-ramp[0] * W0[q] / q95)) * (WA ? Math.max(0, Math.min(1, (lift - 1) / 1.5)) : 1), match = fit && !o.wt ? Math.min(1, 0.15 + 1.2 * n / Math.max(C0[q], 1e-6)) : 1;
    // where opposite hues cancel out (the mixed direction is short) the cell fades instead of turning grey
    const len = Math.hypot(A[q], B[q]) / n, h = (Math.atan2(B[q], A[q]) * 180 / Math.PI + 360) % 360, c = vivid(h, band[0], band[1], o.C);
    img.data[q * 4] = c[0]; img.data[q * 4 + 1] = c[1]; img.data[q * 4 + 2] = c[2]; img.data[q * 4 + 3] = Math.round(255 * o.strength * coverage ** ramp[1] * match * Math.min(1, 0.35 + len)); }
  sg.putImageData(img, 0, 0); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.globalAlpha = o.alpha ?? 1;
  ctx.globalCompositeOperation = o.additive ? 'lighter' : (o.op || 'source-over'); ctx.drawImage(small, 0, 0, W, H); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  if (!o.additive && !o.wt) lastField = { small, GW, GH, z: { ...st.z } };      // the main layer, which the hot and cold spots brighten
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
// the lens can be switched off (lens size "off"): then the points in view stand in for it (the cards, the area panel, the link)
const lensOn = () => st.size > 0;
function inLens() {
  const Ly = lay(), r = st.size * BW, lx = sx(st.lens.x), ly = sy(st.lens.y), out = [], on = lensOn();
  Ly.ents.forEach((e, k) => { if (!vis[k]) return; const X0 = sx(e.x), Y0 = sy(e.y), dx = X0 - lx, dy = Y0 - ly; if (on ? dx * dx + dy * dy <= r * r : X0 >= 0 && Y0 >= 0 && X0 <= W && Y0 <= H) out.push(k); });
  return out;
}
// what the lens is on: the neighbourhood most of its points belong to, with its words, fields and leanings
function renderArea(pool) {
  if (st.mode === 'geo') return renderGeoArea(pool);
  const Ly = lay(); if (Ly.past && pool.length) return renderPastArea(pool, Ly); if (!pool.length) { $('atlas-area').innerHTML = `<span class="atlas-note">${lensOn() ? L('Move the lens onto the map.', 'Die Lupe auf die Karte ziehen.') : L('Nothing in view.', 'Nichts im Blick.')}</span>`; return; }
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
  if (st.mode === 'geo') return fitGeo();
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
  if (st.mode === 'geo') { const Lg = lay(), pool = inLens(), wOf2 = (e) => (e.place ? e.n : visibleRoles(e).length); st.sample = pool.sort((a, b) => wOf2(Lg.ents[b]) - wOf2(Lg.ents[a])).slice(0, 8); renderArea(pool); renderList(); draw(); return; }
  const Ly = lay(), pool = inLens(), per = new Map(); pool.forEach((k) => { const c = st.mode === 'roles' ? (Ly.past ? '' : rows[Ly.ents[k].idx[0]][2]) : Ly.ents[k].name; per.set(c, (per.get(c) || 0) + 1); });
  // weighted draw without replacement: roles by 1/sqrt(roles of that employer in the lens), at most 2 per employer; companies all alike
  const out = [], taken = new Map(), w = pool.map((k) => (st.mode === 'roles' && !Ly.past ? 1 / Math.sqrt(per.get(rows[Ly.ents[k].idx[0]][2])) : 1));
  for (let n = 0, guard = 0; n < 8 && pool.length && guard < 200; n++, guard++) {
    let tot = 0; w.forEach((x) => { tot += x; }); if (tot <= 0) break; let t = rnd() * tot, q = 0; for (; q < w.length - 1; q++) { t -= w[q]; if (t <= 0) break; }
    const c = st.mode === 'roles' && !Ly.past ? rows[Ly.ents[pool[q]].idx[0]][2] : ''; if (st.mode === 'roles' && !Ly.past && (taken.get(c) || 0) >= 2) { w[q] = 0; n--; continue; } taken.set(c, (taken.get(c) || 0) + 1); out.push(pool[q]); w[q] = 0;
  }
  // linked: the lens's linked points, heaviest first (the list is sorted by weight); else the weighted sample above
  const lw = linkWeights(Ly), wp = lw ? pool.filter((k) => lw[k] > 0).sort((a, b) => lw[b] - lw[a]) : [];
  st.sample = wp.length ? wp.slice(0, 8) : out; renderArea(pool); renderList(); draw();
}
// ---- the link between the two views. The selection is what the lens holds (the visible points), or the point whose card is open.
// Roles -> companies: a company's n = the selected roles it has, N = its visible open roles, w = sqrt(n * n / N) (big hirers and
// specialists both show). Companies -> roles: every visible role of a company in the selection gets 1 / sqrt(N), so one big employer
// does not flood the view. The weights are kept by identity (a role's row, a company's slug), so moving the lens in the target view
// does not change them; a filter change rebuilds them (linkBuild). No open roles at all: the companies nearest by profile light up.
const coName = (c) => shortName(coBy.has(c) ? coBy.get(c).name : c);
const selNow = () => { const Ly = lay(); return sel && sel.ly === Ly && vis[sel.k] ? { keys: [sel.k], picked: true } : { keys: inLens(), picked: false }; };
const linkOn = () => !!$('atlas-linked') && $('atlas-linked').checked;
// the companies nearest to the selected ones (cosine of their profile vectors; the selection's own companies left out), the top 12 weighted
function simBuild(o) { const cen = new Float32Array(D), srcs = new Set(o.src); let m = 0;
  for (const c of o.src) { const e = coBy.get(c); if (e && e.vec) { m++; for (let d = 0; d < D; d++) cen[d] += e.vec[d]; } }
  o.n = o.src.length; if (!m) return o;
  const v = unit(cen), sc = []; for (const e of coEnts) { if (srcs.has(e.slug)) continue; let s = 0; for (let d = 0; d < D; d++) s += v[d] * e.vec[d]; if (s > 0) sc.push([s, e]); }
  sc.sort((a, b) => b[0] - a[0]); const top = sc.slice(0, 12); if (!top.length) return o; const mx = top[0][0];
  for (const [s, e] of top) o.wCo.set(e.slug, s / mx); o.top = top.map(([s, e]) => [coName(e.slug), 0, 0, s / mx]); return o; }
// the weights of a link (o: {from, src, picked, sim, to}; src: the selected roles' rows or companies' slugs), with the current filters
function linkBuild(o) { o.wCo = new Map(); o.wRole = new Map(); o.info = new Map(); o.top = []; o.maxShare = 0;
  if (o.sim) simBuild(o);
  else if (o.from === 'roles') { const rs = o.src.filter(roleVisible), n = new Map(); o.n = rs.length;
    for (const i of rs) { const c = rows[i][4]; if (coBy.has(c)) n.set(c, (n.get(c) || 0) + 1); }
    let mx = 0; for (const [c, nc] of n) { const N = visibleRoles(coBy.get(c)).length; if (!N) continue; const w = Math.sqrt(nc * nc / N); o.info.set(c, { n: nc, N, w }); mx = Math.max(mx, w); }
    for (const [c, v] of o.info) o.wCo.set(c, v.w / mx);
    o.top = [...o.info].sort((a, b) => b[1].w - a[1].w).map(([c, v]) => [coName(c), v.n, v.N, v.w / mx]); }
  else if (o.to === 'geo') { o.src.forEach((c) => { if (coBy.has(c)) o.wCo.set(c, 1); }); o.n = o.wCo.size; o.top = [...o.wCo.keys()].map((c) => [coName(c), 0, 0, 1]); }   // companies to the map: the selected ones light up
  else { const cs = o.src.filter((c) => coBy.has(c)).map((c) => [c, visibleRoles(coBy.get(c))]).filter((x) => x[1].length); o.n = cs.length;
    let mx = 0, tot = 0; for (const [, vr] of cs) { mx = Math.max(mx, 1 / Math.sqrt(vr.length)); tot += Math.sqrt(vr.length); }
    for (const [, vr] of cs) for (const i of vr) o.wRole.set(i, (1 / Math.sqrt(vr.length)) / mx);
    if (cs.length) o.maxShare = Math.max(...cs.map((x) => Math.sqrt(x[1].length))) / tot;
    o.top = cs.sort((a, b) => b[1].length - a[1].length).map(([c, vr]) => [coName(c), vr.length, vr.length, (1 / Math.sqrt(vr.length)) / mx]); }
  const ws = [...o.wCo.values(), ...o.wRole.values()].filter((w) => w > 0); o.lit = ws.length; o.empty = !ws.length; return o; }
// the link from the selection (src: keys of the current view's points) to the other view. No company of the selection has open roles:
// the same view, the companies nearest to them light up
function linkNew(from, to, src) { const Ly = lay(); if (Ly.past || !src.keys.length) return null;
  const f = from === 'geo' ? 'companies' : from;   // a point of the geography: a company's link as companies (a place has none, so it is left out)
  const o = { from: f, to, picked: src.picked, src: src.keys.map((k) => (from === 'roles' ? Ly.ents[k].idx[0] : Ly.ents[k].slug)).filter((x) => x != null) };
  if (f === 'companies' && to === 'roles' && !o.src.some((c) => coBy.has(c) && visibleRoles(coBy.get(c)).length)) { o.to = 'companies'; o.sim = true; }
  return linkBuild(o); }
// the weight of each visible point of the target view (0: dimmed); null when no link applies here
function linkWeights(Ly) { if (!lnk || lnk.empty || Ly.past || lnk.to !== st.mode) return null; const lw = new Float32Array(Ly.n), roles = st.mode === 'roles';
  Ly.ents.forEach((e, k) => { if (!vis[k]) return; if (e.place) { lw[k] = -1; return; } const w = roles ? lnk.wRole.get(e.idx[0]) : lnk.wCo.get(e.slug); lw[k] = w || 0; }); return lw; }
// the view on the linked points: the 2nd to 98th percentile by weight (6 % padding as fitTo), the lens on the linked point nearest their centre
function fitLinked() { if (st.mode === 'geo') return fitGeo(); const P = prepare(THEMES[themeFor()]), Ly = P.Ly, lw = P.lw; if (!lw) return fitOrWhole();
  const pts = []; Ly.ents.forEach((e, k) => { if (lw[k] > 0) pts.push([e.x, e.y, lw[k]]); }); if (!pts.length) return fitOrWhole();
  const wp = (j, p) => { const a = pts.map((q) => [q[j], q[2]]).sort((u, v) => u[0] - v[0]), tot = a.reduce((t, q) => t + q[1], 0); let c = 0; for (const [v, w] of a) { c += w; if (c >= p * tot) return v; } return a[a.length - 1][0]; };
  const x0 = wp(0, 0.02), x1 = wp(0, 0.98), y0 = wp(1, 0.02), y1 = wp(1, 0.98), bw = (x1 - x0) * 1.12, bh = (y1 - y0) * 1.12;
  let s = Math.min(24, bw > 0 ? 1 / bw : 24, bh > 0 ? 1 / bh : 24); if (pts.length < 5) s = Math.min(s, 6);
  st.z = { s: Math.max(1, s), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  const tw = pts.reduce((t, q) => t + q[2], 0), mx = pts.reduce((t, q) => t + q[0] * q[2], 0) / tw, my = pts.reduce((t, q) => t + q[1] * q[2], 0) / tw;
  let best = pts[0], bd = Infinity; for (const q of pts) { const d = (q[0] - mx) ** 2 + (q[1] - my) ** 2; if (d < bd) { bd = d; best = q; } }
  st.lens = { x: best[0], y: best[1] }; }
// switch the view. With Linked on (or a card's button, its point being the selection) the selection carries over as the link, and the
// new view is fitted to the linked points; otherwise the view switches as before. The link is built before the switch, from the old view.
function goView(to, keys = null, picked = false) {
  if (to === 'geo' && !GEO) { $('atlas-status').textContent = pick('Loading the map…', 'Lade die Karte …'); geoLoad().then(() => { if (GEO) goView(to, keys, picked); else $('atlas-status').textContent = pick('The map could not be loaded.', 'Die Karte konnte nicht geladen werden.'); }); return; }
  const from = st.mode, sp = keys ? { keys, picked } : (to !== from && linkOn() ? selNow() : null), next = sp ? linkNew(from, to, sp) : null, mode = next ? next.to : to;
  viewChange(() => { lnk = next; st.mode = mode; mount.querySelectorAll('#atlas-mode button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.m === mode)));
    updateModeHeader(); st.open.clear(); st.sample = []; if (lnk) fitLinked(); else fitOrWhole(); resample(); }); }
// a card's button: its point is the selection, and the view switches to the other one
function linkFromCard() { const Ly = lay(); if (!sel || sel.ly !== Ly || !vis[sel.k] || Ly.past) return; goView(st.mode === 'roles' ? 'companies' : 'roles', [sel.k], true); }
// a company's open roles in the link (roles -> companies only): n of N, for the cards
const linkInfo = (e) => (lnk && lnk.info && lnk.to === 'companies' && st.mode === 'companies' ? lnk.info.get(e.slug) || null : null);
const linkRoleTag = (i) => (lnk && !lnk.empty && lnk.to === 'roles' && st.mode === 'roles' && lnk.wRole.get(i) > 0 ? ` · ${L('from an employer in the selection', 'von einem Arbeitgeber der Auswahl')}` : '');
// the banner's text: what the link is, and the heaviest three of it
// (L() gives markup for the two languages: the names are escaped here, the rest is as L() gives it)
function linkText(o) {
  if (o.empty) return L('Nothing in the selection to link', 'Im Ausschnitt ist nichts zu verknüpfen');
  const top = o.top.slice(0, 3).map(([c, n, N]) => esc(c) + (o.from === 'roles' && !o.sim ? ` ${n} ${L('of', 'von')} ${N}` : o.from === 'companies' && !o.sim && o.to !== 'geo' ? ` ${N}` : '')).join(' · ') + (o.top.length > 3 ? ' …' : '');
  let head;
  if (o.sim) { const nm = o.picked ? esc(coName(o.src[0])) : '';
    head = o.picked ? L(`No open roles at ${nm} — showing similar companies`, `Keine offenen Stellen bei ${nm} — ähnliche Firmen`) : L(`None of the ${o.n} companies in your lens has open roles — showing similar companies`, `Keine der ${o.n} Firmen in Ihrer Lupe hat offene Stellen — ähnliche Firmen`); }
  else if (o.from === 'roles') head = o.picked ? L('Companies hiring for this role', 'Firmen, die diese Stelle besetzen') : L(`Companies hiring for the ${o.n} roles in your lens`, `Firmen mit den ${o.n} Stellen in Ihrer Lupe`);
  else if (o.to === 'geo') head = o.picked ? L('Where this company is', 'Wo diese Firma ist') : L(`Where the ${o.n} companies in your lens are`, `Wo die ${o.n} Firmen in Ihrer Lupe sind`);
  else head = o.picked ? L('Roles at this company', 'Stellen dieser Firma') : L(`Roles at the ${o.n} companies in your lens`, `Stellen bei den ${o.n} Firmen in Ihrer Lupe`);
  return [head, top].filter(Boolean).join(' · '); }
function renderBanner() { const on = !!lnk && lnk.to === st.mode && !lay().past; banner.hidden = !on; if (!on) return;
  const t = esc(pick('Clear the link', 'Verknüpfung lösen')); banner.innerHTML = `<span>${linkText(lnk)}</span><button type="button" class="atlas-banner-x" aria-label="${t}" title="${t}">×</button>`; }

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
  if (e.place) return placeCardHtml(k, e);
  if (st.mode === 'roles') { const i = e.idx[0], r = rows[i], reg = ix.regions[ix.attrs[i][3]] || '';
    return `<li class="atlas-item${open ? ' open' : ''}" data-k="${k}" data-id="${e.id}"><button type="button" class="hd" aria-expanded="${open}">${esc(r[1])}${newBadge(i)}</button><div class="m">${esc(r[2])}${reg ? ' · ' + esc(reg) : ''}${ix.attrs[i][1] ? ' · ' + esc(levelName(ix.attrs[i][1])) : ''}${linkRoleTag(i)}</div><div class="snip"></div><div class="more"></div>${voteHtml(e.id)}</li>`; }
  const co = coRows[e.slug] || [e.about || ''];
  const desc = (isDe() && co[1]) ? co[1] : (co[0] || co[2] || e.about || '');
  const archName = (isDe() && co[4]) ? co[4] : (co[3] || '');
  const archCol = co[5] || '#64748b';
  const loc = co[6] || '';
  const carUrl = co[7] || '';
  const webUrl = co[8] || '';
  const tags = co[9] || [];
  const tracked = !!co[11];
  const vr = visibleRoles(e), lk = linkInfo(e);
  const flds = ix.fields.map((f, q) => [f, e.f[q]]).filter((x) => x[1] >= 0.25).sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => fieldLabel(x[0]));
  const facts = [loc && `📍 ${loc}`, archName && `🏛 ${archName}`, tracked && `✓ ${pick('Tracked ATS', 'Überwachtes Portal')}`, ...tags.slice(0, 3).map((t) => `#${t}`)].filter(Boolean);

  return `<li class="atlas-item${open ? ' open' : ''}" data-k="${k}" data-id="${e.id}">`
    + `<button type="button" class="hd" aria-expanded="${open}"><img class="co-logo" src="assets/company/${esc(e.slug)}.png" alt="" loading="lazy" onerror="this.remove()">${esc(e.name)}${archName ? ` <span class="atlas-tag-tier" style="background:${archCol}">${esc(archName)}</span>` : ''}${tracked ? ` <span class="atlas-badge-tracked">● ${L('Tracked', 'Überwacht')}</span>` : ''}</button>`
    + `<div class="m">${loc ? esc(loc) + ' · ' : ''}${lk ? `<span class="co-has-roles">${lk.n} ${L('of', 'von')} ${lk.N} ${L('roles in the selection', 'Stellen in der Auswahl')}</span>` : vr.length ? `<span class="co-has-roles">${vr.length} ${L('open roles', 'offene Stellen')}</span>` : `<span class="co-no-roles">${L('No current vacancies', 'Keine aktuellen Vakanzen')}</span>`}${flds.length ? ' · ' + esc(flds.join(', ')) : (e.field ? ' · ' + esc(e.field) : '')}</div>`
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
  cv.style.cursor = k >= 0 ? 'pointer' : lensOn() && Math.hypot(px - sx(st.lens.x), py - sy(st.lens.y)) <= st.size * BW + 8 ? 'move' : 'grab'; if (cv.title !== t) cv.title = t; }
// the card of the selected point (on the stage, so it also works in full screen): a role with its title as a link, company, region,
// level, age and the marks; or a company with its name, about text and open roles
const pop = document.createElement('div'); pop.className = 'atlas-pop'; pop.hidden = true; stage.appendChild(pop);
const banner = document.createElement('div'); banner.className = 'atlas-banner'; banner.hidden = true; stage.appendChild(banner);   // the link's banner (renderBanner)
const ageText = (i) => { const a = AGE[i]; return !isFinite(a) ? '' : a < 1 ? pick('new today', 'neu heute') : a < 7 ? pick('new this week', 'neu diese Woche') : a < 30 ? pick('new this month', 'neu diesen Monat') : pick(`${Math.round(a)} days ago`, `vor ${Math.round(a)} Tagen`); };
function popHtml(k) { const e = lay().ents[k], close = `<button type="button" class="atlas-pop-x" aria-label="${esc(pick('Close', 'Schließen'))}">×</button>`;
  if (e.past) return close + `<div class="t tl-t">…</div><div class="m tl-c"></div><div class="m">${esc(tlDates(e))}</div>`;
  if (e.place) { const cs = placeCos(k); return close + `<div class="t">${esc(e.name)}</div><div class="m">${e.n.toLocaleString()} ${L('open roles here', 'offene Stellen hier')}</div>` + (cs.length ? `<div class="m" style="margin-top:4px;">${esc(cs.slice(0, 8).map((c) => shortName(c.name)).join(' · '))}${cs.length > 8 ? ' …' : ''}</div>` : ''); }
  if (st.mode === 'roles') { const i = e.idx[0], r = rows[i], reg = ix.regions[ix.attrs[i][3]] || '', age = ageText(i);
    return close + `<a class="t link" href="${roleLink(e.id)}">${esc(r[1])}</a><div class="m">${esc(r[2])}${reg ? ' · ' + esc(reg) : ''}${ix.attrs[i][1] ? ' · ' + esc(levelName(ix.attrs[i][1])) : ''}</div>${age ? `<div class="m">${esc(age)}</div>` : ''}<button type="button" class="atlas-pop-go">${L('Show the company', 'Firma zeigen')}</button>${voteHtml(e.id)}`; }
  const co = coRows[e.slug] || [e.about || ''];
  const desc = (isDe() && co[1]) ? co[1] : (co[0] || co[2] || e.about || '');
  const archName = (isDe() && co[4]) ? co[4] : (co[3] || '');
  const archCol = co[5] || 'var(--accent-text)';
  const loc = co[6] || '';
  const carUrl = co[7] || '';
  const webUrl = co[8] || '';
  const vr = visibleRoles(e), lk = linkInfo(e);
  const link = companyLink(e.slug);
  return close
    + (link ? `<a class="t link" href="${link}">${esc(e.name)}</a>` : `<div class="t">${esc(e.name)}</div>`)
    + (archName || loc ? `<div class="m" style="margin-top:2px;">${archName ? `<span style="color:${archCol};font-weight:600;">${esc(archName)}</span>` : ''}${loc ? (archName ? ' · ' : '') + esc(loc) : ''}</div>` : '')
    + `<div class="m">${lk ? `<span class="co-has-roles">${lk.n} ${L('of', 'von')} ${lk.N} ${L('roles in the selection', 'Stellen in der Auswahl')}</span>` : e.idx.length ? `<span class="co-has-roles">${vr.length} ${L('open roles here', 'offene Stellen hier')}</span>` : `<span class="co-no-roles">${L('No open roles on the board right now', 'Derzeit keine offenen Stellen auf der Börse')}</span>`}</div>`
    + (desc ? `<div class="m" style="margin-top:4px;">${esc(snip(desc, 150))}</div>` : '')
    + `<div class="links" style="margin-top:6px;display:flex;gap:12px;font-size:12.5px;">${link ? `<a class="link" href="${link}">${L('Company page →', 'Firmenseite →')}</a>` : ''}${carUrl ? `<a class="link" href="${esc(carUrl)}" target="_blank" rel="noopener">${L('Careers ↗', 'Karriere ↗')}</a>` : (webUrl ? `<a class="link" href="${esc(webUrl)}" target="_blank" rel="noopener">${L('Website ↗', 'Webseite ↗')}</a>` : '')}</div>`
    + `<button type="button" class="atlas-pop-go">${L('Show its roles', 'Ihre Stellen zeigen')}</button>` + voteHtml(e.id); }
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
  drag = lensOn() && Math.hypot(dx, dy) <= st.size * BW + 8 ? { kind: 'lens', px, py, moved: 0 } : { kind: 'pan', px, py, cx: st.z.cx, cy: st.z.cy, moved: 0 }; });
cv.addEventListener('pointermove', (e) => { if (!touches.has(e.pointerId)) { if (e.pointerType === 'mouse' && !e.buttons) hover(e); return; } touches.set(e.pointerId, ptr(e));
  if (pinch && touches.size === 2) { const [a1, b1] = [...touches.values()], d = Math.hypot(a1[0] - b1[0], a1[1] - b1[1]); zoomTo(pinch.s * d / Math.max(pinch.d, 1), (a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2, false); return; }
  if (!drag) return; const [px, py] = ptr(e); drag.moved = Math.max(drag.moved, Math.hypot(px - drag.px, py - drag.py));
  if (drag.kind === 'lens') { st.lens.x = ux(px); st.lens.y = uy(py); } else { st.z.cx = drag.cx - (px - drag.px) / BW / st.z.s; st.z.cy = drag.cy - (py - drag.py) / BH / st.z.s; }
  draw(); });
const endPtr = (e) => { touches.delete(e.pointerId); if (pinch) { if (touches.size < 2) { pinch = null; resample(); } return; }
  if (!drag) return; const [px, py] = ptr(e), tap = drag.moved < 5, k = tap ? hitAt(px, py) : -1, kind = drag.kind; drag = null;
  if (k >= 0) { showPop(k); draw(); return; }   // a tap on a point opens its card; the lens stays where it is
  if (tap) hidePop();
  const moved = kind === 'lens' || (tap && lensOn()); if (kind === 'pan' && tap && lensOn()) { st.lens.x = ux(px); st.lens.y = uy(py); }
  if (moved) PF.bumpExplored(); resample(); if (moved) { computeTaste(); renderPersonas(); draw(); } };
cv.addEventListener('pointerup', endPtr); cv.addEventListener('pointercancel', endPtr);
function zoomTo(s1, px, py, then = true) { const x0 = ux(px), y0 = uy(py); st.z.s = Math.max(1, Math.min(24, s1)); if (st.z.s === 1) { st.z.cx = 0.5; st.z.cy = 0.5; } else { st.z.cx = x0 - (px - W / 2) / (st.z.s * BW); st.z.cy = y0 - (py - H / 2) / (st.z.s * BH); } if (then) resample(); else draw(); }
function zoom(f, px = W / 2, py = H / 2) { zoomTo(st.z.s * f, px, py); }
cv.addEventListener('mousedown', (e) => { if (e.detail > 1) e.preventDefault(); });      // a double click zooms; it should not select page text
cv.addEventListener('dblclick', (e) => { e.preventDefault(); const [px, py] = ptr(e); zoom(2, px, py); });
cv.addEventListener('wheel', (e) => { e.preventDefault(); const [px, py] = ptr(e); zoom(e.deltaY < 0 ? 1.25 : 0.8, px, py); }, { passive: false });
const zAt = () => (lensOn() ? [sx(st.lens.x), sy(st.lens.y)] : [W / 2, H / 2]);   // the buttons zoom about the lens, or the middle without it
$('atlas-zin').addEventListener('click', () => viewChange(() => zoom(1.5, ...zAt())));
$('atlas-zout').addEventListener('click', () => viewChange(() => zoom(1 / 1.5, ...zAt())));
$('atlas-zreset').addEventListener('click', () => viewChange(() => { fitOrWhole(); resample(); }));
function updateModeHeader() {
  const eyebrow = document.querySelector('.section.atlas .eyebrow');
  const h2 = document.querySelector('.section.atlas h2');
  const intro = document.querySelector('.section.atlas .intro');
  if (st.mode === 'companies') {
    if (eyebrow) eyebrow.textContent = pick('ATLAS · COMPANIES BY DOMAIN & CAPABILITIES', 'ATLAS · FIRMEN NACH FACHGEBIET & KOMPETENZEN');
    if (h2) h2.textContent = pick('The company atlas', 'Der Firmen-Atlas');
    if (intro) intro.textContent = pick(
      'Every employer in the Bavarian aerospace and deep-tech ecosystem is a point. Companies with similar engineering capabilities, subsystems, and focus areas sit together. Move the lens over an area, inspect company profiles, and explore the ecosystem.',
      'Jeder Arbeitgeber im bayerischen Luft- und Raumfahrt- sowie Deep-Tech-Ökosystem ist ein Punkt. Firmen mit ähnlichen technischen Fähigkeiten, Subsystemen und Schwerpunkten liegen beieinander. Verschieben Sie die Lupe, sehen Sie Firmenprofile und entdecken Sie Akteure im Ökosystem.'
    );
  } else if (st.mode === 'geo') {
    if (eyebrow) eyebrow.textContent = pick('ATLAS · GEOGRAPHY OF ROLES', 'ATLAS · GEOGRAFIE DER STELLEN');
    if (h2) h2.textContent = pick('The geography of roles', 'Die Geografie der Stellen');
    if (intro) intro.textContent = pick(
      'Every place with open roles is a point, sized by its roles. Shapes are countries and states, coloured by roles per area. Slide between the true map and the map by roles, where each area is sized by its roles. Companies are small dots. Everything runs in your browser.',
      'Jeder Ort mit offenen Stellen ist ein Punkt, nach seinen Stellen groß. Flächen sind Länder und Bundesländer, nach Stellen je Fläche gefärbt. Schieben Sie zwischen der echten Karte und der Karte nach Stellen, in der jede Fläche nach ihren Stellen groß ist. Firmen sind kleine Punkte. Alles läuft in Ihrem Browser.'
    );
  } else {
    if (eyebrow) eyebrow.textContent = pick('ATLAS · ROLES BY MEANING', 'ATLAS · STELLEN NACH BEDEUTUNG');
    if (h2) h2.textContent = pick('The role atlas', 'Der Stellen-Atlas');
    if (intro) intro.textContent = pick(
      'Every open role is a point. Roles with similar work are linked, and that network is relaxed onto the plane, the way maps of science are drawn: regions are groups of closely linked roles, named by what they have in common. Move the lens, see a sample and mark what you like; it feeds Match me. Everything runs in your browser.',
      'Jede offene Stelle ist ein Punkt. Stellen mit ähnlicher Arbeit sind miteinander verbunden, und dieses Netz wird auf die Fläche entspannt, so wie Karten der Wissenschaften gezeichnet werden: Regionen sind Gruppen eng verbundener Stellen, benannt nach dem, was sie gemeinsam haben. Verschieben Sie die Lupe, sehen Sie eine Stichprobe und markieren Sie, was Ihnen gefällt; das fließt in „Passende Stellen für mich“ ein. Alles läuft in Ihrem Browser.'
    );
  }
}
mount.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'atlas-save-img') { saveImage().catch((err) => { $('atlas-status').textContent = err.message || String(err); }); }
  else if (b.id === 'atlas-fs') toggleFs();
  else if (b.closest('#atlas-mode')) goView(b.dataset.m);
  else if (b.closest('#atlas-fields')) viewChange(() => { const f = b.dataset.f; if (st.fields.has(f)) st.fields.delete(f); else st.fields.add(f); b.setAttribute('aria-pressed', String(st.fields.has(f))); fieldSum(); if (lnk) { linkBuild(lnk); fitLinked(); } else if (!perScope) fitTo(); resample(); });
  else if (b.id === 'atlas-shuffle') resample();
  else if (b.id === 'atlas-play') tlPlay();
  else if (b.closest('#atlas-morph')) geoPlay(+b.dataset.t);
  else if (b.classList.contains('hd')) { const li = b.closest('li'), id = li.dataset.id, on = li.classList.toggle('open'); b.setAttribute('aria-expanded', String(on)); if (on) st.open.add(id); else st.open.delete(id); fillRole(li); }
  else if (b.classList.contains('atlas-pop-x')) { hidePop(); draw(); }
  else if (b.classList.contains('atlas-pop-go')) linkFromCard();
  else if (b.classList.contains('atlas-banner-x')) { lnk = null; resample(); }
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
  if (e.target.id === 'atlas-linked') { if (!e.target.checked) { lnk = null; resample(); } return; }   // on: the next switch of view carries the selection
  if (e.target.id === 'atlas-all') { st.all = e.target.checked; draw(); return; }
  if (e.target.id === 'atlas-cv-on') { cvEmb.on = e.target.checked; setJ(K.cv, cvEmb); computeTaste(); draw(); }
  if (e.target.id === 'atlas-taste' || e.target.id === 'atlas-heat') draw();
});
$('atlas-scope').addEventListener('change', (e) => viewChange(() => { st.scope = +e.target.value; const before = layers.roles; layers.roles = roleMapFor(st.scope); if (lnk) linkBuild(lnk);
  if (perScope) { if (layers.roles !== before && st.mode === 'roles') { st.sample = []; st.z = { s: 1, cx: 0.5, cy: 0.5 }; } }
  else if (lnk) fitLinked(); else fitTo();
  resample(); }));
const lensHead = () => { $('atlas-in').textContent = lensOn() ? pick('In the lens', 'In der Lupe') : pick('In view', 'Im Blick'); };
$('atlas-size').addEventListener('change', (e) => { st.size = +e.target.value; lensHead(); resample(); });
if (cfg.geomap) { const sl = $('atlas-morph-t'); sl.addEventListener('input', (e) => { geoStop(); geoSetT(+e.target.value); }); sl.addEventListener('pointerdown', () => geoStop()); }
if (TL) { $('atlas-time').addEventListener('input', (e) => { tlStop(); setScrub(+e.target.value); }); ['pointerdown', 'keydown'].forEach((ev) => $('atlas-time').addEventListener(ev, () => tlStop())); }
window.addEventListener('storage', () => { ratings = loadRatings(); prefVals = getJ(K.prefs, {}); cvEmb = getJ(K.cv, null); renderPersonas(); renderPrefs(); renderCv(); computeTaste(); draw(); });
fitOrWhole();
resample();
// for scripts (scripts/export_atlas.mjs): the image export and the view switch
window.jobcrawlAtlas = { renderImage, setView, geo: { t: () => geo.t, set: (t) => { geoStop(); geoSetT(t); }, play: (to) => geoPlay(to), loaded: () => !!GEO }, link: () => (lnk ? { from: lnk.from, to: lnk.to, n: lnk.n, lit: lnk.lit, maxShare: lnk.maxShare, sim: !!lnk.sim, picked: !!lnk.picked, empty: lnk.empty, top: lnk.top } : null), lastRender: () => lastRender, view: () => ({ W, H, BW, BH, z: { ...st.z } }),
  lens: () => ({ x: st.lens.x, y: st.lens.y, size: st.size }), inLens: () => inLens(), pointAt: (k) => { const e = lay().ents[k]; return e ? [sx(e.x), sy(e.y)] : null; },
  timeline: () => (TL ? { steps: TL.steps.length, kind: TL.kind, idx: scrub.idx, tm: scrub.tm, end: TL.end, records: TLN } : null), scrubTo: (i) => { tlStop(); setScrub(i); }, play: () => tlPlay(), heatMean: (c) => heatMeanOf(c), heatOn: (on) => { $('atlas-heat').checked = !!on; draw(); }, layer: () => { const Ly = lay(); return { n: Ly.ents.length, embers: Ly.ents.filter((e) => e.ember).length }; }, heatCells: () => { if (!lastHeat) return null; let mx = 0, big = 0, pos = 0, neg = 0; for (const v of lastHeat.sc) { const m = Math.abs(v); if (m > mx) mx = m; if (m >= 0.05) { big++; if (v > 0) pos++; else neg++; } } return { cells: lastHeat.sc.length, max: +mx.toFixed(3), warm: pos, cool: neg }; } };
