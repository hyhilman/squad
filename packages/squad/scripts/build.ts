// Builds the installable package into dist/: the contract (vendored), the squad code, and the
// folders the code reads at run time (assets, images, webapp). `npm pack` runs this through `prepack`.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rewriteContractSpecifier } from "./rewrite.ts";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(PKG, "../..");
const DIST = join(PKG, "dist");
const VENDOR_INDEX = join(DIST, "vendor/contract/index.js");

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal})`);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

rmSync(DIST, { recursive: true, force: true });

const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
run(process.execPath, [tsc, "-p", join(ROOT, "packages/contract/tsconfig.build.json")], ROOT);
run(process.execPath, [tsc, "-p", join(PKG, "tsconfig.build.json")], PKG);

// The squad code imports the contract by name. Inside the package that name must be a path.
for (const f of walk(DIST)) {
  if (!/\.(js|d\.ts)$/.test(f)) continue;
  const before = readFileSync(f, "utf8");
  const after = rewriteContractSpecifier(before, f, VENDOR_INDEX);
  if (after !== before) writeFileSync(f, after);
}
const left = walk(DIST).filter((f) => /\.(js|d\.ts)$/.test(f) && readFileSync(f, "utf8").includes("@squad/contract"));
if (left.length > 0) throw new Error(`still names @squad/contract: ${left.join(", ")}`);

// The bin needs a shebang. The source stays plain so Node can run it with `node src/cli/squad.ts`.
const bin = join(DIST, "cli/squad.js");
const text = readFileSync(bin, "utf8");
if (!text.startsWith("#!")) writeFileSync(bin, `#!/usr/bin/env node\n${text}`);
chmodSync(bin, 0o755);

// The web app is the only part with its own build.
run("npm", ["run", "build", "-w", "@squad/web"], ROOT);
const web = join(ROOT, "apps/web/dist");
if (!existsSync(join(web, "index.html"))) throw new Error(`the web build left no index.html in ${web}`);

cpSync(join(PKG, "assets"), join(DIST, "assets"), { recursive: true });
cpSync(join(ROOT, "images"), join(DIST, "images"), { recursive: true });
cpSync(web, join(DIST, "webapp"), { recursive: true });
console.error(`built ${DIST}`);
