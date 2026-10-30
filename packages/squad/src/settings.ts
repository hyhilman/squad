// squad's settings. Each setting is one EnvSpec row: its key, its default and a one-line why. The row
// is the setting's doc. A value comes from the process environment; `squad.toml` in the home comes
// later and will use the same rows.
//
// Kill switches follow `SQUAD_NO_<FEATURE>=1`, as in doppelganger.

/** One setting's whole definition. */
export interface EnvSpec {
  readonly key: string;
  readonly default?: string;
  /** One line. This is the setting doc. */
  readonly why: string;
  /** The value is a secret. It never comes from `squad.toml`, only from the env or `squad.secret.toml`. */
  readonly secret?: true;
}

export const SQUAD_HOME_ENV: EnvSpec = {
  key: "SQUAD_HOME",
  why: "the project's squad home (accounts, locks, database); unset = .squad/ in the project's main checkout",
};
export const SQUAD_DB_ENV: EnvSpec = {
  key: "SQUAD_DB",
  why: "the database file; unset = state/squad.db in the home. Point it at a throwaway file to test",
};
export const SQUAD_DRY_RUN_ENV: EnvSpec = {
  key: "SQUAD_DRY_RUN",
  default: "0",
  why: "1 = build every argv and plan, run nothing, write nothing",
};
export const SQUAD_DOCKER_ENV: EnvSpec = {
  key: "SQUAD_DOCKER",
  default: "docker",
  why: "the docker binary; tests point it at a fake",
};
export const SQUAD_NO_USAGE_READ_ENV: EnvSpec = {
  key: "SQUAD_NO_USAGE_READ",
  default: "0",
  why: "1 = no usage reads; floors then pass every account that has no read",
};
export const SQUAD_NO_AUTO_PROBE_ENV: EnvSpec = {
  key: "SQUAD_NO_AUTO_PROBE",
  default: "0",
  why: "1 = squad never starts a probe pass by itself",
};
export const SQUAD_NO_RESET_PROBE_ENV: EnvSpec = {
  key: "SQUAD_NO_RESET_PROBE",
  default: "0",
  why: "1 = no probe pass after a window at or under its floor resets, so a claude account keeps its old room numbers until its next pass",
};
export const SQUAD_NO_WEB_LOGIN_ENV: EnvSpec = {
  key: "SQUAD_NO_WEB_LOGIN",
  default: "0",
  why: "1 = `squad web` refuses to start, so nobody can sign in to the web view (fail safe)",
};
export const SQUAD_NO_SERVE_ENV: EnvSpec = {
  key: "SQUAD_NO_SERVE",
  default: "0",
  why: "1 = `squad serve` refuses to start, so no machine caller can start a pass (fail safe)",
};
export const SQUAD_SERVE_DRAIN_S_ENV: EnvSpec = {
  key: "SQUAD_SERVE_DRAIN_S",
  default: "60",
  why: "seconds `squad serve` lets running passes finish after SIGTERM before it stops their containers; with the stop grace it stays under systemd's 90 s",
};
export const SQUAD_NO_LIMIT_RESET_ENV: EnvSpec = {
  key: "SQUAD_NO_LIMIT_RESET",
  default: "0",
  why: "1 = the web app's \"Use limit reset\" starts no claude CLI and spends no reset",
};
export const SQUAD_NO_USAGE_EXPORT_ENV: EnvSpec = {
  key: "SQUAD_NO_USAGE_EXPORT",
  default: "0",
  why: "1 = no per-pass usage file for the usage viewers (agentusage, Tokscale)",
};
export const SQUAD_NO_GC_ENV: EnvSpec = {
  key: "SQUAD_NO_GC",
  default: "0",
  why: "1 = the cleanup job does nothing",
};
export const SQUAD_STOP_GRACE_S_ENV: EnvSpec = {
  key: "SQUAD_STOP_GRACE_S",
  default: "20",
  why: "seconds between SIGTERM and SIGKILL when a pass is stopped, so a token refresh in flight can finish",
};
export const SQUAD_SESSION_TTL_D_ENV: EnvSpec = {
  key: "SQUAD_SESSION_TTL_D",
  default: "7",
  why: "days an unused session folder is kept before the cleanup job removes it",
};
export const SQUAD_CONVERSATION_IDLE_D_ENV: EnvSpec = {
  key: "SQUAD_CONVERSATION_IDLE_D",
  default: "7",
  why: "days an open conversation may sit without a turn before the cleanup job closes it and deletes its history; one with a running turn is never closed",
};
export const SQUAD_KEEP_PASSES_D_ENV: EnvSpec = {
  key: "SQUAD_KEEP_PASSES_D",
  default: "400",
  why: "days a pass row is kept before the cleanup job deletes it; events are kept forever",
};
export const SQUAD_KEEP_LOGS_D_ENV: EnvSpec = {
  key: "SQUAD_KEEP_LOGS_D",
  default: "400",
  why: "days a pass's stored stream and prompt (the history page reads them) and a usage export file are kept before the cleanup job deletes them",
};
export const SQUAD_FLOOR_DEFAULT_ENV: EnvSpec = {
  key: "SQUAD_FLOOR_DEFAULT",
  default: "10",
  why: "share of each window (percent) left for the account's owner; an account with its own floor ignores this",
};
export const SQUAD_COOL_RATE_LIMIT_S_ENV: EnvSpec = {
  key: "SQUAD_COOL_RATE_LIMIT_S",
  default: "300",
  why: "seconds an account rests after a rate-limit answer",
};
export const SQUAD_COOL_QUOTA_S_ENV: EnvSpec = {
  key: "SQUAD_COOL_QUOTA_S",
  default: "3600",
  why: "seconds an account rests after a quota answer when the reset time is not known",
};

