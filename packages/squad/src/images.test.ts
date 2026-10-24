import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildArgv, IMAGES, NODE_IMAGE } from "./images.ts";

const RUNNERS = ["pi", "codex", "claude"] as const;
const CLI = { pi: "pi", codex: "codex", claude: "claude" } as const;
const dockerfile = (r: string): string => readFileSync(new URL(`../../../images/${r}/Dockerfile`, import.meta.url), "utf8");

test("the table pins the versions and the tags", () => {
  assert.equal(IMAGES.pi.version, "1.1.0");
  assert.equal(IMAGES.codex.version, "0.162.1");
  assert.equal(IMAGES.claude.version, "2.1.310");
  for (const r of RUNNERS) assert.equal(IMAGES[r].tag, `squad-${r}:${IMAGES[r].version}`);
  assert.match(NODE_IMAGE, /^node:22-bookworm-slim@sha256:[0-9a-f]{64}$/);
});

test("buildArgv is the pure docker build argv", () => {
  assert.deepEqual(buildArgv("pi"), [
    "build", "-f", "images/pi/Dockerfile",
    "--build-arg", `NODE_IMAGE=${NODE_IMAGE}`,
    "--build-arg", "PI_VERSION=1.1.0",
    "-t", "squad-pi:1.1.0",
    "images",
  ]);
});

for (const r of RUNNERS) {
  test(`${r}: the Dockerfile declares exactly the ARGs buildArgv passes`, () => {
    const declared = [...dockerfile(r).matchAll(/^ARG (\w+)/gm)].map((m) => m[1]).sort();
    const passed = buildArgv(r)
      .filter((_, i, a) => a[i - 1] === "--build-arg")
      .map((s) => s.split("=")[0])
      .sort();
    assert.deepEqual(declared, passed);
    assert.ok(declared.includes("NODE_IMAGE"));
  });

  test(`${r}: the Dockerfile starts from NODE_IMAGE and uses squad-entry`, () => {
    const d = dockerfile(r);
    assert.match(d, /^FROM \$\{NODE_IMAGE\}$/m);
    assert.ok(d.includes(`ENTRYPOINT ["squad-entry", "${CLI[r]}"]`));
    assert.match(d, /^COPY entry\.sh \/usr\/local\/bin\/squad-entry$/m);
    assert.match(d, new RegExp(`^COPY ${r}/gitconfig /etc/gitconfig$`, "m"));
    assert.ok(d.includes("GIT_SSH_COMMAND=/bin/false"));
    assert.ok(d.includes("GH_CONFIG_DIR=/gh"));
  });
}

test("each image sets its account folder", () => {
  assert.ok(dockerfile("pi").includes("PI_CODING_AGENT_DIR=/pi"));
  assert.ok(dockerfile("codex").includes("CODEX_HOME=/codex"));
  assert.ok(dockerfile("claude").includes("CLAUDE_CONFIG_DIR=/claude"));
  assert.ok(dockerfile("claude").includes("DISABLE_AUTOUPDATER=1"));
});
