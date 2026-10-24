// The pass history as the web app shows it: a row, and for one pass its prompt and what the assistant
// said. The assistant texts come from the stored stream through the runner's own parser; the raw
// stream is never sent. Every text goes through `maskSecrets` first.

import { maskSecrets, type PassDetail, type PassTranscript, type PassView } from "@squad/contract";
import type { HomeLayout } from "../home.ts";
import { findPassFile, idsWithLog, readPassFile } from "../passfiles.ts";
import { isSupported, RUNNER_SPECS } from "../runners/table.ts";
import type { PassRow } from "../usage/report.ts";

/** The most bytes of a prompt, and of the texts of a transcript. */
export const MAX_TEXT_BYTES = 256 * 1024;

const day = (iso: string | null): string[] => (iso === null ? [] : [iso.slice(0, 10)]);

const viewOf = (r: PassRow, hasTranscript: boolean): PassView => ({
  passId: r.id,
  ...(r.account === null ? {} : { account: r.account }),
  startedAt: r.startedAt,
  ...(r.endedAt === null ? {} : { endedAt: r.endedAt }),
  caller: { flow: r.flow, action: r.action },
  ...(r.taskKind === null || r.taskId === null ? {} : { task: { kind: r.taskKind, id: r.taskId } }),
  model: r.model,
  ...(r.outcome === null ? {} : { outcome: r.outcome }),
  ...(r.failKind === null ? {} : { failKind: r.failKind }),
  ...(r.failCode === null ? {} : { failCode: r.failCode }),
  tokens: { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, reasoning: r.reasoning },
  ...(r.costUsd === null ? {} : { costUsd: r.costUsd }),
  hasTranscript,
});

/** Rows for a list. One look at the day folders of the page tells which have a stream file. */
export function passViews(home: HomeLayout, rows: readonly PassRow[]): PassView[] {
  const have = idsWithLog(home, rows.flatMap((r) => [...day(r.startedAt), ...day(r.endedAt)]));
  return rows.map((r) => viewOf(r, have.has(r.id)));
}

/** At most `max` bytes, cut on a character edge. */
function cut(text: string, max: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text) <= max) return { text, cut: false };
  return { text: Buffer.from(text).subarray(0, max).toString("utf8").replace(/�+$/, ""), cut: true };
}

function transcriptOf(raw: string, runner: string): { transcript: PassTranscript; truncated: boolean } | undefined {
  if (!isSupported(runner)) return undefined;
  const parser = RUNNER_SPECS[runner].stream();
  parser.push(raw);
  parser.end();
  const o = parser.outcome();
  let budget = MAX_TEXT_BYTES;
  let truncated = false;
  const texts: string[] = [];
  for (const t of o.texts) {
    const c = cut(maskSecrets(t), budget);
    if (c.cut) truncated = true;
    texts.push(c.text);
    budget -= Buffer.byteLength(c.text);
    if (budget <= 0) {
      truncated = truncated || texts.length < o.texts.length;
      break;
    }
  }
  const final = cut(maskSecrets(o.text), MAX_TEXT_BYTES);
  return { transcript: { texts, final: final.text }, truncated: truncated || final.cut };
}

/** A file's text, or undefined when it is gone or cannot be read (a half-written or damaged gzip). */
const textOf = (path: string | undefined): string | undefined => {
  if (path === undefined) return undefined;
  try {
    return readPassFile(path);
  } catch {
    return undefined;
  }
};

/** Whether a pass ended in a way that leaves files. A busy or lost row and a pass with no account leave none. */
const expectsFiles = (r: PassRow): boolean => r.account !== null && r.outcome !== null && r.outcome !== "busy" && r.outcome !== "lost";

export function passDetail(home: HomeLayout, r: PassRow): PassDetail {
  const days = [...day(r.endedAt), ...day(r.startedAt)];
  const raw = textOf(findPassFile(home, r.id, "log", days));
  const promptRaw = textOf(findPassFile(home, r.id, "prompt", days));
  const t = raw === undefined ? undefined : transcriptOf(raw, r.runner);
  const p = promptRaw === undefined ? undefined : cut(maskSecrets(promptRaw), MAX_TEXT_BYTES);
  const truncated = (p?.cut ?? false) || (t?.truncated ?? false);
  return {
    ...viewOf(r, raw !== undefined),
    ...(p === undefined ? {} : { prompt: p.text }),
    ...(t === undefined ? {} : { transcript: t.transcript }),
    ...(expectsFiles(r) && (raw === undefined || promptRaw === undefined) ? { expired: true as const } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  };
}