export const SQUAD_USAGE_READ_S_ENV: EnvSpec = {
  key: "SQUAD_USAGE_READ_S",
  default: "300",
  why: "seconds between two usage reads of one codex login account; the reads of many accounts are spread over this time",
};
export const SQUAD_KEY_PARALLEL_ENV: EnvSpec = {
  key: "SQUAD_KEY_PARALLEL",
  default: "4",
  why: "passes one key or token account can run at once; a login account always runs one",
};
export const SQUAD_PRICES_URL_ENV: EnvSpec = {
  key: "SQUAD_PRICES_URL",
  default: "https://models.dev/api.json",
  why: "the address of a models.dev style price catalog, kept in state/prices.json for 6 hours; no key in the address; empty = no fetch",
};
export const SQUAD_NO_PRICES_ENV: EnvSpec = {
  key: "SQUAD_NO_PRICES",
  default: "0",
  why: "1 = the price catalog is never fetched; the saved copy is still read",
};
export const SQUAD_NO_KEY_CAPS_ENV: EnvSpec = {
  key: "SQUAD_NO_KEY_CAPS",
  default: "0",
  why: "1 = the pool ignores the owners' dollar caps on key accounts, so squad may spend past a cap; off (caps in force) is the safe side",
};
export const SQUAD_TICK_S_ENV: EnvSpec = {
  key: "SQUAD_TICK_S",
  default: "60",
  why: "seconds between two ticks of the `squad web` background loop (usage reads, auto probes, price refresh)",
};
export const SQUAD_PROBE_MODEL_CODEX_ENV: EnvSpec = {
  key: "SQUAD_PROBE_MODEL_CODEX",
  why: "the model an auto probe uses on a codex account; unset = no auto probe on codex, because there is no safe default; the reset probe uses it only when no served model has a price",
};
export const SQUAD_PROBE_MODEL_CLAUDE_ENV: EnvSpec = {
  key: "SQUAD_PROBE_MODEL_CLAUDE",
  why: "the model an auto probe uses on a claude account; unset = no auto probe on claude, because there is no safe default; the reset probe uses it only when no served model has a price",
};
export const SQUAD_PROBE_MODEL_PI_ENV: EnvSpec = {
  key: "SQUAD_PROBE_MODEL_PI",
  why: "the model an auto probe uses on a pi account; unset = no auto probe on pi, because there is no safe default; the reset probe uses it only when no served model has a price",
};

export const SETTINGS: readonly EnvSpec[] = [
  SQUAD_HOME_ENV,
  SQUAD_DB_ENV,
  SQUAD_DRY_RUN_ENV,
  SQUAD_DOCKER_ENV,
  SQUAD_NO_USAGE_READ_ENV,
  SQUAD_NO_AUTO_PROBE_ENV,
  SQUAD_NO_RESET_PROBE_ENV,
  SQUAD_NO_WEB_LOGIN_ENV,
  SQUAD_NO_SERVE_ENV,
  SQUAD_SERVE_DRAIN_S_ENV,
  SQUAD_NO_LIMIT_RESET_ENV,
  SQUAD_NO_GC_ENV,
  SQUAD_NO_USAGE_EXPORT_ENV,
  SQUAD_STOP_GRACE_S_ENV,
  SQUAD_SESSION_TTL_D_ENV,
  SQUAD_CONVERSATION_IDLE_D_ENV,
  SQUAD_KEEP_PASSES_D_ENV,
  SQUAD_KEEP_LOGS_D_ENV,
  SQUAD_FLOOR_DEFAULT_ENV,
  SQUAD_COOL_RATE_LIMIT_S_ENV,
  SQUAD_COOL_QUOTA_S_ENV,
  SQUAD_USAGE_READ_S_ENV,
  SQUAD_KEY_PARALLEL_ENV,
  SQUAD_PRICES_URL_ENV,
  SQUAD_NO_PRICES_ENV,
  SQUAD_NO_KEY_CAPS_ENV,
  SQUAD_TICK_S_ENV,
  SQUAD_PROBE_MODEL_CODEX_ENV,
  SQUAD_PROBE_MODEL_CLAUDE_ENV,
  SQUAD_PROBE_MODEL_PI_ENV,
];

type Env = Readonly<Record<string, string | undefined>>;

/** The value, or the default, or undefined. An empty value counts as unset. */
export function envOptional(spec: EnvSpec, env: Env = process.env): string | undefined {
  const v = env[spec.key];
  return v !== undefined && v !== "" ? v : spec.default;
}

/** A number setting. A value that is not a finite number is refused, with the raw value in the error. */
export function envNum(spec: EnvSpec, env: Env = process.env): number {
  const raw = envOptional(spec, env);
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${spec.key} must be a number, got ${JSON.stringify(raw ?? "")}`);
  return n;
}

/** A kill switch or flag: on only for exactly "1". */
export const envOn = (spec: EnvSpec, env: Env = process.env): boolean => envOptional(spec, env) === "1";
