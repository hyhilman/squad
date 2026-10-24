// Parses `pi -p --mode json`. Tokens count from assistant `message_end` only: `agent_end` repeats
// every message with its usage, and `turn_end` repeats the last one, so counting them double-counts.

import { parsePiError } from "../classify.ts";
import type { Failure, StreamOutcome, Usage } from "../types.ts";
import { isObj, JsonLines, num, textOf } from "./lines.ts";

export class PiStream {
  #lines = new JsonLines((e) => this.#event(e));
  #texts: string[] = [];
  #last: Record<string, unknown> | undefined;
  #turns = 0;
  #ended = false;
  #usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

  push(chunk: string): void {
    this.#lines.push(chunk);
  }

  end(): void {
    this.#lines.end();
  }

  #event(e: Record<string, unknown>): void {
    if (e.type === "turn_end") this.#turns++;
    else if (e.type === "agent_end") this.#ended = true;
    else if (e.type === "message_end" && isObj(e.message) && e.message.role === "assistant") {
      const m = e.message;
      this.#last = m;
      const t = textOf(m.content);
      if (t !== "") this.#texts.push(t);
      const u = isObj(m.usage) ? m.usage : {};
      this.#usage.input += num(u.input);
      this.#usage.output += num(u.output);
      this.#usage.cacheRead += num(u.cacheRead);
      this.#usage.cacheWrite += num(u.cacheWrite);
      this.#usage.reasoning += num(u.reasoning);
    }
  }

  outcome(): StreamOutcome {
    const last = this.#last;
    let failure: Failure | undefined;
    if (last !== undefined && (last.stopReason === "error" || last.stopReason === "aborted")) {
      failure = parsePiError(typeof last.errorMessage === "string" ? last.errorMessage : "");
    }
    const usage: Usage = { ...this.#usage };
    const model = last !== undefined && typeof last.provider === "string" && typeof last.model === "string" ? `${last.provider}/${last.model}` : null;
    return {
      // The answer is the last assistant message only, so an empty last message gives "".
      text: last === undefined ? "" : textOf(last.content),
      texts: [...this.#texts],
      turns: this.#turns,
      ended: this.#ended,
      model,
      usage,
      ...(failure === undefined ? {} : { failure }),
      badLines: this.#lines.badLines,
    };
  }
}

export function parsePiStream(text: string): StreamOutcome {
  const s = new PiStream();
  s.push(text);
  s.end();
  return s.outcome();
}
