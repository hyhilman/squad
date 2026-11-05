// What differs between runners, in one place: the CLI args, the stream parser and the usage export.
// `runPass` looks a runner up here, so adding a runner is one row and, where it differs, a small hook.

import { claudeExport, codexExport, piExport, type ExportMeta } from "../store/export.ts";
import { ClaudeStream } from "../streams/claude.ts";
import { CodexStream } from "../streams/codex.ts";
import { PiStream } from "../streams/pi.ts";
import type { StreamOutcome } from "../types.ts";
import { skillBody } from "../turn.ts";
import { cliArgs as claudeArgs } from "./claude.ts";
import { cliArgs as codexArgs } from "./codex.ts";
import { cliArgs as piArgs, type CliPlan } from "./pi.ts";

export interface StreamParser {
  push(chunk: string): void;
  end(): void;
  outcome(): StreamOutcome;
}

export interface CliRequest {
  readonly model: string;
  readonly prompt: string;
  /** pi's session id; pi makes the session if it is new. */
  readonly sessionId?: string;
  /**
   * A claude or codex conversation turn. `id` is claude's transcript UUID or codex's thread id (null
   * before codex names it); `resume` is true when there is history to load. A resumed turn sends only
   * the new text: what went before is in the history.
   */
  readonly history?: { readonly id: string | null; readonly resume: boolean };
  /** codex only: the host folder mounted at /squad/out for its last-message file. */
  readonly outDir?: string;
  readonly cwd?: string;
  /** The standard fields (see ../turn.ts). `skill.text` is SKILL.md, read by the caller. */
  readonly system?: string;
  readonly effort?: string;
  readonly skill?: { readonly name: string; readonly dir: string; readonly text: string };
  /**
   * False on a later turn of a conversation: the skill is already in the history, so the message goes
   * as written. The skill stays loaded (same flags every turn) so the prompt cache still matches.
   */
  readonly openSkill?: boolean;
}

export interface RunnerSpec {
  readonly cli: (req: CliRequest) => CliPlan;
  readonly stream: () => StreamParser;
  /** The usage file text for a finished pass, or "" when there is nothing to write. */
  readonly exportOf: (raw: string, outcome: StreamOutcome, meta: ExportMeta) => string;
}

const need = (v: string | undefined, runner: string, what: string): string => {
  if (v === undefined) throw new Error(`${runner} needs ${what}`);
  return v;
};

export const RUNNER_SPECS = {
  pi: {
    cli: (r) => piArgs({ model: r.model, effort: r.effort ?? null, prompt: r.skill === undefined || r.openSkill === false ? r.prompt : `/skill:${r.skill.name} ${r.prompt}`, skill: r.skill ?? null, sessionId: r.sessionId ?? null, guidance: r.system ?? null }),
    stream: () => new PiStream(),
    exportOf: (raw, _o, meta) => piExport(raw, meta),
  },
  claude: {
    // The skill rides in the system prompt on every turn, so the flags and the prompt cache stay the same.
    cli: (r) => claudeArgs({ model: r.model, effort: r.effort ?? null, prompt: r.prompt, skill: r.skill === undefined ? null : skillBody(r.skill.text), system: r.system ?? null, ...(r.history === undefined ? {} : { history: { id: need(r.history.id ?? undefined, "claude", "a transcript id"), resume: r.history.resume } }) }),
    stream: () => new ClaudeStream(),
    exportOf: (_raw, o, meta) => claudeExport(o, meta),
  },
  codex: {
    // codex has no system or skill flag: both go into the prompt, in this order. A resumed thread has them already.
    cli: (r) => codexArgs({
      model: r.model,
      effort: r.effort ?? null,
      prompt: r.history?.resume === true ? r.prompt : [r.system, r.skill === undefined || r.openSkill === false ? undefined : skillBody(r.skill.text), r.prompt].filter((x) => x !== undefined && x !== "").join("\n\n"),
      skill: null,
      cwd: need(r.cwd, "codex", "cwd"),
      outDir: need(r.outDir, "codex", "outDir"),
      ...(r.history === undefined ? {} : { history: { resume: r.history.resume ? need(r.history.id ?? undefined, "codex", "a thread id to resume") : null } }),
    }),
    stream: () => new CodexStream(),
    exportOf: (_raw, o, meta) => codexExport(o, meta),
  },
} as const satisfies Record<string, RunnerSpec>;

export type SupportedRunner = keyof typeof RUNNER_SPECS;

export const isSupported = (runner: string): runner is SupportedRunner => Object.hasOwn(RUNNER_SPECS, runner);
