// "Match me" panel: ranks the open roles against pasted text or rated roles, in the visitor's browser.
// Upgraded with:
// - Always-Visible Background -> Target Activity Bar with 3-way Career Step control ([Same level] [↗ Step up / Lead] [⇄ Pivot field])
// - 1-Click Quick Reason Pills on ▼ Vote ([Wrong field/work] [Good work, too junior ↗] [Too senior ↘] [Wrong company] [Wrong location])
// - Two-Facet Match Chips (Background + Target Match, Level Stepped Up ↗)
// Mounted by match.html into #match-panel.

import { loadConfig, dataUrl, pageUrl, roleLink, companyLink, defaultScope, modelCache, L, LP, esc, isDe } from './app.js';
import { loadIndex, rank, rankByTaste, tasteWeight, sampleSpread, matchAny, matchFields, chunkCvText, decomposeRating, queryVec } from './match.js';
import * as PF from './profile.js';

const cfg = await loadConfig();
PF.setPersonas(cfg.personas);
const K = PF.keys();
const mount = document.getElementById('match-panel');
if (!mount) throw new Error('no #match-panel');

const LEVEL_CODES = [''].concat(cfg.levels.slice().sort((a, b) => a.rank - b.rank).map((b) => b.code));
const levelNames = (k, ix) => { const code = (ix || st.ix) ? (ix || st.ix).levels[k] : LEVEL_CODES[k]; const b = cfg.levels.find((x) => x.code === code); return b ? [b.label.en, b.label.de] : ['', '']; };
const fieldNames = (id) => { const f = cfg.fields.find((x) => x.id === id); return f ? [f.label.en, f.label.de] : [id, id]; };
const levelOpt = (k) => { const b = cfg.levels.find((x) => x.code === LEVEL_CODES[k]); return `<option value="${k}">${b ? L(b.label.en, b.label.de) : esc(LEVEL_CODES[k])}</option>`; };
const levelOpts = LEVEL_CODES.slice(1).map((_, k) => levelOpt(k + 1)).join('');
const ROLE_LINK = cfg.role_url ? L('Full role page →', 'Ganze Stellenseite →') : L('Details in the job list →', 'Details in der Stellenliste →');
const scopeOpts = cfg.scopes.map((s, k) => `<option value="${k}"${k === defaultScope() ? ' selected' : ''}>${L(s.label.en, s.label.de)}</option>`).join('');

const style = document.createElement('style');
style.textContent = `
.match-panel{border:1px solid var(--line);border-radius:10px;background:var(--panel);margin:0 0 18px}
.match-panel>summary,.match-head{cursor:pointer;list-style:none;padding:14px 18px;display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
.match-panel>summary::-webkit-details-marker{display:none}
.match-head strong{font-size:16px}
.match-body{padding:0 18px 18px;display:flex;flex-direction:column;gap:12px}
.match-body textarea{width:100%;min-height:140px;max-height:60vh;resize:vertical;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font:inherit;font-size:14px;line-height:1.45}
.match-row{display:flex;gap:10px 16px;flex-wrap:wrap;align-items:flex-end}
.match-row label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
.match-row input[type=text]{padding:7px 8px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font:inherit;font-size:14px;min-width:12em}.match-row select{padding:7px 8px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font:inherit;font-size:14px}
.match-status{font-size:13px;color:var(--muted);min-height:1.4em}
.match-bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden;margin-top:6px}.match-bar>i{display:block;height:100%;width:0;background:var(--accent)}
.match-results{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.match-r{display:grid;grid-template-columns:2.2em 1fr auto;gap:2px 10px;align-items:start;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--paper)}
.match-r .n{grid-row:1/3;color:var(--muted);font-variant-numeric:tabular-nums;padding-top:2px}
.match-r a.t{font-weight:600;color:var(--ink);text-decoration:none;min-width:0;overflow-wrap:anywhere}.match-r a.t:hover{color:var(--accent-text);text-decoration:underline}
.match-r .m{font-size:13px;color:var(--muted);grid-column:2}
.match-r .w{grid-column:2/4;display:flex;gap:5px;flex-wrap:wrap}
.match-chip{font-size:11.5px;padding:1px 7px;border:1px solid var(--line);border-radius:10px;color:var(--muted)}
.match-chip.mean{border-color:var(--accent-text);color:var(--accent-text)}
.match-chip.conv{border-color:#10b981;color:#059669;font-weight:600}
.match-chip.stepup{border-color:#6366f1;color:#4f46e5;font-weight:600}
.match-r{cursor:default}
.match-r .hd{all:unset;cursor:pointer;display:block;min-width:0;font-weight:600;overflow-wrap:anywhere}.match-r .hd:hover{color:var(--accent-text)}.match-r .hd:focus-visible{outline:2px solid var(--accent)}
.match-r .hd::after{content:"▾";margin-left:8px;color:var(--muted);font-weight:400}.match-r.open .hd::after{content:"▴"}
.match-r .sum{font-size:12.5px;color:var(--accent-text);white-space:nowrap}
.match-d{grid-column:1/-1;display:none;flex-direction:column;gap:12px;padding-top:10px;border-top:1px solid var(--line);margin-top:6px}
.match-r.open .match-d{display:flex}
.match-d .facts{display:flex;gap:6px 14px;flex-wrap:wrap;font-size:13px;color:var(--muted)}
.match-d .txt{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.5;max-height:26em;overflow:auto;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}
.match-d .links{display:flex;gap:14px;flex-wrap:wrap;font-size:14px}
.asp{display:grid;grid-template-columns:minmax(7em,max-content) 1fr;gap:6px 14px;align-items:center}
.asp>span.k{font-size:13px;color:var(--ink)}.asp small{color:var(--muted);display:block;font-size:11.5px}
.stars{display:inline-flex}.stars button{all:unset;cursor:pointer;font-size:20px;line-height:1;padding:3px 2px;color:var(--line)}.stars button.on{color:var(--accent-text)}.stars button:focus-visible{outline:2px solid var(--accent)}
.lvl{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden;flex-wrap:wrap}.lvl button{all:unset;cursor:pointer;font-size:12.5px;padding:5px 9px;border-right:1px solid var(--line);color:var(--muted)}.lvl button:last-child{border-right:0}.lvl button.on{background:var(--accent);color:var(--btn-fg,#fff)}.lvl button:focus-visible{outline:2px solid var(--accent)}
button.more-asp{all:unset;cursor:pointer;font-size:13px;color:var(--accent-text)}button.more-asp:hover{text-decoration:underline}button.more-asp:focus-visible{outline:2px solid var(--accent)}
.match-h{font-size:14px;margin:6px 0 0}.vote{display:inline-flex;align-items:center;gap:2px;grid-column:3;grid-row:2}.vote button{all:unset;cursor:pointer;font-size:13px;padding:3px 7px;border:1px solid var(--line);border-radius:5px;color:var(--muted)}.vote button.on{background:var(--accent);color:var(--btn-fg,#fff);border-color:var(--accent)}.vote button:focus-visible{outline:2px solid var(--accent)}.vote .pull{font-size:12px;color:var(--muted);margin-left:6px;font-variant-numeric:tabular-nums}
.match-fields{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.match-fields button{all:unset;cursor:pointer;font-size:12.5px;padding:3px 10px;border:1px solid var(--line);border-radius:12px;color:var(--muted)}.match-fields button[aria-pressed=true]{border-color:var(--accent-text);color:var(--accent-text);font-weight:600}.match-fields button:focus-visible{outline:2px solid var(--accent)}
.match-row label.match-ex{flex-direction:row;align-items:center;gap:6px;font-size:13px;color:var(--ink)}
.match-file{font-size:13px;color:var(--muted)}.match-file input{font-size:13px;color:var(--ink);max-width:100%}
.match-d .similar ul{margin:4px 0 0;padding-left:18px;font-size:13.5px;display:flex;flex-direction:column;gap:2px}
.match-note{font-size:12.5px;color:var(--muted)}
.target-bar{display:flex;gap:8px 12px;align-items:center;flex-wrap:wrap;padding:8px 12px;background:var(--paper);border:1px solid var(--line);border-radius:8px;margin-top:4px}
.career-step{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.career-step button{all:unset;cursor:pointer;font-size:12px;padding:4px 9px;border-right:1px solid var(--line);color:var(--muted);background:var(--paper)}
.career-step button:last-child{border-right:0}
.career-step button.on{background:var(--accent);color:var(--btn-fg,#fff);font-weight:600}
#match-target-text{padding:6px 9px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font:inherit;font-size:13px;flex:1;min-width:14em}
.reason-strip{grid-column:2/4;display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:4px 0 2px;font-size:12px;color:var(--muted);border-top:1px dashed var(--line);margin-top:4px}
.reason-strip button{all:unset;cursor:pointer;padding:2px 8px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);font-size:11.5px}
.reason-strip button:hover{border-color:var(--accent);color:var(--accent-text)}
.reason-strip button.on{background:var(--accent);color:var(--btn-fg,#fff);border-color:var(--accent)}
.detected-badge{font-size:12px;padding:2px 8px;background:var(--line);border-radius:10px;color:var(--ink);font-weight:500}
@media(max-width:560px){.vote{grid-column:2;grid-row:auto}.match-r{grid-template-columns:1.8em 1fr}.asp{grid-template-columns:1fr}.reason-strip{grid-column:1/-1}}
`;
document.head.appendChild(style);

