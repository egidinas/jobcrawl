// Messages, versions and tolerant reading (design §0.4).
//
// Envelope: CloudEvents 1.0 (JSON format). Every message between producers and consumers (delta events, work items, results) travels as
//   { specversion: "1.0", id, source, type: "io.jobcrawl.<kind>[.<op>]", time, subject?, datacontenttype: "application/json",
//     dataschema: "<$id of the payload JSON Schema>", jcschema: "<name>/v<major>", jcproducer: "<package>@<semver>", data }
// (jcschema / jcproducer are CloudEvents extension attributes: lower-case alphanumerics only.)
//
// Reading rules (tolerant reader):
//   * unknown fields are ignored (never an error); a missing optional field takes its default
//   * a known schema name with an older major is upcast step by step through registered upcasters (v1 -> v2 -> ...)
//   * a known name with a NEWER major than this code understands, or an unknown name / type, is NOT rejected: read() returns
//     { status: 'unsupported', reason, message } so the caller stores it and passes it on (nothing is lost; a newer consumer handles it)
//   * additive changes stay within a major; a breaking change is a new major, served side by side, with an upcaster for old logs
import { randomUUID } from 'node:crypto';

export const SPEC = '1.0';
export const PRODUCER = '@egidinas/jobcrawl@0.0.0-phase0';
export const SCHEMA_BASE = 'https://github.com/egidinas/jobcrawl/schemas/';

/** "delta/v1" -> { name: 'delta', major: 1 } (null when malformed). */
export function parseSchema(s) {
  const m = /^([a-z][a-z0-9-]*)\/v(\d+)$/.exec(String(s ?? ''));
  return m ? { name: m[1], major: Number(m[2]) } : null;
}

/** Wraps a payload in a CloudEvents envelope. */
export function wrap(schema, data, { type, source = 'jobcrawl', subject, id = randomUUID(), time = new Date().toISOString(), producer = PRODUCER } = {}) {
  const p = parseSchema(schema);
  if (!p) throw new Error(`wrap: bad schema "${schema}" (want name/vN)`);
  return { specversion: SPEC, id, source, type: type ?? `io.jobcrawl.${p.name}`, time, ...(subject ? { subject } : {}),
    datacontenttype: 'application/json', dataschema: `${SCHEMA_BASE}${p.name}-v${p.major}.schema.json`, jcschema: schema, jcproducer: producer, data };
}

/**
 * A reader for the schema majors this code understands: accept = { delta: { major: 1, defaults: {...} }, ... }, and upcasters keyed
 * "<name>/v<from>" -> fn(data) returning the data of the next major. read(msg) -> { status: 'ok', schema, data, upcast } |
 * { status: 'unsupported', reason, message }.
 */
export function makeReader({ accept = {}, upcasters = {} } = {}) {
  return function read(msg) {
    const env = msg && typeof msg === 'object' && msg.specversion ? msg : null;
    const schema = env ? env.jcschema : msg?.schema;          // bare payloads (log lines) carry `schema` themselves
    const p = parseSchema(schema);
    if (!p) return { status: 'unsupported', reason: `no or malformed schema (${schema ?? 'none'})`, message: msg };
    const want = accept[p.name];
    if (!want) return { status: 'unsupported', reason: `unknown schema ${p.name}`, message: msg };
    if (p.major > want.major) return { status: 'unsupported', reason: `${schema} is newer than this reader (understands v${want.major})`, message: msg };
    let data = env ? env.data : msg;
    let major = p.major;
    const steps = [];
    while (major < want.major) {
      const up = upcasters[`${p.name}/v${major}`];
      if (!up) return { status: 'unsupported', reason: `no upcaster from ${p.name}/v${major}`, message: msg };
      data = up(data); major++; steps.push(`v${major}`);
    }
    data = { ...(want.defaults ?? {}), ...data };
    if (!env && data.schema) data.schema = `${p.name}/v${major}`;
    return { status: 'ok', schema: `${p.name}/v${major}`, data, upcast: steps };
  };
}
