import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANNEL_OF_BRANCH,
  DOWNLOAD,
  VERBS,
  VERB_OPTIONS,
  bump,
  notesFor,
  planRelease,
  publish,
  run,
  setLockVersion,
  setVersion,
  type Deps,
  type Plan,
  type Verb,
} from "../scripts/release.ts";
import { connectCommand } from "../src/web/connect.ts";

const SHA = "2545d712325f61583b26f8873348fc63ae781174";
const RCS = Array.from({ length: 10 }, (_, i) => `v0.1.0-rc.${i + 1}`);

const planOf = (branch: string, version = "0.1.0", tags: readonly string[] = RCS, head?: string): Plan => {
  const d = planRelease({ branch, sha: SHA, version, tags, ...(head === undefined ? {} : { head }) });
  assert.equal(d.skip, false, d.skip ? d.reason : "");
  return (d as { plan: Plan }).plan;
};

test("three branches make releases: dev, rc and main", () => {
  assert.deepEqual(CHANNEL_OF_BRANCH, { dev: "dev", rc: "rc", main: "stable" });
  assert.throws(() => planRelease({ branch: "feature", sha: SHA, version: "0.1.0", tags: [] }), /makes no release/);
});

test("rc takes one more than the highest rc tag of the base, so rc.10 is followed by rc.11", () => {
  const p = planOf("rc");
  assert.equal(p.version, "0.1.0-rc.11");
  assert.equal(p.tag, "v0.1.0-rc.11");
  assert.equal(p.prerelease, true);
  assert.deepEqual(p.tarballs, ["squad-0.1.0-rc.11.tgz", "squad-contract-0.1.0-rc.11.tgz"]);
  assert.equal(planOf("rc", "0.1.0", ["v0.1.0-rc.2", "v0.1.0-rc.9"]).version, "0.1.0-rc.10");
  assert.equal(planOf("rc", "0.1.0", []).version, "0.1.0-rc.1");
});

test("a dev build is named by its commit and is its own pre-release", () => {
  const p = planOf("dev");
  assert.equal(p.version, "0.1.0-dev.g2545d71");
  assert.equal(p.tag, "v0.1.0-dev.g2545d71");
  assert.equal(p.prerelease, true);
});

test("main makes the stable version, and a base that is already released is a skip there", () => {
  const p = planOf("main");
  assert.equal(p.version, "0.1.0");
  assert.equal(p.prerelease, false);
  const again = planRelease({ branch: "main", sha: SHA, version: "0.1.0", tags: [...RCS, "v0.1.0"] });
  assert.equal(again.skip, true);
  assert.match((again as { reason: string }).reason, /already released.*bump/);
});

test("on dev and rc a released base fails with the bump hint", () => {
  for (const branch of ["dev", "rc"]) {
    assert.throws(() => planRelease({ branch, sha: SHA, version: "0.1.0", tags: ["v0.1.0"] }), /already released.*bump patch\|minor\|major/);
  }
});

test("the base must be three numbers, one step above the last stable release", () => {
  assert.throws(() => planOf("rc", "0.1.0-rc.10"), /not a base/);
  assert.throws(() => planRelease({ branch: "rc", sha: SHA, version: "0.3.0", tags: ["v0.1.0"] }), /0\.1\.1 \(patch\), 0\.2\.0 \(minor\) or 1\.0\.0/);
  assert.equal(planOf("rc", "0.10.0", ["v0.9.0", "v0.10.0-rc.1"]).version, "0.10.0-rc.2");
});

test("a commit that is no longer the branch head is a skip: the newer push releases", () => {
  const d = planRelease({ branch: "rc", sha: SHA, head: "f".repeat(40), version: "0.1.0", tags: RCS });
  assert.equal(d.skip, true);
  assert.match((d as { reason: string }).reason, /newer push/);
});

test("a dev build of a commit that was already built is a skip", () => {
  const d = planRelease({ branch: "dev", sha: SHA, version: "0.1.0", tags: ["v0.1.0-dev.g2545d71"] });
  assert.equal(d.skip, true);
});

