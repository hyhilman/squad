import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli/squad.ts", import.meta.url));

test("the CLI from source prints no SQLite experimental warning", () => {
  const home = mkdtempSync(join(tmpdir(), "squad-quiet-"));
  const r = spawnSync(process.execPath, [CLI, "list"], { env: { ...process.env, SQUAD_HOME: home }, encoding: "utf8" });
  assert.doesNotMatch(r.stderr, /ExperimentalWarning|SQLite is an experimental/);
});

test("other warnings still print", () => {
  const home = mkdtempSync(join(tmpdir(), "squad-quiet-"));
  const r = spawnSync(process.execPath, ["--import", fileURLToPath(new URL("./fixtures-warn.mjs", import.meta.url)), CLI, "list"], { env: { ...process.env, SQUAD_HOME: home }, encoding: "utf8" });
  assert.match(r.stderr, /OtherWarning/);
});
