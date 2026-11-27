// Idempotent merge of worker results into the central store (design §0.3). A result (schema result/v1) is keyed by
// (subject, stage, version): subject = posting id or content hash, stage = "<stage id>@<stage version>", version = the input's content
// version. Re-delivering a result is a no-op; a result for an older input version than the stored one is ignored; every stored result
// keeps its provenance (worker, host, model@version, time). Pure: works on a Map or any object with get/set.
//   result: { subject, stage, version, status?, reason?, value, provenance: { worker, host, model?, t } }
// status (compat/graceful.mjs): ok | skipped | unsupported | failed. An ok result is never replaced by a non-ok one of the same
// version, and a non-ok result is replaced by an ok one (the capability appeared later). A missing status counts as ok (older producers).

export const RESULT_SCHEMA = 'result/v1';
const isOk = (r) => (r.status ?? 'ok') === 'ok';

/** Returns 'stored' | 'duplicate' | 'stale' | 'upgraded'. */
export function mergeResult(table, r) {
  if (!r?.subject || !r?.stage) throw new Error('mergeResult: subject and stage are required');
  const k = `${r.subject}|${r.stage}`;
  const cur = table.get(k);
  const v = Number(r.version ?? 0);
  if (cur && cur.version > v) return 'stale';
  if (cur && cur.version === v) {
    if (!isOk(cur) && isOk(r)) { table.set(k, { ...r, version: v }); return 'upgraded'; }
    return 'duplicate';
  }
  table.set(k, { ...r, version: v });
  return 'stored';
}
