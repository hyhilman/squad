// The result types shared by the stream parsers, the runners and the store.

import type { Tokens } from "./store/db.ts";

export type FailureKind = "quota" | "rate-limit" | "auth" | "provider" | "idle" | "timeout" | "no-account" | "busy";

export interface Failure {
  readonly kind: FailureKind;
  /** The exact provider code or HTTP status, or "" when there is none. */
  readonly code: string;
  readonly message: string;
}

/** The same shape as the store's `Tokens`; one type, two names. */
export type Usage = Tokens;

/** Percent left (0..100) in each window, and ISO times the windows reset. */
export interface Room {
  readonly left5h?: number;
  readonly leftWeek?: number;
  readonly resets5h?: string;
  readonly resetsWeek?: string;
}

export interface StreamOutcome {
  readonly text: string;
  readonly texts: readonly string[];
  readonly turns: number;
  readonly ended: boolean;
  readonly model: string | null;
  readonly usage: Usage;
  readonly failure?: Failure;
  readonly room?: Room;
  readonly badLines: number;
}
