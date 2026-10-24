// Keeps the models.json of pi key accounts in step with the catalog. It rewrites the model list of a
// custom provider the account already has; it never touches auth.json and never adds a provider.

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HomeLayout } from "../home.ts";
import type { CatalogProvider } from "../prices.ts";
import { PI_BUILTIN_KEY, PI_NOT_OFFERED, piModels } from "../providers.ts";
import { isObj } from "../streams/lines.ts";
import type { Store } from "../store/db.ts";
import { listAccounts } from "./store.ts";

/** Rewrites each pi key account's models.json when the catalog lists other models. Returns how many files changed. */
export function syncModelsFiles(home: HomeLayout, store: Store, catalog: readonly CatalogProvider[]): number {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  let changed = 0;
  for (const a of listAccounts(store.db, "pi")) {
    if (a.kind !== "key" || a.state === "moved") continue;
    const file = join(home.accounts, a.runner, a.name, "models.json");
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!isObj(doc) || !isObj(doc.providers)) continue;
    let touched = false;
    const providers: Record<string, unknown> = { ...doc.providers };
    for (const [id, old] of Object.entries(doc.providers)) {
      const src = byId.get(id);
      // A built-in provider has no model list on disk; a provider the catalog lost, or lists with no model, keeps what it has.
      if (!isObj(old) || src === undefined || src.api === undefined || PI_BUILTIN_KEY.includes(id) || PI_NOT_OFFERED.includes(id)) continue;
      const models = piModels(src);
      if (models.length === 0) continue;
      const next = { ...old, baseUrl: src.api, models };
      if (JSON.stringify(next) === JSON.stringify(old)) continue;
      providers[id] = next;
      touched = true;
    }
    if (!touched) continue;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ...doc, providers }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    changed++;
  }
  return changed;
}
