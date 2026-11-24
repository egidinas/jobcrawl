// place.esm.js: generated from geobase.js + place_data.js + place_a.js at source commit 3b92e864cb (proto/transitions on feat/atlas-view-transitions, make_esm_place.sh); do not edit
// PATCHED here after 3b92e864cb (jobcrawl, 24 Nov 2026, the first-zoom freeze): loadFlat builds each outline from one path string in slices,
// landOf remembers its answers per outline, loadGeoDetail names the finer outlines (GEO.hiresIds). Port these to proto/transitions before regenerating.
// Places base for the transitions page, in the look of the site's geography page (atlas-geography.html, neon theme): flat OKLCH area fills
// ranked by posting density (deep blue = few, magenta, amber = many), thin borders, rivers, names with counts. Drawn on a 2D canvas behind
// the transparent MapLibre canvas with the map's own projection. Painting and tokens follow paintGeo / geoLayer in
// tools/geo_points/atlas.main.patched.js (feat/map-galaxy-design, 7f078f782c): fills vivid(geoHue(q), 0.50, 0.76, 0.28) at 0.82, borders at
// 0.35 / 0.6 px, rivers rgb(150,205,255) at 1.5 and 1.0 px. The place points are drawn by tx.js through GEO.afterDraw.
// Data: the page's geo-map-<scope>.json (version 2): shapes {id, name, kind, rings[[x, y, cx, cy, mx, my]]}, rivers {rank, pts}; positions in the
// scope's plane (0..1, y from the north edge); box + w map the plane to world Mercator.
const STYLE = {
  bg: '#05060a', ink: '#e6e6f0', neutral: 'rgb(26,28,36)', river: 'rgb(150,205,255)', border: 0.35, fillAlpha: 0.82,
  fieldL: [0.50, 0.76], chroma: 0.28, hue: (q) => 240 + 170 * q,   // the page's density ramp
};
const GEO = { U: 1e6, layers: [], ready: false, afterDraw: null, classed: false };
// the classed count scale shared by the place-map options (areas, hexagons, clusters): class k holds counts >= CLASS_BREAKS[k]
// one single-hue sequential ramp (blue, dark to light, colour-blind safe) for areas, clusters and legend. Areas: class bounds per level from quantiles of the counts (PlaceData.recount -> GEO.breaks);
// clusters: the fixed bounds CLASS_BREAKS (a cluster's count is not an area's count)
const CLASS_BREAKS = [2, 5, 15, 40, 120, 400, 1200], CLASS_COL = ['#1d3a6e', '#2a5298', '#3a6fbd', '#5b8fd6', '#86aee6', '#b3cff3', '#e3efff'];
const classIn = (br, n) => { let k = -1; for (let i = 0; i < br.length; i++) if (n >= br[i]) k = i; return k; };
const classOf = (n) => classIn(CLASS_BREAKS, n);
const rgbOfHex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const classRgbIn = (br, n) => { const k = classIn(br, n); return k < 0 ? rgbOfHex(CLASS_COL[0]) : rgbOfHex(CLASS_COL[k]); };
const classRgb = (n) => (n > 0 ? classRgbIn(CLASS_BREAKS, n) : null);
const geoMercX = (lon) => (lon + 180) / 360, geoMercY = (lat) => { const r = Math.max(-80, Math.min(80, lat)) * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2; };

// OKLCH helpers, as in atlas.js (the largest chroma inside the sRGB gamut; vivid() picks the lightness in a band that allows the most)
function oklinear(L, C, h) {
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
}
const inGamut = (L, C, h) => oklinear(L, C, h).every((x) => x >= 0 && x <= 1);
function maxChroma(L, h, target) { if (inGamut(L, target, h)) return target; let lo = 0, hi = target; for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (inGamut(L, mid, h)) lo = mid; else hi = mid; } return lo; }
function oklch(L, C, h) { return oklinear(L, C, h).map((x) => Math.round(255 * Math.max(0, Math.min(1, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)))); }
const vividCache = new Map();
function vivid(h, lo, hi, target) {
  const k = Math.round(h) % 360 + '/' + lo + '/' + hi + '/' + target;
  if (!vividCache.has(k)) { const hh = Math.round(h) % 360; let best = [lo, 0];
    for (let L = lo; L <= hi + 1e-9; L += 0.01) { const c = maxChroma(L, hh, target); if (c > best[1] + 1e-4) best = [L, c]; }
    vividCache.set(k, oklch(best[0], best[1], hh)); }
  return vividCache.get(k);
}

