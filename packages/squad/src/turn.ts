// The fields every runner takes in the same form, and their checks. A one-shot pass (`runPass`) uses
// them now; a conversation turn will use the same type. Every check here runs before any account is
// picked or any container starts.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Runner } from "./docker.ts";
import { checkSkillName } from "./runners/model.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** A folder that holds `SKILL.md`. `name` is also the folder name the CLI sees. */
export interface SkillRef {
  readonly name: string;
  readonly dir: string;
}

/** A host path the caller wants inside the container. */
export interface ExtraMount {
  readonly host: string;
  readonly container: string;
  readonly ro: boolean;
}

export interface TurnOptions {
  /** Extra system prompt. codex has no flag for it, so it goes at the top of the prompt. */
  readonly system?: string;
  readonly skill?: SkillRef;
  readonly effort?: Effort;
  readonly mounts?: readonly ExtraMount[];
  /** A caller image built FROM squad's. It must keep squad's label and entrypoint. */
  readonly image?: string;
  /** A fixed container name. `docker rm -f` of it runs before the turn. */
  readonly container?: string;
  /** Extra labels. Keys that start with `squad.` are squad's own and are refused. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Each stdout chunk as it arrives. A tap only: parsing does not use it. */
  readonly onOutput?: (chunk: string) => void;
}

/** The levels each CLI takes, checked on the pinned images (pi 1.1.0, codex 0.162.1, claude 2.1.310). */
const EFFORTS: Readonly<Record<Runner, readonly Effort[]>> = {
  pi: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max"],
  claude: ["low", "medium", "high", "xhigh", "max"],
};

export function checkEffort(runner: Runner, effort: string): Effort {
  if (!(EFFORTS[runner] as readonly string[]).includes(effort)) throw new Error(`effort ${JSON.stringify(effort)} is not one of ${EFFORTS[runner].join(", ")} for ${runner}`);
  return effort as Effort;
}

export interface LoadedSkill extends SkillRef {
  /** SKILL.md as it is on disk. */
  readonly text: string;
}

export function loadSkill(skill: SkillRef): LoadedSkill {
  checkSkillName(skill.name);
  if (!isAbsolute(skill.dir)) throw new Error(`skill dir ${skill.dir} must be an absolute path`);
  const file = join(skill.dir, "SKILL.md");
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`skill dir ${skill.dir} has no SKILL.md`);
  return { ...skill, text: readFileSync(file, "utf8") };
}

/** SKILL.md without its YAML front matter. */
export const skillBody = (text: string): string => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();

export function checkLabels(labels: Readonly<Record<string, string>>): void {
  for (const [k, v] of Object.entries(labels)) {
    if (k.startsWith("squad.")) throw new Error(`label ${k}: keys under squad. are reserved`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(k)) throw new Error(`label key ${JSON.stringify(k)} is not safe`);
    if (/[\r\n\0]/.test(v)) throw new Error(`label ${k} has a bad value`);
  }
}

/** Not `squad-…`: that is squad's own pass names, and `docker rm -f` of one could kill a pass on another account. */
export function checkContainerName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.startsWith("squad-")) throw new Error(`container name ${JSON.stringify(name)} is not allowed`);
}

export interface ImageInfo {
  readonly labels: Readonly<Record<string, string>>;
  readonly entrypoint: readonly string[] | null;
}

/** What `docker image inspect` says, or null when the image is not there. */
export function dockerInspectImage(docker: string, image: string): ImageInfo | null {
  const r = spawnSync(docker, ["image", "inspect", "--format", "{{json .Config}}", image], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const c = JSON.parse(r.stdout) as { Labels?: Record<string, string> | null; Entrypoint?: string[] | null };
  return { labels: c.Labels ?? {}, entrypoint: c.Entrypoint ?? null };
}

/** The lock lives in squad-entry, so an image that drops it would run a pass with no lock. */
export function checkImage(image: string, runner: Runner, inspect: (image: string) => ImageInfo | null): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image)) throw new Error(`image ${JSON.stringify(image)} is not a safe image name`);
  const info = inspect(image);
  if (info === null) throw new Error(`image ${image} not found`);
  if (info.labels["squad.entry"] !== "1") throw new Error(`image ${image} lacks the squad.entry=1 label: build it FROM a squad image`);
  const e = info.entrypoint;
  if (e === null || e[0] !== "squad-entry" || e[1] !== runner) throw new Error(`image ${image} has a foreign entrypoint; it must be squad-entry ${runner}`);
}
