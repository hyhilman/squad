// The release tool. The release job in .github/workflows/ci.yml calls it. All of its logic sits here,
// where tests reach it without a network or a runner.
//
//   node packages/squad/scripts/release.ts plan    --branch <dev|rc|main> --sha <sha> [--check-head] [--tags "<tag> ..."] [--format github]
//   node packages/squad/scripts/release.ts publish --branch <dev|rc|main> --sha <sha> --expect <version> [--tags "<tag> ..."]
//   node packages/squad/scripts/release.ts bump    patch|minor|major [--tags "<tag> ..."]
//
// Three channels, one branch each, as in doppelganger. A person starts a dev build on `dev` (Run
// workflow): `<base>-dev.g<short sha>`. A push to `rc` makes a release candidate `<base>-rc.<n>`. A push
// to `main` makes the stable version `<base>`. The base is the `version` in packages/squad/package.json;
// a person raises it with `bump`, CI never does.
//
// Unlike doppelganger, a dev build gets its own GitHub pre-release: squad ships no images, so the
// tarballs on a release are the whole build. The web app's connect command also names the tarball by
// its exact version (src/web/connect.ts), so each build needs its own `v<version>` tag.
//
// The installed package must know its exact version. So a release is a tag-only commit: the branch head
// plus squad's package.json and lock entry at that version, tagged. Only the tag is pushed. The branch
// never moves, so no bot commit lands on it and starts CI again.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SQUAD_DRY_RUN_ENV, envOn } from "../src/settings.ts";

export type Channel = "dev" | "rc" | "stable";

/** The branch that makes each channel. Any other branch makes nothing. */
export const CHANNEL_OF_BRANCH: Readonly<Record<string, Channel>> = { dev: "dev", rc: "rc", main: "stable" };

/** Where a release's files live. src/web/connect.ts names the squad tarball under the same address; a test pins the two together. */
export const DOWNLOAD = "https://github.com/hyhilman/squad/releases/download";

/** The workspace that owns the version. The SDK tarball takes the same number (contract/scripts/pack.sh). */
export const SQUAD_DIR = "packages/squad";

// The standard identity of a GitHub Actions bot. The release commit and tag carry it.
const BOT = [
  "-c", "user.name=github-actions[bot]",
  "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
  "-c", "commit.gpgsign=false",
  "-c", "tag.gpgsign=false",
];

export interface Plan {
  readonly channel: Channel;
  readonly branch: string;
  /** The commit the release is made from. */
  readonly sha: string;
  /** The `version` in packages/squad/package.json: three numbers. */
  readonly base: string;
  readonly version: string;
  /** `v<version>`. */
  readonly tag: string;
  readonly prerelease: boolean;
  /** The two tarballs on the release: squad itself and the SDK. */
  readonly tarballs: readonly [string, string];
}

export type Decision = { readonly skip: false; readonly plan: Plan } | { readonly skip: true; readonly reason: string };

export function channelOf(branch: string): Channel {
  const channel = Object.hasOwn(CHANNEL_OF_BRANCH, branch) ? CHANNEL_OF_BRANCH[branch] : undefined;
  if (channel === undefined) throw new Error(`${JSON.stringify(branch)} makes no release: only dev, rc and main do`);
  return channel;
}

const NUMBER = "(0|[1-9]\\d*)";
const VERSION_RE = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);

/** The version in package.json must be a base: three numbers, with no -dev or -rc part. CI adds that. */
export function baseOf(version: string): string {
  if (!VERSION_RE.test(version)) {
    throw new Error(`${SQUAD_DIR}/package.json version ${JSON.stringify(version)} is not a base like 0.1.0. A person sets the base; CI adds the -dev or -rc part`);
  }
  return version;
}

/** The tags of a `git tag` listing, one per line or space. */
export function parseTags(text: string): string[] {
  return text.split(/\s+/).filter((t) => t !== "");
}

export type Bump = "patch" | "minor" | "major";
export const BUMPS: readonly Bump[] = ["patch", "minor", "major"];

export type Verb = "plan" | "publish" | "bump";
export const VERBS: readonly Verb[] = ["plan", "publish", "bump"];
const OPTIONS = {
  branch: { type: "string" },
  sha: { type: "string" },
  tags: { type: "string" },
  expect: { type: "string" },
  format: { type: "string" },
  "check-head": { type: "boolean" },
} as const;

