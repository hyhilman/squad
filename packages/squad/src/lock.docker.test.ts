// Real Docker, real flock. Skipped unless SQUAD_DOCKER_CHECK=1. It runs images/entry.sh inside the
// local node:22-bookworm-slim image (mounted as the entrypoint), so no image build is needed.
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const IMG = "node:22-bookworm-slim";
const ENTRY = new URL("../../../images/entry.sh", import.meta.url).pathname;
const SKIP = process.env.SQUAD_DOCKER_CHECK !== "1";
const TERM_CLI = ["sh", "-c", 'trap "echo got-term; exit 0" TERM; while :; do sleep 0.2; done'];

const root = SKIP ? "" : mkdtempSync(join(tmpdir(), "squad-lock-"));
const names: string[] = [];
let n = 0;
const uniq = (): string => {
  const name = `squad-lockt-${process.pid}-${n++}`;
  names.push(name);
  return name;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const docker = (args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
const hostFlockFree = (file: string): boolean => spawnSync("flock", ["-n", file, "true"]).status === 0;

function runArgs(name: string, opts: { rm: boolean; mounts: string[]; env?: string[]; cli: string[] }): string[] {
  return [
    "run", ...(opts.rm ? ["--rm"] : []), "--init", "--name", name,
    // --mount, not -v: a missing source is an error, where -v would make a root-owned folder there.
    "--mount", `type=bind,source=${ENTRY},target=/usr/local/bin/squad-entry,readonly`,
    ...opts.mounts.flatMap((m) => ["-v", m]),
    ...(opts.env ?? []).flatMap((e) => ["-e", e]),
    "--entrypoint", "sh", IMG, "/usr/local/bin/squad-entry", ...opts.cli,
  ];
}

async function waitFor(cond: () => boolean, what: string, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${what}`);
}

function lockFile(): string {
  const f = join(mkdtempSync(join(root, "l-")), "acct.lock");
  writeFileSync(f, "");
  return f;
}

describe("entry.sh in real Docker", { skip: SKIP }, () => {
  after(() => {
    for (const nm of names) docker(["rm", "-f", nm]);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("a second container on a held lock exits 75", async () => {
    const lock = lockFile();
    const a = uniq();
    const client = spawn("docker", runArgs(a, { rm: true, mounts: [`${lock}:/squad/lock:ro`], env: ["SQUAD_LOCK=1"], cli: TERM_CLI }), { stdio: "ignore" });
    await waitFor(() => !hostFlockFree(lock), "the first container to take the lock");
    const b = docker(runArgs(uniq(), { rm: true, mounts: [`${lock}:/squad/lock:ro`], env: ["SQUAD_LOCK=1"], cli: ["echo", "ran"] }));
    assert.equal(b.status, 75);
    assert.ok(!b.stdout.includes("ran"));
    docker(["stop", "-t", "10", a]);
    client.kill();
  });

  test("killing the docker client leaves the container running and the lock held", async () => {
    const lock = lockFile();
    const a = uniq();
    const client = spawn("docker", runArgs(a, { rm: true, mounts: [`${lock}:/squad/lock:ro`], env: ["SQUAD_LOCK=1"], cli: TERM_CLI }), { detached: true, stdio: "ignore" });
    await waitFor(() => !hostFlockFree(lock), "the lock");
    process.kill(client.pid!, "SIGKILL");
    await sleep(1000);
    assert.equal(docker(["inspect", "-f", "{{.State.Running}}", a]).stdout.trim(), "true");
    assert.equal(hostFlockFree(lock), false);
    docker(["stop", "-t", "10", a]);
  });

  test("docker stop sends SIGTERM to the CLI, ends fast, and frees the lock", async () => {
    const lock = lockFile();
    const a = uniq();
    const client = spawn("docker", runArgs(a, { rm: false, mounts: [`${lock}:/squad/lock:ro`], env: ["SQUAD_LOCK=1"], cli: TERM_CLI }), { stdio: "ignore" });
    await waitFor(() => !hostFlockFree(lock), "the lock");
    const t0 = Date.now();
    docker(["stop", "-t", "10", a]);
    const took = Date.now() - t0;
    assert.ok(took < 5000, `stop took ${took} ms`);
    assert.ok(docker(["logs", a]).stdout.includes("got-term"));
    await waitFor(() => hostFlockFree(lock), "the lock to be free");
    client.kill();
  });

  test("SQUAD_LOCK=1 with no lock mounted fails, not with 75, and the CLI never runs", () => {
    const r = docker(runArgs(uniq(), { rm: true, mounts: [], env: ["SQUAD_LOCK=1"], cli: ["echo", "ran"] }));
    assert.notEqual(r.status, 0);
    assert.notEqual(r.status, 75);
    assert.ok(!r.stdout.includes("ran"));
  });

  test("SQUAD_TOKEN_FILE becomes CLAUDE_CODE_OAUTH_TOKEN and stays out of docker inspect", () => {
    const fake = "sk-ant-oat01-FAKEFAKEFAKEFAKE";
    const f = join(mkdtempSync(join(root, "t-")), "token");
    writeFileSync(f, `${fake}\n`);
    const name = uniq();
    const r = docker(runArgs(name, { rm: false, mounts: [`${f}:/squad/token:ro`], env: ["SQUAD_TOKEN_FILE=/squad/token"], cli: ["sh", "-c", 'printf %s "$CLAUDE_CODE_OAUTH_TOKEN"; printf "[%s]" "${SQUAD_TOKEN_FILE-unset}"'] }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${fake}[unset]`);
    const inspect = docker(["inspect", name]).stdout;
    assert.ok(inspect.length > 100);
    assert.ok(!inspect.includes(fake));
    docker(["rm", "-f", name]);
  });
});
