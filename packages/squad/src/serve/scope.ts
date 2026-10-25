// What a project token may touch. A pass over `squad serve` is code execution on the host: it mounts
// host paths and picks an image. So every path must exist and sit inside one of the token's roots
// after symlinks are resolved, and the caller gets the resolved path back, so a symlink swapped after
// the check cannot move the mount. A refusal names the field only: no path, no root.
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { IMAGES } from "../images.ts";
import type { SupportedRunner } from "../runners/table.ts";
import type { ExtraMount, SkillRef } from "../turn.ts";
import type { ProjectToken } from "./tokens.ts";

/** An answer that is not 200: the status and the `error` text of `{ error }`. */
export class Refusal extends Error {
  readonly status: number;
  readonly error: string;
  constructor(status: number, error: string) {
    super(error);
    this.status = status;
    this.error = error;
  }
}

/** Wrong, unknown and revoked tokens all get this, so a caller learns nothing about which. */
export const unauthorized = (): Refusal => new Refusal(401, "unauthorized");
export const outOfScope = (field: string): Refusal => new Refusal(403, `out of scope: ${field}`);

export interface ScopeContext {
  /** The squad home. No path may be it, be inside it, or hold it. */
  readonly home: string;
  /** The uid `squad serve` runs as; null where the platform has none. */
  readonly uid: number | null;
}

export interface SetupPaths {
  readonly runner: SupportedRunner;
  readonly account: string;
  readonly cwd: string;
  readonly gitDir?: string;
  readonly skill?: SkillRef;
  readonly mounts?: readonly ExtraMount[];
  readonly image?: string;
}

export interface ScopedSetup {
  /** `<runner>/<name>`. */
  readonly account: string;
  readonly cwd: string;
  readonly gitDir?: string;
  readonly skill?: SkillRef;
  readonly mounts?: readonly ExtraMount[];
}

const within = (p: string, root: string): boolean => {
  const r = relative(root, p);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};

const real = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/** The real path, when it exists, is inside a root, and does not touch the home. Else a 403 naming the field. */
function scopedPath(token: ProjectToken, ctx: ScopeContext, path: string, field: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) throw outOfScope(field);
  const p = real(path);
  if (p === undefined) throw outOfScope(field);
  const roots = token.roots.map((r) => real(r)).filter((r): r is string => r !== undefined);
  if (!roots.some((r) => within(p, r))) throw outOfScope(field);
  // The home may not exist yet under its real name; fall back to the given one.
  const home = real(ctx.home) ?? ctx.home;
  if (within(p, home) || within(home, p)) throw outOfScope(field);
  return p;
}

/** The account id, `<runner>/<name>`, when the token names it. */
export function scopedAccount(token: ProjectToken, runner: string, account: string): string {
  const id = typeof account === "string" && account.includes("/") ? account : `${runner}/${account}`;
  if (!id.startsWith(`${runner}/`) || !token.accounts.includes(id)) throw outOfScope("account");
  return id;
}

/** Checks every host path, the account and the image. Returns the real paths to run with. */
export function scopeSetup(token: ProjectToken, s: SetupPaths, ctx: ScopeContext): ScopedSetup {
  const account = scopedAccount(token, s.runner, s.account);
  const cwd = scopedPath(token, ctx, s.cwd, "cwd");
  if (ctx.uid !== null) {
    const owner = statSync(cwd).uid;
    if (owner !== ctx.uid) throw new Refusal(403, `cwd ${cwd} is owned by uid ${owner}, squad serve runs as uid ${ctx.uid}`);
  }
  const gitDir = s.gitDir === undefined ? undefined : scopedPath(token, ctx, s.gitDir, "gitDir");
  const skill = s.skill === undefined ? undefined : { name: s.skill.name, dir: scopedPath(token, ctx, s.skill.dir, "skill.dir") };
  const mounts = s.mounts?.map((m, i) => ({ host: scopedPath(token, ctx, m.host, `mounts[${i}].host`), container: m.container, ro: m.ro }));
  if (s.image !== undefined && s.image !== IMAGES[s.runner].tag && !token.images.includes(s.image)) throw outOfScope("image");
  return { account, cwd, ...(gitDir === undefined ? {} : { gitDir }), ...(skill === undefined ? {} : { skill }), ...(mounts === undefined ? {} : { mounts }) };
}