/** The options each verb takes. A flag another verb takes is refused, not quietly ignored. Exported
 * so the workflow test checks each step's flags against this list. */
export const VERB_OPTIONS: Record<Verb, Partial<typeof OPTIONS>> = {
  plan: { branch: OPTIONS.branch, sha: OPTIONS.sha, tags: OPTIONS.tags, format: OPTIONS.format, "check-head": OPTIONS["check-head"] },
  publish: { branch: OPTIONS.branch, sha: OPTIONS.sha, tags: OPTIONS.tags, expect: OPTIONS.expect },
  bump: { tags: OPTIONS.tags },
};

type Triple = readonly [number, number, number];

function triple(version: string): Triple {
  const m = VERSION_RE.exec(version);
  if (m === null) throw new Error(`${JSON.stringify(version)} is not a version like 0.1.0`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const compare = (a: Triple, b: Triple): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The highest stable release among `tags`, compared as numbers (0.10.0 is above 0.9.0). Null when there is none. */
export function lastStable(tags: readonly string[]): string | null {
  let best: Triple | null = null;
  for (const tag of tags) {
    if (!tag.startsWith("v") || !VERSION_RE.test(tag.slice(1))) continue;
    const t = triple(tag.slice(1));
    if (best === null || compare(t, best) > 0) best = t;
  }
  return best === null ? null : best.join(".");
}

/** The three versions one step above `last`. Each step resets the numbers after it. */
export function nextSteps(last: string): Readonly<Record<Bump, string>> {
  const [major, minor, patch] = triple(last);
  return { patch: `${major}.${minor}.${patch + 1}`, minor: `${major}.${minor + 1}.0`, major: `${major + 1}.0.0` };
}

/** The version a release counts from before the first stable one. */
export const FIRST = "0.0.0";

/** Throws unless `base` is exactly one step above the last stable release, so a bad base fails on dev before it reaches main. */
export function checkBase(base: string, tags: readonly string[]): void {
  const last = lastStable(tags);
  const steps = nextSteps(last ?? FIRST);
  if (Object.values(steps).includes(base)) return;
  const released = tags.includes(`v${base}`) ? `v${base} is already released: raise the base. ` : "";
  throw new Error(
    `${released}${SQUAD_DIR}/package.json version ${base} is not one step above the last stable release ` +
      `${last === null ? `(none yet, counted as v${FIRST})` : `v${last}`}. ` +
      `The base must be ${steps.patch} (patch), ${steps.minor} (minor) or ${steps.major} (major). ` +
      "Run: git fetch --tags && npm run release -- bump patch|minor|major",
  );
}

/**
 * The next release candidate number for `base`: one more than the highest `v<base>-rc.<n>` tag. The
 * highest, not the count, so a deleted tag never makes a number be used twice.
 */
export function nextRc(base: string, tags: readonly string[]): number {
  const prefix = `v${base}-rc.`;
  let highest = 0;
  for (const tag of tags) {
    if (!tag.startsWith(prefix)) continue;
    const n = tag.slice(prefix.length);
    if (/^[1-9]\d*$/.test(n)) highest = Math.max(highest, Number(n));
  }
  return highest + 1;
}

export interface PlanInput {
  readonly branch: string;
  readonly sha: string;
  /** The tip of the branch right now. When it is not `sha`, a newer push owns the release. */
  readonly head?: string;
  /** The `version` in packages/squad/package.json. */
  readonly version: string;
  readonly tags: readonly string[];
}

export function planRelease(input: PlanInput): Decision {
  const channel = channelOf(input.branch);
  const base = baseOf(input.version);
  if (input.head !== undefined && input.head !== input.sha) {
    return { skip: true, reason: `${input.sha.slice(0, 7)} is not the head of ${input.branch} any more (${input.head.slice(0, 7)} is), so that newer push makes the release` };
  }
  // main releases on every push, and most pushes after a stable release do not raise the base. That is
  // a skip, not a red run. On dev and rc the same base fails below, with the bump hint.
  if (channel === "stable" && input.tags.includes(`v${base}`)) {
    return { skip: true, reason: `v${base} is already released. To release main again, raise the base on dev: npm run release -- bump patch|minor|major` };
  }
  checkBase(base, input.tags);
  if (!/^[0-9a-f]{7,40}$/.test(input.sha)) throw new Error(`${JSON.stringify(input.sha)} is not a commit`);
  // `g` keeps the version valid semver when the short hash is all digits and starts with 0.
  const version = channel === "stable" ? base : channel === "rc" ? `${base}-rc.${nextRc(base, input.tags)}` : `${base}-dev.g${input.sha.slice(0, 7)}`;
  if (input.tags.includes(`v${version}`)) return { skip: true, reason: `v${version} already exists: this commit was built before` };
  return {
    skip: false,
    plan: {
      channel,
      branch: input.branch,
      sha: input.sha,
      base,
      version,
      tag: `v${version}`,
      prerelease: channel !== "stable",
      tarballs: [`squad-${version}.tgz`, `squad-contract-${version}.tgz`],
    },
  };
}

/** A package.json text with its `version` swapped. Only that value changes: the file keeps its own layout. */
export function setVersion(text: string, version: string): string {
  const old = (JSON.parse(text) as { version?: unknown }).version;
  if (typeof old !== "string") throw new Error("a package.json has no version to change");
  const field = new RegExp(`("version"\\s*:\\s*)"${old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
  if (!field.test(text)) throw new Error(`could not find "version": "${old}" in a package.json`);
  return text.replace(field, `$1"${version}"`);
}

/** The text of package-lock.json with squad's workspace entry at `version`. */
export function setLockVersion(text: string, version: string): string {
  const lock = JSON.parse(text) as { packages?: Record<string, { version?: string }> };
  const entry = lock.packages?.[SQUAD_DIR];
  if (entry?.version === undefined) throw new Error(`package-lock.json has no ${SQUAD_DIR} entry with a version`);
  entry.version = version;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/** What the plan says, one fact to a line. */
export function describe(plan: Plan): string[] {
  const row = (label: string, text: string): string => `${label.padEnd(12)}${text}`;
  return [
    row("branch", plan.branch),
    row("channel", plan.channel),
    row("commit", plan.sha.slice(0, 7)),
    row("version", plan.version),
    row("tag", plan.tag),
    row("release", `GitHub ${plan.prerelease ? "pre-release" : "release"}, with ${plan.tarballs.join(" and ")}`),
  ];
}

/** `name=value` lines for $GITHUB_OUTPUT. */
export function githubOutput(decision: Decision): string {
  if (decision.skip) return `skip=true\nskip_reason=${decision.reason}\n`;
  const p = decision.plan;
  return `skip=false\nversion=${p.version}\ntag=${p.tag}\nchannel=${p.channel}\n`;
}

export interface Deps {
  /** The repo checkout the release is made in. */
  readonly root: string;
  readonly dryRun: boolean;
  /** Runs a program in `root` and returns its output. Throws, with the program's own words, on failure. */
  readonly run: (cmd: string, args: readonly string[]) => string;
}

/** The notes a release opens with. GitHub adds the changes since the last one. */
export function notesFor(plan: Plan): string {
  const [squad, sdk] = plan.tarballs.map((t) => `${DOWNLOAD}/${plan.tag}/${t}`);
  return [
    ...(plan.channel === "dev" ? [`A dev build of commit ${plan.sha.slice(0, 7)} on dev. Not for real use.`, ""] : []),
    `Install squad: npm install ${squad}`,
    `Install the SDK: npm install ${sdk}`,
  ].join("\n");
}

/**
 * Makes the release in `deps.root`, which must hold `plan.sha` with no change to a tracked file.
 * The tag is pushed only after both tarballs are packed and checked, so a failed build leaves no tag
 * and the next run takes the same number again. Returns what it did (or would do), one step to a line.
 */
export function publish(plan: Plan, deps: Deps): string[] {
  const { root, run } = deps;
  const head = run("git", ["rev-parse", "HEAD"]).trim();
  if (head !== plan.sha) throw new Error(`the checkout is at ${head.slice(0, 7)}, but the plan is for ${plan.sha.slice(0, 7)}`);
  if (run("git", ["status", "--porcelain", "--untracked-files=no"]).trim() !== "") {
    throw new Error("the checkout has changes to tracked files: a release commit would carry them");
  }

  const out: string[] = [];
  const step = (verb: string, text: string, act: () => string | void): void => {
    const note = deps.dryRun ? undefined : act();
    out.push(`${(deps.dryRun ? `would ${verb}` : verb).padEnd(14)}${text}`);
    if (note) out.push(note);
  };
  const pkgPath = join(root, SQUAD_DIR, "package.json");
  const lockPath = join(root, "package-lock.json");
  const dest = deps.dryRun ? join(tmpdir(), "squad-release") : mkdtempSync(join(tmpdir(), "squad-release-"));
  const files = plan.tarballs.map((t) => join(dest, t));

  step("write", `${SQUAD_DIR}/package.json and package-lock.json at version ${plan.version}`, () => {
    writeFileSync(pkgPath, setVersion(readFileSync(pkgPath, "utf8"), plan.version));
    writeFileSync(lockPath, setLockVersion(readFileSync(lockPath, "utf8"), plan.version));
  });
  step("commit", `"squad ${plan.version}" on top of ${plan.sha.slice(0, 7)}. Only the tag is pushed, so ${plan.branch} does not move`, () => {
    run("git", ["add", `${SQUAD_DIR}/package.json`, "package-lock.json"]);
    run("git", [...BOT, "commit", "-m", `squad ${plan.version}`]);
  });
  // Each check installs its own fresh pack into an empty folder and uses it, the version included.
  step("check", "both packages: packages/squad/scripts/check-pack.sh and packages/contract/scripts/check-pack.sh", () => {
    run("bash", ["packages/squad/scripts/check-pack.sh"]);
    run("bash", ["packages/contract/scripts/check-pack.sh"]);
  });
  step("pack", plan.tarballs.join(" and "), () => {
    run("npm", ["pack", "-w", "squad", "--pack-destination", dest, "--silent"]);
    run("bash", ["packages/contract/scripts/pack.sh", dest]);
    const missing = files.filter((f) => !existsSync(f));
    if (missing.length > 0) throw new Error(`the pack did not write ${missing.join(", ")}`);
  });
  step("tag", plan.tag, () => void run("git", [...BOT, "tag", "-a", plan.tag, "-m", `squad ${plan.version}`]));
  step("push", `refs/tags/${plan.tag} to origin`, () => void run("git", ["push", "origin", `refs/tags/${plan.tag}`]));
  step("release", `${plan.tag} as a GitHub ${plan.prerelease ? "pre-release" : "release"}`, () => {
    const kind = plan.prerelease ? ["--prerelease", "--latest=false"] : ["--latest"];
    const args = ["release", "create", plan.tag, ...files, "--title", `squad ${plan.version}`, "--verify-tag", "--generate-notes", "--notes", notesFor(plan), ...kind];
    return run("gh", args).trim();
  });
  return out;
}

/** Raises the base one step from the last stable tag. Refuses when it is already one step above, so two bumps cannot skip a number. */
export function bump(kind: Bump, tags: readonly string[], deps: Deps): string[] {
  const pkgPath = join(deps.root, SQUAD_DIR, "package.json");
  const lockPath = join(deps.root, "package-lock.json");
  const pkgText = readFileSync(pkgPath, "utf8");
  const current = (JSON.parse(pkgText) as { version?: string }).version ?? "";
  const last = lastStable(tags);
  const steps = nextSteps(last ?? FIRST);
  const lastName = last === null ? `none yet, counted as v${FIRST}` : `v${last}`;
  if (Object.values(steps).includes(current)) {
    throw new Error(`${SQUAD_DIR}/package.json is already at ${current}, one step above the last stable release (${lastName}). Release it before you bump again`);
  }
  const next = steps[kind];
  if (!deps.dryRun) {
    writeFileSync(pkgPath, setVersion(pkgText, next));
    writeFileSync(lockPath, setLockVersion(readFileSync(lockPath, "utf8"), next));
  }
  const verb = (deps.dryRun ? "would write" : "wrote").padEnd(12);
  return [`last stable  ${lastName}`, `base         ${current}`, `bump         ${kind}, so ${next}`, "", `${verb}${SQUAD_DIR}/package.json`, `${verb}package-lock.json`];
}

export const USAGE = [
  "usage:",
  "  release.ts plan    --branch <dev|rc|main> --sha <sha> [--check-head] [--tags \"<tag> ...\"] [--format github]",
  "  release.ts publish --branch <dev|rc|main> --sha <sha> --expect <version> [--tags \"<tag> ...\"]",
  "  release.ts bump    patch|minor|major [--tags \"<tag> ...\"]    # the last stable release comes from the given tags or the local ones (git fetch --tags first)",
  "  SQUAD_DRY_RUN=1 release.ts publish|bump ...    # print the steps, do none of them",
].join("\n");

interface Values {
  branch?: string;
  sha?: string;
  tags?: string;
  expect?: string;
  format?: string;
  "check-head"?: boolean;
}

function decide(values: Values, deps: Deps): Decision {
  if (values.branch === undefined) throw new Error("--branch is required");
  const pkg = JSON.parse(readFileSync(join(deps.root, SQUAD_DIR, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string") throw new Error(`${SQUAD_DIR}/package.json has no version`);
  const sha = values.sha ?? deps.run("git", ["rev-parse", "HEAD"]).trim();
  const tags = parseTags(values.tags ?? deps.run("git", ["tag", "--list", "v*"]));
  let head: string | undefined;
  if (values["check-head"] === true) {
    head = deps.run("git", ["ls-remote", "origin", `refs/heads/${values.branch}`]).split(/\s+/)[0];
    if (head === undefined || head === "") throw new Error(`origin has no branch ${values.branch}`);
  }
  return planRelease({ branch: values.branch, sha, ...(head === undefined ? {} : { head }), version: pkg.version, tags });
}

/** Never throws: a refusal prints as a message and exit code 1. */
export function run(argv: readonly string[], deps: Deps): { out: string; err: string; code: number } {
  try {
    const [verb, ...rest] = argv;
    if (verb === undefined || !VERBS.includes(verb as Verb)) return { out: "", err: USAGE, code: 1 };
    const { values, positionals } = parseArgs({ args: rest, options: VERB_OPTIONS[verb as Verb], allowPositionals: true, strict: true }) as {
      values: Values;
      positionals: string[];
    };
    const dry = deps.dryRun ? ["dry run: nothing is written, tagged, pushed or released", ""] : [];

    if (verb === "bump") {
      const kind = positionals[0];
      if (positionals.length !== 1 || !BUMPS.includes(kind as Bump)) return { out: "", err: USAGE, code: 1 };
      const tags = parseTags(values.tags ?? deps.run("git", ["tag", "--list", "v*"]));
      return { out: `${[...dry, ...bump(kind as Bump, tags, deps)].join("\n")}\n`, err: "", code: 0 };
    }
    if (positionals.length > 0) throw new Error(`unexpected argument ${positionals[0]}`);

    const decision = decide(values, deps);
    if (verb === "plan") {
      if (values.format === "github") return { out: githubOutput(decision), err: "", code: 0 };
      return { out: `${decision.skip ? `skip: ${decision.reason}` : describe(decision.plan).join("\n")}\n`, err: "", code: 0 };
    }

    if (decision.skip) return { out: `skip: ${decision.reason}\n`, err: "", code: 0 };
    if (values.expect === undefined) throw new Error("publish needs --expect <version>, the version plan printed");
    if (decision.plan.version !== values.expect) {
      throw new Error(`plan said ${values.expect}, but the tags now give ${decision.plan.version}: another release got in between`);
    }
    return { out: `${[...dry, ...describe(decision.plan), "", ...publish(decision.plan, deps)].join("\n")}\n`, err: "", code: 0 };
  } catch (e) {
    return { out: "", err: `release: ${e instanceof Error ? e.message : String(e)}`, code: 1 };
  }
}

if (import.meta.filename === process.argv[1]) {
  const root = resolve(import.meta.dirname, "../../..");
  const shell = (cmd: string, args: readonly string[]): string => {
    try {
      // stderr is inherited: the pack checks print their progress there, and the job log shows it.
      return execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      throw new Error(`${cmd} ${args.join(" ")} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const result = run(process.argv.slice(2), { root, dryRun: envOn(SQUAD_DRY_RUN_ENV), run: shell });
  if (result.out) process.stdout.write(result.out);
  if (result.err) process.stderr.write(result.err.endsWith("\n") ? result.err : `${result.err}\n`);
  process.exitCode = result.code;
}
