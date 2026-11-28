// Exit codes of the headless commands (design §3.9). One table, used by the CLI and documented in docs/HEADLESS.md.
export const EXIT = Object.freeze({ OK: 0, BOARDS_FAILED: 1, USAGE: 2, LOCKED: 3, STATE: 4, STRICT: 5, SIGINT: 130, SIGTERM: 143 });
export const EXIT_TEXT = Object.freeze({
  0: 'ok', 1: 'some boards failed (details in the report and the log)', 2: 'usage or config error', 3: 'lock held by another run',
  4: 'state store error', 5: '--strict health alert', 130: 'interrupted (SIGINT), state consistent', 143: 'terminated (SIGTERM), state consistent',
});
export const exitForSignal = (name) => (name === 'SIGINT' ? EXIT.SIGINT : EXIT.SIGTERM);
