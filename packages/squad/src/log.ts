// logfmt lines on stderr, so stdout stays free for a command's output. One line per event:
// `ts=… level=… event=… key=value …`. A value with a space, a quote or an `=` is quoted.

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Readonly<Record<string, string | number | boolean | undefined>>;

const BARE = /^[^\s"=\\]+$/;

/** One value as logfmt: bare when it is safe, else a JSON string. */
export function fmtValue(v: string | number | boolean): string {
  const s = String(v);
  return s !== "" && BARE.test(s) ? s : JSON.stringify(s);
}

/** One whole line, without the newline. Undefined fields are left out. */
export function logLine(level: Level, event: string, fields: Fields = {}, now: Date = new Date()): string {
  const parts = [`ts=${now.toISOString()}`, `level=${level}`, `event=${fmtValue(event)}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${fmtValue(v)}`);
  }
  return parts.join(" ");
}

export interface Log {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
}

/** A logger that writes to `out` (stderr by default). */
export function makeLog(out: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Log {
  const at = (level: Level) => (event: string, fields?: Fields) => out(logLine(level, event, fields));
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
