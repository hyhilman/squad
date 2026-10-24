import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHome, homeRoot, layoutOf } from "./home.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

test("the home is .squad/ in the main checkout, also from a linked worktree", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "repo-")));
  const main = join(dir, "main");
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  git(main, "worktree", "add", "-q", join(dir, "wt"));
  assert.equal(homeRoot(main, {}), join(main, ".squad"));
  assert.equal(homeRoot(join(dir, "wt"), {}), join(main, ".squad"));
});

test("SQUAD_HOME wins, and a relative one is from cwd", () => {
  assert.equal(homeRoot("/p", { SQUAD_HOME: "/x/home" }), "/x/home");
  assert.equal(homeRoot("/p", { SQUAD_HOME: "h" }), "/p/h");
});

test("ensureHome makes every folder 0700 and is safe twice", () => {
  const root = join(mkdtempSync(join(tmpdir(), "home-")), "h");
  const l = layoutOf(root, {});
  ensureHome(l);
  ensureHome(l);
  for (const d of [l.root, l.accounts, l.locks, l.state, l.spool, l.sessions]) assert.equal(statSync(d).mode & 0o777, 0o700, d);
  assert.equal(l.db, join(root, "state", "squad.db"));
  assert.equal(layoutOf(root, { SQUAD_DB: "/tmp/x.db" }).db, "/tmp/x.db");
});
