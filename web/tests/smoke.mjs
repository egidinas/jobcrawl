// Smoke test of the web app in a real browser (Playwright, when it is installed; otherwise it prints "skipped" and exits 0).
//
//   node web/tests/smoke.mjs                 (SMOKE_DATA: the data folder; default demo/site, skipped when it is missing)
//   SMOKE_DATA=/path/to/site node web/tests/smoke.mjs
//
// Starts scripts/serve.py on a free port, then at 400 px wide: index.html (keyword search, a role's drawer), match.html
// (Match me in keyword mode, no model) and atlas.html (the canvas draws). Fails on any page error or console error, except
// the expected "model not found" notice, and on any page that scrolls sideways.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.resolve(process.env.SMOKE_DATA || path.join(ROOT, 'demo', 'site'));
const EXPECTED_NOTICE = /model not found/;

// what the data folder holds: the config, and a query taken from its newest role (so any published folder works)
function readData(dir) {
  const read = (rel) => JSON.parse(readFileSync(path.join(dir, rel), 'utf-8'));
  if (!existsSync(path.join(dir, 'config.json')) || !existsSync(path.join(dir, 'jobs-index.json'))) return null;
  const config = read('config.json'), rows = read('jobs-index.json');
  // a query the keyword index holds: a term of match-bm25.json in 2 to 30 % of the roles (match_index.py keeps 2 .. 40 %)
  let query = 'engineer';
  if (existsSync(path.join(dir, 'match', 'match-bm25.json'))) {
    const bm = read('match/match-bm25.json');
    const pool = Object.entries(bm.post).map(([w, p]) => [w, p.length / 2]).filter(([, c]) => c >= 2);
    const pick = (max) => pool.filter(([, c]) => c <= max * bm.n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const best = pick(0.3) || pick(0.4);
    if (best) query = best[0];
  }
  return { config, rows, query, hasAtlas: existsSync(path.join(dir, 'match', 'atlas-layout.json')) };
}

function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) {
    try { return require(name); } catch (e) { /* not installed under this name */ }
  }
  return null;
}

function startServer(data) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [path.join(ROOT, 'scripts', 'serve.py'), '--data', data, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('serve.py did not start')); }, 15000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/serving http:\/\/[^:]+:(\d+)\//);
      if (m) { clearTimeout(timer); resolve({ child, base: `http://127.0.0.1:${m[1]}/` }); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`serve.py exited with ${code}: ${out.trim()}`)); });
  });
}

async function main() {
  const pw = loadPlaywright();
  if (!pw) { console.log('smoke: skipped (Playwright is not installed; npm i playwright, or make it resolvable from here)'); return 0; }
  if (!existsSync(DATA)) { console.log(`smoke: skipped (data folder not found: ${DATA}; set SMOKE_DATA)`); return 0; }
  const data = readData(DATA);
  if (!data) { console.log(`smoke: skipped (${DATA} has no config.json and jobs-index.json: run jobcrawl publish)`); return 0; }
  let browser;
  try { browser = await pw.chromium.launch(); } catch (e) { console.log(`smoke: skipped (no browser: ${e.message.split('\n')[0]})`); return 0; }
  const server = await startServer(DATA);
  const failures = [];
  let checks = 0;
  const ok = (cond, msg) => { checks++; if (!cond) failures.push(msg); return cond; };
  try {
    const context = await browser.newContext({ viewport: { width: 400, height: 860 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    let where = 'start';
    page.on('pageerror', (e) => failures.push(`[${where}] page error: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !EXPECTED_NOTICE.test(msg.text())) failures.push(`[${where}] console error: ${msg.text()}`);
    });
    const noSideScroll = async (name) => ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `[${name}] the page scrolls sideways at 400 px`);

    // 1. the job list: keyword search, filters, paging, the detail drawer
    where = 'index';
    await page.goto(server.base + 'index.html');
    await page.waitForSelector('#results .role-title');
    ok((await page.locator('#results .role-title').count()) > 0, '[index] no roles listed');
    await page.selectOption('#f-scope', { index: data.config.scopes.length - 1 });   // the widest region: every role
    await page.fill('#q', data.query);
    await page.waitForTimeout(400);                      // the search is debounced (120 ms) and re-renders the list
    await page.waitForFunction(() => /role|Stellen/.test(document.getElementById('status').textContent));
    const hits = await page.locator('#results .role-title').count();
    ok(hits > 0, `[index] keyword search "${data.query}" found no roles`);
    const firstTitle = (await page.locator('#results .role-title').first().textContent()) || '';
    await page.locator('#results .role-title').first().click();
    await page.waitForSelector('#drawer:not([hidden]) #d-title');
    ok(((await page.textContent('#d-title')) || '').trim() === firstTitle.trim(), '[index] the drawer shows another role than the one clicked');
    ok(/#[0-9a-f]{8}$/.test(page.url()), '[index] the drawer does not set the role id as the hash');
    const hash = new URL(page.url()).hash;               // closing the drawer clears it
    await page.keyboard.press('Escape');
    await page.waitForSelector('#drawer[hidden]', { state: 'attached' });
    await noSideScroll('index');
    // a role id in the hash opens its drawer on load
    await page.goto(server.base + 'index.html' + (hash || ''));
    await page.waitForSelector('#drawer:not([hidden]) #d-title');

    // 2. Match me: keyword mode, no model
    where = 'match';
    await page.goto(server.base + 'match.html');
    await page.waitForSelector('#match-text');
    await page.fill('#match-text', 'Thermal vacuum test engineer with satellite integration and qualification experience.');
    await page.click('#match-go');
    await page.waitForSelector('#match-results .match-r');
    ok((await page.locator('#match-results .match-r').count()) > 0, '[match] keyword matching returned no roles');
    await noSideScroll('match');

    // 3. Atlas: the canvas draws
    where = 'atlas';
    if (!data.hasAtlas) console.log('smoke: atlas skipped (no match/atlas-layout.json in the data folder: run jobcrawl map)');
    else {
    await page.goto(server.base + 'atlas.html');
    await page.waitForFunction(() => /shown|gezeigt/.test(document.getElementById('atlas-status')?.textContent || ''), null, { timeout: 30000 });
    const painted = await page.evaluate(() => {
      const c = document.getElementById('atlas-cv');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    });
    ok(painted > 0, '[atlas] the canvas is blank');
    await noSideScroll('atlas');
    }
    await context.close();
  } catch (e) {
    failures.push(`exception: ${e.message}`);
  } finally {
    server.child.kill();
    await browser.close();
  }
  if (failures.length) {
    console.error(`smoke: FAILED (${failures.length})`);
    for (const f of failures) console.error('  ' + f);
    return 1;
  }
  console.log(`smoke: ok (${checks} checks, data ${DATA})`);
  return 0;
}

process.exitCode = await main();
