import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loginArgv, shellArgv } from "./login.ts";

const pairs = (argv: string[], flag: string): string[] => argv.flatMap((a, i) => (argv[i - 1] === flag ? [a] : []));
const base = { cwd: "/tmp/scratch", passId: "P1", project: "proj", user: { uid: 1000, gid: 1000 }, home: "/h/.squad", image: "squad-codex:1" };

test("codex login: -it, the staging dir at /codex, no lock, `login --device-auth` after the image", () => {
  const a = loginArgv("codex", { ...base, staging: "/h/.squad/staging/S1" });
  assert.deepEqual(a.slice(0, 5), ["run", "--rm", "-it", "--init", "--name"]);
  assert.ok(pairs(a, "--mount").includes("type=bind,source=/h/.squad/staging/S1,target=/codex"));
  assert.ok(!a.some((x) => x.includes("/squad/lock") || x.includes("SQUAD_LOCK")), "no lock: nothing else sees staging");
  assert.deepEqual(a.slice(a.indexOf("squad-codex:1")), ["squad-codex:1", "login", "--device-auth"]);
  assert.ok(pairs(a, "--label").includes("squad.caller=proj/cli"));
});

test("pi login: no args, the folder at /pi", () => {
  const a = loginArgv("pi", { ...base, image: "squad-pi:1", staging: "/h/.squad/staging/S1" });
  assert.ok(pairs(a, "--mount").includes("type=bind,source=/h/.squad/staging/S1,target=/pi"));
  assert.equal(a[a.length - 1], "squad-pi:1");
});

test("claude login: no args (the person types /login), the folder at /claude, no lock", () => {
  const a = loginArgv("claude", { ...base, image: "squad-claude:1", staging: "/h/.squad/staging/S1" });
  assert.ok(pairs(a, "--mount").includes("type=bind,source=/h/.squad/staging/S1,target=/claude"));
  assert.ok(!a.some((x) => x.includes("SQUAD_LOCK")));
  assert.equal(a[a.length - 1], "squad-claude:1");
});

test("shell on a login: -it, the lock mounted, entrypoint squad-entry, bash", () => {
  const a = shellArgv({ runner: "codex", name: "alice", kind: "login" }, { ...base, dir: "/h/.squad/accounts/codex/alice", lockFile: "/h/.squad/locks/codex/alice.lock" });
  assert.equal(a[2], "-it");
  assert.ok(a.includes("SQUAD_LOCK=1"));
  assert.ok(pairs(a, "--mount").includes("type=bind,source=/h/.squad/locks/codex/alice.lock,target=/squad/lock,readonly"));
  assert.deepEqual(a.slice(a.indexOf("--entrypoint")), ["--entrypoint", "squad-entry", "squad-codex:1", "bash"]);
  assert.ok(pairs(a, "--label").includes("squad.caller=proj/cli"));
});

test("shell on a key: no lock", () => {
  const a = shellArgv({ runner: "pi", name: "k1", kind: "key" }, { ...base, image: "squad-pi:1", dir: "/h/.squad/staging/copy", lockFile: null });
  assert.ok(!a.includes("SQUAD_LOCK=1"));
  assert.equal(a[a.length - 1], "bash");
});

test("login and shell containers carry squad.purpose and keep squad.pass", () => {
  const l = pairs(loginArgv("codex", { ...base, staging: "/h/.squad/staging/S1" }), "--label");
  assert.ok(l.includes("squad.purpose=login") && l.includes("squad.pass=P1"));
  const s = pairs(shellArgv({ runner: "pi", name: "alice", kind: "key" }, { ...base, dir: "/h/.squad/accounts/pi/alice", lockFile: null }), "--label");
  assert.ok(s.includes("squad.purpose=shell") && s.includes("squad.pass=P1"));
});
