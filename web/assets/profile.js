// What a visitor has told Match me and the Atlas, kept in this browser (localStorage) and, on request, in a file they save
// and load again. Nothing here is sent anywhere. Also: starting personas, which fade as the visitor marks and explores,
// and target activity operators with step-up subspace steering.
// Storage keys are `<storage_prefix>-<name>` (config.json; default "jobcrawl").

import { storageKey, profileKind, profileFileName } from './app.js';

const NAMES = { ratings: 'ratings', prefs: 'prefs', cv: 'cv', persona: 'persona', explored: 'explored', settings: 'settings', targets: 'targets' };
/** The full localStorage key of each name: {ratings: "jobcrawl-ratings", ...}. Call after loadConfig. */
export const keys = () => Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [k, storageKey(v)]));
export const getJ = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v === null ? d : v; } catch (e) { return d; } };
export const setJ = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* this page only */ } };

// ---- personas: a typical kind of work to start from when there is no CV. Each is the centre of the board roles whose titles
// match it, so it always fits the current board. Its pull fades by half for every HALF_LIFE marks (an explored lens area counts
// a quarter of a mark) and is gone after about five half-lives: what the visitor shows replaces the guess.
// The list comes from config.json (personas: [{id, label {en, de}, regex, flags}]); setPersonas() turns it into RegExps.
let PERSONAS = [];
export function setPersonas(list) {
  PERSONAS = (list || []).map((p) => ({ id: p.id, label: p.label, rx: new RegExp(p.regex, p.flags || 'i') }));
}
export const personas = () => PERSONAS;
export const HALF_LIFE = 6, START_WEIGHT = 0.8;

/** Unit vectors of the personas in the index space: {id: Float32Array}. rows: jobs-index rows (title at [1]). */
export function personaVectors(ix, rows) {
  const out = {};
  for (const { id, rx } of PERSONAS) {
    const sum = new Float32Array(ix.dim); let n = 0;
    rows.forEach((r, i) => { const o = ix.vrow[i]; if (o < 0 || !rx.test(r[1])) return; let nn = 0; for (let d = 0; d < ix.dim; d++) nn += ix.vec[o * ix.dim + d] ** 2; nn = Math.sqrt(nn) || 1; for (let d = 0; d < ix.dim; d++) sum[d] += ix.vec[o * ix.dim + d] / nn; n++; });
    if (n < 10) continue; let t = 0; for (const x of sum) t += x * x; t = Math.sqrt(t) || 1; out[id] = sum.map((x) => x / t);
  }
  return out;
}

/** Computes persona vectors partitioned by seniority level, plus the empirical Step-Up Vector:
 *  { all: {id: Float32Array}, lead: {id: Float32Array}, stepUpVec: Float32Array, levelCentroids: {entry, mid, senior, lead} }.
 *  stepUpVec is the empirical unit vector: norm(mean(lead/senior roles) - mean(entry/mid roles)).
 */