mount.innerHTML = `<details class="match-details">
<summary class="match-head"><strong>${L('Match me', 'Passende Stellen für mich')}</strong><span class="small muted">${L('Paste your CV or describe what you want. Ranked open roles, computed on your device.', 'CV einfügen oder beschreiben, was Sie suchen. Passende offene Stellen, berechnet auf Ihrem Gerät.')}</span></summary>
<div class="match-body">
<textarea id="match-text" spellcheck="false" ${LP('Optional: paste your CV, or write a few lines on the work you want to do. Or leave this empty and rate roles instead (use the button below).', 'Optional: CV einfügen oder in wenigen Zeilen beschreiben, was Sie machen möchten. Oder leer lassen und stattdessen Stellen bewerten (Knopf darunter).')}></textarea>
<div class="match-file"><label>${L('or read a CV file (PDF or text; read on this device, nothing is uploaded):', 'oder eine CV-Datei lesen (PDF oder Text; auf diesem Gerät gelesen, nichts wird hochgeladen):')} <input type="file" id="match-file" accept=".pdf,.txt,.md,application/pdf,text/plain"></label> <span class="match-note" id="match-file-status"></span></div>

<div class="target-bar" id="target-control-bar">
  <span id="target-bar-label" class="match-note">${L('Target activity — steer where you want to go next:', 'Zielaktivität — Richtung für den nächsten Karriereschritt:')}</span>
  <div class="career-step" id="career-step-group" role="group" aria-label="${L('Career Step', 'Karriereschritt')}">
    <button type="button" data-step="same" class="${PF.targetState().step === 'same' ? 'on' : ''}">${L('Same level', 'Gleiches Level')}</button>
    <button type="button" data-step="stepup" class="${PF.targetState().step === 'stepup' ? 'on' : ''}">${L('↗ Step up / Lead', '↗ Aufstieg / Lead')}</button>
    <button type="button" data-step="pivot" class="${PF.targetState().step === 'pivot' ? 'on' : ''}">${L('⇄ Pivot field', '⇄ Quereinstieg')}</button>
  </div>
  <input type="text" id="match-target-text" value="${esc(PF.targetState().ambition || '')}" ${LP('Target role / ambition (optional, e.g. Head of Production, Director AIT)', 'Zielrolle / Ambition (optional, z. B. Head of Production, Director AIT)')}>
</div>

<div class="match-fields" id="match-personas" role="group"></div>
<div class="match-fields" id="match-fields" role="group" aria-label="${isDe() ? 'Fachgebiete der Jobbörse' : 'Fields from the jobs board'}"></div>

<div class="match-row">
<label>${L('Where', 'Wo')}<select id="match-scope">${scopeOpts}</select></label>
<label>${L('Level from', 'Level ab')}<select id="match-min"><option value="0">${L('any', 'beliebig')}</option>${levelOpts}</select></label>
<label>${L('to', 'bis')}<select id="match-max"><option value="99">${L('any', 'beliebig')}</option>${levelOpts}</select></label>
<label>${L('Employer influence', 'Einfluss des Arbeitgebers')}<select id="match-co"><option value="0">${L('none', 'keiner')}</option><option value="0.08">${L('light', 'leicht')}</option><option value="0.15" selected>${L('medium', 'mittel')}</option><option value="0.3">${L('strong', 'stark')}</option></select></label>
<label>${L('Max per employer', 'Max. je Arbeitgeber')}<select id="match-cap"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option><option value="99">${L('no limit', 'unbegrenzt')}</option></select></label>
<label>${L('Narrow by keywords', 'Nach Stichwörtern eingrenzen')}<input id="match-kw" type="text" ${LP('e.g. thermal, TVAC, GNC', 'z. B. Thermal, TVAC, GNC')}></label>
<label>${L('Keywords', 'Stichwörter')}<select id="match-kwmode"><option value="auto" selected>${L('automatic', 'automatisch')}</option><option value="must">${L('must match', 'müssen passen')}</option><option value="hint">${L('only a hint', 'nur ein Hinweis')}</option><option value="off">${L('ignore (ratings decide)', 'ignorieren (Bewertungen entscheiden)')}</option></select></label>
<label class="match-ex"><input type="checkbox" id="match-explore"> ${L('Mix in 4 roles to explore', '4 Stellen zum Erkunden beimischen')}</label>
<button type="button" class="button" id="match-go">${L('Find roles', 'Stellen finden')}</button>
<button type="button" class="button outline" id="match-spread">${L('Show me a spread to rate', 'Eine Auswahl zum Bewerten zeigen')}</button>
<a class="button outline" href="${pageUrl('atlas.html')}" id="match-atlas">${L('Explore the atlas', 'Atlas erkunden')}</a>
<button type="button" class="button" id="match-taste" hidden>${L('Update results from my ratings', 'Ergebnisse aus meinen Bewertungen aktualisieren')}</button>
<button type="button" class="button outline" id="match-model">${L('Add meaning matching', 'Bedeutungsabgleich zuschalten')}</button>
</div>

<div class="match-status" id="match-status" aria-live="polite"></div>
<div class="match-bar" id="match-bar" hidden><i></i></div>
<h3 class="match-h" id="match-rated-h" hidden>${L('Roles you rated', 'Von Ihnen bewertete Stellen')}</h3><ol class="match-results" id="match-rated"></ol>
<h3 class="match-h" id="match-res-h" hidden></h3><ol class="match-results" id="match-results"></ol>
<div class="match-row" id="match-foot" hidden>
<button type="button" class="button outline small-btn" id="match-more">${L('Show 20 more', '20 weitere zeigen')}</button>
<button type="button" class="button outline small-btn" id="match-forget">${L('Forget everything on this device', 'Alles auf diesem Gerät vergessen')}</button>
<button type="button" class="button outline small-btn" id="match-save">${L('Save my profile as a file', 'Mein Profil als Datei speichern')}</button>
<label class="match-file">${L('Load a saved profile: ', 'Gespeichertes Profil laden: ')}<input type="file" id="match-load" accept=".json,application/json"></label>
<button type="button" class="button outline small-btn" id="match-copy">${L('Copy my ratings', 'Meine Bewertungen kopieren')}</button>
</div>
<p class="match-note">${L('Your text and ratings stay in this browser; nothing is uploaded. Ratings alone (no CV) need no download: the roles you like and dislike are looked up in the board\'s own meaning index. Meaning matching downloads a small language model once (about 200 MB) and keeps it in this browser.', 'Ihr Text und Ihre Bewertungen bleiben in diesem Browser; es wird nichts hochgeladen. Bewertungen allein (ohne CV) brauchen keinen Download: Die Stellen, die Sie mögen oder ablehnen, werden im Bedeutungsindex der Börse nachgeschlagen. Der Bedeutungsabgleich lädt einmalig ein kleines Sprachmodell (ca. 200 MB) und behält es in diesem Browser.')}</p>
</div></details>`;

