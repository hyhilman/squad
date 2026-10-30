import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildArgv, IMAGE_REVISION, IMAGES, NODE_IMAGE, PYTHON_VERSION, UV_IMAGE } from "./images.ts";

const RUNNERS = ["pi", "codex", "claude"] as const;
const CLI = { pi: "pi", codex: "codex", claude: "claude" } as const;
const dockerfile = (r: string): string => readFileSync(new URL(`../../../images/${r}/Dockerfile`, import.meta.url), "utf8");

test("the table pins the versions and the tags", () => {
  assert.equal(IMAGES.pi.version, "1.1.0");
  assert.equal(IMAGES.codex.version, "0.162.1");
  assert.equal(IMAGES.claude.version, "2.1.310");
  assert.equal(IMAGE_REVISION, 2);
  for (const r of RUNNERS) assert.equal(IMAGES[r].tag, `squad-${r}:${IMAGES[r].version}-r${IMAGE_REVISION}`);
  assert.match(NODE_IMAGE, /^node:22-bookworm-slim@sha256:[0-9a-f]{64}$/);
  assert.match(UV_IMAGE, /^ghcr\.io\/astral-sh\/uv:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  assert.match(PYTHON_VERSION, /^3\.(1[2-9])\.\d+$/, "an exact patch, 3.12 or newer");
});

test("buildArgv is the pure docker build argv", () => {
  assert.deepEqual(buildArgv("pi"), [
    "build", "-f", "images/pi/Dockerfile",
    "--build-arg", `NODE_IMAGE=${NODE_IMAGE}`,
    "--build-arg", `UV_IMAGE=${UV_IMAGE}`,
    "--build-arg", "PYTHON_VERSION=3.12.12",
    "--build-arg", "PI_VERSION=1.1.0",
    "-t", "squad-pi:1.1.0-r2",
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

  test(`${r}: the Dockerfile installs uv and Python for any uid`, () => {
    const d = dockerfile(r);
    assert.match(d, /^FROM \$\{UV_IMAGE\} AS uv$/m);
    assert.match(d, /^COPY --from=uv \/uv \/uvx \/usr\/local\/bin\/$/m);
    assert.ok(d.includes('uv python install --no-cache --no-bin "$PYTHON_VERSION"'));
    assert.ok(d.includes("/usr/local/bin/python3"));
    assert.ok(d.includes("chmod -R a+rX /opt/uv-python"));
  });
}

test("each image sets its account folder", () => {
  assert.ok(dockerfile("pi").includes("PI_CODING_AGENT_DIR=/pi"));
  assert.ok(dockerfile("codex").includes("CODEX_HOME=/codex"));
  assert.ok(dockerfile("claude").includes("CLAUDE_CONFIG_DIR=/claude"));
  assert.ok(dockerfile("claude").includes("DISABLE_AUTOUPDATER=1"));
});

test("every runner Dockerfile carries the squad.entry=1 label, which checkImage looks for", () => {
  for (const runner of ["pi", "codex", "claude"]) {
    const text = dockerfile(runner);
    assert.match(text, /^LABEL squad\.entry="1"$/m, runner);
  }
});

test("the claude image ships squad-browser at the path the web sign-in sets as $BROWSER, and it writes the file the server reads", async () => {
  const { BROWSER_SCRIPT, OPENED_FILE } = await import("./web/setup-token.ts");
  assert.match(dockerfile("claude"), new RegExp(`^COPY --chmod=755 claude/squad-browser ${BROWSER_SCRIPT}$`, "m"));
  const script = readFileSync(new URL("../../../images/claude/squad-browser", import.meta.url), "utf8");
  assert.ok(script.includes(`/claude/${OPENED_FILE}`) && script.includes("umask 077"));
});

test("the README names the current pi tag and the Python of the images", () => {
  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(`(\`${IMAGES.pi.tag}\`)`));
  assert.ok(readme.includes(`Python ${PYTHON_VERSION.split(".").slice(0, 2).join(".")} and uv`));
});
