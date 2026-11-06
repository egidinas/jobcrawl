// Re-profiling trigger, used by crawl.mjs on every board it fetches (state in <data>/source-health.json, next to fails/zero/last_jobs).
// An entry the profiler wrote carries profile: { method, at, items, expected_min, expected_max }. When its yield stays under
// expected_min for REPROFILE_CYCLES successful cycles, or it fails REPROFILE_CYCLES cycles in a row, the crawl sets reprofile_due (with
// a reason and the day); `node crawler/profiler.mjs reprofile-queue` turns the flagged companies into profiler input. The flag clears
// when the board is back at its baseline, or when the entry carries a newer profile (profile.at changed). companies.json is never edited.
export const REPROFILE_CYCLES = 3;

/** Update one board's health record h for a cycle; returns the alert line when reprofile_due is (still) set, else ''. */
export function reprofileCycle(h, profile, { ok, n = 0, today }) {
  if (!profile || typeof profile !== 'object') return '';
  if (h.profile_at !== profile.at) { h.profile_at = profile.at; h.low = 0; delete h.reprofile_due; delete h.reprofile_since; delete h.reprofile_reason; }
  const min = Number(profile.expected_min) || 0;
  if (ok) h.low = min > 0 && n < min ? (h.low ?? 0) + 1 : 0;
  const fails = h.fails ?? 0;
  const due = fails >= REPROFILE_CYCLES || (h.low ?? 0) >= REPROFILE_CYCLES;
  if (due && !h.reprofile_due) {
    h.reprofile_due = true;
    h.reprofile_since = today;
    h.reprofile_reason = fails >= REPROFILE_CYCLES ? `failed ${fails} cycles in a row` : `${n} jobs, under the profiled minimum ${min} for ${h.low} cycles (profiled ${profile.at}: ${profile.items} via ${profile.method})`;
  } else if (h.reprofile_due && ok && n >= Math.max(1, min)) {
    delete h.reprofile_due; delete h.reprofile_since; delete h.reprofile_reason;
  }
  return h.reprofile_due ? `REPROFILE ${h.reprofile_reason} (since ${h.reprofile_since}; node crawler/profiler.mjs reprofile-queue)` : '';
}
