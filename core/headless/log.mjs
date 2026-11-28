// Structured logs for unattended runs: JSON lines (one object per line, flushed per line) or terse text, to stderr or a file.
// stdout is never used here: with --json it carries the machine result and nothing else.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const LOG_FORMATS = ['json', 'text'];
/** The default format: text on a terminal, JSON otherwise. */
export const defaultFormat = (isTTY = Boolean(process.stderr.isTTY)) => (isTTY ? 'text' : 'json');

export function createLogger({ format = defaultFormat(), file = null, write = null, now = () => new Date() } = {}) {
  if (!LOG_FORMATS.includes(format)) throw new Error(`--log-format must be one of ${LOG_FORMATS.join('|')}`);
  if (file) mkdirSync(dirname(file), { recursive: true });
  const sink = write ?? (file ? (s) => appendFileSync(file, s) : (s) => process.stderr.write(s));
  const emit = (level, event, fields = {}) => {
    const t = now().toISOString();
    if (format === 'json') sink(JSON.stringify({ t, level, event, ...fields }) + '\n');
    else {
      const kv = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
      sink(`${t} ${level.toUpperCase().padEnd(5)} ${event}${kv ? ' ' + kv : ''}\n`);
    }
  };
  return { format, file, info: (e, f) => emit('info', e, f), warn: (e, f) => emit('warn', e, f), error: (e, f) => emit('error', e, f) };
}
