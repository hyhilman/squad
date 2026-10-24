// Drops Node's "SQLite is an experimental feature" warning for the CLI only.
// squad.ts imports this first, so the filter is in place before the queued warning prints.
// Library users and tests that import squad.ts are not the program, so they keep the warning.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url).replace(/quiet\.[jt]s$/, "squad");
const entry = process.argv[1];
let isProgram = false;
try {
  isProgram = entry !== undefined && realpathSync(entry).replace(/\.[jt]s$/, "") === here;
} catch {
  // No readable entry path: keep the warning.
}

// Node loads node:sqlite while it links the imports, before any module code runs, so wrapping
// emitWarning is too late. The warning is printed on the next tick by a 'warning' listener, so
// this drops that one event.
if (isProgram) {
  const emit = process.emit.bind(process) as (event: string, ...args: unknown[]) => boolean;
  process.emit = ((event: string, ...args: unknown[]) => {
    const w = args[0] as Error | undefined;
    if (event === "warning" && w?.name === "ExperimentalWarning" && w.message.startsWith("SQLite is an experimental")) return false;
    return emit(event, ...args);
  }) as typeof process.emit;
}
