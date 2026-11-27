// A small JSON Schema checker for the subset the jobcrawl schemas use (type, const, enum, required, properties,
// additionalProperties, items, pattern, minimum, minLength, $ref to a sibling file). It is for tests and `jobcrawl doctor`;
// a full validator (a small audited dependency) can replace it without changing callers.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');
const cache = new Map();
export function loadSchema(name) {
  const file = name.endsWith('.json') ? name : `${name}.schema.json`;
  if (!cache.has(file)) cache.set(file, JSON.parse(readFileSync(join(DIR, file), 'utf8')));
  return cache.get(file);
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const isType = (v, t) => (t === 'number' ? typeof v === 'number' : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t);

/** Returns a list of error strings (empty when valid). */
export function validate(value, schema, path = '$') {
  if (typeof schema === 'string') schema = loadSchema(schema);
  if (schema.$ref) return validate(value, loadSchema(schema.$ref), path);
  const errs = [];
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => isType(value, t))) return [`${path}: expected ${types.join('|')}, got ${typeOf(value)}`];
  }
  if ('const' in schema && value !== schema.const) errs.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === 'number' && schema.minimum != null && value < schema.minimum) errs.push(`${path}: below ${schema.minimum}`);
  if (typeOf(value) === 'object') {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${path}: missing ${k}`);
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      if (schema.properties?.[k]) errs.push(...validate(v, schema.properties[k], `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}: unexpected key ${k}`);
      else if (typeof schema.additionalProperties === 'object') errs.push(...validate(v, schema.additionalProperties, `${path}.${k}`));
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(v, schema.items, `${path}[${i}]`)));
  return errs;
}
