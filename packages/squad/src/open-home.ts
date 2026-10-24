import { ensureHome, homeRoot, layoutOf, type HomeLayout } from "./home.ts";
import { openStore, type Store } from "./store/db.ts";

/**
 * Finds the home of the project that holds `dir` (default: the current folder; SQUAD_HOME wins),
 * makes its folders and opens its store.
 */
export function openHome(dir?: string, env: Readonly<Record<string, string | undefined>> = process.env): { home: HomeLayout; store: Store } {
  const home = layoutOf(homeRoot(dir, env), env);
  ensureHome(home);
  return { home, store: openStore({ dbPath: home.db, spoolDir: home.spool }) };
}