const $ = (id) => mount.querySelector('#' + id);
const st = {
  idIndex: null, ix: null, rows: null, model: null, emb: null, embText: null,
  pData: null, detectedProfile: null, activeReasonId: null,
  shown: 20, last: null,
  ratings: new Map(Object.entries((() => { try { return JSON.parse(localStorage.getItem(K.ratings) || '{}'); } catch (e) { return {}; } })())),
  more: false
};
const say = (html) => { $('match-status').innerHTML = html; };

async function ensureIndex() {
  if (st.ix) return st.ix;
  say(L('Loading the role index…', 'Lade den Stellenindex …'));
  const [ix, rows] = await Promise.all([loadIndex(dataUrl('match/'), cfg.glossary), fetch(dataUrl('jobs-index.json')).then((r) => r.json())]);
  st.prefDefs = await fetch(dataUrl('match/match-prefs.json')).then((r) => (r.ok ? r.json() : { prefs: [] })).then((j) => j.prefs.map((p) => ({ ...p, v: Float32Array.from(p.v) }))).catch(() => []);
  st.ix = ix; st.rows = rows;
  st.pData = PF.personaVectorsByLevel(st.ix, st.rows);
  buildFields();
  return ix;
}

st.fields = new Set();
function buildPersonas() {
  if (!st.ix || !st.rows) return;
  st.pData = st.pData || PF.personaVectorsByLevel(st.ix, st.rows);
  const ts = PF.targetState();
  const chosen = (ts.ids && ts.ids.length) ? ts.ids : PF.chosenPersonas();
  const w = PF.personaWeight();

  let introHtml = '';
  if (st.detectedProfile && st.detectedProfile.topPersonas.length) {
    const pLabels = st.detectedProfile.topPersonas.map((id) => {
      const p = PF.personas().find((x) => x.id === id);
      return p ? L(p.label.en, p.label.de) : id;
    }).join(' · ');
    introHtml = `<span class="detected-badge">${L('Detected from CV: ' + pLabels, 'Aus dem CV erkannt: ' + pLabels)}</span> `;
  }

  $('match-personas').innerHTML = introHtml
    + `<span class="match-note">${L('Target activity:', 'Zielaktivität:')}</span>`
    + PF.personas().filter((p) => st.pData.all[p.id]).map((p) => `<button type="button" data-persona="${p.id}" aria-pressed="${chosen.includes(p.id)}">${L(p.label.en, p.label.de)}</button>`).join('')
    + (chosen.length ? ` <span class="match-note">${w ? L(`pull ${Math.round(w / PF.START_WEIGHT * 100)} %`, `Sog ${Math.round(w / PF.START_WEIGHT * 100)} %`) : ''}</span>` : '');
}

function buildFields() {
  buildPersonas();
  $('match-taste').hidden = !hasTaste();
  $('match-fields').innerHTML = st.ix.fields.map((f) => `<button type="button" data-f="${esc(f)}" aria-pressed="${st.fields.has(f)}">${L(...fieldNames(f))}</button>`).join('');
}

async function cacheReady() {
  try { return await caches.has(modelCache()); } catch (e) { return false; }
}

async function ensureModel() {
  if (st.model) return st.model;
  const { loadModel } = await import('./embed.js');
  const bar = $('match-bar'); bar.hidden = false;
  try {
    st.model = await loadModel({ modelUrl: cfg.model_url, cacheName: modelCache(), onProgress: (f, label) => {
      bar.firstElementChild.style.width = (f * 100).toFixed(0) + '%';
      say(f < 0.97 ? L('Downloading the matching model (once): ', 'Lade das Abgleichmodell (einmalig): ') + (f * 100).toFixed(0) + ' %' : L('Starting the model…', 'Starte das Modell …'));
    } });
  } finally { bar.hidden = true; }
  $('match-model').hidden = true; return st.model;
}

