import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IMAGES } from "../images.ts";
import { Refusal, scopeSetup, type ScopeContext } from "./scope.ts";
import type { ProjectToken } from "./tokens.ts";

const setup = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "scope-")));
  const root = join(d, "work");
  const outside = join(d, "outside");
  const home = join(d, "work", ".squad");
  for (const p of [root, outside, home, join(root, "repo", ".git"), join(root, "skill"), join(root, "tools")]) mkdirSync(p, { recursive: true });
  writeFileSync(join(root, "skill", "SKILL.md"), "# s\n");
  const token: ProjectToken = { id: "T1", project: "p", accounts: ["pi/one"], roots: [root], images: ["my/pi:1"], createdAt: "", lastUsedAt: null };
  const ctx: ScopeContext = { home, uid: process.getuid!() };
  return { d, root, repo: join(root, "repo"), outside, home, token, ctx };
};

const forbidden = (field: string) => (e: unknown): boolean => {
  assert.ok(e instanceof Refusal, String(e));
  assert.equal(e.status, 403);
  assert.equal(e.error, `out of scope: ${field}`);
  return true;
};

test("a setup inside the roots passes and comes back with real paths", () => {
  const { root, repo, token, ctx } = setup();
  symlinkSync(join(root, "repo"), join(root, "link"));
  const out = scopeSetup(token, { runner: "pi", account: "one", cwd: join(root, "link"), gitDir: join(root, "repo", ".git"), skill: { name: "s", dir: join(root, "skill") }, mounts: [{ host: join(root, "tools"), container: "/tools", ro: true }] }, ctx);
  assert.deepEqual(out, { account: "pi/one", cwd: join(root, "repo"), gitDir: join(root, "repo", ".git"), skill: { name: "s", dir: join(root, "skill") }, mounts: [{ host: join(root, "tools"), container: "/tools", ro: true }] });
  assert.equal(scopeSetup(token, { runner: "pi", account: "pi/one", cwd: repo, image: "my/pi:1" }, ctx).account, "pi/one");
  assert.equal(scopeSetup(token, { runner: "pi", account: "pi/one", cwd: repo, image: IMAGES.pi.tag }, ctx).account, "pi/one");
});

test("an account the token does not name is a 403 naming the field", () => {
  const { repo, token, ctx } = setup();
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "two", cwd: repo }, ctx), forbidden("account"));
  assert.throws(() => scopeSetup(token, { runner: "codex", account: "one", cwd: repo }, ctx), forbidden("account"));
});

test("with no account the setup carries the token's accounts of that runner; none is the same 403", () => {
  const { repo, token, ctx } = setup();
  const both = { ...token, accounts: ["pi/one", "codex/one", "pi/two"] };
  assert.deepEqual(scopeSetup(both, { runner: "pi", cwd: repo }, ctx), { allowed: ["pi/one", "pi/two"], cwd: repo });
  assert.throws(() => scopeSetup(token, { runner: "codex", cwd: repo }, ctx), forbidden("account"));
});

test("a path outside every root is a 403; a sibling with the root as its prefix is outside too", () => {
  const { root, repo, outside, token, ctx } = setup();
  mkdirSync(`${root}-evil`);
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: outside }, ctx), forbidden("cwd"));
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: `${root}-evil` }, ctx), forbidden("cwd"));
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: repo, gitDir: outside }, ctx), forbidden("gitDir"));
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: repo, skill: { name: "s", dir: outside } }, ctx), forbidden("skill.dir"));
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: repo, mounts: [{ host: join(root, "tools"), container: "/a", ro: true }, { host: outside, container: "/b", ro: true }] }, ctx), forbidden("mounts[1].host"));
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: "relative/path" }, ctx), forbidden("cwd"));
});

test("a symlink inside a root that points outside it is refused (no symlink escape)", () => {
  const { root, repo, outside, token, ctx } = setup();
  symlinkSync(outside, join(root, "escape"));
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: join(root, "escape") }, ctx), forbidden("cwd"));
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: repo, mounts: [{ host: join(root, "escape"), container: "/x", ro: false }] }, ctx), forbidden("mounts[0].host"));
});

test("a symlink to the squad home, or a root that holds the home, never mounts the home", () => {
  const { root, repo, home, token, ctx } = setup();
  symlinkSync(home, join(root, "home-link"));
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: join(root, "home-link") }, ctx), forbidden("cwd"));
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: repo, mounts: [{ host: join(root, "home-link"), container: "/x", ro: true }] }, ctx), forbidden("mounts[0].host"));
  // The root itself holds the home: mounting the whole root would show every account.
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: repo, mounts: [{ host: root, container: "/x", ro: true }] }, ctx), forbidden("mounts[0].host"));
});

test("a missing path is a 403 naming the field", () => {
  const { root, repo, token, ctx } = setup();
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: join(root, "nope") }, ctx), forbidden("cwd"));
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: repo, gitDir: join(root, "nope") }, ctx), forbidden("gitDir"));
});

test("an image that is neither squad's own nor in the token's list is a 403", () => {
  const { repo, token, ctx } = setup();
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: repo, image: "evil/pi:1" }, ctx), forbidden("image"));
  // squad's own image of another runner is not this runner's.
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: repo, image: IMAGES.codex.tag }, ctx), forbidden("image"));
});

test("a cwd owned by another uid is a 403 that names both uids", () => {
  const { repo, token, ctx } = setup();
  const me = process.getuid!();
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: repo }, { ...ctx, uid: me + 1 }), (e: unknown) => {
    assert.ok(e instanceof Refusal);
    assert.equal(e.status, 403);
    assert.equal(e.error, `cwd ${repo} is owned by uid ${me}, squad serve runs as uid ${me + 1}`);
    return true;
  });
});

test("a container name must start with the token's project and a dash, so a token can only replace its own containers", () => {
  const { repo, token, ctx } = setup();
  assert.equal(scopeSetup(token, { runner: "pi", account: "one", cwd: repo, container: "p-review-42" }, ctx).account, "pi/one");
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: repo, container: "postgres" }, ctx), forbidden("container"));
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: repo, container: "p" }, ctx), forbidden("container"));
  assert.throws(() => scopeSetup(token, { runner: "pi", account: "one", cwd: repo, container: "pp-x" }, ctx), forbidden("container"), "another project that starts with the same letters");
});
