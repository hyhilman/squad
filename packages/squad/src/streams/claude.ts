// Parses `claude -p --output-format stream-json --verbose`. Usage comes from the `result` event
// only: the `assistant` event repeats it.

import { kindOfHttpStatus } from "../classify.ts";
import type { Failure, Room, StreamOutcome } from "../types.ts";
import { isObj, JsonLines, num, textOf } from "./lines.ts";

const leftPct = (utilization: unknown): number | undefined => (typeof utilization === "number" ? Math.round((1 - utilization) * 100) : undefined);
const iso = (secs: unknown): string | undefined => (typeof secs === "number" ? new Date(secs * 1000).toISOString() : undefined);

export class ClaudeStream {
  #lines = new JsonLines((e) => this.#event(e));
  #texts: string[] = [];
  #model: string | null = null;
  #result: Record<string, unknown> | undefined;
  #windows: Record<string, unknown> | undefined;

  push(chunk: string): void {
    this.#lines.push(chunk);
  }

  end(): void {
    this.#lines.end();
  }

  #event(e: Record<string, unknown>): void {
    if (e.type === "system" && e.subtype === "init" && typeof e.model === "string") this.#model = e.model;
    else if (e.type === "assistant" && isObj(e.message)) {
      const t = textOf(e.message.content);
      if (t !== "") this.#texts.push(t);
    } else if (e.type === "rate_limit_event" && isObj(e.rate_limit_info) && isObj(e.rate_limit_info.unifiedWindows)) {
      this.#windows = e.rate_limit_info.unifiedWindows;
    } else if (e.type === "result") this.#result = e;
  }

  #room(): Room | undefined {
    const w = this.#windows;
    if (w === undefined) return undefined;
    const five = isObj(w.five_hour) ? w.five_hour : {};
    const week = isObj(w.seven_day) ? w.seven_day : {};
    const room = {
      left5h: leftPct(five.utilization),
      leftWeek: leftPct(week.utilization),
      resets5h: iso(five.resetsAt),
      resetsWeek: iso(week.resetsAt),
    };
    // Leave out unset keys, so the object compares equal to one written by hand.
    return Object.fromEntries(Object.entries(room).filter(([, v]) => v !== undefined)) as Room;
  }

  outcome(): StreamOutcome {
    const r = this.#result;
    const u = r !== undefined && isObj(r.usage) ? r.usage : {};
    let failure: Failure | undefined;
    if (r !== undefined && (r.is_error === true || r.subtype !== "success")) {
      const subtype = typeof r.subtype === "string" ? r.subtype : "";
      const message = typeof r.result === "string" ? r.result.slice(0, 500) : subtype;
      failure =
        typeof r.api_error_status === "number"
          ? { kind: kindOfHttpStatus(r.api_error_status), code: String(r.api_error_status), message }
          : { kind: "provider", code: subtype, message };
    }
    const room = this.#room();
    const split = isObj(u.cache_creation) ? u.cache_creation : undefined;
    return {
      text: r !== undefined && typeof r.result === "string" ? r.result : "",
      texts: [...this.#texts],
      turns: r === undefined ? 0 : num(r.num_turns),
      ended: r !== undefined,
      model: this.#model,
      usage: {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheWrite: num(u.cache_creation_input_tokens),
        reasoning: 0,
      },
      ...(split === undefined ? {} : { cacheWrite1h: num(split.ephemeral_1h_input_tokens) }),
      ...(r !== undefined && typeof r.total_cost_usd === "number" && Number.isFinite(r.total_cost_usd) ? { cliCostUsd: r.total_cost_usd } : {}),
      ...(failure === undefined ? {} : { failure }),
      ...(room === undefined ? {} : { room }),
      badLines: this.#lines.badLines,
    };
  }
}

export function parseClaudeStream(text: string): StreamOutcome {
  const s = new ClaudeStream();
  s.push(text);
  s.end();
  return s.outcome();
}
