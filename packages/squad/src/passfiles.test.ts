import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import { ensureHome, layoutOf } from "./home.ts";
import { findPassFile, readPassFile, writePassFiles } from "./passfiles.ts";
import { readFileSync } from "node:fs";

const home = () => {
  const h = layoutOf(mkdtempSync(join(tmpdir(), "passfiles-")), {});
  ensureHome(h);
  return h;
};
const NOW = new Date("2026-10-24T12:00:00.000Z");

test("writePassFiles writes both files gzipped, mode 0600, with no tmp file left", () => {
  const h = home();
  const path = writePassFiles(h, NOW, "P1", "say ok", '{"a":1}\n');
  const dir = join(h.passLogs, "2026-10-24");
  assert.equal(path, join(dir, "P1.log.gz"));
  assert.deepEqual(readdirSync(dir).sort(), ["P1.log.gz", "P1.prompt.gz"]);
  for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600);
  assert.equal(gunzipSync(readFileSync(path)).toString(), '{"a":1}\n');
  assert.equal(gunzipSync(readFileSync(join(dir, "P1.prompt.gz"))).toString(), "say ok");
});

test("findPassFile and readPassFile read the gz files, and an old plain .log too", () => {
  const h = home();
  writePassFiles(h, NOW, "P1", "hi", "raw");
  assert.equal(readPassFile(findPassFile(h, "P1", "log")!), "raw");
  assert.equal(readPassFile(findPassFile(h, "P1", "prompt")!), "hi");
  const old = join(h.passLogs, "2026-08-01");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "OLD.log"), "plain");
  assert.equal(readPassFile(findPassFile(h, "OLD", "log")!), "plain");
  assert.equal(findPassFile(h, "OLD", "prompt"), undefined);
  assert.equal(findPassFile(h, "NONE", "log"), undefined);
  assert.ok(!existsSync(join(h.passLogs, "x")));
});

test("findPassFile takes a day hint first, and refuses an id that is not a plain id", () => {
  const h = home();
  writePassFiles(h, NOW, "P1", "hi", "raw");
  assert.ok(findPassFile(h, "P1", "log", ["2026-10-24"]));
  assert.equal(findPassFile(h, "../P1", "log"), undefined);
  assert.equal(findPassFile(h, "P1/../P1", "log"), undefined);
});
