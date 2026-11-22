// Geography pills and pins (Package B). A DOM layer over the geography canvas that changes with the zoom:
//   zoomed out  country pills (code, name, open roles)       - from the place file's rows (every role with a country)
//   zoomed in   city pills (name, open roles)                 - only roles with a real place (the place file's coordinates), each to its nearest city
//   street      company pins (logo or monogram)               - only verified exact sites (side/company-pins.json, precision 'site'); every other employer stays inside its city pill
// Counts follow the field chips (the page's own selection, PA.D.sel). A region header ("Bavaria · N employers · M open roles") and a list
// beside the map (a bottom sheet on a phone) name the same set. "Hiring now" shows or hides the pinned companies without open roles; the status
// words are the owner's (side/company-status.json): "Hiring · N open roles", "No open roles found (checked <date>)", "Careers page watched".
// The view and the filters live in the address (#v=lat,lon,deg&f=...&hn=0&pin=slug), so a link opens the same picture.
// Nothing is invented: a point is drawn only where the data has one. No external request (logos are the site's own files or a monogram).
// atlas.js loads this module after the first geography draw and gives it a narrow API (see pillsApi there); ?pills=0 keeps the classic labels.

const CSS = `
.gp-wrap{display:flex;gap:12px;align-items:stretch}.gp-wrap>.atlas-stage{flex:1 1 auto;min-width:0}
.gp-layer{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1}
.gp-pill{all:unset;box-sizing:border-box;position:absolute;left:0;top:0;pointer-events:auto;cursor:pointer;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px 0 6px;border-radius:13px;background:color-mix(in srgb,var(--paper) 90%,transparent);border:1px solid color-mix(in srgb,var(--accent-text) 55%,var(--line));color:var(--ink);font:600 12.5px/1 'Hanken Grotesk',system-ui,sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.35);will-change:transform;transition:opacity .15s}
.gp-pill:hover,.gp-pill:focus-visible{border-color:var(--accent-text);background:var(--paper);z-index:3;outline:none}.gp-pill:focus-visible{box-shadow:0 0 0 2px var(--accent)}
.gp-pill .gp-cc{font:700 10px/1 'Martian Mono',ui-monospace,monospace;letter-spacing:.03em;padding:3px 4px;border-radius:4px;background:color-mix(in srgb,var(--accent-text) 22%,transparent);color:var(--accent-text)}
.gp-pill b{color:var(--accent-text);font-weight:700;font-variant-numeric:tabular-nums}
.gp-pill.gp-city{height:24px;padding:0 9px;font-size:12px}
.gp-pin{all:unset;box-sizing:border-box;position:absolute;left:0;top:0;pointer-events:auto;cursor:pointer;width:36px;height:36px;border-radius:50%;background:#fff;border:2px solid var(--accent-text);box-shadow:0 3px 10px rgba(0,0,0,.45);will-change:transform;display:flex;align-items:center;justify-content:center;z-index:2}
.gp-pin:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.gp-pin.gp-off{opacity:.6;border-style:dashed;border-color:var(--muted)}.gp-pin.gp-sel{z-index:4;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 45%,transparent),0 3px 10px rgba(0,0,0,.45)}
.gp-pin .atlas-co-logo{margin:0;width:100%;height:100%;border-radius:50%;background:#fff}.gp-pin .atlas-co-logo img{padding:4px}.gp-pin .atlas-co-logo.mono{font-size:12px}
.gp-pin .gp-n{position:absolute;right:-8px;top:-8px;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:9px;background:var(--accent);color:var(--btn-fg,#fff);font:700 10.5px/18px 'Hanken Grotesk',system-ui,sans-serif;text-align:center}
.gp-pin.gp-dot{width:14px;height:14px;border-width:2px;background:var(--accent-text)}.gp-pin.gp-dot .atlas-co-logo,.gp-pin.gp-dot .gp-n{display:none}
.gp-pin.gp-bub{background:var(--accent);border-color:var(--paper);color:var(--btn-fg,#fff);font:700 13px/1 'Hanken Grotesk',system-ui,sans-serif;width:38px;height:38px}.gp-pin.gp-bub b{font-weight:700}
.gp-card{position:absolute;pointer-events:auto;z-index:6;width:260px;max-width:calc(100% - 16px);box-sizing:border-box;padding:12px 30px 12px 12px;border:1px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:6px}
.gp-card[hidden]{display:none}.gp-card .gp-ch{display:flex;gap:10px;align-items:center}.gp-card .atlas-co-logo{width:36px;height:36px;margin:0;flex:none}.gp-card .gp-cn{font-weight:700;font-size:14.5px;overflow-wrap:anywhere}
.gp-card .gp-st{font-size:12.5px;color:var(--muted)}.gp-card .gp-st.gp-hire{color:var(--accent-text);font-weight:600}
.gp-card a{color:var(--accent-text);text-decoration:none;font-size:12.5px}.gp-card a:hover{text-decoration:underline}.gp-card .gp-links{display:flex;flex-wrap:wrap;gap:4px 14px}
.gp-x{all:unset;cursor:pointer;position:absolute;right:6px;top:5px;width:22px;height:22px;text-align:center;line-height:22px;font-size:16px;color:var(--muted)}.gp-x:focus-visible{outline:2px solid var(--accent)}
.gp-panel{box-sizing:border-box;display:flex;flex-direction:column;min-height:0;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);overflow:hidden}
.gp-wrap>.gp-panel{flex:0 0 340px;width:340px}
.gp-head{padding:12px 14px 10px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:6px}
.gp-title{margin:0;font:700 16px/1.25 'Hanken Grotesk',system-ui,sans-serif;color:var(--ink)}.gp-sub{font-size:12.5px;color:var(--muted);line-height:1.45}.gp-sub b{color:var(--ink);font-variant-numeric:tabular-nums}
.gp-tools{display:flex;gap:6px 8px;flex-wrap:wrap;align-items:center}
.gp-tg{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:7px;font-size:12.5px;padding:4px 10px 4px 6px;border:1px solid var(--line);border-radius:14px;color:var(--muted)}.gp-tg:focus-visible{outline:2px solid var(--accent)}
.gp-tg i{display:inline-block;width:26px;height:15px;border-radius:8px;background:var(--line);position:relative;transition:background .15s}.gp-tg i::after{content:'';position:absolute;left:2px;top:2px;width:11px;height:11px;border-radius:50%;background:var(--paper);transition:transform .15s}
.gp-tg[aria-pressed=true]{color:var(--ink);border-color:var(--accent-text)}.gp-tg[aria-pressed=true] i{background:var(--accent)}.gp-tg[aria-pressed=true] i::after{transform:translateX(11px)}
.gp-list{list-style:none;margin:0;padding:4px 0;overflow:auto;flex:1 1 auto;min-height:0}
.gp-row{all:unset;box-sizing:border-box;display:flex;gap:10px;align-items:center;width:100%;padding:7px 14px;cursor:pointer;font-size:13px}.gp-row:hover,.gp-row:focus-visible{background:color-mix(in srgb,var(--accent) 12%,transparent);outline:none}
.gp-row .gp-rn{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gp-row b{color:var(--accent-text);font-variant-numeric:tabular-nums}.gp-row .gp-rs{display:block;font-size:11.5px;color:var(--muted);white-space:normal}
.gp-row .atlas-co-logo{width:24px;height:24px;margin:0;flex:none}
.gp-gh{padding:8px 14px 3px;font:700 11px/1.3 'Martian Mono',ui-monospace,monospace;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.gp-foot{padding:8px 14px;border-top:1px solid var(--line);font-size:11.5px;color:var(--muted);line-height:1.45}
.gp-grab{display:none}.gp-panel[hidden],.gp-layer[hidden]{display:none}
@media(max-width:1099px){.gp-wrap{display:block}
 .atlas-stage>.gp-panel{position:absolute;left:0;right:0;bottom:0;z-index:5;border-radius:12px 12px 0 0;border-width:1px 0 0;max-height:46%;box-shadow:0 -6px 20px rgba(0,0,0,.4)}
 .gp-panel .gp-list,.gp-panel .gp-foot{display:none}.gp-panel.gp-open .gp-list,.gp-panel.gp-open .gp-foot{display:block}.gp-panel.gp-open{max-height:62%}
 .gp-grab{all:unset;display:block;cursor:pointer;width:100%;height:20px;position:relative}.gp-grab::after{content:'';position:absolute;left:50%;top:8px;width:38px;height:4px;margin-left:-19px;border-radius:2px;background:var(--muted);opacity:.7}.gp-grab:focus-visible{outline:2px solid var(--accent)}
 .gp-sub{display:none}.gp-panel.gp-open .gp-sub{display:block}
 .gp-head{padding:0 12px 8px;border:0}.gp-panel.gp-open .gp-head{border-bottom:1px solid var(--line)}.gp-title{font-size:14.5px}
 .gp-pill{height:24px;font-size:12px}.gp-card{width:calc(100% - 16px)}}
@media(prefers-reduced-motion:reduce){.gp-pill,.gp-tg i,.gp-tg i::after{transition:none}}
`;

