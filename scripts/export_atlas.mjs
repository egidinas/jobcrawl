// Export the role atlas as PNG images: the roles map (worldwide scope) and the companies map.
//
//   node scripts/export_atlas.mjs --data <folder> [--out <dir>] [--scale 5] [--theme neon|light]
//
// Starts scripts/serve.py on a free port for the data folder, opens atlas.html, waits for the map, and writes
// <out>/atlas-roles-worldwide.png and <out>/atlas-companies.png (the image of web/assets/atlas.js renderImage, at scale times
// the 900 x 640 map, in the neon or the light theme; light files get a -light suffix). The worldwide scope is the one whose config entry has match.any, else the last. Needs Playwright
// (NODE_PATH, or installed next to this script's repo).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage(msg) { if (msg) console.error(`export_atlas: ${msg}`); console.error('usage: node scripts/export_atlas.mjs --data <folder> [--out <dir>] [--scale 5] [--theme neon|light]'); process.exit(2); }
function parseArgs(argv) {
  const a = { data: null, out: process.cwd(), scale: 5, theme: 'neon' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--data') { a.data = v; i++; } else if (k === '--out') { a.out = v; i++; } else if (k === '--scale') { a.scale = Number(v); i++; } else if (k === '--theme') { a.theme = v; i++; } else usage(`unknown argument ${k}`);
  }
  if (!a.data) usage('--data is required');
  if (!(a.scale > 0 && a.scale <= 8)) usage('--scale must be a number from 0 to 8');
  if (!['neon', 'light'].includes(a.theme)) usage('--theme must be neon or light');
  return a;
}
function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) { try { return require(name); } catch (e) { /* not under this name */ } }
  throw new Error('Playwright is not installed (set NODE_PATH to its node_modules folder)');
}
function startServer(data) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [path.join(ROOT, 'scripts', 'serve.py'), '--data', data, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('serve.py did not start')); }, 15000);
    child.stdout.on('data', (d) => { out += d; const m = out.match(/serving http:\/\/[^:]+:(\d+)\//); if (m) { clearTimeout(timer); resolve({ child, base: `http://127.0.0.1:${m[1]}/` }); } });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`serve.py exited with ${code}: ${out.trim()}`)); });
  });
}
// width and height from the PNG header (IHDR)
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = path.resolve(args.data), out = path.resolve(args.out);
  if (!existsSync(path.join(data, 'config.json'))) throw new Error(`no config.json in ${data}`);
  if (!existsSync(path.join(data, 'match', 'atlas-layout.json'))) throw new Error(`no match/atlas-layout.json in ${data}: run jobcrawl map and publish`);
  const config = JSON.parse(readFileSync(path.join(data, 'config.json'), 'utf-8'));
  const k = config.scopes.findIndex((x) => x.match && x.match.any);
  const worldwide = k < 0 ? config.scopes.length - 1 : k;
  const pw = loadPlaywright();
  mkdirSync(out, { recursive: true });
  const server = await startServer(data);
  let browser;
  try {
    browser = await pw.chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.setDefaultTimeout(120000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.base + 'atlas.html?data=/data/');
    await page.waitForFunction(() => /shown|gezeigt/.test(document.getElementById('atlas-status')?.textContent || ''));
    const files = [];
    const write = async (mode, file) => {
      await page.evaluate(({ mode, scope }) => window.jobcrawlAtlas.setView({ mode, scope }), { mode, scope: worldwide });
      const b64 = await page.evaluate(async ({ scale, theme }) => {
        const blob = await window.jobcrawlAtlas.renderImage({ scale, names: 'many', theme }), bytes = new Uint8Array(await blob.arrayBuffer());
        let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(s);
      }, { scale: args.scale, theme: args.theme });
      const info = await page.evaluate(() => window.jobcrawlAtlas.lastRender());
      const buf = Buffer.from(b64, 'base64'), dest = path.join(out, args.theme === 'light' ? file.replace(/\.png$/, '-light.png') : file);
      writeFileSync(dest, buf);
      files.push({ dest, ...pngSize(buf), info });
    };
    await write('roles', 'atlas-roles-worldwide.png');
    await write('companies', 'atlas-companies.png');
    if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
    for (const f of files) {
      const isCo = path.basename(f.dest).startsWith('atlas-companies'), c = f.info, placed = c.areas + (isCo ? c.companies : c.employers);
      const names = isCo ? `${c.areas} area names + ${c.companies} company names` : `${c.areas} area names + ${c.employers} employer names`;
      console.log(`${f.dest}  ${f.width}x${f.height}  ${names} (${placed} placed)`);
    }
    return 0;
  } finally {
    if (browser) await browser.close();
    process.kill(server.child.pid, 'SIGTERM');   // the server, by its PID
  }
}

process.exitCode = await main().catch((e) => { console.error(`export_atlas: ${e.message}`); return 1; });