test("setVersion changes only the version and keeps the layout", () => {
  const text = '{\n  "name": "squad",\n  "version": "0.1.0",\n  "devDependencies": { "x": "0.1.0" }\n}\n';
  assert.equal(setVersion(text, "0.1.0-rc.11"), text.replace('"version": "0.1.0"', '"version": "0.1.0-rc.11"'));
});

test("setLockVersion changes squad's workspace entry and nothing else", () => {
  const lock = { name: "squad-monorepo", lockfileVersion: 3, packages: { "": { name: "squad-monorepo" }, "packages/squad": { version: "0.1.0" }, "packages/contract": { version: "0.1.0-dev" } } };
  const out = JSON.parse(setLockVersion(JSON.stringify(lock), "0.1.0-rc.11"));
  assert.equal(out.packages["packages/squad"].version, "0.1.0-rc.11");
  assert.equal(out.packages["packages/contract"].version, "0.1.0-dev");
  assert.equal(out.packages[""].version, undefined);
});

test("the notes name the same tarball address the connect command uses", () => {
  const p = planOf("rc");
  const squad = `${DOWNLOAD}/${p.tag}/${p.tarballs[0]}`;
  assert.ok(notesFor(p).includes(squad));
  assert.ok(connectCommand(p.version, "https://squad.example.com", "x").command.includes(squad));
  assert.match(notesFor(planOf("dev")), /dev build/);
});

/** A repo folder with squad's package.json and the lock, and a fake `run` that records each call. */
function fakeRepo(version = "0.1.0"): { root: string; calls: string[]; deps: (dryRun: boolean) => Deps } {
  const root = mkdtempSync(join(tmpdir(), "squad-release-test-"));
  mkdirSync(join(root, "packages/squad"), { recursive: true });
  writeFileSync(join(root, "packages/squad/package.json"), `{\n  "name": "squad",\n  "version": "${version}"\n}\n`);
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "packages/squad": { version } } }, null, 2));
  const calls: string[] = [];
  const fake = (cmd: string, args: readonly string[]): string => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "git" && args[0] === "rev-parse") return `${SHA}\n`;
    if (cmd === "git" && args[0] === "status") return "";
    if (cmd === "git" && args[0] === "tag" && args[1] === "--list") return RCS.join("\n");
    if (cmd === "git" && args[0] === "ls-remote") return `${SHA}\trefs/heads/rc\n`;
    // The packs write their tarball into the folder they are given.
    if (cmd === "npm" && args[0] === "pack") writeFileSync(join(args[args.indexOf("--pack-destination") + 1]!, "squad-0.1.0-rc.11.tgz"), "");
    if (cmd === "bash" && args[0] === "packages/contract/scripts/pack.sh") writeFileSync(join(args[1]!, "squad-contract-0.1.0-rc.11.tgz"), "");
    return "";
  };
  return { root, calls, deps: (dryRun) => ({ root, dryRun, run: fake }) };
}

