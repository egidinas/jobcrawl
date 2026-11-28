// A zero-dependency Model Context Protocol server core: JSON-RPC 2.0, newline-delimited over stdio.
//
// Revisions. The pinned current revision is 2026-07-28 (modelcontextprotocol.io/specification/2026-07-28, read 2026-11-28): stateless,
// every request carries `_meta["io.modelcontextprotocol/protocolVersion"]` and `.../clientCapabilities`, results carry `resultType`,
// `server/discover` replaces the handshake, a version the server does not speak is answered with error -32022 and data.supported.
// The server is DUAL-ERA: a request without that `_meta` selects the legacy handshake (`initialize`, revisions 2025-11-25, 2025-06-18,
// 2025-03-26, 2024-11-05), scoped to the process, so today's clients work. Not implemented: subscriptions, resources, prompts, tasks,
// multi round-trip input (a read-only tool server needs none; tools/list answers without pagination).
// Batches (JSON arrays) are refused with -32600 (removed from the protocol in 2025-06-18).
// Error codes: -32700 parse, -32600 invalid request, -32601 unknown method, -32602 invalid params / unknown tool, -32603 internal,
// -32022 unsupported protocol version. A tool's own failure is a normal result with isError: true.
import { sanitizeDeep } from './sanitize.mjs';

export const MODERN_VERSIONS = Object.freeze(['2026-07-28']);
export const LEGACY_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const SUPPORTED_VERSIONS = Object.freeze([...MODERN_VERSIONS, ...LEGACY_VERSIONS]);
export const CURRENT_VERSION = MODERN_VERSIONS[0];
const K_VERSION = 'io.modelcontextprotocol/protocolVersion';
const K_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const K_SERVER = 'io.modelcontextprotocol/serverInfo';

export class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const err = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });

/** Validates tool arguments against the small JSON Schema subset the tools use. Returns a list of problems. */
export function validateArgs(schema, args) {
  const bad = [];
  if (!isObj(args)) return ['arguments must be an object'];
  const props = schema.properties ?? {};
  for (const r of schema.required ?? []) if (args[r] === undefined) bad.push(`missing "${r}"`);
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) { if (schema.additionalProperties === false) bad.push(`unknown argument "${k}"`); continue; }
    if (v === null) { bad.push(`"${k}" must not be null`); continue; }
    if (p.type === 'string' && typeof v !== 'string') bad.push(`"${k}" must be a string`);
    else if (p.type === 'integer' && !Number.isInteger(v)) bad.push(`"${k}" must be an integer`);
    else if (p.type === 'boolean' && typeof v !== 'boolean') bad.push(`"${k}" must be a boolean`);
    else if (p.type === 'object' && !isObj(v)) bad.push(`"${k}" must be an object`);
    else if (p.type === 'string' && p.maxLength && v.length > p.maxLength) bad.push(`"${k}" is longer than ${p.maxLength} characters`);
    else if (p.type === 'integer' && ((p.minimum !== undefined && v < p.minimum) || (p.maximum !== undefined && v > p.maximum))) bad.push(`"${k}" must be between ${p.minimum ?? '-inf'} and ${p.maximum ?? 'inf'}`);
    else if (p.enum && !p.enum.includes(v)) bad.push(`"${k}" must be one of ${p.enum.join(', ')}`);
  }
  return bad;
}

/**
 * createServer({ name, version, instructions, tools }) -> { handle(message), tools }.
 * tool: { name, title, description, inputSchema, annotations?, handler(args) -> { data, isError? } }.
 * handle(message) returns the response object, or null for a notification. It never throws.
 */
