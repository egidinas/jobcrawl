// Loads node:sqlite without its one ExperimentalWarning ("SQLite is an experimental feature", Node 22). Only that warning is dropped:
// every other warning (deprecations, other experimental features) still reaches process.emitWarning's listeners. The filter must be in
// place before the first load of node:sqlite in the process (Node prints the warning once, on the module's first load).
let installed = false;
const SQLITE_WARNING = /SQLite is an experimental feature/;

export function quietSqliteWarning() {
  if (installed) return;
  installed = true;
  const orig = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0]?.type ?? warning?.name);
    if (type === 'ExperimentalWarning' && SQLITE_WARNING.test(String(warning?.message ?? warning))) return;
    return orig.call(this, warning, ...rest);
  };
}

/** node:sqlite, loaded quietly. */
export async function loadSqlite() {
  quietSqliteWarning();
  return import('node:sqlite');
}
