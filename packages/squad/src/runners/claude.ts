// The pure CLI args of a claude pass. The prompt goes on stdin. The skill sits in a throwaway
// `.claude/skills` tree that `--add-dir` makes claude load, since `--setting-sources ""` turns off
// every other source.

import type { Mount } from "../docker.ts";
import { checkModel, checkSkillName } from "./model.ts";
import type { CliPlan } from "./pi.ts";

export interface ClaudeRequest {
  readonly model: string;
  readonly effort: string | null;
  readonly prompt: string;
  readonly skill: { readonly name: string; readonly dir: string } | null;
  readonly system?: string | null;
}

export function cliArgs(req: ClaudeRequest): CliPlan {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", checkModel(req.model)];
  if (req.effort !== null) args.push("--effort", req.effort);
  if (req.system != null) args.push("--append-system-prompt", req.system);
  args.push("--permission-mode", "bypassPermissions", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "");
  const mounts: Mount[] = [];
  if (req.skill !== null) {
    mounts.push({ host: req.skill.dir, container: `/squad/skills/.claude/skills/${checkSkillName(req.skill.name)}`, ro: true });
    args.push("--add-dir", "/squad/skills");
  }
  return { args, stdin: req.prompt, mounts };
}