const SETTINGS = ['match-scope', 'match-min', 'match-max', 'match-cap', 'match-co', 'match-kwmode', 'match-explore', 'match-kw'];
function saveSettings() {
  const o = {};
  for (const id of SETTINGS) { const el = $(id); if (el) o[id] = el.type === 'checkbox' ? el.checked : el.value; }
  o.fields = [...st.fields];
  PF.setJ(K.settings, o);
}
function restoreSettings() {
  const o = PF.getJ(K.settings, null); if (!o) return;
  for (const id of SETTINGS) { const el = $(id); if (el && o[id] !== undefined) { if (el.type === 'checkbox') el.checked = !!o[id]; else el.value = o[id]; } }
  (o.fields || []).forEach((f) => st.fields.add(f));
}
function settings() {
  return { scope: +$('match-scope').value, minLevel: +$('match-min').value, maxLevel: +$('match-max').value, perEmployer: +$('match-cap').value };
}

const ENOUGH = 3;
function kwPlan(items) {
  const kw = $('match-kw').value.trim(), fields = [...st.fields], pick = $('match-kwmode').value, ix = st.ix;
  const enough = items.filter((x) => x.w > 0.3 && ix.vrow[x.i] >= 0).length >= ENOUGH;
  const mode = !kw && !fields.length ? 'none' : pick === 'auto' ? (enough ? 'off' : 'must') : pick;
  const mustOf = () => { const a = kw ? matchAny(ix, kw) : null, f = fields.length ? matchFields(ix, fields) : null; return a && f ? Uint8Array.from(a, (x, i) => x & f[i]) : a || f; };
  return { kw, mode, auto: pick === 'auto', must: mode === 'must' ? mustOf() : null, enough, hintText: [kw, ...fields].join(' ').trim() };
}

function companyExtras(cvQ = null) {
  const out = PF.convolvedExtras(st.ix, cvQ, st.pData);
  const names = new Set();
  const ix = st.ix;
  for (const [id, r] of st.ratings) {
    if (!id.startsWith('co:')) continue;
    const w = tasteWeight(r); if (!w) continue;
    const slug = id.slice(3), sum = new Float32Array(ix.dim); let n = 0;
    st.rows.forEach((row, i) => { if (row[4] === slug && ix.vrow[i] >= 0) { n++; for (let d = 0; d < ix.dim; d++) sum[d] += ix.vec[ix.vrow[i] * ix.dim + d]; if (w < 0) names.add(row[2]); } });
    if (n) { let t = 0; for (const x of sum) t += x * x; t = Math.sqrt(t) || 1; out.push({ w, vec: sum.map((x) => x / t), co: slug }); }
  }
  return { out, names };
}

const hasTaste = () => {
  const ts = PF.targetState();
  return (ts.ids && ts.ids.length > 0) || PF.personaWeight() > 0 || sharedPrefs().some((p) => p.val) || !!sharedCv() || [...st.ratings].some(([k, r]) => tasteWeight(r) || r.reason);
};
const getJ = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } };
const sharedPrefs = () => { const vals = getJ(K.prefs, {}); return (st.prefDefs || []).map((p) => ({ ...p, val: vals[p.id] || 0 })); };
const sharedCv = () => { const c = getJ(K.cv, null); return c && c.on !== false && c.v ? c.v : null; };
const idOf = (i) => st.rows[i][0];
const ratedItems = () => {
  if (!st.idIndex) st.idIndex = new Map(st.ix.ids.map((id, i) => [id, i]));
  return [...st.ratings].map(([id, r]) => ({ id, i: st.idIndex.get(id), r, w: tasteWeight(r) })).filter((x) => x.i !== undefined);
};

function badEmployers(items, ce) {
  const by = new Map();
  for (const x of items) {
    if (x.r.company) { const c = st.rows[x.i][4]; by.set(c, [...(by.get(c) || []), x.r.company]); }
    if (x.r.reason === 'wrong_company') { const c = st.rows[x.i][4]; by.set(c, [...(by.get(c) || []), 1]); }
  }
  const out = new Map();
  for (const [c, v] of by) { const avg = v.reduce((a, b) => a + b, 0) / v.length; if (avg < 3) out.set(c, Math.min(1, (3 - avg) / 2)); }
  for (const e of ce.out) if (e.w < 0) out.set(e.co, 1);
  return out;
}

function badRegionsFromRatings(items) {
  const bad = new Map();
  for (const x of items) {
    if (x.r.reason === 'wrong_place' && st.ix.attrs[x.i]) {
      bad.set(st.ix.attrs[x.i][3], 1.0);
    }
  }
  return bad;
}

function levelHint(items) {
  const t = items.filter((x) => x.r.level !== undefined && st.ix.attrs[x.i][1]).map((x) => st.ix.attrs[x.i][1] - x.r.level).sort((a, b) => a - b);
  if (t.length < 2) return '';
  const lo = Math.max(1, Math.min(st.ix.levels.length - 1, t[Math.floor((t.length - 1) * 0.25)]));
  const hi = Math.max(1, Math.min(st.ix.levels.length - 1, t[Math.ceil((t.length - 1) * 0.75)]));
  const nm = (k) => L(...levelNames(k));
  return ' ' + L('Your level answers point to ', 'Ihre Level-Antworten deuten auf ') + nm(lo) + (lo === hi ? '' : ' – ') + (lo === hi ? '' : nm(hi)) + L(' (set the level filter if you want to use that).', ' (Level-Filter setzen, um das zu nutzen).');
}