test("publish stamps, commits, checks and packs before it tags, pushes the tag and makes the release", () => {
  const repo = fakeRepo();
  const out = publish(planOf("rc"), repo.deps(false));
  assert.equal(JSON.parse(readFileSync(join(repo.root, "packages/squad/package.json"), "utf8")).version, "0.1.0-rc.11");
  assert.equal(JSON.parse(readFileSync(join(repo.root, "package-lock.json"), "utf8")).packages["packages/squad"].version, "0.1.0-rc.11");
  const at = (prefix: string): number => {
    const i = repo.calls.findIndex((c) => c.startsWith(prefix));
    assert.notEqual(i, -1, `no call ${prefix}`);
    return i;
  };
  const order = [
    at("git add packages/squad/package.json package-lock.json"),
    at("git -c user.name=github-actions[bot]"),
    at("bash packages/squad/scripts/check-pack.sh"),
    at("bash packages/contract/scripts/check-pack.sh"),
    at("npm pack -w squad"),
    at("bash packages/contract/scripts/pack.sh"),
    repo.calls.findIndex((c) => / tag -a v0\.1\.0-rc\.11 /.test(c)),
    at("git push origin refs/tags/v0.1.0-rc.11"),
    at("gh release create v0.1.0-rc.11"),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const release = repo.calls[order.at(-1)!]!;
  assert.match(release, /squad-0\.1\.0-rc\.11\.tgz .*squad-contract-0\.1\.0-rc\.11\.tgz/);
  assert.match(release, /--prerelease --latest=false$/);
  // Only the tag is pushed: no branch push of any kind.
  assert.equal(repo.calls.filter((c) => c.startsWith("git push")).length, 1);
  assert.equal(out.length > 0, true);
});

test("a stable release is marked latest", () => {
  const repo = fakeRepo();
  const plan = { ...planOf("main"), tarballs: ["squad-0.1.0-rc.11.tgz", "squad-contract-0.1.0-rc.11.tgz"] as const };
  publish(plan, repo.deps(false));
  assert.match(repo.calls.at(-1)!, /--latest$/);
});

test("a dry run writes nothing and runs only the reads", () => {
  const repo = fakeRepo();
  const out = publish(planOf("rc"), repo.deps(true));
  assert.equal(JSON.parse(readFileSync(join(repo.root, "packages/squad/package.json"), "utf8")).version, "0.1.0");
  assert.deepEqual(repo.calls, [`git rev-parse HEAD`, `git status --porcelain --untracked-files=no`]);
  assert.ok(out.every((l) => l.startsWith("would ")));
});

test("publish refuses a checkout at another commit or with changes", () => {
  const root = mkdtempSync(join(tmpdir(), "squad-release-test-"));
  const at = (head: string, status: string): Deps => ({ root, dryRun: true, run: (_c, a) => (a[0] === "rev-parse" ? head : status) });
  assert.throws(() => publish(planOf("rc"), at("f".repeat(40), "")), /the checkout is at/);
  assert.throws(() => publish(planOf("rc"), at(SHA, " M x")), /changes to tracked files/);
});

test("bump raises the base one step from the last stable tag, and refuses a second bump", () => {
  const repo = fakeRepo("0.1.0-rc.10");
  bump("minor", RCS, repo.deps(false));
  assert.equal(JSON.parse(readFileSync(join(repo.root, "packages/squad/package.json"), "utf8")).version, "0.1.0");
  assert.throws(() => bump("patch", RCS, repo.deps(false)), /already at 0\.1\.0/);
  const after = fakeRepo("0.1.0");
  bump("patch", ["v0.1.0"], after.deps(false));
  assert.equal(JSON.parse(readFileSync(join(after.root, "package-lock.json"), "utf8")).packages["packages/squad"].version, "0.1.1");
});

test("run: publish needs the version plan printed, and a flag of another verb is refused", () => {
  const repo = fakeRepo();
  const bad = run(["publish", "--branch", "rc", "--sha", SHA, "--expect", "0.1.0-rc.10"], repo.deps(true));
  assert.equal(bad.code, 1);
  assert.match(bad.err, /another release got in between/);
  const ok = run(["publish", "--branch", "rc", "--sha", SHA, "--expect", "0.1.0-rc.11"], repo.deps(true));
  assert.equal(ok.code, 0, ok.err);
  assert.equal(run(["bump", "minor", "--branch", "rc"], repo.deps(true)).code, 1);
  const gh = run(["plan", "--branch", "rc", "--sha", SHA, "--check-head", "--format", "github"], repo.deps(true));
  assert.equal(gh.out, "skip=false\nversion=0.1.0-rc.11\ntag=v0.1.0-rc.11\nchannel=rc\n");
});

test("every release.ts step in the workflow names a verb and flags that verb takes", () => {
  const yml = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const steps = [...yml.matchAll(/release\.ts (\w+)([^\n]*)/g)];
  assert.ok(steps.length >= 2);
  for (const [, verb, rest] of steps) {
    assert.ok(VERBS.includes(verb as Verb), verb);
    for (const [, flag] of rest!.matchAll(/--([a-z-]+)/g)) assert.ok(Object.hasOwn(VERB_OPTIONS[verb as Verb], flag!), `${verb} --${flag}`);
  }
});
