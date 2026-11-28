// The ambient abort signal of the board being read. runBoard/readBoard run a source inside runWithSignal(signal, fn); the engine fetch
// (core/fetch/guard.mjs) merges currentSignal() into every request, so a board's time budget aborts the requests in flight, also for
// sources that were written before ctx existed and call fetch() themselves. Sources that take ctx get the same signal as ctx.signal.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
export const runWithSignal = (signal, fn) => als.run({ signal }, fn);
/** Runs fn (and its async continuations) outside any board context: for process-wide memoized work such as robots.txt. */
export const runOutsideSignal = (fn) => als.exit(fn);
export const currentSignal = () => als.getStore()?.signal ?? null;
