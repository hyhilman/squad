import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { findForbidden } from "@squad/contract";

const ROOT = fileURLToPath(new URL("./fixtures/captures/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(ROOT);

test("the captures folder is not empty", () => {
  assert.ok(files.some((f) => f.endsWith(".jsonl")));
});

test("no capture line carries a token or a secret-shaped value", () => {
  for (const f of files.filter((p) => p.endsWith(".jsonl"))) {
    readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .forEach((l, i) => assert.equal(findForbidden(JSON.parse(l)), undefined, `${f}:${i + 1}`));
  }
});

test("no capture holds a home path, a temp path or an email address", () => {
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.ok(!text.includes("/home/"), `${f} has /home/`);
    assert.ok(!text.includes("/tmp/"), `${f} has /tmp/`);
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(text), `${f} has an email shape`);
  }
});
