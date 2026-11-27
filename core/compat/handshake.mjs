// Capability handshake (design §0.4). Each side advertises what it understands; work is routed only where both sides agree, so a fleet
// with mixed versions (rolling upgrades, one machine at a time) keeps working, and a new function is simply not routed to a worker that
// does not have it ("failing gracefully": the item waits or is marked unsupported, nothing crashes).
//   advertisement: { producer: "<package>@<semver>", schemas: { delta: [1], posting: [1], ... }, features: ["delta.unknown", ...],
//                    engine?: ">=0.1 <0.3" (plugins: the engine range they support) }
import { PRODUCER } from './envelope.mjs';

export const SCHEMAS_SUPPORTED = Object.freeze({
  delta: [1], posting: [1], snapshot: [1], 'board-state': [1], routing: [1], parity: [1], 'work-item': [1], worker: [1], 'artifact-ref': [1], result: [1], envelope: [1],
});
export const FEATURES = Object.freeze(['delta.unknown-status', 'queue.leases', 'result.status', 'vectors.float16', 'vectors.int8']);

export function advertise({ producer = PRODUCER, schemas = SCHEMAS_SUPPORTED, features = FEATURES, engine } = {}) {
  return { producer, schemas: Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, [...v]])), features: [...features], ...(engine ? { engine } : {}) };
}

/** Highest major both sides support per schema; features both have. */
export function negotiate(a, b) {
  const schemas = {};
  for (const [name, majors] of Object.entries(a.schemas ?? {})) {
    const common = majors.filter((m) => (b.schemas?.[name] ?? []).includes(m));
    if (common.length) schemas[name] = Math.max(...common);
  }
  return { schemas, features: (a.features ?? []).filter((f) => (b.features ?? []).includes(f)) };
}

/** Whether a worker advertisement can take an item needing { schemas: { name: major }, features: [...] }. */
export function canHandle(adv, needs = {}) {
  const miss = [];
  for (const [name, major] of Object.entries(needs.schemas ?? {})) if (!(adv?.schemas?.[name] ?? []).includes(major)) miss.push(`${name}/v${major}`);
  for (const f of needs.features ?? []) if (!(adv?.features ?? []).includes(f)) miss.push(`feature ${f}`);
  return miss.length ? { ok: false, missing: miss } : { ok: true };
}

/** Semver range check for plugins ("engine": ">=0.1.0 <0.3.0"); only >=, >, <=, <, = and plain versions, space-separated (AND). */
export function satisfies(version, range) {
  const v = parse(version);
  if (!v || !range) return Boolean(v);
  return range.trim().split(/\s+/).every((c) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(c);
    const r = parse(m[2]);
    if (!r) return false;
    const d = cmp(v, r);
    return { '>=': d >= 0, '<=': d <= 0, '>': d > 0, '<': d < 0, '=': d === 0, undefined: d === 0 }[m[1]];
  });
}
const parse = (s) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? '').replace(/^.*@/, '')); return m ? m.slice(1, 4).map(Number) : null; };
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
