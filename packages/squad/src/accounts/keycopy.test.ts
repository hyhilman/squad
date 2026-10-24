import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHome, layoutOf } from "../home.ts";
import type { AccountRow } from "./store.ts";
import { withKeyCopy } from "./keycopy.ts";

const setup = (kind: AccountRow["kind"]) => {
  const home = layoutOf(join(mkdtempSync(join(tmpdir(), "kc-")), "home"), {});
  ensureHome(home);
  const dir = join(home.accounts, "pi", "k1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), '{"fake":"not-a-real-key"}');
  const account = { id: "pi/k1", runner: "pi", name: "k1", kind } as AccountRow;
  return { home, dir, account };
};

test("fn sees a private copy, and the copy is gone after success", async () => {
  const { home, dir, account } = setup("key");
  let seen = "";
  const out = await withKeyCopy(home, account, (copy) => {
    seen = copy;
    assert.notEqual(copy, dir);
    assert.ok(copy.startsWith(home.staging));
    assert.equal(statSync(copy).mode & 0o777, 0o700);
    assert.equal(readFileSync(join(copy, "auth.json"), "utf8"), '{"fake":"not-a-real-key"}');
    return 42;
  });
  assert.equal(out, 42);
  assert.equal(existsSync(seen), false);
  assert.deepEqual(readdirSync(home.staging), []);
  assert.ok(existsSync(join(dir, "auth.json")), "the real folder stays");
});

test("the copy is gone after a throw, and the error comes through", async () => {
  const { home, account } = setup("key");
  await assert.rejects(() => withKeyCopy(home, account, async () => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(readdirSync(home.staging), []);
});

test("a login or token account throws before any copy", async () => {
  for (const kind of ["login", "token"] as const) {
    const { home, account } = setup(kind);
    let called = false;
    await assert.rejects(() => withKeyCopy(home, account, () => { called = true; }), /key/);
    assert.equal(called, false);
    assert.deepEqual(readdirSync(home.staging), []);
  }
});

test("a pass id given to withKeyCopy is in the copy name", async () => {
  const { home, account } = setup("key");
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  await withKeyCopy(home, account, (copy) => {
    assert.match(copy.split("/").pop()!, new RegExp(`^pi-k1-${id}-[A-Za-z0-9]{6}$`));
  }, id);
});
