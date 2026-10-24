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
  /** Only pi keeps a session in this step. */
  readonly sessionId?: string;
  /** codex only: the host folder mounted at /squad/out for its last-message file. */
  readonly outDir?: string;
  readonly cwd?: string;
  /** The standard fields (see ../turn.ts). `skill.text` is SKILL.md, read by the caller. */
  readonly system?: string;
  readonly effort?: string;
  readonly skill?: { readonly name: string; readonly dir: string; readonly text: string };
}

export interface RunnerSpec {
  readonly cli: (req: CliRequest) => CliPlan;
  readonly stream: () => StreamParser;
  /** The usage file text for a finished pass, or "" when there is nothing to write. */
  readonly exportOf: (raw: string, outcome: StreamOutcome, meta: ExportMeta) => string;
}

const need = (v: string | undefined, what: string): string => {
  if (v === undefined) throw new Error(`codex needs ${what}`);
  return v;
};

export const RUNNER_SPECS = {
  pi: {
    cli: (r) => piArgs({ model: r.model, effort: r.effort ?? null, prompt: r.skill === undefined ? r.prompt : `/skill:${r.skill.name} ${r.prompt}`, skill: r.skill ?? null, sessionId: r.sessionId ?? null, guidance: r.system ?? null }),
    stream: () => new PiStream(),
    exportOf: (raw, _o, meta) => piExport(raw, meta),
  },
  claude: {
    cli: (r) => claudeArgs({ model: r.model, effort: r.effort ?? null, prompt: r.skill === undefined ? r.prompt : `/${r.skill.name} ${r.prompt}`, skill: r.skill ?? null, system: r.system ?? null }),
    stream: () => new ClaudeStream(),
    exportOf: (_raw, o, meta) => claudeExport(o, meta),
  },
  codex: {
    // codex has no system or skill flag: both go into the prompt, in this order.
    cli: (r) => codexArgs({ model: r.model, effort: r.effort ?? null, prompt: [r.system, r.skill === undefined ? undefined : skillBody(r.skill.text), r.prompt].filter((x) => x !== undefined && x !== "").join("\n\n"), skill: null, cwd: need(r.cwd, "cwd"), outDir: need(r.outDir, "outDir") }),
    stream: () => new CodexStream(),
    exportOf: (_raw, o, meta) => codexExport(o, meta),
  },
} as const satisfies Record<string, RunnerSpec>;

export type SupportedRunner = keyof typeof RUNNER_SPECS;

export const isSupported = (runner: string): runner is SupportedRunner => Object.hasOwn(RUNNER_SPECS, runner);