const EUROPE = [-25, 34, 45, 72], BAV = [8.97, 47.27, 13.84, 50.56];
const CITY_KM = 40, PIN_DEG = 1.6, CITY_DEG = 14;
const fmt = (n, de) => n.toLocaleString(de ? 'de-DE' : 'en');
const mercLon = (x) => x * 360 - 180, mercLat = (y) => 180 / Math.PI * Math.atan(Math.sinh(Math.PI * (1 - 2 * y)));
const kmBetween = (a, b, c, d) => { const p = Math.PI / 180, x = (c - a) * p * Math.cos((b + d) / 2 * p), y = (d - b) * p; return 6371 * Math.hypot(x, y); };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function init(api) {
  const { stage, PA, L } = api, de = () => api.isDe();
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const S = { hn: true, logos: true, pin: null, key: null, t0: performance.now(), pins: [], status: null, statusP: null, lastHash: '', level: '', geo: null, rec: null, open: false, hashApplied: false };

  // ---- the layer, the card and the panel
  const layer = document.createElement('div'); layer.className = 'gp-layer'; layer.setAttribute('role', 'group'); layer.setAttribute('aria-label', api.pick('Places and companies', 'Orte und Firmen'));
  const card = document.createElement('div'); card.className = 'gp-card'; card.hidden = true; card.setAttribute('role', 'dialog');
  stage.appendChild(layer); layer.appendChild(card);
  const panel = document.createElement('section'); panel.className = 'gp-panel'; panel.setAttribute('aria-label', api.pick('Region summary and list', 'Region und Liste'));
  panel.innerHTML = `<button type="button" class="gp-grab" aria-label="${esc(api.pick('Show or hide the list', 'Liste ein- oder ausblenden'))}" aria-expanded="false"></button>
<div class="gp-head"><h3 class="gp-title"></h3><div class="gp-sub"></div><div class="gp-tools"><button type="button" class="gp-tg" id="gp-hn" aria-pressed="true"><i></i>${esc(api.pick('Hiring now', 'Stellen offen'))}</button><button type="button" class="gp-tg" id="gp-logos" aria-pressed="true"><i></i>${esc(api.pick('Logos', 'Logos'))}</button></div></div>
<ul class="gp-list" role="list"></ul><div class="gp-foot"></div>`;
  const wrap = document.createElement('div'); wrap.className = 'gp-wrap'; stage.parentNode.insertBefore(wrap, stage); wrap.appendChild(stage);
  const mq = matchMedia('(min-width:1100px)'), place = () => { if (mq.matches) { if (panel.parentNode !== wrap) wrap.appendChild(panel); } else if (panel.parentNode !== stage) stage.appendChild(panel); sync(); };
  const $t = panel.querySelector('.gp-title'), $s = panel.querySelector('.gp-sub'), $l = panel.querySelector('.gp-list'), $f = panel.querySelector('.gp-foot'), $hn = panel.querySelector('#gp-hn'), $lg = panel.querySelector('#gp-logos'), $g = panel.querySelector('.gp-grab');
  mq.addEventListener ? mq.addEventListener('change', place) : mq.addListener(place);

  // ---- data: the countries, the cities, the located roles' nearest city
  const D = PA.D, N = D.N, idIx = new Map(D.ids.map((id, i) => [id, i]));
  const W = api.GEO().scopes.worldwide, K = W && W.box && W.w ? (W.box[2] - W.box[0]) / W.w : 1, wx = (x) => (W ? W.box[0] : 0) + x * K, wy = (y) => (W ? W.box[1] : 0) + y * K;
  const wd = api.data('worldwide') || { shapes: [], places: [] };
  const countries = new Map();   // cc -> {cc,name,lon,lat,ext,rings(bbox+rings in world units)}
  for (const sh of wd.shapes || []) { if (sh.kind !== 'country') continue;
    let best = null, ba = -1, polys = [];
    for (const r of sh.rings || []) { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; const pts = r.map((v) => [wx(v[0]), wy(v[1])]); for (const v of pts) { if (v[0] < a) a = v[0]; if (v[0] > c) c = v[0]; if (v[1] < b) b = v[1]; if (v[1] > d) d = v[1]; }
      const ar = (c - a) * (d - b); polys.push({ bb: [a, b, c, d], pts }); if (ar > ba) { ba = ar; best = [a, b, c, d]; } }
    if (!best) continue; const lo = mercLon((best[0] + best[2]) / 2), la = mercLat((best[1] + best[3]) / 2), w = (best[2] - best[0]) * 360;
    countries.set(sh.id, { cc: sh.id, name: sh.name, lon: lo, lat: la, w, polys }); }
  const cityList = (wd.places || []).filter((p) => p.pr === 'city').map((p) => ({ id: p.id, name: p.name, cc: String(p.id).split('|')[0], lon: mercLon(wx(p.x)), lat: mercLat(wy(p.y)), n: 0 }));
  // the located roles: each to its nearest city within CITY_KM (a one-degree grid keeps it cheap); the rest stay country-level in the pills
  const grid = new Map(); cityList.forEach((c, k) => { const g = Math.floor(c.lon) + ',' + Math.floor(c.lat); (grid.get(g) || grid.set(g, []).get(g)).push(k); });
  const roleCity = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) { if (D.cat[i] !== 1) continue; const lo = D.lon[i], la = D.lat[i], gx = Math.floor(lo), gy = Math.floor(la); let bk = -1, bd = CITY_KM;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const k of grid.get((gx + dx) + ',' + (gy + dy)) || []) { const c = cityList[k]; if (c.cc !== D.cc[i]) continue; const d = kmBetween(lo, la, c.lon, c.lat); if (d < bd) { bd = d; bk = k; } }
    roleCity[i] = bk; }
  const inEurope = (c) => c.lon >= EUROPE[0] && c.lon <= EUROPE[2] && c.lat >= EUROPE[1] && c.lat <= EUROPE[3];
  const countryAt = (lon, lat) => { const x = (lon + 180) / 360, r = lat * Math.PI / 180, y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
    for (const c of countries.values()) for (const p of c.polys) { const b = p.bb; if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue; let ins = false; const q = p.pts;
      for (let i = 0, j = q.length - 1; i < q.length; j = i++) if ((q[i][1] > y) !== (q[j][1] > y) && x < (q[j][0] - q[i][0]) * (y - q[i][1]) / (q[j][1] - q[i][1]) + q[i][0]) ins = !ins; if (ins) return c; }
    return null; };

  // a pin is drawn only where the employer has open roles placed in the pin's country (a site-table row for another company of the same name, 'Aero' in
  // Helsinki for a US company, would be a wrong point); the others stay in their city or country pill and are listed in state().pinsDropped for the geo pipeline
  const coCc = new Map(); for (let i = 0; i < N; i++) { const sl = D.coName[D.co[i]]; let m = coCc.get(sl); if (!m) coCc.set(sl, m = { n: 0 }); m.n++; if (D.cc[i]) m[D.cc[i]] = (m[D.cc[i]] || 0) + 1; }
  const pinOk = (p) => { const m = coCc.get(p.slug), c = countryAt(p.lon, p.lat); return !!m && !!c && (m[c.cc] || 0) > 0; };

  // ---- the selection's counts (the field chips; PA.key changes with them)
  function recount() { const R = { cc: new Map(), city: new Int32Array(cityList.length), co: new Map(), world: { n: 0, e: new Set() }, europe: { n: 0, lo: 0, e: new Set() }, bav: { n: 0, e: new Set() }, none: 0, located: 0 };
    for (let i = 0; i < N; i++) { if (!D.sel[i]) continue; const cc = D.cc[i]; R.world.n++; R.world.e.add(D.co[i]); if (!cc) { R.none++; continue; }
      let o = R.cc.get(cc); if (!o) R.cc.set(cc, o = { n: 0, e: new Set(), lo: 0 }); o.n++; o.e.add(D.co[i]); const c = countries.get(cc); if (c && inEurope(c)) { R.europe.n++; R.europe.e.add(D.co[i]); }
      if (D.cat[i] === 1) { o.lo++; R.located++; if (c && inEurope(c)) R.europe.lo++; if (roleCity[i] >= 0) R.city[roleCity[i]]++; if (D.n3code && D.n3code[i] && String(D.n3code[i]).startsWith('DE2')) { R.bav.n++; R.bav.e.add(D.co[i]); } }
      const sl = D.coName[D.co[i]]; R.co.set(sl, (R.co.get(sl) || 0) + 1); }
    return R; }

  // ---- pins and status (small files, read once; the status file only when a status is shown)
  const pinsP = fetch(api.dataUrl('side/company-pins.json')).then((r) => (r.ok ? r.json() : null)).then((j) => { const all = j && Array.isArray(j.pins) ? j.pins.filter((p) => p.precision === 'site' && p.verified === true && Number.isFinite(p.lat) && Number.isFinite(p.lon)) : []; S.pins = all.filter(pinOk); S.pinsDropped = all.filter((p) => !pinOk(p)).map((p) => p.slug); S.pinsWhy = all.filter((p) => !pinOk(p)).map((p) => { const m = coCc.get(p.slug), c = countryAt(p.lon, p.lat); return { slug: p.slug, name: p.name, lat: p.lat, lon: p.lon, pin_country: c ? c.cc : null, open_roles_in_board: m ? m.n : 0, role_countries: m ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'n').sort((x, y) => y[1] - x[1]).slice(0, 4)) : {}, reason: !m ? 'no open role in the public board' : !c ? 'pin point in no country shape' : 'no open role placed in the pin country' }; }); S.pinsAll = all.length; }).catch(() => {});
  const needStatus = () => { if (!S.statusP) S.statusP = fetch(api.dataUrl('side/company-status.json')).then((r) => (r.ok ? r.json() : null)).then((j) => { S.status = j && j.companies ? j.companies : {}; schedule(); }).catch(() => { S.status = {}; }); return S.statusP; };
  const statusText = (slug, n) => { const s = S.status && S.status[slug]; if (!s) return null;
    if (s.k === 'hiring') { const m = n > 0 ? n : s.n; return { k: 'hiring', t: de() ? `Stellen offen · ${m} ${m === 1 ? 'offene Stelle' : 'offene Stellen'}` : `Hiring · ${m} open ${m === 1 ? 'role' : 'roles'}` }; }
    return { k: s.k, t: de() ? s.de : s.en }; };

  // ---- the view
  const level = (deg) => (deg >= CITY_DEG ? 'country' : deg >= PIN_DEG ? 'city' : 'pin');
  function region(R, ctr, deg) {   // the named set the header counts: worldwide, Europe, one country, Bavaria (located roles, NUTS1 DE2)
    if (deg >= 95) return { name: api.pick('Worldwide', 'Weltweit'), n: R.world.n, lo: R.located, none: R.none, e: R.world.e.size, set: 'all' };
    const c = countryAt(ctr[0], ctr[1]);
    if (deg >= 14 || !c) { const inEu = ctr[0] >= EUROPE[0] && ctr[0] <= EUROPE[2] && ctr[1] >= EUROPE[1] && ctr[1] <= EUROPE[3]; if (inEu && deg >= 12 || (!c && inEu)) return { name: api.pick('Europe', 'Europa'), n: R.europe.n, lo: R.europe.lo, e: R.europe.e.size, set: 'europe' };
      if (!c) return { name: api.pick('Worldwide', 'Weltweit'), n: R.world.n, lo: R.located, none: R.none, e: R.world.e.size, set: 'all' }; }
    if (c.cc === 'DE' && deg < 7 && ctr[0] >= BAV[0] && ctr[0] <= BAV[2] && ctr[1] >= BAV[1] && ctr[1] <= BAV[3] && D.n3code) return { name: api.pick('Bavaria', 'Bayern'), n: R.bav.n, lo: R.bav.n, e: R.bav.e.size, set: 'bavaria', note: api.pick('roles with a place in Bavaria; roles known only as Germany are counted under Germany', 'Stellen mit Ort in Bayern; Stellen nur mit Land Deutschland zählen unter Deutschland') };
    const o = R.cc.get(c.cc) || { n: 0, lo: 0, e: new Set() }; return { name: nameOf(c.cc, c.name), n: o.n, lo: o.lo, e: o.e.size, set: 'country:' + c.cc }; }
  const dn = {}, nameOf = (cc, fb) => { try { const l = de() ? 'de' : 'en'; return (dn[l] || (dn[l] = new Intl.DisplayNames([l], { type: 'region' }))).of(cc) || fb || cc; } catch (e) { return fb || cc; } };
  const cityName = (c) => c.name;

  const pool = new Map();   // key -> element
  let raf = 0; const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
  const flyDeg = (c) => Math.max(3.5, Math.min(24, (c.w || 8) * 1.25));
  function el(key, cls, tag = 'button') { let e = pool.get(key); if (!e) { e = document.createElement(tag); if (tag === 'button') e.type = 'button'; e.dataset.k = key; layer.appendChild(e); pool.set(key, e); } if (e.className !== cls) e.className = cls; e._used = true; return e; }
  const put = (e, x, y, html) => { if (e._h !== html) { e.innerHTML = html; e._h = html; } e.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`; };

  function render() {
    if (!S.on) return; S.renders = (S.renders || 0) + 1; const Wd = api.W(), Hd = api.H(), deg = api.deg(), ctr = api.center(); S.deg = deg;
    if (!S.rec || S.key !== api.selKey()) { S.key = api.selKey(); S.rec = recount(); }
    const R = S.rec, lv = level(deg), boxes = [], drawn = []; let pillSum = 0, hidden = 0; S.level = lv;
    for (const e of pool.values()) e._used = false;
    const fits = (x, y, w, h) => x >= 4 && y >= 4 && x + w <= Wd - 4 && y + h <= Hd - 4 && !boxes.some((b) => x < b[2] && x + w > b[0] && y < b[3] && y + h > b[1]);
    const mark = (x, y, w, h) => boxes.push([x - 2, y - 2, x + w + 2, y + h + 2]);
    const items = []; if (Wd > 600) boxes.push([Wd - 52, 0, Wd, 190]);   // the zoom buttons
    if (lv === 'country') for (const [cc, o] of R.cc) { const c = countries.get(cc); if (!c || !o.n) { continue; }
      items.push({ k: 'c:' + cc, cls: 'gp-pill gp-country', n: o.n, name: nameOf(cc, c.name), cc, lon: c.lon, lat: c.lat, deg: flyDeg(c) });
    }
    if (lv !== 'country') cityList.forEach((c, k) => { const n = R.city[k]; if (n > 0) items.push({ k: 'y:' + c.id, cls: 'gp-pill gp-city', n, name: cityName(c), lon: c.lon, lat: c.lat, deg: Math.min(1.1, Math.max(0.5, deg / 4)) }); });
    items.sort((a, b) => b.n - a.n);
    // pins first (they sit on their site), then the pills that still fit; a pill hidden for room stays in the list
    const pins = [];
    if (lv === 'pin') for (const p of S.pins) { const n = R.co.get(p.slug) || 0; if (!n && S.hn) continue; pins.push({ p, n }); }
    pins.sort((a, b) => (b.n > 0) - (a.n > 0) || b.n - a.n);
    const pinSize = S.logos ? 36 : 14;
    // pins that would overlap become one count bubble (companies), which splits when the view zooms in
    const cl = [], gap = pinSize + 8;
    for (const q of pins) { const [x, y] = api.project(q.p.lon, q.p.lat); if (x < -40 || y < -40 || x > Wd + 40 || y > Hd + 40) continue; const c = cl.find((o) => Math.hypot(o.x - x, o.y - y) < gap);
      if (c) { c.m.push(q); c.x += (x - c.x) / c.m.length; c.y += (y - c.y) / c.m.length; } else cl.push({ x, y, m: [q] }); }
    for (const c of cl) {
      if (c.m.length > 1) { const X = c.x - 19, Y = c.y - 19; if (!fits(X, Y, 38, 38)) { hidden++; continue; } mark(X, Y, 38, 38); const lon = c.m.reduce((t, q) => t + q.p.lon, 0) / c.m.length, lat = c.m.reduce((t, q) => t + q.p.lat, 0) / c.m.length;
        const e = el('b:' + c.m.map((q) => q.p.slug).sort().join(',').slice(0, 80), 'gp-pin gp-bub'); e.setAttribute('aria-label', api.pick(`${c.m.length} companies, zoom in`, `${c.m.length} Firmen, hineinzoomen`)); put(e, X, Y, `<b>${c.m.length}</b>`); e.onclick = () => api.fly(lon, lat, Math.max(0.004, api.deg() / 3.5)); drawn.push({ kind: 'cluster', n: c.m.length }); continue; }
      const { p, n } = c.m[0], x = c.x, y = c.y, X = x - pinSize / 2, Y = y - pinSize / 2; if (!fits(X, Y, pinSize, pinSize)) { hidden++; continue; } mark(X, Y, pinSize, pinSize);
      const e = el('p:' + p.slug, 'gp-pin' + (S.logos ? '' : ' gp-dot') + (n ? '' : ' gp-off') + (S.pin === p.slug ? ' gp-sel' : '')); e.setAttribute('aria-label', `${p.name}${n ? ' · ' + n : ''}`);
      put(e, X, Y, S.logos ? api.coLogo(p.slug, p.name) + (n ? `<span class="gp-n">${n}</span>` : '') : ''); e._pin = { p, n }; e.onclick = () => openCard(p, n, x, y); drawn.push({ kind: 'pin', slug: p.slug, n }); }
    for (const it of items) { const [x, y] = api.project(it.lon, it.lat), w = 26 + it.name.length * 6.6 + String(it.n).length * 8 + (it.cc ? 22 : 0), h = it.cc ? 26 : 24; let X = x - w / 2, Y = y - h / 2, ok = fits(X, Y, w, h);
      if (!ok && lv === 'pin') for (const [ox, oy] of [[0, -h - 22], [0, h + 22], [-w / 2 - 22, 0], [w / 2 + 22, 0]]) { if (fits(X + ox, Y + oy, w, h)) { X += ox; Y += oy; ok = true; break; } }   // beside the pins on its site
      if (!ok) { hidden++; continue; } mark(X, Y, w, h); pillSum += it.n;
      const e = el(it.k, it.cls); e.setAttribute('aria-label', `${it.name}, ${fmt(it.n, de())} ${api.pick('open roles', 'offene Stellen')}`);
      put(e, X, Y, `${it.cc ? `<span class="gp-cc">${esc(it.cc)}</span>` : ''}<span class="gp-nm">${esc(it.name)}</span><b>${fmt(it.n, de())}</b>`); e.onclick = () => api.fly(it.lon, it.lat, it.deg); drawn.push({ kind: it.cc ? 'country' : 'city', key: it.k, n: it.n }); }
    for (const [k, e] of pool) if (!e._used) { e.remove(); pool.delete(k); }
    if (S.card) positionCard();
    S.drawn = drawn; S.pillSum = pillSum; S.hidden = hidden;
    header(R, ctr, deg, lv, items, pins);
    syncHash();
  }

  // the region's own roles, counted once per selection: P.n = P.ccN (every role with a country) + P.none; P.n = P.cityN (a real place, nearest city in its own country)
  // + P.noCity (a real place but no city within reach) + P.countryOnly + P.none. The header, the list rows and the check all read these.
  function partsOf(rg) { const k = rg.set + '|' + S.key; if (S.pk === k) return S.pv;
    const P = { n: 0, located: 0, withCity: 0, noCity: 0, countryOnly: 0, none: 0, e: new Set(), ccN: new Map(), cityN: new Map() };
    for (let i = 0; i < N; i++) { if (!D.sel[i]) continue; const cc = D.cc[i]; let inR;
      if (rg.set === 'all') inR = true; else if (rg.set === 'europe') { const c = countries.get(cc); inR = !!c && inEurope(c); }
      else if (rg.set === 'bavaria') inR = D.cat[i] === 1 && !!D.n3code && !!D.n3code[i] && String(D.n3code[i]).startsWith('DE2'); else inR = cc === rg.set.slice(8);
      if (!inR) continue; P.n++; P.e.add(D.co[i]);
      if (!cc) P.none++; else if (D.cat[i] === 1) { P.located++; if (roleCity[i] >= 0) { P.withCity++; P.cityN.set(roleCity[i], (P.cityN.get(roleCity[i]) || 0) + 1); } else P.noCity++; } else if (D.cat[i] === 2) P.countryOnly++; if (cc) P.ccN.set(cc, (P.ccN.get(cc) || 0) + 1); }
    S.pk = k; S.pv = P; return P; }

  function header(R, ctr, deg, lv, items, pins) {
    const rg = region(R, ctr, deg), f = (n) => fmt(n, de()), P = partsOf(rg);
    rg.n = P.n; rg.e = P.e.size; S.region = rg; S.parts = { n: P.n, located: P.located, withCity: P.withCity, noCity: P.noCity, countryOnly: P.countryOnly, none: P.none, ccSum: [...P.ccN.values()].reduce((t, v) => t + v, 0), citySum: [...P.cityN.values()].reduce((t, v) => t + v, 0) };
    $t.textContent = `${rg.name} · ${f(rg.e)} ${api.pick(rg.e === 1 ? 'employer' : 'employers', 'Arbeitgeber')} · ${f(rg.n)} ${rg.set === 'bavaria' ? api.pick(`roles placed in ${rg.name}`, `in ${rg.name} verortete Stellen`) : rg.set === 'all' ? api.pick(rg.n === 1 ? 'open role' : 'open roles', rg.n === 1 ? 'offene Stelle' : 'offene Stellen') : api.pick(`roles in ${rg.name} (by country)`, `Stellen in ${rg.name} (nach Land)`)}`;
    $s.innerHTML = rg.set === 'bavaria' ? esc(api.pick(`${f(rg.n)} open roles with a place in Bavaria (NUTS region DE2). Roles known only as Germany count under Germany.`, `${f(rg.n)} offene Stellen mit Ort in Bayern (NUTS-Region DE2). Stellen nur mit Land Deutschland zählen unter Deutschland.`))
      : esc(api.pick(`${f(P.n)} open roles in the public board: ${f(P.located)} with a place on the map, ${f(P.countryOnly)} known by country only${P.none ? `, ${f(P.none)} without a place` : ''}.`,
        `${f(P.n)} offene Stellen im öffentlichen Board: ${f(P.located)} mit Ort auf der Karte, ${f(P.countryOnly)} nur mit Land${P.none ? `, ${f(P.none)} ohne Ort` : ''}.`));
    // the list: the region's places at this level, biggest first, then what is not at a place (so the rows add up to the header); the pinned companies are a group of their own
    const rows = [], info = [];
    if (lv === 'country') { for (const [cc, n] of P.ccN) { const c = countries.get(cc); rows.push({ n, name: nameOf(cc, c && c.name), sub: '', lon: c && c.lon, lat: c && c.lat, deg: c ? flyDeg(c) : 6 }); }
      if (P.none) info.push({ n: P.none, name: api.pick('No country given', 'Ohne Länderangabe') }); }
    else { for (const [k, n] of P.cityN) { const c = cityList[k]; rows.push({ n, name: c.name, sub: nameOf(c.cc), lon: c.lon, lat: c.lat, deg: 0.8 }); }
      if (P.noCity) info.push({ n: P.noCity, name: api.pick('Placed, but no city nearby', 'Mit Ort, aber ohne Stadt in der Nähe') });
      if (P.countryOnly) info.push({ n: P.countryOnly, name: api.pick('Known by country only (no city)', 'Nur mit Land bekannt (ohne Stadt)') });
      if (P.none) info.push({ n: P.none, name: api.pick('Without a place', 'Ohne Ort') }); }
    rows.sort((a, b) => b.n - a.n); S.listSum = rows.reduce((t, r) => t + r.n, 0) + info.reduce((t, r) => t + r.n, 0); S.listN = rows.length;
    const inView = (lon, lat) => { const [x, y] = api.project(lon, lat); return x >= -20 && y >= -20 && x <= api.W() + 20 && y <= api.H() + 20; };
    const pinRows = lv === 'pin' ? pins.filter(({ p }) => inView(p.lon, p.lat)).map(({ p, n }) => ({ n, name: p.name, lon: p.lon, lat: p.lat, pin: p })) : [];
    const top = rows.slice(0, 80), key = lv + '|' + rg.set + '|' + top.map((r) => r.name + r.n).join(',') + '|' + info.map((r) => r.n).join(',') + '|' + pinRows.map((r) => r.name + r.n).join(',');
    if (S.listKey !== key) { S.listKey = key; $l.innerHTML = '';
      const head = (t) => { const li = document.createElement('li'); li.className = 'gp-gh'; li.textContent = t; $l.appendChild(li); };
      const add = (r) => { const li = document.createElement('li'), b = document.createElement(r.lon == null && !r.pin ? 'div' : 'button'); if (b.tagName === 'BUTTON') b.type = 'button'; b.className = 'gp-row';
        b.innerHTML = `${r.pin ? api.coLogo(r.pin.slug, r.pin.name) : ''}<span class="gp-rn">${esc(r.name)}${r.sub ? `<span class="gp-rs">${esc(r.sub)}</span>` : ''}</span><b>${f(r.n)}</b>`;
        if (b.tagName === 'BUTTON') b.onclick = () => { if (r.pin) { api.fly(r.lon, r.lat, 0.08); setTimeout(() => { const [x, y] = api.project(r.lon, r.lat); openCard(r.pin, r.n, x, y); }, 700); } else api.fly(r.lon, r.lat, r.deg); };
        li.appendChild(b); $l.appendChild(li); };
      if (pinRows.length) { head(api.pick('Companies with a verified site (all their open roles)', 'Firmen mit geprüftem Standort (alle ihre offenen Stellen)')); pinRows.forEach(add); head(api.pick(lv === 'country' ? 'Countries' : 'Places', lv === 'country' ? 'Länder' : 'Orte')); }
      top.forEach(add); if (rows.length > top.length) { const li = document.createElement('li'); li.className = 'gp-gh'; li.textContent = api.pick(`+ ${rows.length - top.length} more places with fewer roles`, `+ ${rows.length - top.length} weitere Orte mit weniger Stellen`); $l.appendChild(li); }
      info.forEach(add); }
    $f.textContent = api.pick(`${f(S.drawn ? S.drawn.filter((d) => d.kind === 'city' || d.kind === 'country').length : 0)} pills drawn${S.hidden ? `, ${f(S.hidden)} more kept off the map for room (all are in the list)` : ''}. Pins mark verified exact sites only and show a company's open roles in all; every other employer stays in its city's number.`,
      `${f(S.drawn ? S.drawn.filter((d) => d.kind === 'city' || d.kind === 'country').length : 0)} Pillen gezeichnet${S.hidden ? `, ${f(S.hidden)} weitere aus Platzgründen nur in der Liste` : ''}. Pins zeigen nur geprüfte genaue Standorte und alle offenen Stellen der Firma; jeder andere Arbeitgeber steht in der Zahl seiner Stadt.`);
    if (mq.matches) panel.style.height = api.H() + 'px'; else { const sc = stage.querySelector('.atlas-scrub:not([hidden])'); panel.style.bottom = (sc ? sc.offsetHeight : 0) + 'px'; }
  }

  // ---- the company card
  function openCard(p, n, x, y) { if (!mq.matches) { panel.classList.remove('gp-open'); sync(); } S.pin = p.slug; S.card = { p, n }; needStatus().then(() => { if (S.card && S.card.p === p) fillCard(); }); fillCard(); schedule(); }
  function fillCard() { const { p, n } = S.card, s = statusText(p.slug, n), link = api.companyLink(p.slug), cat = `atlas-companies.html#company=${encodeURIComponent(p.slug)}`;
    const roles = n > 0 ? `${f(n)} ${api.pick(n === 1 ? 'open role' : 'open roles', n === 1 ? 'offene Stelle' : 'offene Stellen')} →` : '';
    card.innerHTML = `<button type="button" class="gp-x" aria-label="${esc(api.pick('Close', 'Schließen'))}">×</button><div class="gp-ch">${api.coLogo(p.slug, p.name)}<span class="gp-cn">${esc(p.name)}</span></div>`
      + (s ? `<div class="gp-st${s.k === 'hiring' ? ' gp-hire' : ''}">${esc(s.t)}</div>` : '')
      + `<div class="gp-links">${roles ? (link ? `<a href="${esc(link)}">${esc(roles)}</a>` : `<span>${esc(roles)}</span>`) : ''}${link && !roles ? `<a href="${esc(link)}">${esc(api.pick('Company page', 'Firmenseite'))}</a>` : ''}<a href="${esc(cat)}">${esc(api.pick('Show in the company atlas', 'Im Firmen-Atlas zeigen'))}</a></div>`;
    card.hidden = false; card.querySelector('.gp-x').onclick = closeCard; positionCard(); }
  const f = (n) => fmt(n, de());
  function positionCard() { if (!S.card) return; const [x, y] = api.project(S.card.p.lon, S.card.p.lat), Wd = api.W(), Hd = api.H(), w = card.offsetWidth || 260, h = card.offsetHeight || 120;
    if (Wd < 600) { card.style.left = '8px'; card.style.top = '8px'; return; }   // a phone: the card at the top, the pin stays in sight below it
    let cx = x + 26, cy = y - h / 2; if (cx + w > Wd - 8) cx = x - 26 - w; cx = Math.max(8, cx); cy = Math.max(8, Math.min(Hd - h - 8, cy)); card.style.left = cx + 'px'; card.style.top = cy + 'px'; }
  function closeCard() { S.card = null; S.pin = null; card.hidden = true; schedule(); }
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.card) closeCard(); });

  // ---- toggles
  function sync() { $hn.setAttribute('aria-pressed', String(S.hn)); $lg.setAttribute('aria-pressed', String(S.logos)); const open = panel.classList.contains('gp-open'); $g.setAttribute('aria-expanded', String(open)); if (!mq.matches) panel.style.height = ''; }
  $hn.onclick = () => { S.hn = !S.hn; sync(); if (!S.hn) needStatus(); schedule(); };
  $lg.onclick = () => { S.logos = !S.logos; sync(); schedule(); };
  $g.onclick = () => { panel.classList.toggle('gp-open'); sync(); };

  // ---- the address: #v=lat,lon,deg&f=<chips>&hn=0&logos=0&pin=<slug>
  const chips = () => [...document.querySelectorAll('#atlas-fields button[aria-pressed="true"]')].map((b) => b.dataset.f).filter(Boolean);
  function syncHash() { if (!S.hashApplied || S.ht) return; S.ht = setTimeout(() => { S.ht = 0; const c = api.center(), q = [`v=${c[1].toFixed(3)},${c[0].toFixed(3)},${(+api.deg().toPrecision(3))}`]; const fs = chips(); for (const x of fs) q.push('f=' + encodeURIComponent(x));
      if (!S.hn) q.push('hn=0'); if (!S.logos) q.push('logos=0'); if (S.pin) q.push('pin=' + encodeURIComponent(S.pin)); const h = '#' + q.join('&');
      if (h !== S.lastHash && h !== location.hash) { S.lastHash = h; try { history.replaceState(null, '', location.pathname + location.search + h); } catch (e) { /* the address stays */ } } }, 300); }
  function applyHash() { S.hashApplied = true; const h = location.hash.slice(1); if (!/(^|&)v=/.test(h)) return; S.lastHash = '#' + h; if (S.card && !/(^|&)pin=/.test(h)) closeCard(); const P = new URLSearchParams(h), v = (P.get('v') || '').split(',').map(Number);
    if (P.get('hn') === '0') S.hn = false; if (P.get('logos') === '0') S.logos = false; sync();
    const wantF = new Set(P.getAll('f').map((x) => x.toLowerCase())); let clicked = 0;
    document.querySelectorAll('#atlas-fields button[data-f]').forEach((b) => { if (wantF.has(b.dataset.f.toLowerCase()) !== (b.getAttribute('aria-pressed') === 'true')) { b.click(); clicked++; } });
    const go = () => { if (v.length === 3 && v.every(Number.isFinite)) api.fly(v[1], v[0], v[2], true); const pin = P.get('pin');   // a field chip refits the map: the view from the address comes after it
      if (pin) pinsP.then(() => { const p = S.pins.find((x) => x.slug === pin); if (p) { needStatus(); setTimeout(() => { S.rec = null; render(); openCard(p, (S.rec || (S.rec = recount())).co.get(p.slug) || 0); }, 300); } }); };
    if (clicked) setTimeout(go, 900); else go(); }
  addEventListener('hashchange', () => { if (S.on && location.hash !== S.lastHash) applyHash(); });
  place(); S.on = false;
  const api2 = { tick(on) { S.on = !!on; layer.hidden = !on; panel.hidden = !on; wrap.classList.toggle('gp-off', !on); if (on) { if (!S.hashApplied) { applyHash(); } schedule(); } },
    state() { const rg = S.region || {}; return { level: S.level, deg: S.deg, region: rg.name, set: rg.set, employers: rg.e, roles: rg.n, pills: (S.drawn || []).filter((d) => d.kind === 'city' || d.kind === 'country'), pins: (S.drawn || []).filter((d) => d.kind === 'pin'), pillSum: S.pillSum, hidden: S.hidden, listSum: S.listSum, listN: S.listN, parts: S.parts,
      world: S.rec ? { roles: S.rec.world.n, employers: S.rec.world.e.size, located: S.rec.located, none: S.rec.none, countrySum: [...S.rec.cc.values()].reduce((t, o) => t + o.n, 0), citySum: [...S.rec.city].reduce((t, n) => t + n, 0) } : null,
      hiringNow: S.hn, logos: S.logos, card: S.card ? S.card.p.slug : null, pinsLoaded: S.pins.length, pinsDropped: S.pinsDropped || [], pinsAll: S.pinsAll, pinsWhy: S.pinsWhy || [], clusters: (S.drawn || []).filter((d) => d.kind === 'cluster').length, ms: Math.round(performance.now() - S.t0), renders: S.renders }; },
    fly: api.fly, openPin(slug) { const p = S.pins.find((x) => x.slug === slug); if (p) openCard(p, (S.rec || (S.rec = recount())).co.get(slug) || 0); },
    toggleHiring(v) { S.hn = !!v; sync(); schedule(); } };
  return api2;
}