export function personaVectorsByLevel(ix, rows) {
  const dim = ix.dim;
  const all = {}, lead = {};
  const leadIdx = ix.levels ? ix.levels.indexOf('lead') : -1;
  const seniorIdx = ix.levels ? ix.levels.indexOf('senior') : -1;
  const midIdx = ix.levels ? ix.levels.indexOf('mid') : -1;
  const entryIdx = ix.levels ? ix.levels.indexOf('entry') : -1;

  for (const { id, rx } of PERSONAS) {
    const sumAll = new Float32Array(dim);
    const sumLead = new Float32Array(dim);
    let nAll = 0, nLead = 0;
    rows.forEach((r, i) => {
      const o = ix.vrow[i];
      if (o < 0 || !rx.test(r[1])) return;
      let nn = 0;
      for (let d = 0; d < dim; d++) nn += ix.vec[o * dim + d] ** 2;
      nn = Math.sqrt(nn) || 1;
      for (let d = 0; d < dim; d++) {
        const val = ix.vec[o * dim + d] / nn;
        sumAll[d] += val;
      }
      nAll++;
      const lv = ix.attrs[i] ? ix.attrs[i][1] : -1;
      if (lv === leadIdx || lv === seniorIdx) {
        for (let d = 0; d < dim; d++) sumLead[d] += ix.vec[o * dim + d] / nn;
        nLead++;
      }
    });
    if (nAll >= 5) {
      let t = 0; for (const x of sumAll) t += x * x; t = Math.sqrt(t) || 1;
      all[id] = sumAll.map((x) => x / t);
    }
    if (nLead >= 3) {
      let t = 0; for (const x of sumLead) t += x * x; t = Math.sqrt(t) || 1;
      lead[id] = sumLead.map((x) => x / t);
    }
  }

  // Level centroids and empirical step-up vector
  const levelCentroids = {};
  const levelSums = { entry: new Float32Array(dim), mid: new Float32Array(dim), senior: new Float32Array(dim), lead: new Float32Array(dim) };
  const levelCounts = { entry: 0, mid: 0, senior: 0, lead: 0 };
  const leadSum = new Float32Array(dim), jrSum = new Float32Array(dim);
  let nLeadTot = 0, nJrTot = 0;

  rows.forEach((r, i) => {
    const o = ix.vrow[i];
    if (o < 0 || !ix.attrs[i]) return;
    const lv = ix.attrs[i][1];
    let nn = 0;
    for (let d = 0; d < dim; d++) nn += ix.vec[o * dim + d] ** 2;
    nn = Math.sqrt(nn) || 1;

    let targetKey = null;
    if (lv === leadIdx) targetKey = 'lead';
    else if (lv === seniorIdx) targetKey = 'senior';
    else if (lv === midIdx) targetKey = 'mid';
    else if (lv === entryIdx) targetKey = 'entry';

    if (targetKey) {
      for (let d = 0; d < dim; d++) levelSums[targetKey][d] += ix.vec[o * dim + d] / nn;
      levelCounts[targetKey]++;
    }

    if (lv === leadIdx || lv === seniorIdx) {
      for (let d = 0; d < dim; d++) leadSum[d] += ix.vec[o * dim + d] / nn;
      nLeadTot++;
    } else if (lv === entryIdx || lv === midIdx) {
      for (let d = 0; d < dim; d++) jrSum[d] += ix.vec[o * dim + d] / nn;
      nJrTot++;
    }
  });

  for (const [code, count] of Object.entries(levelCounts)) {
    if (count > 0) {
      let t = 0; for (const x of levelSums[code]) t += x * x; t = Math.sqrt(t) || 1;
      levelCentroids[code] = levelSums[code].map((x) => x / t);
    }
  }

  const stepUpVec = new Float32Array(dim);
  if (nLeadTot > 0 && nJrTot > 0) {
    for (let d = 0; d < dim; d++) {
      stepUpVec[d] = (leadSum[d] / nLeadTot) - (jrSum[d] / nJrTot);
    }
    let t = 0; for (const x of stepUpVec) t += x * x; t = Math.sqrt(t) || 1;
    for (let d = 0; d < dim; d++) stepUpVec[d] /= t;
  }

  return { all, lead, stepUpVec, levelCentroids };
}

/** Fast projection of cvVec onto personas and level centroids (<2ms):
 *  returns { topPersonas: [id1, id2], detectedLevel: 'entry'|'mid'|'senior'|'lead', sims: {...} }.
 */
export function inferCvProfile(ix, cvVec, pData) {
  if (!cvVec || !pData) return null;
  const sims = {};
  for (const [id, vec] of Object.entries(pData.all || {})) {
    let s = 0;
    for (let d = 0; d < ix.dim; d++) s += cvVec[d] * vec[d];
    sims[id] = s;
  }
  const topPersonas = Object.entries(sims).sort((a, b) => b[1] - a[1]).slice(0, 2).map((x) => x[0]);

  let detectedLevel = 'mid', bestLvlSim = -2;
  for (const [code, vec] of Object.entries(pData.levelCentroids || {})) {
    let s = 0;
    for (let d = 0; d < ix.dim; d++) s += cvVec[d] * vec[d];
    if (s > bestLvlSim) { bestLvlSim = s; detectedLevel = code; }
  }
  return { topPersonas, detectedLevel, sims };
}

/** Target state: { ids: [...], step: 'same'|'stepup'|'pivot', ambition: '' } */
export function targetState() {
  return getJ(keys().targets, { ids: [], step: 'stepup', ambition: '' });
}
export function setTargetState(state) {
  setJ(keys().targets, state);
}

