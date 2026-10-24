// The pure plan -> `docker run` argv. It reads no file and starts nothing, so a test can pin every
// rule. The caller builds the plan, runs the argv, and keeps the passes apart.

import { posix } from "node:path";
import { envNum, SQUAD_STOP_GRACE_S_ENV } from "./settings.ts";

export type Runner = "claude" | "codex" | "pi";
export type AccountKind = "login" | "key" | "token";

/** A host path mounted into the container. `container` defaults to the host path. */
export interface Mount {
  readonly host: string;
  readonly container?: string;
  readonly ro: boolean;
}

export interface PassPlan {
  readonly runner: Runner;
  readonly image: string;
  readonly name: string;
  readonly passId: string;
  /** What the container is for. gc leaves a running login or shell alone: a person is using it. Default "pass". */
  readonly purpose?: "pass" | "login" | "shell";
  readonly caller: { readonly project: string; readonly flow: string };
  /** null on a rootless daemon, where the container user already maps to the host user. */
  readonly user: { readonly uid: number; readonly gid: number } | null;
  readonly cwd: string;
  /** The main repo's .git. A worktree keeps its objects there. */
  readonly gitDir: string;
  readonly mounts: readonly Mount[];
  /**
   * Files laid read-only over a path inside the account mount. Only `/codex/config.toml` is allowed
   * for now. The host file must be outside the home.
   */
  readonly overlays: readonly { readonly host: string; readonly container: string }[];
  /**
   * A session folder, `<home>/sessions/<runner>/<account>/<id>`, mounted read-write at /squad/sessions.
   * It is the one home path besides the account and the lock; `mounts` can never reach it.
   */
  readonly session: { readonly dir: string } | null;
  readonly account: { readonly name: string; readonly kind: AccountKind; readonly dir: string };
  /** Host path of the account lock. Required for a login. */
  readonly lockFile: string | null;
  readonly identity: { readonly name: string; readonly email: string };
  readonly ghDir: string | null;
  /** The squad home. No extra mount, cwd or git dir may be it, be inside it, or hold it. */
  readonly home?: string | null;
  readonly env: Readonly<Record<string, string>>;
  /** The CLI args from src/runners. */
  readonly args: readonly string[];
  /** A person at a terminal (`squad login`, `squad shell`): `-it` in place of `-i`. */
  readonly tty?: boolean;
  /** Replaces the image's ENTRYPOINT, such as `squad-entry` to run `bash` behind the lock. */
  readonly entrypoint?: string;
}

const ACCOUNT_PATH: Readonly<Record<Runner, string>> = { pi: "/pi", codex: "/codex", claude: "/claude" };

