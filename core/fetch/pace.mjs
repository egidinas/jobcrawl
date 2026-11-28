// Global request pacing and connect-error retries (recording incident 2026-11-28: on the NUC, bursts of simultaneous NEW connections are
// dropped somewhere on the uplink while paced requests get through: 8 parallel fetches failed 8/8 with UND_ERR_CONNECT_TIMEOUT, the same
// 8 URLs one after another 16/16 ok, both while the live crawl ran).
//
// makePacedFetch(base, opts) returns a fetch that
//   * starts at most one request per `gapMs` across the whole process (a global token bucket of size 1), so new connections never burst
//   * retries connect-level failures (no response at all: UND_ERR_CONNECT_TIMEOUT, ECONNRESET, ECONNREFUSED, ETIMEDOUT, EAI_AGAIN,
//     UND_ERR_SOCKET, ENETUNREACH, EHOSTUNREACH) up to `retries` times after `backoffMs[i]`, never an HTTP answer and never a caller abort
//   * reports every failure with its real cause code to `onError(url, code, attempt, ms)` (the "fetch failed" message hides it)
// errorCode(err) gives the cause code of a fetch error.
const CONNECT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE']);

// the string code of a fetch error: cause.code (undici, system errors), else the error name (a DOMException such as an AbortSignal timeout
// carries a numeric legacy code, e.g. 23, which says nothing)
export const errorCode = (e) => {
  for (const c of [e?.cause?.code, e?.code]) if (typeof c === 'string' && c) return c;
  return String(e?.cause?.name ?? e?.name ?? 'ERROR');
};
export const isConnectError = (e) => CONNECT_CODES.has(errorCode(e));

export function makePacedFetch(base, { gapMs = 250, retries = 2, backoffMs = [3000, 10000], onError = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  // one slot after the other: each waits for the previous start and then until gapMs after it, measured on the clock at that moment, so
  // late timers (a busy event loop) can never release several requests at once
  let chain = Promise.resolve(), last = -Infinity;
  const slot = () => {
    const p = chain.then(async () => {
      const wait = last + gapMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
    });
    chain = p.catch(() => {});
    return p;
  };
  return async function pacedFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    for (let attempt = 0; ; attempt++) {
      await slot();
      const t0 = now();
      try {
        return await base(input, init);
      } catch (e) {
        const code = errorCode(e);
        onError(url, code, attempt, now() - t0);
        if (init?.signal?.aborted || !isConnectError(e) || attempt >= retries) throw e;
        await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)]);
      }
    }
  };
}