/** Generates steered query vectors combining user's CV chunk/summary vectors with chosen target activities and stepUpVec:
 *  returns [{ w, vec, persona, kind }].
 */
export function convolvedExtras(ix, cvVecs, pData) {
  const ts = targetState();
  const chosen = (ts.ids && ts.ids.length) ? ts.ids : chosenPersonas();
  const step = ts.step || 'stepup';
  const out = [];
  const dim = ix.dim;

  const cvList = Array.isArray(cvVecs) ? cvVecs.filter(Boolean) : (cvVecs ? [cvVecs] : []);
  const stepUp = (step === 'stepup' && pData && pData.stepUpVec) ? pData.stepUpVec : null;

  // 1. Add target activity vectors (at lead level if stepping up)
  for (const id of chosen) {
    const actVec = (pData && (step === 'stepup' ? (pData.lead[id] || pData.all[id]) : pData.all[id]));
    if (actVec) {
      out.push({ w: 0.90, vec: actVec, persona: id, kind: 'target_activity' });
    }
  }

  // 2. Add steered CV vectors and convolve them with target activities
  for (const cvV of cvList) {
    let steered = cvV;
    if (stepUp) {
      steered = new Float32Array(dim);
      let t = 0;
      for (let d = 0; d < dim; d++) {
        steered[d] = cvV[d] + 0.35 * stepUp[d];
        t += steered[d] * steered[d];
      }
      t = Math.sqrt(t) || 1;
      for (let d = 0; d < dim; d++) steered[d] /= t;
    }
    out.push({ w: 0.85, vec: steered, kind: 'cv_steered' });

    for (const id of chosen) {
      const actVec = (pData && pData.all[id]);
      if (actVec) {
        const conv = new Float32Array(dim);
        let t = 0;
        for (let d = 0; d < dim; d++) {
          conv[d] = 0.55 * actVec[d] + 0.45 * steered[d];
          t += conv[d] * conv[d];
        }
        t = Math.sqrt(t) || 1;
        for (let d = 0; d < dim; d++) conv[d] /= t;
        out.push({ w: 0.95, vec: conv, persona: id, kind: 'target_conv' });
      }
    }
  }
  return out;
}

const markCount = () => Object.keys(getJ(keys().ratings, {})).length + getJ(keys().explored, 0) / 4;
/** The current weight of the chosen personas (0 when none, or when they have faded). */
export function personaWeight() {
  const p = getJ(keys().persona, null); if (!p || !p.ids || !p.ids.length) return 0;
  const w = START_WEIGHT * Math.pow(0.5, Math.max(0, markCount() - (p.marks0 || 0)) / HALF_LIFE);
  return w < 0.03 ? 0 : w;
}
export function choosePersonas(ids) { setJ(keys().persona, ids.length ? { ids, marks0: markCount() } : null); }
export const chosenPersonas = () => (getJ(keys().persona, null) || { ids: [] }).ids;
/** Extra liked areas for the ranking: [{w, vec}] for the chosen personas at their current weight. */
export function personaExtras(vecs) { const w = personaWeight(); return w ? chosenPersonas().filter((id) => vecs[id]).map((id) => ({ w, vec: vecs[id], persona: id })) : []; }
/** Removes everything Match me and the Atlas keep on this device. */
export function forgetAll() { for (const key of Object.values(keys())) { try { localStorage.removeItem(key); } catch (e) { /* nothing kept */ } } }
export function bumpExplored() { setJ(keys().explored, getJ(keys().explored, 0) + 1); }

// ---- save and load: one JSON file with everything above (the CV only as its numbers, and only if the visitor ticks it)
export function profileJSON(includeCv) {
  const o = { kind: profileKind(), version: 1, saved: new Date().toISOString() };
  for (const [k, key] of Object.entries(keys())) { if (k === 'cv' && !includeCv) continue; const v = getJ(key, null); if (v !== null) o[k] = v; }
  return JSON.stringify(o);
}
export function saveProfileFile(includeCv) {
  const blob = new Blob([profileJSON(includeCv)], { type: 'application/json' }), a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = profileFileName(); document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
export async function loadProfileFile(file) {
  const o = JSON.parse(await file.text());
  if (o.kind !== profileKind()) throw new Error('This is not a saved Match me profile.');
  for (const [k, key] of Object.entries(keys())) { if (o[k] !== undefined) setJ(key, o[k]); }
  return o;
}