async function run(useModel) {
  const text = $('match-text').value.trim();
  const targetAmbition = $('match-target-text')?.value.trim() || '';
  const ix = await ensureIndex();
  const items = ratedItems().filter((x) => x.w !== null || x.r.reason);
  let note = '';

  if (text.length < 20 && !hasTaste() && !targetAmbition) {
    say(L('Paste a few lines about your work, select a target activity, or rate some roles.', 'Fügen Sie ein paar Zeilen zu Ihrer Arbeit ein, wählen Sie eine Zielaktivität, oder bewerten Sie Stellen.'));
    return;
  }

  // Meaning embedding with model if requested
  if (text.length >= 20 && useModel && ix.vec && st.embText !== text) {
    try {
      const m = await ensureModel();
      say(L('Reading your text with the model…', 'Lese Ihren Text mit dem Modell …'));
      st.emb = await m.embed(text, 512);
      st.embText = text;
      try {
        localStorage.setItem(K.cv, JSON.stringify({ v: Array.from(st.emb, (x) => Math.round(x * 1e4) / 1e4), on: true }));
      } catch (e) {}
    } catch (e) {
      console.error(e);
      st.emb = null;
      note = L('The meaning model could not be started on this device; showing keyword matches. ', 'Das Bedeutungsmodell lässt sich auf diesem Gerät nicht starten; zeige Stichwort-Treffer. ') + esc(e.message || '') + ' ';
    }
  }

  const usable = text.length >= 20 && st.emb && st.embText === text;
  const storedCv = !usable ? sharedCv() : null;
  const cvEmbedding = usable ? st.emb : storedCv;
  const cvQ = (cvEmbedding && st.ix.dim) ? queryVec(st.ix, cvEmbedding) : null;

  // Auto-detect CV background persona if embedding is available
  if (cvQ && st.pData) {
    st.detectedProfile = PF.inferCvProfile(st.ix, cvQ, st.pData);
    buildPersonas();
  }

  const ce = companyExtras(cvQ);
  const o = settings();
  const companyOf = (i) => st.rows[i][2];
  const kp = kwPlan(items);
  o.must = kp.must;

  const ts = PF.targetState();
  const chosenIds = (ts.ids && ts.ids.length) ? ts.ids : PF.chosenPersonas();
  const personaKw = PF.personas().filter((p) => chosenIds.includes(p.id)).map((p) => `${p.label.en} ${p.label.de}`).join(' ');
  const stepKw = ts.step === 'stepup' ? 'director head lead manager principal chief leiter abteilungsleiter bereichsleiter teamlead' : '';
  const combinedTargetText = [targetAmbition, personaKw, stepKw].filter(Boolean).join(' ').trim();

  let out, msg;
  const prefs = sharedPrefs();
  const anyPref = prefs.some((p) => p.val);
  const badCo = badEmployers(items, ce);
  const badReg = badRegionsFromRatings(items);
  const stepUpVec = st.pData ? st.pData.stepUpVec : null;

  if (items.length || ce.out.length || anyPref || cvEmbedding || combinedTargetText) {
    const likedText = (await Promise.all(items.filter((x) => x.w > 0.3).map(async (x) => ((await shard(idOf(x.i)))[idOf(x.i)] || {}).x || ''))).map((t, k) => st.rows[items.filter((x) => x.w > 0.3)[k].i][1] + ' ' + t.slice(0, 1500)).join(' ');

    const t = rankByTaste(ix, {
      items: items.map((x) => ({ i: x.i, r: x.r, w: x.w, coW: x.r.company ? (x.r.company - 3) / 2 : undefined })),
      coKey: (i) => st.rows[i][4],
      coupling: +$('match-co').value,
      explore: $('match-explore').checked ? 4 : 0,
      prefs,
      cvEmbedding,
      text: (text.length >= 20 ? text : '') + (kp.mode === 'hint' ? ' ' + kp.hintText : ''),
      targetText: combinedTargetText,
      keywords: kp.mode === 'off' || (kp.auto && kp.enough) ? 'off' : 'blend',
      likedText,
      ...o,
      top: 200,
      companyOf,
      skip: new Set(items.map((x) => x.i)),
      badCompanies: badCo,
      badRegions: badReg,
      extra: ce.out,
      stepUpVec,
    });

    out = { results: t.results.map((r) => ({ ...r, dense: true })) };
    const nAreas = t.areaCount;
    msg = L(`Convolved match: ${items.length} ratings, target activities, and background domain combined. `, `Konvolutionsabgleich: ${items.length} Bewertungen, Zielaktivitäten und Fachbereich kombiniert. `);
    msg += levelHint(items);
  } else {
    out = rank(ix, { text: text + (kp.mode === 'hint' ? ' ' + kp.hintText : ''), embedding: usable ? st.emb : null, ...o, top: 200, companyOf });
    msg = out.usedModel ? L('Keywords and meaning combined. Rate some roles to refine this. ', 'Stichwörter und Bedeutung kombiniert. Bewerten Sie einige Stellen, um das zu verfeinern. ') : L('Keywords only; add meaning matching, or rate some roles, for better results. ', 'Nur Stichwörter; mit Bedeutungsabgleich oder Bewertungen werden die Treffer besser. ');
  }

  st.last = out;
  st.shown = 20;
  render();
  say(note + (out.results.length ? msg : L('Nothing matched these settings. Try a wider region or level range.', 'Keine Treffer mit diesen Einstellungen. Versuchen Sie eine größere Region oder einen weiteren Level-Bereich.') + ' ' + msg));
}

async function spread() {
  const ix = await ensureIndex(), o = settings(), ok = (i) => (ix.attrs[i][0] >> o.scope & 1) === 1 && ix.attrs[i][1] >= o.minLevel && ix.attrs[i][1] <= o.maxLevel;
  const kp = kwPlan(ratedItems().filter((x) => x.w !== null)), must = kp.must, ok2 = (i) => ok(i) && (!must || must[i] > 0);
  const picks = sampleSpread(ix, ok2, 12);
  st.last = { results: picks.map((i) => ({ i, why: [], dense: false })) }; st.shown = 12; render();
  say(L('A spread of very different roles. Open the ones that catch your eye and rate the work itself; likes and dislikes both count. Then update the results.', 'Eine Auswahl sehr unterschiedlicher Stellen. Öffnen Sie, was Sie anspricht, und bewerten Sie die Arbeit selbst; Gefallen und Ablehnung zählen. Dann die Ergebnisse aktualisieren.'));
}

const ASPECTS = [['role', 'The work itself', 'Die Arbeit selbst', 'what you would do day to day', 'was Sie täglich tun würden'], ['company', 'The employer', 'Der Arbeitgeber', 'would you want to work there', 'ob Sie dort arbeiten wollen'], ['place', 'The place', 'Der Ort', 'location and ways of working', 'Ort und Arbeitsweise']];
const EXTRA = [['skills', 'My skills fit', 'Passt zu meinen Kenntnissen', 'could I do it from day one', 'könnte ich es sofort'], ['interest', 'How much it interests me', 'Wie sehr es mich reizt', 'regardless of fit', 'unabhängig von der Eignung']];
const CHOICES = {
  level: ['The level', 'Das Level', 'seniority against yours', 'Seniorität im Vergleich zu Ihrer', [[-2, 'far too junior', 'viel zu junior'], [-1, 'a bit junior', 'etwas junior'], [0, 'right level', 'passendes Level'], [1, 'a bit senior', 'etwas senior'], [2, 'far too senior', 'viel zu senior']], false],
  pay: ['The pay', 'Die Bezahlung', 'as far as you can tell', 'soweit erkennbar', [[-2, 'far too low', 'viel zu niedrig'], [-1, 'low', 'niedrig'], [0, 'fair', 'angemessen'], [1, 'good', 'gut'], [2, 'very good', 'sehr gut']], true],
  apply: ['Would you apply', 'Würden Sie sich bewerben', 'a plain yes or no', 'ein klares Ja oder Nein', [[-1, 'no', 'nein'], [0, 'maybe', 'vielleicht'], [1, 'yes', 'ja']], true],
};

