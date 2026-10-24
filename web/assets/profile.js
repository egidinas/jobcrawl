// What a visitor has told Match me and the Atlas, kept in this browser (localStorage) and, on request, in a file they save
// and load again. Nothing here is sent anywhere. Also: starting personas, which fade as the visitor marks and explores.
// Storage keys are `<storage_prefix>-<name>` (config.json; default "jobcrawl").

import { storageKey, profileKind, profileFileName } from './app.js';

const NAMES = { ratings: 'ratings', prefs: 'prefs', cv: 'cv', persona: 'persona', explored: 'explored', settings: 'settings' };
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
