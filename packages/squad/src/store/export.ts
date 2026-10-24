// The per-pass usage file for the viewers (agentusage, Tokscale). Both read pi session files: a
// `session` header, then one `{"type":"message"}` line per assistant reply. We keep the usage and
// drop all text, because a viewer can serve prompts with no login.
//
// `exportLine` is a port of doppelganger's function of the same name; the test pins its output
// byte for byte. The header is ours: its `cwd` is project/flow/action (the viewers group by cwd),
// so no host path leaks.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HomeLayout } from "../home.ts";
import type { Log } from "../log.ts";
import type { StreamOutcome } from "../types.ts";
import { isObj } from "../streams/lines.ts";

export interface ExportMeta {
  readonly passId: string;
  readonly project: string;
  readonly flow: string;
  readonly action: string;
  /** Stamps a header the stream had none for, and the one claude message (claude has no per-reply time). */
  readonly at: Date;
  /** The model the pass asked for. codex does not report one, so its export needs this. */
  readonly model?: string;
}

/** pi writes a message's time as epoch milliseconds; a session file holds an ISO string. */
const isoOf = (t: unknown): string | null => (typeof t === "number" && Number.isFinite(t) ? new Date(t).toISOString() : typeof t === "string" ? t : null);

/** The message line of one pi event line, or undefined for a line that is not kept. `id` must be unique across passes. */
export function exportLine(line: string, id: string): string | undefined {
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObj(ev) || ev.type !== "message_end") return undefined;
  const m = ev.message;
  if (!isObj(m) || m.role !== "assistant" || !isObj(m.usage)) return undefined;
  const message = {
    role: "assistant",
    provider: m.provider,
    model: m.model,
    api: m.api,
    usage: m.usage,
    stopReason: m.stopReason,
    timestamp: m.timestamp,
    content: [],
  };
  return JSON.stringify({ type: "message", id, parentId: null, timestamp: isoOf(m.timestamp), message });
}

const cwdOf = (m: ExportMeta): string => `${m.project}/${m.flow}/${m.action}`;

/** The whole file for one pi pass, from its raw stdout. "" when no reply carries usage, so nothing is written. */
export function piExport(raw: string, meta: ExportMeta): string {
  const messages: string[] = [];
  let session: Record<string, unknown> | undefined;
  raw.split("\n").forEach((line, i) => {
    if (session === undefined && line.startsWith('{"type":"session"')) {
      try {
        const ev: unknown = JSON.parse(line);
        if (isObj(ev) && ev.type === "session") session = ev;
      } catch {
        // A broken header line is as good as none.
      }
      return;
    }
    // The line number makes the id unique within the pass, as in doppelganger.
    const kept = exportLine(line, `${meta.passId}:${i + 1}`);
    if (kept !== undefined) messages.push(kept);
  });
  if (messages.length === 0) return "";
  const header: Record<string, unknown> = { type: "session", version: 3, id: meta.passId, timestamp: meta.at.toISOString(), ...session, cwd: cwdOf(meta) };
  // The capture's own id must not stay: it would repeat across passes. Assigning keeps the key's place.
  header.id = meta.passId;
  return `${[JSON.stringify(header), ...messages].join("\n")}\n`;
}

/** The whole file for one claude pass. Tokens come from the result event, which `outcome.usage` already holds once. */
export function claudeExport(outcome: StreamOutcome, meta: ExportMeta): string {
  const u = outcome.usage;
  const total = u.input + u.output + u.cacheRead + u.cacheWrite;
  if (total === 0) return "";
  const iso = meta.at.toISOString();
  const header = { type: "session", version: 3, id: meta.passId, timestamp: iso, cwd: cwdOf(meta) };
  const message = {
    role: "assistant",
    provider: "anthropic",
    model: outcome.model ?? "unknown",
    api: "anthropic-messages",
    // squad prices a pass itself (prices.ts); claude gives no per-token cost, so the viewers see zero.
    usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: meta.at.getTime(),
    content: [],
  };
  const line = { type: "message", id: `${meta.passId}:1`, parentId: null, timestamp: iso, message };
  return `${JSON.stringify(header)}\n${JSON.stringify(line)}\n`;
}

/** The whole file for one codex pass. `outcome.usage` is already fresh input, cache read and output, as for claude. */
export function codexExport(outcome: StreamOutcome, meta: ExportMeta): string {
  const u = outcome.usage;
  const total = u.input + u.output + u.cacheRead + u.cacheWrite;
  if (total === 0) return "";
  const iso = meta.at.toISOString();
  const header = { type: "session", version: 3, id: meta.passId, timestamp: iso, cwd: cwdOf(meta) };
  const message = {
    role: "assistant",
    provider: "openai",
    model: meta.model ?? "unknown",
    api: "openai-responses",
    usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: meta.at.getTime(),
    content: [],
  };
  const line = { type: "message", id: `${meta.passId}:1`, parentId: null, timestamp: iso, message };
  return `${JSON.stringify(header)}\n${JSON.stringify(line)}\n`;
}

/** Writes `<usageExport>/<passId>.jsonl` (0600) through a temp name, so a viewer never reads half a file. A failure is a warning. */
export function writeUsageExport(home: HomeLayout, passId: string, text: string, log?: Log): void {
  try {
    mkdirSync(home.usageExport, { recursive: true, mode: 0o700 });
    const tmp = join(home.usageExport, `${passId}.jsonl.tmp`);
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, join(home.usageExport, `${passId}.jsonl`));
  } catch (e) {
    log?.warn("usage-export-failed", { pass: passId, error: e instanceof Error ? e.message.split("\n")[0] : "error" });
  }
}
