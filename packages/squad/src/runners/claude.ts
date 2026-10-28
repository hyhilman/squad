// The pure CLI args of a claude pass. The prompt goes on stdin. The skill sits in a throwaway plugin
// named `squad`; the prompt's `/<name>` opens it. `--setting-sources ""` keeps the
// worktree's settings and hooks out, and it also stops claude from loading skills under an
// `--add-dir`; a `--plugin-dir` still loads.

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

/** claude names a plugin after its folder: this one is `squad`. */
const PLUGIN_DIR = "/squad/skills/squad";

export function cliArgs(req: ClaudeRequest): CliPlan {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", checkModel(req.model)];
  if (req.effort !== null) args.push("--effort", req.effort);
  if (req.system != null) args.push("--append-system-prompt", req.system);
  args.push("--permission-mode", "bypassPermissions", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "");
  const mounts: Mount[] = [];
  if (req.skill !== null) {
    mounts.push({ host: req.skill.dir, container: `${PLUGIN_DIR}/skills/${checkSkillName(req.skill.name)}`, ro: true });
    args.push("--plugin-dir", PLUGIN_DIR);
  }
  return { args, stdin: req.prompt, mounts };
}