const shards = new Map();
function shard(id) {
  const k = id.slice(0, 2);
  if (!shards.has(k)) shards.set(k, fetch(dataUrl('jobs-desc-' + k + '.json')).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  return shards.get(k);
}
const rated = (id) => st.ratings.get(id) || {};
const persist = () => { try { localStorage.setItem(K.ratings, JSON.stringify(Object.fromEntries(st.ratings))); } catch (e) {} };

function summary(id) {
  const r = rated(id); if (!Object.keys(r).length) return '';
  if (r.reason === 'too_junior') return L('rated: good work · too junior ↗', 'bewertet: gute Arbeit · etwas junior ↗');
  if (r.reason === 'too_senior') return L('rated: good work · too senior ↘', 'bewertet: gute Arbeit · etwas senior ↘');
  if (r.reason === 'wrong_company') return L('rated: work fits · wrong employer', 'bewertet: Arbeit passt · falscher Arbeitgeber');
  if (r.reason === 'wrong_place') return L('rated: work fits · wrong location', 'bewertet: Arbeit passt · falscher Ort');
  if (r.reason === 'wrong_work') return L('rated: wrong work/field ✗', 'bewertet: falsches Fachgebiet ✗');
  const sg = (v) => (v > 0 ? '+' : '') + v;
  return L('rated', 'bewertet') + ' ' + ASPECTS.map(([k]) => r[k] || '·').join(' ') + (r.level === undefined ? '' : ' ' + sg(r.level)) + (r.apply === undefined ? '' : r.apply > 0 ? ' ✓' : r.apply < 0 ? ' ✗' : ' ?');
}

const starRow = (k, en, de, hen, hde, r) => `<span class="k">${L(en, de)}<small>${L(hen, hde)}</small></span><span class="stars" data-k="${k}" role="group">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" class="${n <= (r[k] || 0) ? 'on' : ''}" aria-label="${n}" aria-pressed="${n <= (r[k] || 0)}">★</button>`).join('')}</span>`;
const choiceRow = (k, r) => { const [en, de, hen, hde, opts] = CHOICES[k]; return `<span class="k">${L(en, de)}<small>${L(hen, hde)}</small></span><span class="lvl" data-k="${k}">${opts.map(([v, oen, ode]) => `<button type="button" data-v="${v}" class="${r[k] === v ? 'on' : ''}">${L(oen, ode)}</button>`).join('')}</span>`; };

function aspectHtml(id) {
  const r = rated(id), more = st.more || EXTRA.some(([k]) => r[k]) || ['pay', 'apply'].some((k) => r[k] !== undefined);
  return `<div class="asp">${ASPECTS.map(([k, ...t]) => starRow(k, ...t, r)).join('')}${choiceRow('level', r)}</div>`
    + `<button type="button" class="link more-asp" aria-expanded="${more}">${more ? L('Fewer aspects ▴', 'Weniger Aspekte ▴') : L('More aspects (optional) ▾', 'Weitere Aspekte (optional) ▾')}</button>`
    + (more ? `<div class="asp">${EXTRA.map(([k, ...t]) => starRow(k, ...t, r)).join('')}${choiceRow('pay', r)}${choiceRow('apply', r)}</div>` : '');
}

function reasonStripHtml(id) {
  const r = rated(id);
  const act = r.reason || '';
  return `<div class="reason-strip" data-id="${id}">`
    + `<span>${L('Why not?', 'Warum nicht?')}</span>`
    + `<button type="button" data-reason="wrong_work" class="${act === 'wrong_work' ? 'on' : ''}">${L('Wrong field/work', 'Falsches Fachgebiet')}</button>`
    + `<button type="button" data-reason="too_junior" class="${act === 'too_junior' ? 'on' : ''}">${L('Good work, too junior ↗', 'Gute Arbeit, zu junior ↗')}</button>`
    + `<button type="button" data-reason="too_senior" class="${act === 'too_senior' ? 'on' : ''}">${L('Too senior ↘', 'Zu senior ↘')}</button>`
    + `<button type="button" data-reason="wrong_company" class="${act === 'wrong_company' ? 'on' : ''}">${L('Wrong company', 'Falscher Arbeitgeber')}</button>`
    + `<button type="button" data-reason="wrong_place" class="${act === 'wrong_place' ? 'on' : ''}">${L('Wrong location', 'Falscher Ort')}</button>`
    + `</div>`;
}

function similarHtml(i) {
  if (i === undefined || i < 0 || !st.ix.nbOf) return '';
  const dups = st.ix.dupsOf(i), nb = st.ix.nbOf(i).slice(0, 6), link = (j) => `<a class="link" href="${roleLink(st.rows[j][0])}">${esc(st.rows[j][1])}</a> <span class="match-note">${esc(st.rows[j][2])}</span>`;
  return (dups.length ? `<div class="match-note">${L(`Also listed ${dups.length} more time${dups.length > 1 ? 's' : ''}:`, `Noch ${dups.length}-mal ausgeschrieben:`)} ${dups.slice(0, 4).map((j) => `<a class="link" href="${roleLink(st.rows[j][0])}">${esc(st.rows[j][2])}${st.ix.regions[st.ix.attrs[j][3]] ? ' · ' + esc(st.ix.regions[st.ix.attrs[j][3]]) : ''}</a>`).join(', ')}</div>` : '')
    + (nb.length ? `<div class="similar"><span class="match-note">${L('Similar roles:', 'Ähnliche Stellen:')}</span><ul>${nb.map((x) => `<li>${link(x.i)}</li>`).join('')}</ul></div>` : '');
}

async function fillDetail(li) {
  const id = li.dataset.id, box = li.querySelector('.match-d'); if (box.dataset.ready) return; box.dataset.ready = '1';
  const d = (await shard(id))[id], row = st.rows.find((x) => x[0] === id);
  const facts = d ? [d.l, d.r, d.lv && st.ix.levels.indexOf(d.lv) > 0 && L(...levelNames(st.ix.levels.indexOf(d.lv))), (d.tg || []).join(' · '), d.d && L('listed ', 'gelistet ') + d.d].filter(Boolean) : [];
  const text = d && d.x ? d.x.replace(/\n{3,}/g, '\n\n').trim() : '';
  box.innerHTML = `<div class="facts">${facts.map((f) => `<span>${typeof f === 'string' && !f.startsWith('<') ? esc(f) : f}</span>`).join('')}</div>`
    + (text ? `<div class="txt" tabindex="0">${esc(text)}</div>` : `<p class="match-note">${L('No description was saved for this role; the title is all that was matched.', 'Für diese Stelle wurde keine Beschreibung gespeichert; abgeglichen wurde nur der Titel.')}</p>`)
    + `<div class="links"><a class="link" href="${roleLink(id)}">${ROLE_LINK}</a>${d && companyLink(d.cs) ? `<a class="link" href="${companyLink(d.cs)}">${L('About ' + row[2] + ' →', 'Über ' + row[2] + ' →')}</a>` : ''}<a class="link" href="${esc(row[3])}" target="_blank" rel="noopener">${L('Apply on the employer site ↗', 'Beim Arbeitgeber bewerben ↗')}</a></div>`
    + similarHtml(st.idIndex ? st.idIndex.get(id) : st.rows.findIndex((x) => x[0] === id))
    + `<div class="aspects">${aspectHtml(id)}</div>`;
}

function voteHtml(id) {
  const r = rated(id), w = tasteWeight(r);
  return [[-1, '▼', 'less like this', 'weniger davon'], [0, '●', 'ignore for the search', 'für die Suche ignorieren'], [1, '▲', 'more like this', 'mehr davon']].map(([v, g, en, de]) => `<button type="button" data-v="${v}" class="${r.vote === v ? 'on' : ''}" title="${esc(isDe() ? de : en)}" aria-label="${esc(isDe() ? de : en)}" aria-pressed="${r.vote === v}">${g}</button>`).join('')
    + (w === null ? '' : `<span class="pull">${w > 0 ? '+' : ''}${w.toFixed(1)}</span>`);
}

function listHtml(entries, open, ix, numbered = true) {
  return entries.map((r, k) => {
    const row = st.rows[r.i], id = row[0], lv = ix.attrs[r.i][1], region = ix.regions[ix.attrs[r.i][3]] || '', short = (i) => esc(st.rows[i][1].slice(0, 34));
    const rData = rated(id);
    const showReason = rData.vote === -1 || st.activeReasonId === id;

    const chips = (r.also ? `<span class="match-chip">${L(`+${r.also} more listing${r.also > 1 ? 's' : ''}`, `+${r.also} weitere Ausschreibung${r.also > 1 ? 'en' : ''}`)}</span>` : '')
      + (r.explore ? `<span class="match-chip">${L('to explore: unlike what you rated so far', 'zum Erkunden: anders als bisher bewertet')}</span>` : '')
      + (r.dense && !r.explore ? `<span class="match-chip mean">${L('meaning', 'Bedeutung')}</span>` : '')
      + (r.sim > 0.35 && st.emb ? `<span class="match-chip conv">${L('background + target match', 'Fachbereich + Zielrolle')}</span>` : '')
      + (lv >= 4 ? `<span class="match-chip stepup">${L('lead / senior ↗', 'Lead / Senior ↗')}</span>` : '')
      + (r.why || []).map((w) => `<span class="match-chip">${esc(w)}</span>`).join('')
      + (r.near >= 0 && r.near !== undefined ? `<span class="match-chip mean">${L('like', 'ähnlich')}: ${short(r.near)}</span>` : '')
      + (r.couple && r.couple.liked > 0.05 ? `<span class="match-chip mean">${L('employer liked here', 'Arbeitgeber hier gemocht')}</span>` : r.couple && r.couple.similar > 0.5 ? `<span class="match-chip">${L('employer like ones you liked', 'Arbeitgeber wie gemochte')}</span>` : '')
      + (r.avoid >= 0 && r.avoid !== undefined && r.sim < 0.6 ? `<span class="match-chip">${L('close to a no', 'nah an einem Nein')}: ${short(r.avoid)}</span>` : '');

    return `<li class="match-r${open.has(id) ? ' open' : ''}" data-id="${id}"><span class="n">${numbered ? k + 1 : '★'}</span><button type="button" class="hd" aria-expanded="${open.has(id)}">${esc(row[1])}</button>
