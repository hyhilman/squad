// The pure CLI args of a pi pass. The prompt is the last argument, after `--`, so a prompt that
// starts with a dash is not read as a flag.

import type { Mount } from "../docker.ts";
import { checkModel, checkSkillName } from "./model.ts";

export interface PiRequest {
  readonly model: string;
  readonly effort: string | null;
  readonly prompt: string;
  readonly skill: { readonly name: string; readonly dir: string } | null;
  readonly sessionId: string | null;
  readonly guidance: string | null;
}

export interface CliPlan {
  readonly args: string[];
  /** Text for the CLI's stdin, or null when the prompt is an argument. */
  readonly stdin: string | null;
  readonly mounts: Mount[];
}

export function cliArgs(req: PiRequest): CliPlan {
  const args = ["-p", "--mode", "json", "--no-context-files", "--no-extensions", "--no-prompt-templates", "--no-themes", "--model", checkModel(req.model)];
  const mounts: Mount[] = [];
  if (req.effort !== null) args.push("--thinking", req.effort);
  if (req.skill !== null) {
    const path = `/skills/${checkSkillName(req.skill.name)}`;
    args.push("--skill", path);
    mounts.push({ host: req.skill.dir, container: path, ro: true });
  }
  if (req.sessionId !== null) args.push("--session-dir", "/squad/sessions", "--session-id", req.sessionId);
  if (req.guidance !== null) args.push("--append-system-prompt", req.guidance);
  args.push("--", req.prompt);
  return { args, stdin: null, mounts };
}
