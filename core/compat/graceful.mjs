// Graceful failure for stages, plugins, models and worker types (design §0.4): a missing or failing capability never stops the pipeline.
// runStage() returns a result/v1 with status:
//   ok           the stage ran
//   unsupported  the stage, plugin, model or schema is not available here (reason says which); retried when the capability appears
//   skipped      configured off, budget hit or not applicable (reason)
//   failed       it ran and threw (reason); the queue retries with backoff, then dead-letters
// A non-ok result never replaces an ok one of the same version, and an ok result replaces a non-ok one (merge.mjs).
export async function runStage(stage, input, { available = true, enabled = true, provenance = {} } = {}) {
  const base = { subject: input.subject, stage: `${stage?.id ?? 'unknown'}@${stage?.version ?? '0'}`, version: Number(input.version ?? 0), provenance: { worker: 'local', ...provenance, t: new Date().toISOString() } };
  if (!stage || typeof stage.run !== 'function') return { ...base, status: 'unsupported', reason: 'stage not installed' };
  if (!available) return { ...base, status: 'unsupported', reason: 'capability not available on this worker' };
  if (!enabled) return { ...base, status: 'skipped', reason: 'disabled by configuration' };
  try {
    return { ...base, status: 'ok', value: await stage.run(input) };
  } catch (e) {
    return { ...base, status: 'failed', reason: String(e?.message ?? e).slice(0, 300) };
  }
}

/** Health line of degraded capabilities from a list of results: { "<stage>": { unsupported, skipped, failed, reasons: [...] } }. */
export function degraded(results) {
  const out = {};
  for (const r of results) {
    if (r.status === 'ok') continue;
    const d = (out[r.stage] ??= { unsupported: 0, skipped: 0, failed: 0, reasons: [] });
    d[r.status] = (d[r.status] ?? 0) + 1;
    if (d.reasons.length < 3 && !d.reasons.includes(r.reason)) d.reasons.push(r.reason);
  }
  return out;
}