<span class="sum">${summary(id)}</span>
<span class="vote" data-k="vote" role="group" aria-label="${isDe() ? 'Gewicht' : 'Weight'}">${voteHtml(id)}</span>
<span class="m">${esc(row[2])}${region ? ' · ' + esc(region) : ''}${lv ? ' · ' + L(...levelNames(lv, ix)) : ''}</span>
<span class="w">${chips}</span>
${showReason ? reasonStripHtml(id) : ''}
<div class="match-d"></div></li>`;
  }).join('');
}

function render() {
  const ix = st.ix, res = st.last ? st.last.results.slice(0, st.shown) : [], ol = $('match-results'), rl = $('match-rated');
  const open = new Set([...mount.querySelectorAll('.match-r.open')].map((e) => e.dataset.id));
  ol.innerHTML = listHtml(res, open, ix);
  const rated = ratedItems().filter((x) => x.w !== null || Object.keys(x.r).length);
  const showRated = st.last && st.last.results.length && rated.length && !res.some((r) => st.ratings.has(idOf(r.i)));
  rl.innerHTML = showRated ? listHtml(rated.map((x) => ({ i: x.i })), open, ix, false) : ''; $('match-rated-h').hidden = !showRated;
  mount.querySelectorAll('.match-r.open').forEach(fillDetail);
  $('match-foot').hidden = !(res.length || rated.length);
  $('match-more').hidden = !st.last || st.shown >= st.last.results.length;
  $('match-taste').hidden = !hasTaste();
}

mount.addEventListener('change', async (e) => {
  if (SETTINGS.includes(e.target.id)) saveSettings();
  if (e.target.id === 'match-target-text') {
    const ts = PF.targetState();
    ts.ambition = e.target.value.trim();
    PF.setTargetState(ts);
    return;
  }
  if (e.target.id === 'match-load' && e.target.files.length) {
    try {
      await PF.loadProfileFile(e.target.files[0]);
      st.ratings = new Map(Object.entries(PF.getJ(K.ratings, {})));
      st.fields.clear();
      restoreSettings();
      if (st.ix) buildFields();
      say(L('Profile loaded. Press "Update results from my ratings".', 'Profil geladen. „Ergebnisse aus meinen Bewertungen aktualisieren“ drücken.'));
    } catch (err) { say(esc(err.message || String(err))); }
    return;
  }
  if (e.target.id !== 'match-file' || !e.target.files.length) return;
  const stat = $('match-file-status'); stat.textContent = isDe() ? 'Lese die Datei …' : 'Reading the file…';
  try {
    const { fileText } = await import('./pdftext.js');
    const t = await fileText(e.target.files[0]);
    $('match-text').value = t;
    stat.textContent = (isDe() ? `${t.length.toLocaleString('de-DE')} Zeichen gelesen; prüfen und bei Bedarf kürzen, das Wichtigste zuerst.` : `${t.length.toLocaleString()} characters read; check it and trim if needed, most relevant part first.`);
  } catch (err) { stat.textContent = err.message || String(err); }
});

mount.addEventListener('click', async (e) => {
  const li = e.target.closest('.match-r');

  // Reason strip button click (Quick Reason Pills on ▼)
  const rBtn = e.target.closest('.reason-strip button');
  if (rBtn && li) {
    const id = li.dataset.id;
    const reason = rBtn.dataset.reason;
    const r = st.ratings.get(id) || {};
    if (r.reason === reason) {
      delete r.reason;
    } else {
      r.reason = reason;
      if (reason === 'too_junior') {
        r.role = Math.max(r.role || 0, 4);
        r.level = -1;
      } else if (reason === 'too_senior') {
        r.role = Math.max(r.role || 0, 4);
        r.level = 1;
      } else if (reason === 'wrong_company') {
        r.role = Math.max(r.role || 0, 4);
        r.company = 1;
      } else if (reason === 'wrong_place') {
        r.role = Math.max(r.role || 0, 4);
        r.place = 1;
      } else if (reason === 'wrong_work') {
        r.role = 1;
      }
    }
    st.ratings.set(id, r);
    persist();
    render();
    say(L('Rating reason updated. Updating results…', 'Bewertungsgrund aktualisiert. Aktualisiere Treffer …'));
    await run(!!st.model);
    return;
  }

  // Career Step segmented control click ([Same level] [↗ Step up / Lead] [⇄ Pivot field])
  const stepBtn = e.target.closest('#career-step-group button');
  if (stepBtn) {
    const step = stepBtn.dataset.step;
    mount.querySelectorAll('#career-step-group button').forEach((b) => b.classList.toggle('on', b.dataset.step === step));
    const ts = PF.targetState();
    ts.step = step;
    PF.setTargetState(ts);
    if (st.ix) buildPersonas();
    return;
  }

  // Voting buttons (▲ / ● / ▼)
  const rate = e.target.closest('.stars button, .lvl button, .vote button');
  if (rate && li) {
    const id = li.dataset.id, k = rate.closest('[data-k]').dataset.k, v = rate.dataset.n !== undefined ? +rate.dataset.n : +rate.dataset.v;
    const r = st.ratings.get(id) || {};
    if (r[k] === v) delete r[k]; else r[k] = v;
    if (k === 'vote' && v === -1) {
      st.activeReasonId = id;
    } else if (k === 'vote' && v !== -1) {
      delete r.reason;
      if (st.activeReasonId === id) st.activeReasonId = null;
    }
    if (Object.keys(r).length) st.ratings.set(id, r); else st.ratings.delete(id);
    persist();
    if (st.ix) buildPersonas();
    render();
    $('match-taste').hidden = !hasTaste();
    return;
  }

  if (e.target.closest('.more-asp') && li) { st.more = !st.more; const id = li.dataset.id; li.querySelector('.aspects').innerHTML = aspectHtml(id); return; }
  const head = e.target.closest('.hd');
  if (head && li) { const on = li.classList.toggle('open'); head.setAttribute('aria-expanded', String(on)); if (on) fillDetail(li); return; }

  // Target Activity persona pill click
  const pe = e.target.closest('[data-persona]');
  if (pe) {
    const id = pe.dataset.persona;
    const ts = PF.targetState();
    let c = ts.ids || [];
    c = c.includes(id) ? c.filter((x) => x !== id) : [...c, id].slice(-2);
    ts.ids = c;
    PF.setTargetState(ts);
    PF.choosePersonas(c);
    buildPersonas();
    $('match-taste').hidden = !hasTaste();
    return;
  }

  if (e.target.closest('#match-save')) { PF.saveProfileFile(false); return; }
  if (e.target.closest('#match-forget')) {
    PF.forgetAll(); st.ratings.clear(); st.fields.clear();
    const ts = PF.targetState(); ts.ids = []; ts.ambition = ''; PF.setTargetState(ts);
    if (st.ix) buildFields();
    render();
    say(L('Everything this page kept on this device is gone.', 'Alles, was diese Seite auf diesem Gerät gespeichert hatte, ist gelöscht.'));
    return;
  }
  const fb = e.target.closest('#match-fields button');
  if (fb) { const f = fb.dataset.f; if (st.fields.has(f)) st.fields.delete(f); else st.fields.add(f); fb.setAttribute('aria-pressed', String(st.fields.has(f))); saveSettings(); return; }

  const btn = e.target.closest('button'); if (!btn) return;
  try {
    if (btn.id === 'match-go') { btn.disabled = true; await run(!!st.model || (await cacheReady())); btn.disabled = false; }
    else if (btn.id === 'match-model') { btn.disabled = true; await run(true); btn.disabled = false; }
    else if (btn.id === 'match-taste') { btn.disabled = true; await run(!!st.model); btn.disabled = false; }
    else if (btn.id === 'match-spread') { btn.disabled = true; await spread(); btn.disabled = false; }
    else if (btn.id === 'match-more') { st.shown += 20; render(); }
    else if (btn.id === 'match-copy') await copyRatings();
  } catch (err) { console.error(err); say(esc(err.message || String(err))); btn.disabled = false; }
});

async function copyRatings() {
  const rated = [...st.ratings].map(([id, r]) => {
    const x = st.rows.find((y) => y[0] === id);
    return { id, title: x[1], company: x[2], url: x[3], reason: r.reason, role: r.role, company_rating: r.company, place: r.place, level: r.level, skills: r.skills, interest: r.interest, pay: r.pay, would_apply: r.apply, vote: r.vote, weight: tasteWeight(r) };
  });
  if (!rated.length) { say(L('Rate a few roles first: open one and use the stars.', 'Bewerten Sie zuerst einige Stellen: eine öffnen und die Sterne nutzen.')); return; }
  const txt = rated.map((r) => `${r.reason ? '[' + r.reason + '] ' : ''}work ${r.role || '-'}/5  employer ${r.company_rating || '-'}/5  place ${r.place || '-'}/5  level ${r.level === undefined ? '-' : (r.level > 0 ? '+' : '') + r.level}${r.would_apply === undefined ? '' : '  apply ' + ['no', 'maybe', 'yes'][r.would_apply + 1]}   ${r.title} · ${r.company}  [${r.id}]`).join('\n') + '\n\n' + JSON.stringify(rated);
  try { await navigator.clipboard.writeText(txt); say(L('Copied ' + rated.length + ' ratings.', rated.length + ' Bewertungen kopiert.')); }
  catch (e) { const ta = $('match-text'); ta.value = txt; ta.select(); say(L('Copy blocked by the browser: your ratings are in the text box, select and copy them.', 'Kopieren vom Browser blockiert: Ihre Bewertungen stehen im Textfeld, bitte markieren und kopieren.')); }
}

if (location.hash === '#match') mount.querySelector('details').open = true;
window.addEventListener('hashchange', () => { if (location.hash === '#match') { mount.querySelector('details').open = true; mount.scrollIntoView({ block: 'start' }); } });
mount.querySelector('details').addEventListener('toggle', (e) => { if (e.target.open) ensureIndex().catch(() => {}); });
if (mount.querySelector('details').open) ensureIndex().catch(() => {});
cacheReady().then((ready) => { if (ready) $('match-model').hidden = true; });
document.getElementById('match-jump')?.addEventListener('click', () => { const d = mount.querySelector('details'); d.open = true; mount.scrollIntoView({ block: 'start' }); });
restoreSettings();