function loadGeoFile(url) {
  return fetch(url).then((r) => r.json()).then((d) => {
    const k = (d.box[2] - d.box[0]) / d.w, U = GEO.U;
    const wx = (x) => (d.box[0] + x * k) * U, wy = (y) => (d.box[1] + y * k) * U;
    const shapes = d.shapes.map((s) => {
      const path = new Path2D(); let area = 0, cx = 0, cy = 0, best = 0, bb = [1e18, 1e18, -1e18, -1e18];
      s.rings.forEach((ring) => {
        ring.forEach((p, i) => { const X = wx(p[0]), Y = wy(p[1]); i ? path.lineTo(X, Y) : path.moveTo(X, Y); if (X < bb[0]) bb[0] = X; if (Y < bb[1]) bb[1] = Y; if (X > bb[2]) bb[2] = X; if (Y > bb[3]) bb[3] = Y; }); path.closePath();
        let a = 0, sx = 0, sy = 0; for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; const c = p[0] * q[1] - q[0] * p[1]; a += c; sx += (p[0] + q[0]) * c; sy += (p[1] + q[1]) * c; }
        area += Math.abs(a) / 2; if (Math.abs(a) > best && a !== 0) { best = Math.abs(a); cx = sx / (3 * a); cy = sy / (3 * a); }
      });
      return { id: s.id, name: s.name, kind: s.kind, path, bb, areaWorld: area * k * k, mx: (d.box[0] + cx * k), my: (d.box[1] + cy * k) };
    });
    const rp = [new Path2D(), new Path2D()];
    d.rivers.forEach((r) => { const P = rp[r.rank <= 3 ? 0 : 1]; r.pts.forEach((p, i) => (i ? P.lineTo(wx(p[0]), wy(p[1])) : P.moveTo(wx(p[0]), wy(p[1])))); });
    return { shapes, rivers: rp };
  });
}
// counts per country id (ISO code) come from the postings on the page, so the numbers match the points; the colour is the page's log-density scale
// ---- the county level (NUTS3 2024, built by build_levels.py from the NUTS work), assignment of postings to units, counts that add up across levels
const yieldTask = () => new Promise((ok) => setTimeout(ok, 0));
function flatShape(s, kind) {
  let area = 0, cx = 0, cy = 0, best = 0; const bb = [1e18, 1e18, -1e18, -1e18], d = [];
  const mx = (lon) => (lon + 180) / 360, my = (lat) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2; };
  s.r.forEach((flat) => {
    let a = 0, sx = 0, sy = 0, px = 0, py = 0, fx = 0, fy = 0;
    for (let i = 0; i < flat.length; i += 2) {
      const X = mx(flat[i] / 1e4), Y = my(flat[i + 1] / 1e4), u = X * GEO.U, v = Y * GEO.U; d.push((i ? 'L' : 'M') + u + ' ' + v);
      if (u < bb[0]) bb[0] = u; if (v < bb[1]) bb[1] = v; if (u > bb[2]) bb[2] = u; if (v > bb[3]) bb[3] = v;
      if (i) { const c = px * Y - X * py; a += c; sx += (px + X) * c; sy += (py + Y) * c; } else { fx = X; fy = Y; } px = X; py = Y;
    }
    const c = px * fy - fx * py; a += c; sx += (px + fx) * c; sy += (py + fy) * c; d.push('Z');
    area += Math.abs(a) / 2; if (Math.abs(a) > best && a !== 0) { best = Math.abs(a); cx = sx / (3 * a); cy = sy / (3 * a); }
  });
  return { id: s.id, name: s.name, cc: s.cc, kind, path: new Path2D(d.join('')), bb, areaWorld: area, mx: cx, my: cy, n: 0 };
}
function loadFlat(url, kind) {
  return fetch(url).then((r) => r.json()).then(async (d) => {
    const out = []; let t0 = performance.now();
    for (const sh of d.shapes) { out.push(flatShape(sh, kind)); if (performance.now() - t0 > 30) { await yieldTask(); t0 = performance.now(); } }
    return out;
  });
}
// ---- loading in two phases (contract with the geography page, 2026-11-14)
// Phase 1, loadGeo(urls, counts, pts, opts): the world and Europe outline files only. Sets GEO.countries, GEO.states (German state counts from point-in-polygon on the state shapes, GEO.n1 per posting),
//   GEO.layers, GEO.labelSets.country / .state, GEO.ready = true; GEO.counties = [], GEO.n3 = Int32Array(N).fill(-1), GEO.detail = 'none'; labelSets.county equals labelSets.state until phase 2.
// Phase 2, loadGeoDetail(l3): l3 = {shapes: [levels_l3, levels_extra], hires, assign?}. Idempotent (the same promise when called twice). County shapes, finer outlines for the non-European countries,
//   counties by point-in-polygon (the NUTS assignment file only when l3.assign is given), c.state links, labelSets.county rebuilt, GEO.detail = 'ready', GEO.last = null, then GEO.onDetail() so the page repaints.
// loadGeo with opts.shapes does both phases in one call (pages that do not load lazily).
// pts: { T (true mercator positions), has (located), N, ids }; opts.place(landOf) may move points off a coast (called after each phase that changes the outlines).
const GEOSTATE = {};
async function loadGeo(urls, counts, pts, opts) {
  opts = opts || {}; await geoPhase1(urls, counts, pts, opts);
  if (opts.shapes) await loadGeoDetail(opts);
  return GEO.labelSets;
}
function geoLabelSets() {
  const lab = (s) => ({ t: s.name, mx: s.mx, my: s.my, get n() { return s.n; }, area: s.areaWorld, id: s.id, kind: s.kind, s });
  const countries = GEO.countries, states = GEO.states, counties = GEO.counties, ccWithCounties = new Set(counties.filter((c) => c.n > 0).map((c) => c.cc));
  const state = [...states.map(lab), ...countries.filter((s) => s.id !== 'DE').map(lab)];
  // labels by the level named: countries, states (Germany) with the countries that have none, counties with the countries that have none (until the detail phase: the states)
  GEO.labelSets = { country: countries.map(lab), state, county: counties.length ? [...counties.map(lab), ...countries.filter((s) => !ccWithCounties.has(s.id)).map(lab)] : state };
  return GEO.labelSets;
}
async function geoPhase1(urls, counts, pts, opts) {
  const [world, europe] = await Promise.all(urls.map(loadGeoFile));
  const seen = new Map(); [...world.shapes, ...europe.shapes.filter((s) => s.kind === 'country')].forEach((s) => seen.set(s.id, s));   // the europe outline replaces the world one
  const countries = [...seen.values()]; countries.forEach((s) => { s.n = counts[s.id] || 0; });
  const v = countries.filter((s) => s.n > 0 && s.areaWorld > 0).map((s) => Math.log10(s.n / s.areaWorld)).sort((a, b) => a - b);
  const dr = v.length ? [v[Math.floor(0.05 * (v.length - 1))], v[v.length - 1] + 0.5] : [0, 1];
  const colourOf = (n, area) => { if (GEO.classed) return classRgb(n); const q = Math.max(0, Math.min(1, (Math.log10(n / area) - dr[0]) / Math.max(1e-9, dr[1] - dr[0]))); return vivid(STYLE.hue(q), STYLE.fieldL[0], STYLE.fieldL[1], STYLE.chroma); };
  countries.forEach((s) => { if (s.n > 0 && s.areaWorld > 0) s.rgb = colourOf(s.n, s.areaWorld); });
  // land test per country (for placing postings on land)
  const cxl = document.createElement('canvas').getContext('2d'), landCache = new Map(), pipMemo = new WeakMap();
  const landOf = (cc) => { if (landCache.has(cc)) return landCache.get(cc); const sh = seen.get(cc); let m = sh && pipMemo.get(sh.path); if (sh && !m) pipMemo.set(sh.path, (m = new Map()));
    const o = sh ? { has: (lon, lat) => { const k = lon + ',' + lat; let r = m.get(k); if (r === undefined) { r = cxl.isPointInPath(sh.path, geoMercX(lon) * GEO.U, geoMercY(lat) * GEO.U, 'evenodd'); m.set(k, r); } return r; }, w: (sh.bb[2] - sh.bb[0]) / GEO.U * 360, h: (sh.bb[3] - sh.bb[1]) / GEO.U * 360 } : null; landCache.set(cc, o); return o; };
  Object.assign(GEOSTATE, { world, europe, seen, countries, colourOf, landOf, landCache, pts, opts, cxl });
  if (opts.place) GEO.placeStats = opts.place(landOf);
  // the German states. With a county code per posting (pts.n3code, assigned once when the place file is built) a state is the first three characters of its postings' county codes, so its count is
  // by construction the sum of its counties' counts in both phases; without codes the states are counted by point in polygon on the postings' positions (the counties are not there yet).
  const states = europe.shapes.filter((s) => s.kind === 'state'), n1 = new Int32Array(pts.N).fill(-1); states.forEach((s) => { s.n = 0; });
  if (pts.n3code) { const sid = new Map(states.map((s, j) => [s.id, j])); for (let i = 0; i < pts.N; i++) { const c = pts.has[i] && pts.n3code[i]; if (!c) continue; const j = sid.get(c.slice(0, 3)); if (j !== undefined) { n1[i] = j; states[j].n++; } } }
  else for (let i = 0; i < pts.N; i++) {
    if (!pts.has[i]) continue; const x = pts.T[2 * i] * GEO.U, y = pts.T[2 * i + 1] * GEO.U;
    for (let j = 0; j < states.length; j++) { const s = states[j]; if (x < s.bb[0] || x > s.bb[2] || y < s.bb[1] || y > s.bb[3]) continue; if (cxl.isPointInPath(s.path, x, y, 'evenodd')) { n1[i] = j; s.n++; break; } }
  }
  states.forEach((s) => { if (s.n > 0 && s.areaWorld > 0) s.rgb = colourOf(s.n, s.areaWorld); });
  GEO.layers = [{ shapes: world.shapes, rivers: world.rivers }, { shapes: europe.shapes, rivers: europe.rivers }];
  GEO.countries = countries; GEO.states = states; GEO.counties = []; GEO.n3 = new Int32Array(pts.N).fill(-1); GEO.n1 = n1; GEO.detail = 'none'; GEO.stats = { fromFile: 0, fromPip: 0, assigned: 0, counties: 0 };
  geoLabelSets(); GEO.ready = true;
}
function loadGeoDetail(l3) {
  if (GEOSTATE.detailP) return GEOSTATE.detailP;
  GEOSTATE.detailP = (async () => {
    const { world, seen, countries, colourOf, landOf, landCache, pts, opts } = GEOSTATE; l3 = l3 || {};
    const [parts, hires, assign] = await Promise.all([Promise.all((l3.shapes || []).map((u) => loadFlat(u, 'county'))), l3.hires ? loadFlat(l3.hires, 'country') : [], l3.assign ? fetch(l3.assign).then((r) => r.json()) : null]);
    const counties = parts.flat();
    // finer outlines (GISCO 1:1M, simplified by size) replace the world file's 1:50M ones for the non-European countries that have postings (the shape objects stay, so counts and colours stay)
    for (const h of hires) { const o = seen.get(h.id); if (o && world.shapes.includes(o)) { o.path = h.path; o.bb = h.bb; o.areaWorld = h.areaWorld; o.mx = h.mx; o.my = h.my; } }
    landCache.clear(); if (opts.place) GEO.placeStats = opts.place(landOf);
    // postings -> county: the NUTS assignment file when given (declared / gazetteer), else the point in the polygon on the drawn position
    const cx = document.createElement('canvas').getContext('2d'), byId = new Map(counties.map((c, i) => [c.id, i])), n3 = new Int32Array(pts.N).fill(-1); let fromFile = 0, fromPip = 0;
    if (pts.n3code) { for (let i = 0; i < pts.N; i++) { const c = pts.has[i] && pts.n3code[i]; if (!c) continue; const j = byId.get(c); if (j !== undefined) { n3[i] = j; fromFile++; } } }   // the codes assigned when the place file was built: no point in polygon at all
    else if (assign) for (let i = 0; i < pts.N; i++) { if (!pts.has[i]) continue; const k = assign.m[pts.ids[i]]; if (k !== undefined) { const j = byId.get(assign.codes[k]); if (j !== undefined) { n3[i] = j; fromFile++; } } }
    if (!pts.n3code) for (let i = 0; i < pts.N; i++) {
      if (n3[i] >= 0 || !pts.has[i]) continue; const x = pts.T[2 * i] * GEO.U, y = pts.T[2 * i + 1] * GEO.U;
      for (let j = 0; j < counties.length; j++) { const c = counties[j]; if (x < c.bb[0] || x > c.bb[2] || y < c.bb[1] || y > c.bb[3]) continue; if (cx.isPointInPath(c.path, x, y, 'evenodd')) { n3[i] = j; fromPip++; break; } }
    }
    counties.forEach((c) => { c.n = 0; }); for (let i = 0; i < pts.N; i++) if (n3[i] >= 0) counties[n3[i]].n++;
    counties.forEach((c) => { if (c.n > 0 && c.areaWorld > 0) c.rgb = colourOf(c.n, c.areaWorld); });
    // the German states = the first three characters of the county id; once the counties are there a state's count is the sum of its counties
    const states = GEO.states, stById = new Map(states.map((s) => [s.id, s])); states.forEach((s) => { s.n = 0; });
    counties.forEach((c) => { const s = stById.get(c.id.slice(0, 3)); if (s) { s.n += c.n; c.state = s; } });
    states.forEach((s) => { if (s.n > 0 && s.areaWorld > 0) s.rgb = colourOf(s.n, s.areaWorld); });
    GEO.hiresIds = hires.map((h) => h.id); GEO.counties = counties; GEO.n3 = n3; GEO.stats = { fromFile, fromPip, assigned: fromFile + fromPip, counties: counties.length }; GEO.detail = 'ready'; geoLabelSets(); GEO.last = null;
    if (GEO.onDetail) GEO.onDetail();
  })();
  return GEOSTATE.detailP;
}
// the class scale for a page that paints with its own canvas (no drawGeo): bounds and colours of a level ('country' | 'state' | 'county') and the legend rows
const classesFor = (level) => ({ breaks: (GEO.breaks || {})[level] || [], colours: CLASS_COL.slice() });
const legendRows = (level) => { const b = classesFor(level).breaks; return b.map((x, k) => [CLASS_COL[k], k < b.length - 1 ? (b[k + 1] - 1 > x ? `${x.toLocaleString('en')}–${(b[k + 1] - 1).toLocaleString('en')}` : x.toLocaleString('en')) : `${x.toLocaleString('en')}+`]); };
// the affine map from path units to css px for the current camera: [a, b, c, d, e, f] (css x = a*u + c*v + e, css y = b*u + d*v + f)
function geoAffine(m, cw, ch, U) { const w = m[15]; return [m[0] / w * 0.5 * cw / U, -m[1] / w * 0.5 * ch / U, m[4] / w * 0.5 * cw / U, -m[5] / w * 0.5 * ch / U, m[12] / w * 0.5 * cw + 0.5 * cw, (0.5 - m[13] / w * 0.5) * ch]; }
const smooth = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
// matrix: the map's mercator -> clip matrix (flat map, no pitch); cw/ch css size; dpr device pixel ratio
function drawGeo(cv, matrix, cw, ch, dpr) {
  if (!GEO.ready) return;
  const key = [matrix[0], matrix[1], matrix[4], matrix[5], matrix[12], matrix[13], matrix[15], cw, ch, dpr].join(',');
  const animating = GEO.animUntil && performance.now() < GEO.animUntil;
  if (!animating && cv.dataset.key === key) return;   // the camera has not moved (a transition, a filter): the picture is the same
  const N = geoAffine(matrix, cw, ch, GEO.U);
  // while the camera moves the last picture is carried along by a CSS transform (cheap); a full redraw follows at most every 300 ms and at rest
  if (!animating && GEO.last && performance.now() - GEO.last.t < 300) {
    const O = GEO.last.M, det = O[0] * O[3] - O[1] * O[2];
    const ia = O[3] / det, ib = -O[1] / det, ic = -O[2] / det, id = O[0] / det, ie = (O[2] * O[5] - O[3] * O[4]) / det, iff = (O[1] * O[4] - O[0] * O[5]) / det;
    cv.style.transform = `matrix(${N[0] * ia + N[2] * ib},${N[1] * ia + N[3] * ib},${N[0] * ic + N[2] * id},${N[1] * ic + N[3] * id},${N[0] * ie + N[2] * iff + N[4]},${N[1] * ie + N[3] * iff + N[5]})`;
    cv.style.transformOrigin = '0 0'; clearTimeout(GEO.tm); GEO.tm = setTimeout(() => { cv.dataset.key = ''; window.GEOAGAIN && window.GEOAGAIN(); }, 320); return;
  }
  cv.style.transform = 'none'; cv.dataset.key = key; GEO.last = { t: performance.now(), M: N };
  const g = cv.getContext('2d'), U = GEO.U, A = N[0];
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); cv.style.width = cw + 'px'; cv.style.height = ch + 'px'; }
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.fillStyle = STYLE.bg; g.fillRect(0, 0, cv.width, cv.height);
  g.setTransform(dpr * N[0], dpr * N[1], dpr * N[2], dpr * N[3], dpr * N[4], dpr * N[5]);
  const unit = 1 / Math.abs(A);   // one css px in path units
  const byId = new Map(GEO.countries.map((s) => [s.id, s]));
  const zNow = Math.log2(Math.abs(A) * U / 512), deg = 360 * cw / (512 * Math.pow(2, zNow));
  g.globalAlpha = STYLE.fillAlpha;
  for (const L of GEO.layers) for (const s of L.shapes) { if (s.kind !== 'country') continue; const c = byId.get(s.id), rgb = c && c.rgb; g.fillStyle = rgb ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : STYLE.neutral; g.fill(s.path, 'evenodd'); }
  // the levels fade in with the zoom (the page cross-fades its levels in 360 ms): the states below about 25 degrees of view, the counties below about 9
  const sa = smooth((30 - deg) / 10), ca = smooth((11 - deg) / 3);
  const vx = [(0 - N[4]) / N[0], (cw - N[4]) / N[0]], vy = [(0 - N[5]) / N[3], (ch - N[5]) / N[3]], vx0 = Math.min(...vx), vx1 = Math.max(...vx), vy0 = Math.min(...vy), vy1 = Math.max(...vy);   // the view in path units (flat map)
  const inView = (c) => !(c.bb[2] < vx0 || c.bb[0] > vx1 || c.bb[3] < vy0 || c.bb[1] > vy1);
  if (sa > 0) { g.globalAlpha = STYLE.fillAlpha * sa; for (const s of GEO.states) { g.fillStyle = s.rgb ? `rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]})` : STYLE.neutral; g.fill(s.path, 'evenodd'); } }
  if (ca > 0) { g.globalAlpha = STYLE.fillAlpha * ca; for (const c of GEO.counties) { if (!inView(c)) continue; g.fillStyle = c.rgb ? `rgb(${c.rgb[0]},${c.rgb[1]},${c.rgb[2]})` : STYLE.neutral; g.fill(c.path, 'evenodd'); } }
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.globalAlpha = STYLE.border; g.strokeStyle = STYLE.ink; g.lineWidth = 0.6 * unit;
  for (const L of GEO.layers) for (const s of L.shapes) g.stroke(s.path);
  if (ca > 0) { g.globalAlpha = STYLE.border * ca; g.lineWidth = 0.5 * unit; for (const c of GEO.counties) { if (inView(c)) g.stroke(c.path); } }
  const rw = Math.min(1.8, 0.8 + 0.25 * Math.max(0, zNow - 3));
  g.globalAlpha = 0.9; g.strokeStyle = STYLE.river;
  for (const L of GEO.layers) { g.lineWidth = 1.5 * rw * unit; g.stroke(L.rivers[0]); if (zNow >= 5.2) { g.lineWidth = 1.0 * rw * unit; g.stroke(L.rivers[1]); } }
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.globalAlpha = 1;
  if (GEO.afterDraw) GEO.afterDraw(g, matrix, cw, ch, dpr);
  g.setTransform(1, 0, 0, 1, 0, 0);
}
// PlaceData: the data side of the place map (shared by map-proto, the transitions page and atlas-geography). Plain script, no DOM.
//
// A posting is, for the place map, exactly one of
//   located      real place: its own coordinates, or one company site / an address from the raw feed (each with a basis)  -> a point, counted in areas
//   country-only a country (or region) but no real place (also a company site chosen from several)                       -> NOT a point; a figure on its country
//   none         no place at all
// and located + country-only + none = the selection. Nothing is placed at hubs. Own points just off a coast move to the nearest real place of their country.
// Arrays are aligned with the rows of postings.json that also have galaxy coordinates (the same 33,627 as the transitions page).
const PlaceData = (function () {
  const mercX = (lon) => (lon + 180) / 360, mercY = (lat) => { const r = Math.max(-80, Math.min(80, lat)) * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2; };
  // src: { postings, galaxy, coTypes, places, meta } (parsed JSON; coTypes/places/meta optional)
  function prepare(src) {
    const P = src.postings, G = src.galaxy, CT = src.coTypes || {}, PL = src.places || {}, MT = src.meta || { families: [] };
    const rows = P.rows.filter((r) => G[r[0]]), N = rows.length;
    const D = { N, rows, lon: new Float64Array(N), lat: new Float64Array(N), cat: new Uint8Array(N), basis: new Uint8Array(N), co: new Int32Array(N), fam: new Uint8Array(N), cc: [], title: [], ids: [], sel: new Uint8Array(N).fill(1),
      coName: P.companies.map((c) => c[1]), coCol: P.companies.map((c) => (CT[c[0]] ? CT[c[0]][0] : '#94a3b8')), fams: (MT.families || []).map((f) => f.name), cnt: { located: 0, country: 0, none: 0 }, coOnly: {}, nSel: 0 };
    rows.forEach((r, i) => {
      const pl = PL[r[0]], addr = pl && /^(mcf_postal|company_address)/.test(pl[2]);
      if (r[11] === 'point' && !addr) { D.lon[i] = r[9]; D.lat[i] = r[10]; D.cat[i] = 1; D.basis[i] = 1; }                                      // own coordinates
      else if (pl && !/_choice/.test(pl[2])) { D.lon[i] = pl[0]; D.lat[i] = pl[1]; D.cat[i] = 1; D.basis[i] = 2; }                              // one company site / address, basis in places
      else D.cat[i] = r[6] ? 2 : 3;                                                                                                            // country-only, or no place
      D.co[i] = r[2]; D.fam[i] = r[3]; D.cc.push(r[6]); D.title.push(String(r[1]).toLowerCase()); D.ids.push(r[0]);
    });
    return D;
  }
  // the per-cycle place file (places-v1.json, jobcrawl map/places.py): located = lon present (the generator already applied its not-located bases), country-only = a country but no point, none = no country.
  // The rows of postings.json (with galaxy coordinates) stay the rows of D; ids join to the place file; rows the place file does not have fall back to country-only / none and are counted in D.missing.
  function prepareFromPlaces(pv, src) {
    const D = prepare({ postings: src.postings, galaxy: src.galaxy, coTypes: src.coTypes, places: {}, meta: src.meta }), byId = new Map(), ci = pv.cols ? pv.cols.indexOf('n3') : -1, codes = src.codes || null; if (ci >= 0 || codes) D.n3code = new Array(D.N).fill(null);; pv.rows.forEach((r) => byId.set(r[0], r)); D.source = 'places-v1 ' + (pv.surface || ''); D.missing = 0; D.basisName = new Array(D.N).fill('');
    for (let i = 0; i < D.N; i++) {
      const r = byId.get(D.ids[i]);
      if (!r) { D.missing++; D.cat[i] = D.cc[i] ? 2 : 3; D.lon[i] = 0; D.lat[i] = 0; D.basis[i] = 0; continue; }
      D.basisName[i] = pv.bases[r[4]] || ''; if (D.n3code) D.n3code[i] = (ci >= 0 ? r[ci] : codes[r[0]]) || null;
      if (r[5] != null && r[6] != null) { D.lon[i] = r[5]; D.lat[i] = r[6]; D.cat[i] = 1; D.basis[i] = 1; D.cc[i] = r[2] || D.cc[i]; }
      else { D.lon[i] = 0; D.lat[i] = 0; D.basis[i] = 0; D.cc[i] = r[2] || ''; D.cat[i] = r[2] ? 2 : 3; }
    }
    return D;
  }
  // mercator positions + the located flag, as geobase.loadGeo wants them
  function geoInput(D) {
    const T = new Float64Array(D.N * 2), has = new Uint8Array(D.N), refresh = () => { for (let i = 0; i < D.N; i++) { has[i] = D.cat[i] === 1 ? 1 : 0; T[2 * i] = mercX(D.lon[i]); T[2 * i + 1] = mercY(D.lat[i]); } };
    refresh(); const cnt = {}; for (let i = 0; i < D.N; i++) if (D.cat[i] === 1) cnt[D.cc[i]] = (cnt[D.cc[i]] || 0) + 1;
    return { pts: { T, has, N: D.N, ids: D.ids, n3code: D.n3code }, counts: cnt, refresh };
  }
  function snapOwn(D, landOf) {   // an own-coordinate point just off its country's coast moves to the nearest real place of its country that lies on land
    const hubs = {}; let moved = 0, foreign = 0;
    for (let i = 0; i < D.N; i++) if (D.cat[i] === 1) { const l = landOf(D.cc[i]); if (l && l.has(D.lon[i], D.lat[i])) (hubs[D.cc[i]] || (hubs[D.cc[i]] = [])).push([D.lon[i], D.lat[i]]); }
    for (let i = 0; i < D.N; i++) {
      if (D.cat[i] !== 1 || D.basis[i] !== 1) continue; const l = landOf(D.cc[i]); if (!l || l.has(D.lon[i], D.lat[i])) continue;
      let near = null, nd = 1e9; for (const h of hubs[D.cc[i]] || []) { const d = Math.hypot(h[0] - D.lon[i], h[1] - D.lat[i]); if (d < nd) { nd = d; near = h; } }
      if (near && nd < 0.6) { D.lon[i] = near[0]; D.lat[i] = near[1]; moved++; } else foreign++;
    }
    return { ownMoved: moved, ownForeign: foreign };
  }
  // the selection's counts: located / country-only / none, per-area counts (geobase GEO) and the class colours; the identity located + country-only + none = selection holds by construction
  function recount(D, GEO) {
    const c = { located: 0, country: 0, none: 0 }, co = {}; GEO.counties.forEach((x) => { x.n = 0; }); GEO.states.forEach((x) => { x.n = 0; }); GEO.countries.forEach((x) => { x.n = 0; });
    const byCc = new Map(GEO.countries.map((x) => [x.id, x])), noCounty = GEO.counties.length === 0;
    for (let i = 0; i < D.N; i++) {
      if (!D.sel[i]) continue;
      if (D.cat[i] === 1) { c.located++; const k = GEO.n3[i]; if (k >= 0) { const cn = GEO.counties[k]; cn.n++; if (cn.state) cn.state.n++; } else if (noCounty && GEO.n1) { const si = GEO.n1[i]; if (si >= 0) GEO.states[si].n++; } const s = byCc.get(D.cc[i]); if (s) s.n++; }   // before the county detail is in, the state counts come from the phase-1 point in polygon (GEO.n1)
      else if (D.cat[i] === 2) { c.country++; co[D.cc[i]] = (co[D.cc[i]] || 0) + 1; } else c.none++;
    }
    // class bounds per level: quantiles of the positive counts (each level has its own scale), the same blue ramp for all
    // class bounds per level: quantiles of the counts of the areas that HAVE postings (zeros excluded), denser at the top end (the lowest class starts at the smallest count, the top class holds the top 1.5%)
    const FR = [0, 0.25, 0.5, 0.7, 0.85, 0.94, 0.985], quant = (list) => { const v = list.filter((x) => x.n > 0).map((x) => x.n).sort((a, b) => a - b), b = []; if (!v.length) return [1, 2, 3, 4, 5, 6, 7]; for (const f of FR) { let x = v[Math.min(v.length - 1, Math.floor(f * v.length))]; if (b.length && x <= b[b.length - 1]) x = b[b.length - 1] + 1; b.push(x); } return b; };
    GEO.breaks = { country: quant(GEO.countries), state: quant(GEO.states), county: quant(GEO.counties) };
    for (const [level, list] of [['county', GEO.counties], ['state', GEO.states], ['country', GEO.countries]]) list.forEach((x) => { x.rgb = x.n > 0 ? classRgbIn(GEO.breaks[level], x.n) : null; });
    D.cnt = c; D.coOnly = co; D.nSel = c.located + c.country + c.none; return c;
  }
  function select(D, query) { const q = (query || '').trim().toLowerCase(); for (let i = 0; i < D.N; i++) D.sel[i] = !q || D.title[i].includes(q) ? 1 : 0; }
  function features(D, extra) {   // GeoJSON points of the located, selected postings (for the clustering sources)
    const out = []; for (let i = 0; i < D.N; i++) if (D.cat[i] === 1 && D.sel[i] && (!extra || extra(i))) out.push({ type: 'Feature', properties: { i, c: D.coCol[D.co[i]], co: D.coName[D.co[i]] }, geometry: { type: 'Point', coordinates: [D.lon[i], D.lat[i]] } });
    return { type: 'FeatureCollection', features: out };
  }
  return { prepare, prepareFromPlaces, geoInput, snapOwn, recount, select, features, mercX, mercY };
})();
// PlaceA: the renderer of option A (Hybrid), shared by map-proto, the transitions page and atlas-geography. Plain script.
//   areas      classed choropleth drill-down (countries, German states, counties) on a 2D canvas behind the transparent MapLibre canvas (geobase.js drawGeo)
//   names      unit name + count (+ "+N country-only" on countries), sized by the unit's size on screen, no overlaps; country-only badges for countries whose name line is not drawn
//   clusters   MapLibre's own clustering (radius 45, clusterMaxZoom 11) of the located postings from zoom 8.6 (sites, then single postings), the areas fade out meanwhile
//   burst      originOf(i, zoom): where a posting starts when it leaves the place view (its area's label point at overview zoom, its own place from the cluster zoom on)
// Needs: geobase.js (GEO, drawGeo, classRgb, loadGeo...), place_data.js (PlaceData), MapLibre GL. No other page code.
const PlaceA = (function () {
  const cfg = { clusterFrom: 7.5, clusterFull: 8.5, areaFloor: 0.22, siteBelow: 8.9 };   // zoom range of the area-to-cluster hand-over; the areas stay at areaFloor under the clusters; degrees of view for the state/county name sets
  const SITE_BELOW = 8.9;
  const lonOf = (mx) => mx * 360 - 180, latOf = (my) => 180 / Math.PI * Math.atan(Math.sinh(Math.PI * (1 - 2 * my)));
  const viewDeg = (zoom, cw) => 360 * cw / (512 * Math.pow(2, zoom));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sm = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
  const stepOf = (key, v) => { const o = ['step', key, v[0]]; CLASS_BREAKS.slice(1).forEach((b, k) => o.push(b, v[k + 1])); return o; };

  // ---- label ink: the text colour is chosen per fill so that it reaches 4.5:1 (WCAG relative luminance) against the fill as drawn (fill blended with the dark ground at the area alpha); the halo is the opposite tone
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }, lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)], GROUND = [5, 6, 10];
  const effBg = (rgb, alpha) => { const f = rgb || [26, 28, 36]; return [0, 1, 2].map((k) => alpha * f[k] + (1 - alpha) * GROUND[k]); };
  const INK = { name: ['#ffffff', '#05060a'], amber: ['#f2b36b', '#4a2300'] };   // light / dark candidates; the one with the higher contrast is used
  function inkFor(rgb, alpha, kind) {
    const bg = effBg(rgb, alpha), score = (arr) => arr.map((h) => ({ h, r: contrast(hexRgb(h), bg) })).sort((x, y) => y.r - x.r);
    let c = score(INK[kind || 'name']); if (kind === 'amber' && c[0].r < 4.5) c = score(INK.name);   // an amber line keeps its colour when it reaches 4.5:1, else white or black
    const t = c[0], dark = lum(hexRgb(t.h)) < 0.3; return { text: t.h, halo: dark ? '#f4f8ff' : '#05060a', ratio: t.r };
  }
  // the contrast table for the report: every class colour (and the neutral unit) at a fill alpha
  function contrastTable(alpha) {
    const rows = CLASS_COL.map((h, k) => { const i = inkFor(hexRgb(h), alpha, 'name'), j = inkFor(hexRgb(h), alpha, 'amber'); return { class: k, fill: h, name_ink: i.text, name_ratio: +i.ratio.toFixed(2), country_only_ink: j.text, country_only_ratio: +j.ratio.toFixed(2) }; });
    const i = inkFor(null, alpha, 'name'), j = inkFor(null, alpha, 'amber'); rows.push({ class: 'neutral', fill: 'rgb(26,28,36)', name_ink: i.text, name_ratio: +i.ratio.toFixed(2), country_only_ink: j.text, country_only_ratio: +j.ratio.toFixed(2) }); return rows;
  }
  function create(opts) {   // opts: { map, D, geoCanvas, before (layer id to insert under), onChange }
    const map = opts.map, D = opts.D, geoCv = opts.geoCanvas; let lastBoxes = [], clOpacity = -1, byCc = null;
    const ctl = { D, lastBoxes: () => lastBoxes };
    ctl.fade = (zoom) => sm(cfg.clusterFull - zoom);   // (names: nameAlpha below)
    ctl.nameAlpha = (zoom) => 0.55 + 0.45 * ctl.fade(zoom);   // the names stay faintly under the clusters at city zoom (orientation)   // 1 = areas and names fully shown, 0 = clusters only (names gone; the areas stay faintly under the clusters)
    ctl.areaAlpha = (zoom) => cfg.areaFloor + (1 - cfg.areaFloor) * ctl.fade(zoom);
    ctl.addLayers = () => {
      map.addSource('ptsA', { type: 'geojson', data: PlaceData.features(D), cluster: true, clusterRadius: 45, clusterMaxZoom: 11 });   // towns stay separate from zoom 12
      map.addSource('co', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const cl = ['has', 'point_count'], z = (v) => ['interpolate', ['linear'], ['zoom'], cfg.clusterFrom, 0, cfg.clusterFull, v];
      const rad = ['step', ['get', 'point_count'], 9, 3, 12, 10, 15, 30, 19, 100, 24, 300, 30, 1000, 36], tsz = ['step', ['get', 'point_count'], 10, 3, 11, 10, 12, 30, 13, 100, 14, 300, 15, 1000, 16];
      const L = [{ id: 'A-cl', type: 'circle', source: 'ptsA', filter: cl, paint: { 'circle-color': stepOf(['get', 'point_count'], CLASS_COL), 'circle-radius': rad, 'circle-opacity': z(0.92), 'circle-stroke-width': 1.2, 'circle-stroke-color': '#05060a', 'circle-stroke-opacity': z(1) } },
        { id: 'A-ct', type: 'symbol', source: 'ptsA', filter: cl, layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Medium'], 'text-size': tsz, 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#05060a', 'text-opacity': z(1) } },
        { id: 'A-pt', type: 'circle', source: 'ptsA', filter: ['!', cl], paint: { 'circle-color': ['get', 'c'], 'circle-radius': 4, 'circle-opacity': z(1), 'circle-stroke-width': 1, 'circle-stroke-color': '#05060a', 'circle-stroke-opacity': z(1) } },
        { id: 'co-ring', type: 'circle', source: 'co', paint: { 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.2 } },
        { id: 'co-dot', type: 'circle', source: 'co', paint: { 'circle-radius': 3.2, 'circle-color': '#ffffff' } }];
      L.forEach((l) => { map.addLayer(l, opts.before); });
      ['A-cl', 'A-ct', 'A-pt'].forEach((id) => map.setLayerZoomRange(id, cfg.clusterFrom, 24));
    };
    // the selection changed (title filter): counts, colours, sources
    ctl.refresh = () => { PlaceData.recount(D, GEO); const s = map.getSource('ptsA'); if (s) s.setData(PlaceData.features(D)); if (geoCv) { geoCv.dataset.key = ''; } GEO.last = null; if (opts.onChange) opts.onChange(); map.triggerRepaint(); };
    // area canvas: the choropleth, fading out as the clusters take over; alpha = a caller's factor (for example the Places weight in a transition)
    function synthMatrix() {   // the flat-map matrix geobase's drawGeo expects (no rotation or pitch)
      const cw = map.getCanvas().clientWidth, ch = map.getCanvas().clientHeight, W = 512 * Math.pow(2, map.getZoom()), c = maplibregl.MercatorCoordinate.fromLngLat(map.getCenter());
      const m = new Float64Array(16); m[0] = 2 * W / cw; m[5] = -2 * W / ch; m[10] = 1; m[15] = 1; m[12] = -2 * c.x * W / cw; m[13] = 2 * c.y * W / ch; return m;
    }
    ctl.drawAreas = (alpha) => {
      const a = alpha === undefined ? 1 : alpha, f = a * ctl.areaAlpha(map.getZoom()); geoCv.style.display = f > 0.003 ? 'block' : 'none'; if (f <= 0.003) return;
      drawGeo(geoCv, synthMatrix(), map.getCanvas().clientWidth, map.getCanvas().clientHeight, devicePixelRatio || 1); geoCv.style.opacity = f;
    };
    // cluster layers follow a caller's factor too (a transition fades them with the Places weight); only touches the style when the value changed
    ctl.setClusterWeight = (w) => { const q = Math.round(w * 50) / 50; if (q === clOpacity) return; clOpacity = q; const z = (v) => ['interpolate', ['linear'], ['zoom'], cfg.clusterFrom, 0, cfg.clusterFull, v * q];
      map.setPaintProperty('A-cl', 'circle-opacity', z(0.92)); map.setPaintProperty('A-cl', 'circle-stroke-opacity', z(1)); map.setPaintProperty('A-ct', 'text-opacity', z(1)); map.setPaintProperty('A-pt', 'circle-opacity', z(1)); map.setPaintProperty('A-pt', 'circle-stroke-opacity', z(1)); };
    // ---- names and country-only figures
    ctl.labelItems = (g, cw, ch, zoom) => {
      const deg = viewDeg(zoom, cw), set = deg > 25 ? 'country' : deg > SITE_BELOW ? 'state' : 'county', ppu = 512 * Math.pow(2, zoom), out = [], boxes = [], shownCc = new Set();
      const hit = (bx) => boxes.some((o) => bx[0] < o[2] && bx[2] > o[0] && bx[1] < o[3] && bx[3] > o[1]);
      const top = Math.max(40, opts.topInset ? opts.topInset() : 40), chipW = Math.min(cw - 16, 214), chipBox = [cw - 8 - chipW, top + 2, cw - 8, top + 22]; boxes.push(chipBox);   // below the page's own controls   // the corner of the chip is reserved before any name
      for (const l of GEO.labelSets[set].filter((x) => x.n > 0).sort((a, b) => b.n - a.n)) {
        if (out.length >= 60) break; const p = map.project([lonOf(l.mx), latOf(l.my)]), x = p.x, y = p.y; if (x < 0 || y < top + 24 || x > cw || y > ch - 30) continue;
        const areaPx = l.area * ppu * ppu, fs = Math.max(cw < 600 ? 10 : 11, Math.min(22, Math.round(Math.sqrt(areaPx) / 8))), co = l.kind === 'country' ? D.coOnly[l.id] || 0 : 0;
        g.font = `600 ${fs}px system-ui,sans-serif`; const t1 = g.measureText(l.t).width; g.font = `500 ${Math.round(fs * 0.85)}px system-ui,sans-serif`; const cnt = l.n.toLocaleString('en'), t2 = g.measureText(cnt).width;
        const s2 = Math.round(fs * 0.7); g.font = `500 ${s2}px system-ui,sans-serif`; const ctext = co ? `+${co.toLocaleString('en')} country-only` : '', t3 = co ? g.measureText(ctext).width : 0;
        const tw = Math.max(t1, t2, t3) + 8, th = fs * 2.3 + (co ? s2 * 1.3 : 0), bx = [x - tw / 2, y - th / 2, x + tw / 2, y + th / 2];
        if (areaPx < 1.4 * tw * th || hit(bx) || bx[0] < 2 || bx[2] > cw - 2) continue; boxes.push(bx); out.push({ l, x, y, bx, fs, cnt, ctext, sm: s2, rgb: l.s && l.s.rgb }); if (l.kind === 'country') shownCc.add(l.id);
      }
      // country-only figures never float as free labels: a country's own figure is the second small line of its name; the figures of countries whose name is not drawn at this zoom add up in one chip
      let rest = 0; for (const k in D.coOnly) if (!shownCc.has(k)) rest += D.coOnly[k];
      if (rest > 0) out.push({ chip: true, t: `not placed: ${rest.toLocaleString('en')} country-only`, x: chipBox[2], y: (chipBox[1] + chipBox[3]) / 2, bx: chipBox });
      lastBoxes = out.map((p) => p.bx); return out;
    };
    ctl.paintLabels = (g, items, alpha, zoom) => {
      const fa = STYLE.fillAlpha * (zoom === undefined ? 1 : ctl.areaAlpha(zoom));   // the fill as drawn
      g.globalAlpha = Math.max(0, Math.min(1, alpha)); g.textBaseline = 'middle'; g.textAlign = 'center'; g.lineJoin = 'round';
      for (const p of items) {
        const ink = inkFor(p.rgb, fa, 'name'), am = inkFor(p.rgb, fa, 'amber'); g.lineWidth = 3.2;
        if (p.chip) { g.font = '600 11px system-ui,sans-serif'; g.textAlign = 'right'; const w = g.measureText(p.t).width + 14; g.globalAlpha = 0.9; g.fillStyle = '#0b1424'; g.strokeStyle = '#3a4a6a'; g.lineWidth = 1; g.beginPath(); g.roundRect(p.x - w, p.y - 10, w, 20, 6); g.fill(); g.stroke(); g.globalAlpha = Math.max(0, Math.min(1, alpha)); g.fillStyle = '#f2b36b'; g.fillText(p.t, p.x - 7, p.y); g.textAlign = 'center'; continue; }
        if (p.badge) { g.font = '600 11px system-ui,sans-serif'; g.strokeStyle = am.halo; g.strokeText(p.t, p.x, p.y); g.fillStyle = am.text; g.fillText(p.t, p.x, p.y); continue; }
        const y = p.y - (p.ctext ? p.sm * 0.6 : 0); g.strokeStyle = ink.halo;
        g.font = `600 ${p.fs}px system-ui,sans-serif`; g.strokeText(p.l.t, p.x, y - p.fs * 0.55); g.fillStyle = ink.text; g.fillText(p.l.t, p.x, y - p.fs * 0.55);
        g.font = `500 ${Math.round(p.fs * 0.85)}px system-ui,sans-serif`; g.strokeText(p.cnt, p.x, y + p.fs * 0.6); g.fillStyle = ink.text; g.fillText(p.cnt, p.x, y + p.fs * 0.6);
        if (p.ctext) { g.font = `500 ${p.sm}px system-ui,sans-serif`; g.strokeStyle = am.halo; g.strokeText(p.ctext, p.x, y + p.fs * 0.6 + p.sm * 1.5); g.fillStyle = am.text; g.fillText(p.ctext, p.x, y + p.fs * 0.6 + p.sm * 1.5); }
      }
      g.globalAlpha = 1;
    };
    ctl.overlaps = () => { let n = 0; for (let i = 0; i < lastBoxes.length; i++) for (let j = i + 1; j < lastBoxes.length; j++) { const a = lastBoxes[i], b = lastBoxes[j]; if (a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]) n++; } return { labels: lastBoxes.length, overlapping: n }; };
    // ---- where a posting starts when it leaves the place view: at overview zoom the label point of its unit at the label level in view (country / state / county;
    // country-only postings: their country's label point; no place: the centre of the view); from the cluster zoom on its own place (blended over the same range as the hand-over)
    ctl.originOf = (i, zoom, cw, out) => {
      byCc = byCc || new Map(GEO.countries.map((s) => [s.id, s])); const deg = viewDeg(zoom, cw), level = deg > 25 ? 0 : deg > SITE_BELOW ? 1 : 2;
      const own = D.cat[i] === 1; let u = null;
      if (own) { const k = GEO.n3[i], cn = k >= 0 ? GEO.counties[k] : null; u = level === 2 && cn ? cn : level === 1 && cn && cn.state ? cn.state : byCc.get(D.cc[i]) || cn; }
      else if (D.cat[i] === 2) u = byCc.get(D.cc[i]);
      let x, y; if (u) { x = u.mx; y = u.my; } else { const c = maplibregl.MercatorCoordinate.fromLngLat(map.getCenter()); x = c.x; y = c.y; }
      if (own) { const w = sm((zoom - cfg.clusterFrom) / (cfg.clusterFull - cfg.clusterFrom)); x += (PlaceData.mercX(D.lon[i]) - x) * w; y += (PlaceData.mercY(D.lat[i]) - y) * w; }
      out[0] = x; out[1] = y; return out;
    };
    ctl.areaAt = (lon, lat) => {
      const cx = ctl._cx || (ctl._cx = document.createElement('canvas').getContext('2d')), x = PlaceData.mercX(lon) * GEO.U, y = PlaceData.mercY(lat) * GEO.U;
      for (const list of [GEO.counties, GEO.states, GEO.countries]) for (const s of list) { if (s.bb && (x < s.bb[0] || x > s.bb[2] || y < s.bb[1] || y > s.bb[3])) continue; if (s.n > 0 && cx.isPointInPath(s.path, x, y, 'evenodd')) return s; }
      return null;
    };
    // a click: a cluster zooms in, an area names itself; returns the tooltip html or null
    ctl.click = (e) => {
      const f = map.queryRenderedFeatures(e.point, { layers: ['A-cl'] })[0];
      if (f) { map.getSource('ptsA').getClusterExpansionZoom(f.properties.cluster_id).then((z) => map.easeTo({ center: f.geometry.coordinates, zoom: z + 0.3 })); return null; }
      const a = ctl.areaAt(e.lngLat.lng, e.lngLat.lat); return a ? `<b>${esc(a.name)}</b><br>${a.n.toLocaleString('en')} open roles` : null;
    };
    // the legend of the area level in view: the class bounds of that level
    ctl.legendHtml = (zoom, cw) => {
      const deg = viewDeg(zoom, cw), lv = deg > 25 ? 'country' : deg > SITE_BELOW ? 'state' : 'county', b = (GEO.breaks || {})[lv]; if (!b) return '';
      const name = { country: 'Countries', state: 'States', county: 'Counties' }[lv];
      return `<b>${name}: open roles per area</b> ` + b.map((x, k) => `<span style="display:inline-block;width:10px;height:10px;background:${CLASS_COL[k]};margin:0 3px 0 8px;vertical-align:-1px"></span>${x.toLocaleString('en')}${k < b.length - 1 ? (b[k + 1] - 1 > x ? '–' + (b[k + 1] - 1).toLocaleString('en') : '') : '+'}`).join('') + ` <span style="opacity:.7;margin-left:8px">clusters: same colours</span>`;
    };
    ctl.stripHtml = (inView, extra) => { const c = D.cnt, f = (n) => n.toLocaleString('en');
      return `Selection <b>${f(D.nSel)}</b> = <b>${f(c.located)}</b> with a real place + <b>${f(c.country)}</b> country-only (a figure on the country, no points) + <b>${f(c.none)}</b> without a place` + (inView === undefined ? '' : ` · <b>${f(inView)}</b> in view`) + (extra || ''); };
    return ctl;
  }
  return { create, viewDeg, SITE_BELOW, cfg, contrastTable, inkFor };
})();

export { GEO, STYLE, CLASS_BREAKS, CLASS_COL, classIn, classOf, classRgb, classRgbIn, drawGeo, loadGeo, loadGeoDetail, loadGeoFile, loadFlat, classesFor, legendRows, geoAffine, vivid, PlaceData, PlaceA };
