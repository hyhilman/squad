// The pure CLI args of a claude pass. The prompt goes on stdin. The skill's text goes in the system
// prompt, after the caller's system text, as codex gets it in its prompt. Opening it as `/<name> <prompt>`
// made claude send the prompt twice (once as the command's arguments, once appended to the skill), and a
// long prompt then cost twice its tokens on every turn. `--setting-sources ""` keeps the worktree's
// settings and hooks out.

import { checkModel } from "./model.ts";
import type { CliPlan } from "./pi.ts";

export interface ClaudeRequest {
  readonly model: string;
  readonly effort: string | null;
  readonly prompt: string;
  /** The skill's SKILL.md body, front matter removed; null for none. */
  readonly skill: string | null;
  readonly system?: string | null;
}

export function cliArgs(req: ClaudeRequest): CliPlan {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", checkModel(req.model)];
  if (req.effort !== null) args.push("--effort", req.effort);
  const system = [req.system, req.skill].filter((x) => x != null && x !== "").join("\n\n");
  if (system !== "") args.push("--append-system-prompt", system);
  args.push("--permission-mode", "bypassPermissions", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "");
  return { args, stdin: req.prompt, mounts: [] };
}
