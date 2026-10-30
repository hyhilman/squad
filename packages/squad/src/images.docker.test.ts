// Real Docker. Skipped unless SQUAD_DOCKER_CHECK=1. It needs the runner images built first
// (`squad image build <runner>`); a runner whose image is missing fails, so a stale host shows.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { IMAGES, PYTHON_VERSION } from "./images.ts";

const SKIP = process.env.SQUAD_DOCKER_CHECK !== "1";
// A pass runs as the host uid, which is not root and not baked into the image.
const PROBE = [
  "set -e",
  "python3 --version",
  "python --version",
  "uv --version",
  "cd \"$(mktemp -d)\"",
  "uv venv -q .venv",
  ".venv/bin/python -c 'import sys; print(sys.version_info[:2] >= (3, 12))'",
].join("\n");

for (const runner of ["claude", "codex", "pi"] as const) {
  test(`${runner}: the image runs python3 ${PYTHON_VERSION} and uv as uid 1000`, { skip: SKIP }, () => {
    const r = spawnSync("docker", [
      "run", "--rm", "--init", "--user", "1000:1000", "--network", "none",
      "--entrypoint", "squad-entry", IMAGES[runner].tag, "sh", "-c", PROBE,
    ], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines[0], `Python ${PYTHON_VERSION}`);
    assert.equal(lines[1], `Python ${PYTHON_VERSION}`);
    assert.match(lines[2]!, /^uv \d+\.\d+\.\d+/);
    assert.equal(lines[3], "True");
  });
}
