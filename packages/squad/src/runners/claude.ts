// The pure CLI args of a claude pass. The prompt goes on stdin. The skill's text goes in the system
// prompt, after the caller's system text, as codex gets it in its prompt. Opening it as `/<name> <prompt>`
// made claude send the prompt twice (once as the command's arguments, once appended to the skill), and a
// long prompt then cost twice its tokens on every turn. `--setting-sources ""` keeps the worktree's
// settings and hooks out. A conversation's later turn sends only the new text: `--resume` loads the rest.

import { checkModel, checkUuid } from "./model.ts";
import type { CliPlan } from "./pi.ts";

export interface ClaudeRequest {
  readonly model: string;
  readonly effort: string | null;
  readonly prompt: string;
  /** The skill's SKILL.md body, front matter removed; null for none. */
  readonly skill: string | null;
  readonly system?: string | null;
  /**
   * A conversation turn: the transcript id (a UUID), and true when a transcript is there to resume.
   * Unset for a one-shot pass, which keeps no transcript.
   */
  readonly history?: { readonly id: string; readonly resume: boolean };
}

export function cliArgs(req: ClaudeRequest): CliPlan {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", checkModel(req.model)];
  if (req.effort !== null) args.push("--effort", req.effort);
  const system = [req.system, req.skill].filter((x) => x != null && x !== "").join("\n\n");
  if (system !== "") args.push("--append-system-prompt", system);
  args.push("--permission-mode", "bypassPermissions");
  if (req.history === undefined) args.push("--no-session-persistence");
  else args.push(req.history.resume ? "--resume" : "--session-id", checkUuid(req.history.id));
  args.push("--strict-mcp-config", "--setting-sources", "");
  return { args, stdin: req.prompt, mounts: [] };
}

/**
 * True when `name` is the folder claude 2.1.310 keeps a transcript in for `cwd`, under projects/.
 * claude turns each character that is not a letter or digit into `-`. A name over 200 characters is
 * cut to 200, then gets `-` and a hash; the hash is claude's own, so only the cut part is compared.
 */
export function isProjectDirOf(name: string, cwd: string): boolean {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return slug.length <= 200 ? name === slug : name.startsWith(`${slug.slice(0, 200)}-`);
}
