// Step 3 of the profiler: load a careers page once in headless Chromium and keep the JSON responses of its XHR/fetch requests.
// Optional dependency: playwright-core (with a Chromium build) is imported only when the profiler runs with --browser, never by the crawl.
// Images, media, fonts, stylesheets and well-known trackers are not loaded (they are most of a page's requests); the profile's user
// agent is the browser's. One browser per run, pages one at a time (the NUC is shared with training jobs).
import { createRequire } from 'node:module';
import { join } from 'node:path';

const BLOCK_TYPES = new Set(['image', 'media', 'font', 'stylesheet', 'manifest', 'texttrack', 'eventsource', 'websocket', 'other']);
const TRACKERS = /google-analytics|googletagmanager|doubleclick|facebook\.(?:net|com)|hotjar|matomo|piwik|clarity\.ms|linkedin\.com\/(?:px|li)|bing\.com|cookiebot|usercentrics|onetrust|consentmanager|youtube|vimeo|maps\.google|gstatic|recaptcha|hubspot|intercom|zendesk|sentry|newrelic|nr-data|segment\.(?:io|com)|mixpanel|fullstory|criteo|adservice|taboola|outbrain/i;

export async function makeSniffer({ ua, log = () => {}, timeoutMs = 25000, maxRequests = 60, maxJsonBytes = 3e6 } = {}) {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch (e) {
    // ESM ignores NODE_PATH; a playwright-core installed outside the repo (the NUC keeps it in ~/atlas/profiler/deps) is found through it
    for (const dir of String(process.env.NODE_PATH ?? '').split(/[:;]/).filter(Boolean)) {
      try { ({ chromium } = createRequire(join(dir, 'noop.js'))('playwright-core')); break; } catch {}
    }
    if (!chromium) throw new Error(`--browser needs playwright-core (npm i playwright-core, or NODE_PATH; PLAYWRIGHT_BROWSERS_PATH): ${e.message}`);
  }
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'] });
  let queue = Promise.resolve();
  async function sniffOne(url) {
    const context = await browser.newContext({ userAgent: ua, locale: 'de-DE', viewport: { width: 1280, height: 1600 }, javaScriptEnabled: true });
    const page = await context.newPage();
    const responses = [];
    let requests = 0, blocked = 0;
    const pending = [];
    const urls = [];
    await page.route('**/*', (route) => {
      const req = route.request();
      if (urls.length < 400) urls.push(req.url());
      if (BLOCK_TYPES.has(req.resourceType()) || TRACKERS.test(req.url()) || requests >= maxRequests) { blocked++; return route.abort(); }
      requests++;
      return route.continue();
    });
    page.on('response', (res) => {
      const req = res.request();
      const type = req.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      const ct = res.headers()['content-type'] ?? '';
      if (!/json|javascript|text\/plain/i.test(ct)) return;
      pending.push((async () => {
        try {
          const body = await res.body();
          if (body.length > maxJsonBytes) return;
          const json = JSON.parse(body.toString('utf8'));
          responses.push({ url: res.url(), status: res.status(), method: req.method(), postData: req.postData() ?? undefined, reqHeaders: req.headers(), json, bytes: body.length });
        } catch {}
      })());
    });
    let html = '', error = '';
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      // a list that loads on scroll or after a consent overlay: one scroll, a short wait
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(1500);
      html = await page.content();
    } catch (e) { error = String(e.message ?? e).split('\n')[0].slice(0, 160); }
    await Promise.allSettled(pending);
    await context.close().catch(() => {});
    return { responses, html, requests, blocked, error, urls };
  }
  return {
    // a page that never settles (a hung context.close, a download dialog) must not block the queue: 60 s, then the next page
    sniff(url) {
      const hung = () => new Promise((r) => setTimeout(() => r({ responses: [], html: '', requests: 0, error: 'browser timeout 60 s', urls: [] }), 60000).unref());
      const p = queue.then(() => Promise.race([sniffOne(url), hung()]));
      queue = p.catch(() => {});
      return p;
    },
    async close() { await browser.close().catch(() => {}); },
  };
}