/** Names squad sets itself. A caller that sets one could point a pass at another account or smuggle a token. */
const INTERNAL_ENV: ReadonlySet<string> = new Set(["SQUAD_LOCK", "SQUAD_TOKEN_FILE", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME", "PI_CODING_AGENT_DIR", "CLAUDE_CONFIG_DIR"]);

/**
 * Every bind mount is `--mount`, never `-v`: `-v` makes a root-owned folder when the source is
 * missing, so a missing lock file would give the container a lock the host never sees. `--mount` fails.
 */
function mountArg(host: string, container: string, ro: boolean): string {
  if (host.includes(",") || container.includes(",")) throw new Error(`a mounted path cannot hold a comma: ${host} -> ${container}`);
  return `type=bind,source=${host},target=${container}${ro ? ",readonly" : ""}`;
}

/** Container paths squad owns, and the three places under /squad that the runners themselves return. */
const RESERVED = ["/squad", "/pi", "/codex", "/claude", "/gh"];
/** The one file an overlay may cover. */
const OVERLAY_TARGET = "/codex/config.toml";
const RUNNER_PATHS = ["/squad/skills", "/squad/out", "/squad/sessions"];

const within = (path: string, base: string): boolean => path === base || path.startsWith(base.endsWith("/") ? base : `${base}/`);

function checkExtraTarget(container: string): void {
  const c = posix.normalize(container);
  if (RESERVED.some((r) => within(c, r)) && !RUNNER_PATHS.some((r) => within(c, r))) throw new Error(`mount target ${container} is reserved for squad`);
}

/** A mount of the home, inside it, or of a parent of it would expose accounts the pass does not own. */
function checkHome(host: string, home: string | null | undefined): void {
  if (home === null || home === undefined) return;
  const h = posix.resolve(host);
  const hm = posix.resolve(home);
  if (within(h, hm) || within(hm, h)) throw new Error(`mount source ${host} touches the squad home`);
}

/** The session folder is one id folder, three levels under `<home>/sessions`: never the root, never a sibling of it. */
function checkSession(dir: string, home: string | null | undefined): void {
  if (home === null || home === undefined) throw new Error("a session needs the squad home, to check its folder");
  const rel = posix.relative(posix.resolve(home, "sessions"), posix.resolve(dir));
  const parts = rel.split("/");
  if (rel === "" || parts.length !== 3 || parts.some((x) => x === "" || x === "..")) throw new Error(`session dir ${dir} must be <home>/sessions/<runner>/<account>/<id>`);
}

export function dockerRunArgv(plan: PassPlan): string[] {
  const { account, runner } = plan;
  for (const k of Object.keys(plan.env)) if (INTERNAL_ENV.has(k)) throw new Error(`env ${k} is set by squad, a caller cannot set it`);
  if (account.kind === "token" && runner !== "claude") throw new Error(`a token account is for claude only, not ${runner}`);
  if (account.kind === "login" && plan.lockFile === null) throw new Error("a login account needs a lock file");

  const argv = ["run", "--rm", plan.tty === true ? "-it" : "-i", "--init", "--name", plan.name];
  argv.push("--label", `squad.pass=${plan.passId}`, "--label", `squad.caller=${plan.caller.project}/${plan.caller.flow}`, "--label", `squad.account=${runner}/${account.name}`, "--label", `squad.purpose=${plan.purpose ?? "pass"}`);
  argv.push("--network", "host");
  if (plan.user !== null) argv.push("--user", `${plan.user.uid}:${plan.user.gid}`);

  checkHome(plan.cwd, plan.home);
  checkHome(plan.gitDir, plan.home);
  argv.push("--mount", mountArg(plan.cwd, plan.cwd, false), "-w", plan.cwd);
  // A git dir inside cwd is already mounted, and a second mount of the same tree is noise.
  if (!within(plan.gitDir, plan.cwd)) argv.push("--mount", mountArg(plan.gitDir, plan.gitDir, false));
  for (const m of plan.mounts) {
    const target = m.container ?? m.host;
    checkExtraTarget(target);
    if (plan.session !== null && within(posix.normalize(target), "/squad/sessions")) throw new Error(`mount target ${target} is the session's`);
    checkHome(m.host, plan.home);
    argv.push("--mount", mountArg(m.host, target, m.ro));
  }

  if (plan.session !== null) {
    checkSession(plan.session.dir, plan.home);
    argv.push("--mount", mountArg(plan.session.dir, "/squad/sessions", false));
  }

  // Exactly one account mount per pass.
  if (account.kind === "token") {
    argv.push("--mount", mountArg(`${account.dir}/token`, "/squad/token", true), "-e", "SQUAD_TOKEN_FILE=/squad/token");
  } else {
    argv.push("--mount", mountArg(account.dir, ACCOUNT_PATH[runner], false));
  }
  // An overlay comes after the account mount: in docker a later mount on a sub-path wins.
  for (const o of plan.overlays) {
    if (runner !== "codex" || posix.normalize(o.container) !== OVERLAY_TARGET) throw new Error(`overlay target ${o.container} is not allowed; only ${OVERLAY_TARGET} for codex`);
    checkHome(o.host, plan.home);
    argv.push("--mount", mountArg(o.host, OVERLAY_TARGET, true));
  }
  if (account.kind === "login") argv.push("--mount", mountArg(plan.lockFile!, "/squad/lock", true), "-e", "SQUAD_LOCK=1");

  if (plan.ghDir !== null) argv.push("--mount", mountArg(plan.ghDir, "/gh", true));
  // The identity comes after the caller env: with a repeated -e, the last one wins.
  for (const [k, v] of Object.entries(plan.env)) argv.push("-e", `${k}=${v}`);
  const { name, email } = plan.identity;
  argv.push("-e", `GIT_AUTHOR_NAME=${name}`, "-e", `GIT_AUTHOR_EMAIL=${email}`, "-e", `GIT_COMMITTER_NAME=${name}`, "-e", `GIT_COMMITTER_EMAIL=${email}`);

  if (plan.entrypoint !== undefined) argv.push("--entrypoint", plan.entrypoint);
  argv.push(plan.image, ...plan.args);
  return argv;
}

/** The grace time of a stop, from the SQUAD_STOP_GRACE_S setting. */
export const stopGraceS = (env?: Readonly<Record<string, string | undefined>>): number => envNum(SQUAD_STOP_GRACE_S_ENV, env);

/** Stop before kill: SIGTERM first, so a token refresh in flight can finish. */
export const dockerStopArgv = (name: string, graceS: number): string[] => ["stop", "-t", String(graceS), name];

export const dockerKillArgv = (name: string): string[] => ["kill", name];

/** Lists the pass containers, any state. The filter is the guard: a container without the label is never listed. */
export const dockerPsArgv = (): string[] => ["ps", "-a", "--filter", "label=squad.pass", "--format", '{{.Names}}\\t{{.Label "squad.pass"}}\\t{{.State}}\\t{{.CreatedAt}}\\t{{.Label "squad.purpose"}}'];

/** Removes a container; `force` also stops a running one. */
export const dockerRmArgv = (name: string, force: boolean): string[] => (force ? ["rm", "-f", name] : ["rm", name]);
