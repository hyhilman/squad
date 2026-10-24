// What differs between runners, in one place: the CLI args, the stream parser and the usage export.
// `runPass` looks a runner up here, so adding a runner is one row and, where it differs, a small hook.

import { claudeExport, codexExport, piExport, type ExportMeta } from "../store/export.ts";
import { ClaudeStream } from "../streams/claude.ts";
import { CodexStream } from "../streams/codex.ts";
import { PiStream } from "../streams/pi.ts";
import type { StreamOutcome } from "../types.ts";
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
    cli: (r) => piArgs({ model: r.model, effort: null, prompt: r.prompt, skill: null, sessionId: r.sessionId ?? null, guidance: null }),
    stream: () => new PiStream(),
    exportOf: (raw, _o, meta) => piExport(raw, meta),
  },
  claude: {
    cli: (r) => claudeArgs({ model: r.model, effort: null, prompt: r.prompt, skill: null }),
    stream: () => new ClaudeStream(),
    exportOf: (_raw, o, meta) => claudeExport(o, meta),
  },
  codex: {
    cli: (r) => codexArgs({ model: r.model, effort: null, prompt: r.prompt, skill: null, cwd: need(r.cwd, "cwd"), outDir: need(r.outDir, "outDir") }),
    stream: () => new CodexStream(),
    exportOf: (_raw, o, meta) => codexExport(o, meta),
  },
} as const satisfies Record<string, RunnerSpec>;

export type SupportedRunner = keyof typeof RUNNER_SPECS;

export const isSupported = (runner: string): runner is SupportedRunner => Object.hasOwn(RUNNER_SPECS, runner);
