import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as lib from "./index.ts";

test("the library entry exports runPass, roomOf, listAccounts and usageBy", () => {
  for (const name of ["runPass", "roomOf", "listAccounts", "usageBy", "open", "send", "close", "servesOf", "listAccountsWithServes"]) assert.equal(typeof (lib as Record<string, unknown>)[name], "function", name);
});

test("the library entry exports the home helpers", () => {
  for (const name of ["openHome", "openStore", "layoutOf", "homeRoot", "ensureHome"]) assert.equal(typeof (lib as Record<string, unknown>)[name], "function", name);
});

test("openHome makes the home and opens its store", () => {
  const root = join(mkdtempSync(join(tmpdir(), "oh-")), "h");
  const { home, store } = lib.openHome(process.cwd(), { SQUAD_HOME: root });
  assert.equal(home.root, root);
  assert.ok(existsSync(home.accounts));
  assert.deepEqual(lib.listAccounts(store.db).length, 0);
});

test("the standard-field types are exported", () => {
  const t: [lib.PassRequest["effort"], lib.Effort, lib.SkillRef, lib.ExtraMount, lib.TurnOptions, lib.Failure, lib.FailureKind, lib.Usage, lib.AccountRow, lib.Log, lib.PassResult, lib.RunDeps, lib.Conversation, lib.OpenRequest, lib.TurnResult, lib.AccountInfo, lib.ServedProvider] | undefined = undefined;
  assert.equal(t, undefined);
});