export function createServer({ name = 'jobcrawl', version = '0.0.0', instructions = '', tools = [], log = () => {} } = {}) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  let legacyReady = false;   // set by `initialize` (legacy era only; scoped to the process, as the legacy revisions define)
  const serverInfo = { name, version };
  const capabilities = { tools: { listChanged: false } };
  const publicTool = (t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
    ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}), annotations: t.annotations ?? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });

  async function dispatch(method, params, modern) {
    const done = (r) => (modern ? { resultType: 'complete', ...r, _meta: { ...(r._meta ?? {}), [K_SERVER]: serverInfo } } : r);
    switch (method) {
      case 'ping': return done({});
      case 'server/discover':
        return { resultType: 'complete', supportedVersions: [...SUPPORTED_VERSIONS], capabilities, instructions, _meta: { [K_SERVER]: serverInfo } };
      case 'tools/list': return done({ tools: tools.map(publicTool) });
      case 'tools/call': {
        if (!isObj(params) || typeof params.name !== 'string') throw new RpcError(-32602, 'tools/call needs params.name');
        const tool = byName.get(params.name);
        if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(params.name).slice(0, 100)}`);
        const args = params.arguments ?? {};
        const bad = validateArgs(tool.inputSchema, args);
        let data, isError = false;
        if (bad.length) { data = { error: `invalid arguments: ${bad.join('; ')}` }; isError = true; }
        else {
          try { ({ data, isError = false } = await tool.handler(args)); }
          catch (e) { log(`tool ${tool.name} failed: ${e?.stack ?? e}`); data = { error: String(e?.message ?? e).slice(0, 500) }; isError = true; }
        }
        const clean = sanitizeDeep(data);   // the one choke point: every string that leaves the server is cleaned and capped
        return done({ content: [{ type: 'text', text: JSON.stringify(clean) }], structuredContent: clean, isError });
      }
      default: throw new RpcError(-32601, `Method not found: ${String(method).slice(0, 100)}`);
    }
  }

  async function handle(msg) {
    if (Array.isArray(msg)) return err(null, -32600, 'JSON-RPC batches are not supported');
    if (!isObj(msg) || msg.jsonrpc !== '2.0') return err(isObj(msg) ? msg.id : null, -32600, 'Invalid Request: jsonrpc must be "2.0"');
    const { id, method, params } = msg;
    if (typeof method !== 'string') return 'result' in msg || 'error' in msg ? null : err(id, -32600, 'Invalid Request: method missing');   // a stray response is ignored
    if (id === undefined) return null;   // a notification (notifications/initialized, /cancelled, ...): nothing to answer, nothing to keep
    if (typeof id !== 'string' && !Number.isInteger(id)) return err(null, -32600, 'Invalid Request: id must be a string or an integer');
    if (params !== undefined && !isObj(params)) return err(id, -32602, 'params must be an object');
    try {
      const meta = params?._meta;
      if (method === 'initialize') {   // legacy handshake
        const want = params?.protocolVersion;
        if (typeof want !== 'string') throw new RpcError(-32602, 'initialize needs params.protocolVersion');
        legacyReady = true;
        const v = LEGACY_VERSIONS.includes(want) ? want : LEGACY_VERSIONS[0];
        return { jsonrpc: '2.0', id, result: { protocolVersion: v, capabilities, serverInfo, ...(instructions ? { instructions } : {}) } };
      }
      const modern = isObj(meta) && meta[K_VERSION] !== undefined;
      if (modern) {
        const v = meta[K_VERSION];
        if (!MODERN_VERSIONS.includes(v)) return err(id, -32022, 'Unsupported protocol version', { supported: [...SUPPORTED_VERSIONS], requested: v });
        if (method !== 'server/discover' && !isObj(meta[K_CAPS])) throw new RpcError(-32602, `_meta["${K_CAPS}"] is required`);
      } else if (method !== 'ping' && method !== 'server/discover' && !legacyReady) {
        throw new RpcError(-32600, `Not initialized: send initialize (legacy revisions) or put _meta["${K_VERSION}"] and _meta["${K_CAPS}"] on every request (${CURRENT_VERSION})`);
      }
      return { jsonrpc: '2.0', id, result: await dispatch(method, params, modern) };
    } catch (e) {
      if (e instanceof RpcError) return err(id, e.code, e.message, e.data);
      log(`internal error: ${e?.stack ?? e}`);
      return err(id, -32603, 'Internal error');
    }
  }
  return { handle, tools, serverInfo };
}

/**
 * Runs the stdio loop: one JSON message per line from `input`, responses (one line each) to `write`. Requests run concurrently.
 * Resolves when the input ends and every started request has answered. Lines longer than maxLine are answered with -32600 and dropped.
 */
export function serveStdio(server, { input = process.stdin, write, maxLine = 1 << 20, log = () => {} } = {}) {
  return new Promise((resolve) => {
    const pending = new Set();
    let buf = '', skipping = false, ended = false;
    const out = (r) => { if (r) write(JSON.stringify(r) + '\n'); };
    const finish = () => { if (ended && !pending.size) resolve(); };
    const run = (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { out(err(null, -32700, 'Parse error')); return; }
      const p = server.handle(msg).then(out, (e) => { log(String(e?.stack ?? e)); out(err(msg?.id, -32603, 'Internal error')); }).finally(() => { pending.delete(p); finish(); });
      pending.add(p);
    };
    input.setEncoding?.('utf8');
    input.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (skipping) { skipping = false; continue; }
        if (line.length > maxLine) { out(err(null, -32600, `message longer than ${maxLine} characters`)); continue; }
        run(line);
      }
      if (buf.length > maxLine) { if (!skipping) out(err(null, -32600, `message longer than ${maxLine} characters`)); skipping = true; buf = ''; }
    });
    input.on('end', () => { if (buf.trim() && !skipping) run(buf); ended = true; finish(); });
    input.on('error', (e) => { log(`stdin: ${e}`); ended = true; finish(); });
  });
}
