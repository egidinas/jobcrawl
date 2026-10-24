// Shared by the three pages (index.html, match.html, atlas.html): where the data folder is, config.json (read once),
// the language, the storage keys, the header and the footer. Plain browser modules, no build step.
// Every URL is relative to this file or to the page, so the web folder works under any base path.
// The data folder is ?data=<folder>, else <meta name="jobcrawl-data" content="<folder>"> in the page (a site that serves the data
// from its own root), else data/. It holds the files `jobcrawl publish` wrote (config.json, jobs-*.json, match/).
// Site-specific behaviour comes from config.json: link templates (role_url, company_url), the default scope, and the names under
// which the browser keeps the visitor's data (storage). Every key is optional; profiles/schema.md lists them under `web`.

const PARAMS = new URL(location.href).searchParams;
const DEFAULT_PREFIX = 'jobcrawl';
const PAGE_NAMES = { index: { en: 'Jobs', de: 'Stellen' }, match: { en: 'Match me', de: 'Passende Stellen' }, atlas: { en: 'Atlas', de: 'Atlas' } };
const NAV = [['index', 'index.html', 'Jobs', 'Stellen'], ['match', 'match.html', 'Match me', 'Passende Stellen'], ['atlas', 'atlas.html', 'Atlas', 'Atlas']];

const META_DATA = (() => { try { return document.querySelector('meta[name="jobcrawl-data"]')?.content || null; } catch (e) { return null; } })();
export const DATA_BASE = (() => {
  const u = new URL(PARAMS.get('data') || META_DATA || 'data/', location.href);
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.href;
})();
/** An absolute URL inside the data folder. */
export const dataUrl = (path = '') => new URL(path, DATA_BASE).href;
/** A page of the web app, carrying the data folder along. */
export const pageUrl = (file) => { const d = PARAMS.get('data'); return d ? `${file}?data=${encodeURIComponent(d)}` : file; };
const fill = (tpl, key, v) => tpl.split(`{${key}}`).join(encodeURIComponent(v));
/** The detail view of one role: config role_url ("job.html?id={id}"), else the index page with the role's id as its hash. */
export const roleLink = (id) => (cfg && cfg.role_url ? fill(cfg.role_url, 'id', id) : `${pageUrl('index.html')}#${encodeURIComponent(id)}`);
/** The page of an employer (config company_url, e.g. "company-{slug}.html"), or null when the site has none. */
export const companyLink = (slug) => (cfg && cfg.company_url && slug ? fill(cfg.company_url, 'slug', slug) : null);
/** Index (in config scopes) of the scope a page starts with: config default_scope (an id), else the first. */
export const defaultScope = () => { const k = cfg && cfg.default_scope ? cfg.scopes.findIndex((s) => s.id === cfg.default_scope) : -1; return k < 0 ? 0 : k; };

let cfg = null, cfgPromise = null, prefix = DEFAULT_PREFIX, store = {};
/** config.json of the data folder, fetched once. Rejects with a message that names the folder when it is missing. */
export function loadConfig() {
  if (!cfgPromise) {
    cfgPromise = fetch(dataUrl('config.json')).then((r) => {
      if (!r.ok) throw new Error(`config.json not found in ${DATA_BASE} (HTTP ${r.status}). Run jobcrawl publish, or open this page with ?data=<folder>.`);
      return r.json();
    }).then((c) => { cfg = c; store = c.storage || {}; prefix = store.prefix || c.storage_prefix || DEFAULT_PREFIX; return c; });
  }
  return cfgPromise;
}
/** The loaded config (after loadConfig). */
export const config = () => cfg;
/** localStorage key for this site: `<storage.prefix>-<name>`. */
export const storageKey = (name) => `${prefix}-${name}`;
/** Where the language choice is kept (storage.lang, else <prefix>-lang); a site may share it with its own pages. */
const langKey = () => store.lang || storageKey('lang');
/** Name of the browser cache that keeps the model files (storage.model_cache, else <prefix>-eg2-v1). */
export const modelCache = () => store.model_cache || storageKey('eg2-v1');
/** The "kind" a saved profile file carries (storage.profile_kind, else jobcrawl-profile), and its file name. */
export const profileKind = () => store.profile_kind || 'jobcrawl-profile';
export const profileFileName = () => store.profile_file || 'jobcrawl-profile.json';

