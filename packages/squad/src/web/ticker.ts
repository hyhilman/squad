// The background loop of `squad web`: once a tick it reads due codex usage, probes suspect accounts
// and renews the price catalog. Steps run one after the other, and a tick never overlaps the last.
// The clock, the timers and every step's work are injected, so a test needs no timer and no network.

import { dueProbes, PROBE_AFTER_MS } from "../accounts/probe.ts";
import { getHealth, listAccounts, type AccountRow } from "../accounts/store.ts";
import { dueReads, readIntervalMs, refreshUsage } from "../accounts/usage-read.ts";
import type { HomeLayout } from "../home.ts";
import type { Log } from "../log.ts";
import { syncModelsFiles } from "../accounts/models-sync.ts";
import { loadPrices, loadProviders, recordPriceHistory, refreshPrices as realRefreshPrices, type RefreshPrices } from "../prices.ts";
import {
  SQUAD_DRY_RUN_ENV, SQUAD_NO_PRICES_ENV, SQUAD_PRICES_URL_ENV, SQUAD_PROBE_MODEL_CLAUDE_ENV, SQUAD_PROBE_MODEL_CODEX_ENV, SQUAD_PROBE_MODEL_PI_ENV,
  SQUAD_TICK_S_ENV, envNum, envOn, type EnvSpec,
} from "../settings.ts";
import type { Store } from "../store/db.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface Timers {
  every(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** The real timers. `unref` so the loop never keeps the process alive by itself. */
export const realTimers: Timers = {
  every: (fn, ms) => setInterval(fn, ms).unref(),
  clear: (h) => clearInterval(h as NodeJS.Timeout),
};

export interface TickStep {
  readonly name: string;
  run(): Promise<void>;
}

export interface Ticker {
  /** Runs one tick now. Returns at once, with a log line, when the last tick is still running. */
  tick(): Promise<void>;
  stop(): void;
}

export function createTicker(o: { steps: readonly TickStep[]; intervalMs: number; log: Log; timers?: Timers }): Ticker {
  const timers = o.timers ?? realTimers;
  let running = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      o.log.info("tick-skipped", { why: "the last tick is still running" });
      return;
    }
    running = true;
    try {
      for (const s of o.steps) {
        try {
          await s.run();
        } catch (e) {
          // Only the error class: the text can hold an address or a token.
          o.log.warn("tick-step-failed", { step: s.name, error: e instanceof Error ? e.name : "unknown" });
        }
      }
    } finally {
      running = false;
    }
  };
  const handle = timers.every(() => void tick(), o.intervalMs);
  return {
    tick,
    stop: () => {
      if (stopped) return;
      stopped = true;
      timers.clear(handle);
    },
  };
}

export interface StepDeps {
  readonly env: Env;
  readonly home: HomeLayout;
  readonly store: Store;
  readonly log: Log;
  readonly now: () => Date;
  readonly fetch: typeof globalThis.fetch;
  /** Runs one probe pass. The same code as `squad probe`; it is the caller's to give. */
  readonly probe: (account: AccountRow, model: string) => Promise<void>;
  /** Replaceable for tests. */
  readonly readUsage?: (account: AccountRow) => Promise<unknown>;
  readonly refreshPrices?: (o: RefreshPrices) => Promise<unknown>;
}

const PROBE_MODEL: Readonly<Record<string, EnvSpec>> = {
  codex: SQUAD_PROBE_MODEL_CODEX_ENV,
  claude: SQUAD_PROBE_MODEL_CLAUDE_ENV,
  pi: SQUAD_PROBE_MODEL_PI_ENV,
};

export function tickSteps(d: StepDeps): TickStep[] {
  // A failed probe leaves the account suspect and may leave `last_used_at` as it was, so `dueProbes`
  // would name it every tick. This map keeps a real pass to one per account per hour.
  const probedAt = new Map<string, number>();
  return [
    {
      name: "usage-read",
      run: async () => {
        const accounts = listAccounts(d.store.db);
        const health = new Map(accounts.map((a) => [a.id, getHealth(d.store.db, a.id)]));
        const read = d.readUsage ?? ((a: AccountRow) => refreshUsage(d.store, d.home, a, d.fetch, d.now(), d.log));
        for (const a of dueReads(accounts, health, d.now(), readIntervalMs(d.env), d.env)) {
          try {
            await read(a);
          } catch (e) {
            d.log.warn("usage-read-failed", { account: a.id, error: e instanceof Error ? e.name : "unknown" });
          }
        }
      },
    },
    {
      name: "auto-probe",
      run: async () => {
        const accounts = listAccounts(d.store.db);
        const health = new Map(accounts.map((a) => [a.id, getHealth(d.store.db, a.id)]));
        for (const a of dueProbes(accounts, health, d.now(), d.env)) {
          const spec = PROBE_MODEL[a.runner];
          const model = spec === undefined ? undefined : d.env[spec.key];
          if (model === undefined || model === "") continue;
          const last = probedAt.get(a.id);
          if (last !== undefined && d.now().getTime() - last < PROBE_AFTER_MS) continue;
          probedAt.set(a.id, d.now().getTime());
          try {
            await d.probe(a, model);
          } catch (e) {
            d.log.warn("auto-probe-failed", { account: a.id, error: e instanceof Error ? e.name : "unknown" });
          }
        }
      },
    },
    {
      name: "prices",
      run: async () => {
        if (envOn(SQUAD_NO_PRICES_ENV, d.env)) return;
        // Read the raw value: an empty address means "no fetch", which envOptional would turn into the default.
        const url = d.env[SQUAD_PRICES_URL_ENV.key] ?? SQUAD_PRICES_URL_ENV.default ?? "";
        const refresh = d.refreshPrices ?? realRefreshPrices;
        const result = await refresh({ home: d.home, url, now: d.now().getTime(), fetch: d.fetch, env: d.env });
        // Only a new copy can hold a new price or a new model.
        if (result !== "refreshed") return;
        try {
          recordPriceHistory(d.store.db, loadPrices(d.home), d.now());
        } catch (e) {
          d.log.warn("price-history-failed", { error: e instanceof Error ? e.name : "unknown" });
        }
        const n = syncModelsFiles(d.home, d.store, loadProviders(d.home));
        if (n > 0) d.log.info("models-json-updated", { accounts: n });
      },
    },
  ];
}

/** Starts the loop. Nothing under a dry run or in api-only (dev) mode, or when the interval is bad. */
export function startTicker(o: StepDeps & { readonly apiOnly?: boolean; readonly timers?: Timers }): Ticker | undefined {
  if (o.apiOnly === true || envOn(SQUAD_DRY_RUN_ENV, o.env)) return undefined;
  let seconds: number;
  try {
    seconds = envNum(SQUAD_TICK_S_ENV, o.env);
  } catch {
    seconds = NaN;
  }
  if (!(seconds >= 1)) {
    o.log.warn("ticker-off", { why: `${SQUAD_TICK_S_ENV.key} must be a number of seconds, 1 or more` });
    return undefined;
  }
  return createTicker({ steps: tickSteps(o), intervalMs: seconds * 1000, log: o.log, ...(o.timers === undefined ? {} : { timers: o.timers }) });
}
