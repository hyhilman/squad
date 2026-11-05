// The pure CLI args of a codex pass. The prompt goes on stdin (the `-` at the end).

import type { Mount } from "../docker.ts";
import { checkModel, checkSkillName, checkUuid } from "./model.ts";
import type { CliPlan } from "./pi.ts";

export interface CodexRequest {
  readonly model: string;
  readonly effort: string | null;
  readonly prompt: string;
  /** codex has no flag for one skill, so the caller reads SKILL.md and passes its text. */
  readonly skill: { readonly name: string; readonly text: string } | null;
  readonly cwd: string;
  /** Host folder for the last-message file. It is mounted at /squad/out. */
  readonly outDir: string;
  /**
   * A conversation turn: codex's thread id to resume, or null for the first turn (codex names the
   * thread itself). Unset for a one-shot pass, which keeps no rollout.
   */
  readonly history?: { readonly resume: string | null };
}

/** `<guidance>\n\n/<skill>\n\n<lines>`: the `/<skill>` line becomes the skill text, without its front matter. */
function withSkill(prompt: string, skill: { name: string; text: string }): string {
  const lines = prompt.split("\n");
  const at = lines.findIndex((l) => l.trim() === `/${skill.name}`);
  if (at === -1) return prompt;
  const body = skill.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  return [...lines.slice(0, at), body, ...lines.slice(at + 1)].join("\n");
}

export function cliArgs(req: CodexRequest): CliPlan {
  const args = ["exec", "--json", "--ignore-user-config", ...(req.history === undefined ? ["--ephemeral"] : []), "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", req.cwd, "-m", checkModel(req.model)];
  if (req.effort !== null) args.push("-c", `model_reasoning_effort=${req.effort}`);
  args.push("-o", "/squad/out/last-message.txt");
  // codex 0.162.1 takes the exec flags before `resume`. It finds the rollout by id, under $CODEX_HOME/sessions.
  const resume = req.history?.resume ?? null;
  if (resume !== null) args.push("resume", checkUuid(resume));
  args.push("-");
  if (req.skill !== null) checkSkillName(req.skill.name);
  const stdin = req.skill === null ? req.prompt : withSkill(req.prompt, req.skill);
  const mounts: Mount[] = [{ host: req.outDir, container: "/squad/out", ro: false }];
  return { args, stdin, mounts };
}