/** The language in use: the stored choice when the config offers it, else English, else the first language offered. */
export function curLang() {
  const langs = cfg ? cfg.languages : ['en'];
  let v = null; try { v = localStorage.getItem(langKey()); } catch (e) { /* default below */ }
  if (langs.includes(v)) return v;
  return langs.includes('en') ? 'en' : langs[0];
}
export const isDe = () => curLang() === 'de';
/** English or German text for the current language (German falls back to English when it is missing). */
export const pick = (en, de) => (isDe() && de ? de : en);
/** Text of a {en, de} label from the config. */
export const labelText = (l) => (l ? pick(l.en, l.de) : '');
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** Bilingual HTML text: the current language is shown, both are kept for the language switch. */
export const L = (en, de) => `<span data-en="${esc(en)}" data-de="${esc(de ?? en)}">${esc(pick(en, de))}</span>`;
/** Bilingual placeholder attributes. */
export const LP = (en, de) => `placeholder="${esc(pick(en, de))}" data-en-placeholder="${esc(en)}" data-de-placeholder="${esc(de ?? en)}"`;

/** Stores the language and reloads the page, so every view is rendered in it. */
export function setLang(v) {
  try { localStorage.setItem(langKey(), v); } catch (e) { /* kept for this page only */ }
  location.reload();
}

function applyStatic() {
  const de = isDe();
  document.querySelectorAll('[data-de]').forEach((el) => {
    if (el.dataset.en === undefined) el.dataset.en = el.textContent;
    el.textContent = de ? el.dataset.de : el.dataset.en;
  });
  document.querySelectorAll('[data-de-placeholder]').forEach((el) => {
    if (el.dataset.enPlaceholder === undefined) el.dataset.enPlaceholder = el.getAttribute('placeholder') || '';
    el.setAttribute('placeholder', de ? el.dataset.dePlaceholder : el.dataset.enPlaceholder);
  });
}

function renderHeader(page, c) {
  const h = document.getElementById('site-header'); if (!h) return;
  const langs = c.languages || ['en'], cur = curLang();
  h.innerHTML = `<div class="wrap bar"><a class="brand" href="${pageUrl('index.html')}">${esc(c.title || c.name)}</a>
<nav aria-label="${esc(pick('Views', 'Ansichten'))}"><ul class="nav">${NAV.map(([id, file, en, de]) => `<li><a href="${pageUrl(file)}"${id === page ? ' aria-current="page"' : ''}>${L(en, de)}</a></li>`).join('')}</ul></nav>
${langs.length > 1 ? `<div class="langs" role="group" aria-label="Language / Sprache">${langs.map((l) => `<button type="button" data-lang="${esc(l)}" aria-pressed="${l === cur}">${esc(l.toUpperCase())}</button>`).join('')}</div>` : ''}</div>`;
  h.addEventListener('click', (e) => { const b = e.target.closest('[data-lang]'); if (b && b.dataset.lang !== cur) setLang(b.dataset.lang); });
}

function renderFooter(c) {
  const f = document.getElementById('site-footer'); if (!f) return;
  const refs = (c.links && c.links.reference) || [];
  f.innerHTML = `<div class="wrap">${c.tagline ? `<p>${esc(c.tagline)}</p>` : ''}
<p class="muted small">${L('Public postings, read and ranked on this device. Nothing you type is uploaded.', 'Öffentliche Ausschreibungen, auf diesem Gerät gelesen und sortiert. Nichts, was Sie eingeben, wird hochgeladen.')}</p>
${refs.length ? `<p class="small refs"><span>${L('Reference sites:', 'Referenzseiten:')}</span> ${refs.map((r) => `<a href="${esc(r.url)}" rel="noopener">${esc(r.label)}</a>`).join(' · ')}</p>` : ''}</div>`;
}

/** Loads the config, sets the language, accent, title, header, footer. Call first on every page. Returns the config. */
export async function boot(page) {
  let c;
  try { c = await loadConfig(); } catch (e) {
    const main = document.querySelector('main');
    if (main) main.insertAdjacentHTML('afterbegin', `<p class="notice error" role="alert">${esc(e.message)}</p>`);
    throw e;
  }
  document.documentElement.lang = curLang();
  if (c.accent) { const s = document.documentElement.style; s.setProperty('--accent', c.accent); s.setProperty('--accent-text', c.accent); }
  const names = PAGE_NAMES[page] || { en: '', de: '' };
  document.title = `${c.title || c.name} · ${pick(names.en, names.de)}`;
  renderHeader(page, c); renderFooter(c); applyStatic();
  return c;
}
