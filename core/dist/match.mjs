// Worker capabilities and work requirements (design §0.3). A worker declares what it has; a work item says what it needs; the
// scheduler gives an item only to a worker that meets it. Shapes (schema worker/v1):
//   worker:   { id, host, capabilities: { net, browser, gpu, vram_gb, cpu_threads, ram_gb, models: [..], packs: [..], topics: [..] },
//               budgets: { cpu_threads, vram_gb, ram_gb }, policy: { smoke_measured: { <topic>: { rate, peak_vram_gb, ... } } } }
//   requires: { net?, browser?, gpu?, vram_gb?, cpu_threads?, ram_gb?, models?: [..], packs?: [..], long?: true }
// Fleet node rules become policies here: an item marked `long` (expected > 15 min) goes only to a worker with a measured smoke for its
// topic, and bookings come from the measured numbers, never from a guess (AGENTS.md "Node tasks").

import { canHandle } from '../compat/handshake.mjs';

export function meets(worker, requires, topic = null) {
  if (!requires) return { ok: true };
  const c = worker?.capabilities ?? {};
  const miss = [];
  for (const k of ['net', 'browser', 'gpu']) if (requires[k] && !c[k]) miss.push(k);
  for (const k of ['vram_gb', 'cpu_threads', 'ram_gb']) if (requires[k] != null && !((c[k] ?? 0) >= requires[k])) miss.push(`${k}>=${requires[k]}`);
  for (const k of ['models', 'packs']) for (const m of requires[k] ?? []) if (!(c[k] ?? []).includes(m)) miss.push(`${k}:${m}`);
  if (requires.long && topic && !worker?.policy?.smoke_measured?.[topic]) miss.push(`measured smoke for ${topic}`);
  // capability handshake: schema majors and features the item needs must be in the worker's advertisement (compat/handshake.mjs)
  if (requires.schemas || requires.features) { const h = canHandle(worker?.advertisement ?? {}, requires); if (!h.ok) miss.push(...h.missing); }
  return miss.length ? { ok: false, missing: miss } : { ok: true };
}
