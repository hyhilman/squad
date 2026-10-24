// The files of a pass: its raw CLI stream and its prompt, gzipped, in `logs/passes/<day>/`. A pass
// that found no account writes none. Older passes may still have a plain `<id>.log`.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { HomeLayout } from "./home.ts";

export type PassFileKind = "log" | "prompt";

const PLAIN_ID = /^[0-9A-Za-z]{1,40}$/;
const DAY = /^\d{4}-\d\d-\d\d$/;

/** Writes to a tmp name, then renames, so a reader never sees half a file. */
function writeGz(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, gzipSync(text), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Writes `<id>.log.gz` and `<id>.prompt.gz` under the day of `now`. Returns the log path. */
export function writePassFiles(home: HomeLayout, now: Date, passId: string, prompt: string, raw: string): string {
  const dir = join(home.passLogs, now.toISOString().slice(0, 10));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = join(dir, `${passId}.log.gz`);
  writeGz(join(dir, `${passId}.prompt.gz`), prompt);
  writeGz(log, raw);
  return log;
}

const names = (id: string, kind: PassFileKind): string[] => (kind === "log" ? [`${id}.log.gz`, `${id}.log`] : [`${id}.prompt.gz`]);

/** The file of a pass, or undefined. `days` are folders to try first; then every day folder is searched. */
export function findPassFile(home: HomeLayout, id: string, kind: PassFileKind, days: readonly string[] = []): string | undefined {
  if (!PLAIN_ID.test(id)) return undefined;
  const hit = (day: string): string | undefined => names(id, kind).map((n) => join(home.passLogs, day, n)).find((p) => existsSync(p));
  for (const d of days) {
    const f = DAY.test(d) ? hit(d) : undefined;
    if (f !== undefined) return f;
  }
  let all: string[];
  try {
    all = readdirSync(home.passLogs);
  } catch {
    return undefined;
  }
  for (const d of all) {
    const f = DAY.test(d) ? hit(d) : undefined;
    if (f !== undefined) return f;
  }
  return undefined;
}

/** The ids that have a stream file in these day folders. */
export function idsWithLog(home: HomeLayout, days: Iterable<string>): Set<string> {
  const ids = new Set<string>();
  for (const d of new Set(days)) {
    if (!DAY.test(d)) continue;
    let files: string[];
    try {
      files = readdirSync(join(home.passLogs, d));
    } catch {
      continue;
    }
    for (const f of files) {
      const m = /^(.+)\.log(?:\.gz)?$/.exec(f);
      if (m !== null) ids.add(m[1]!);
    }
  }
  return ids;
}

/** The text of a pass file, also when it is gzipped. */
export function readPassFile(path: string): string {
  const data = readFileSync(path);
  return (path.endsWith(".gz") ? gunzipSync(data) : data).toString("utf8");
}
