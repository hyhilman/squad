// Splits pushed chunks into lines and parses each as JSON. A chunk may end in the middle of a line.

export class JsonLines {
  #buf = "";
  badLines = 0;

  readonly #onEvent: (event: Record<string, unknown>) => void;

  constructor(onEvent: (event: Record<string, unknown>) => void) {
    this.#onEvent = onEvent;
  }

  push(chunk: string): void {
    this.#buf += chunk;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      this.#line(this.#buf.slice(0, nl));
      this.#buf = this.#buf.slice(nl + 1);
    }
  }

  /** Reads the last line when the stream ended without a newline. */
  end(): void {
    const rest = this.#buf;
    this.#buf = "";
    this.#line(rest);
  }

  #line(raw: string): void {
    const line = raw.trim();
    if (line === "") return;
    try {
      const v: unknown = JSON.parse(line);
      if (typeof v === "object" && v !== null && !Array.isArray(v)) this.#onEvent(v as Record<string, unknown>);
      else this.badLines++;
    } catch {
      this.badLines++;
    }
  }
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The text of every `{type:"text"}` part, joined. */
export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((p) => (isObj(p) && p.type === "text" && typeof p.text === "string" ? p.text : "")).join("");
}
