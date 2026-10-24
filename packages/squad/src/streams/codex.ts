// Parses `codex exec --json`. Usage comes from `turn.completed` events, summed over turns.
// An `item.completed` of type `error` is a warning (for example missing model metadata), not a failure.

import { parseCodexError } from "../classify.ts";
import type { Failure, StreamOutcome } from "../types.ts";
import { isObj, JsonLines, num } from "./lines.ts";

export class CodexStream {
  #lines = new JsonLines((e) => this.#event(e));
  #texts: string[] = [];
  #turns = 0;
  #ended = false;
  #usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  #failed: string | undefined;
  #error: string | undefined;
  #failedSeen = false;

  push(chunk: string): void {
    this.#lines.push(chunk);
  }

  end(): void {
    this.#lines.end();
  }

  #event(e: Record<string, unknown>): void {
    if (e.type === "item.completed" && isObj(e.item) && e.item.type === "agent_message" && typeof e.item.text === "string") {
      this.#texts.push(e.item.text);
    } else if (e.type === "turn.completed") {
      this.#turns++;
      this.#ended = true;
      const u = isObj(e.usage) ? e.usage : {};
      const cached = num(u.cached_input_tokens);
      // codex's input_tokens already holds the cached ones. Keep `input` as fresh input only, so the
      // four fields mean the same as pi's and claude's, and a viewer does not count the cache twice.
      this.#usage.input += Math.max(0, num(u.input_tokens) - cached);
      this.#usage.cacheRead += cached;
      this.#usage.cacheWrite += num(u.cache_write_input_tokens);
      this.#usage.output += num(u.output_tokens);
      this.#usage.reasoning += num(u.reasoning_output_tokens);
    } else if (e.type === "turn.failed") {
      this.#ended = true;
      this.#failedSeen = true;
      if (isObj(e.error) && typeof e.error.message === "string") this.#failed = e.error.message;
    } else if (e.type === "error" && typeof e.message === "string") {
      this.#error = e.message;
    }
  }

  outcome(): StreamOutcome {
    // turn.failed is the final word; the last top-level error is the fallback.
    const message = this.#failed ?? this.#error;
    const failure: Failure | undefined = message === undefined && !this.#failedSeen ? undefined : parseCodexError(message ?? "");
    return {
      text: this.#texts.at(-1) ?? "",
      texts: [...this.#texts],
      turns: this.#turns,
      ended: this.#ended,
      model: null,
      usage: { ...this.#usage },
      ...(failure === undefined ? {} : { failure }),
      badLines: this.#lines.badLines,
    };
  }
}

export function parseCodexStream(text: string): StreamOutcome {
  const s = new CodexStream();
  s.push(text);
  s.end();
  return s.outcome();
}
