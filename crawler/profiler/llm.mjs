// Step 5 of the profiler: ask a LOCAL model (llama.cpp's llama-server, OpenAI-compatible endpoint; no hosted APIs) which links of a
// page skeleton are individual job postings. The answer has a fixed JSON schema; the profiler turns it into a step-4 configuration and
// keeps it only when the production fetch then yields >= 3 job-like items.

export const LLM_SCHEMA = {
  type: 'object',
  properties: {
    is_job_list: { type: 'boolean' },
    job_links: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    full_list_link: { type: 'string' },
  },
  required: ['is_job_list', 'job_links'],
};

const SYSTEM = 'You read a compact view of a company careers web page (its headings and links). Answer only with JSON. '
  + 'job_links: up to 6 hrefs, copied exactly from LINK lines, that each open ONE individual job posting (a specific role such as '
  + '"Software Engineer (m/w/d)"), never navigation, categories, application forms, blog posts or the general careers page. '
  + 'is_job_list: true if the page lists individual job postings. full_list_link: the href of a link to the complete job list if this '
  + 'page only teases it, else an empty string.';

export function makeLlm({ url = 'http://127.0.0.1:8091', model = 'local', timeoutMs = 120000, log = () => {} } = {}) {
  let queue = Promise.resolve();
  async function askOne(skeleton) {
    const body = {
      model,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: skeleton }],
      temperature: 0, max_tokens: 400,
      response_format: { type: 'json_schema', json_schema: { name: 'job_links', schema: LLM_SCHEMA, strict: true } },
    };
    const t0 = Date.now();
    try {
      const res = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { error: `llm HTTP ${res.status}` };
      const j = await res.json();
      const txt = j.choices?.[0]?.message?.content ?? '';
      const ans = JSON.parse(txt.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1'));
      // small models copy whole skeleton lines ("LINK /jobs/1 :: Engineer"): keep the href
      const clean = (x) => String(x ?? '').replace(/^\s*LINK\s+/i, '').split(' :: ')[0].trim();
      return { ...ans, job_links: (ans.job_links ?? []).map(clean).filter(Boolean), full_list_link: clean(ans.full_list_link), ms: Date.now() - t0 };
    } catch (e) { return { error: `llm ${String(e.message ?? e).slice(0, 120)}` }; }
  }
  return (skeleton) => { const p = queue.then(() => askOne(skeleton)); queue = p.catch(() => {}); return p; };
}
