// Pure helpers for the "Add account" form: group the providers, say what secret one needs, build the
// request. No React and no fetch, so `node --test` runs them.
import type { AddAccountBody, ProviderView } from "@squad/contract";

export interface ProviderOption {
  readonly value: string;
  /** What the person reads and searches: the name, the id and the model count. */
  readonly label: string;
}
export interface ProviderGroup {
  readonly label: string;
  readonly options: readonly ProviderOption[];
}

const optionOf = (p: ProviderView): ProviderOption => ({ value: p.id, label: `${p.name} (${p.id}) - ${p.models} model${p.models === 1 ? "" : "s"}` });

/** Seats (codex, claude), the providers built into pi, and the other providers from the catalog. Empty groups are left out. */
export function groupProviders(list: readonly ProviderView[]): ProviderGroup[] {
  const seats = list.filter((p) => p.runner !== "pi");
  const builtin = list.filter((p) => p.runner === "pi" && p.builtin === true);
  const other = list.filter((p) => p.runner === "pi" && p.builtin !== true);
  return [
    { label: "Seats", options: seats.map(optionOf) },
    { label: "Built into pi", options: builtin.map(optionOf) },
    { label: "Other providers (from the catalog)", options: other.map(optionOf) },
  ].filter((g) => g.options.length > 0);
}

export interface SecretField {
  /** The label of the password box; undefined = no box (the device login needs none). */
  readonly label: string | undefined;
  readonly hint?: string;
}

export function secretField(p: Pick<ProviderView, "kind"> | undefined): SecretField {
  if (p === undefined || p.kind === "login") return { label: undefined };
  if (p.kind === "token") return { label: "setup-token", hint: "Run `claude setup-token` on your own computer and paste the result here." };
  return { label: "API key", hint: "The key is sent once to the server over HTTPS and is stored only in the account folder." };
}

/** The same shape rule as the server (packages/squad/src/accounts/add.ts). The server checks again. */
export function secretError(v: string | undefined): string | undefined {
  if (v === undefined || v === "") return "Paste the value.";
  if (v.length > 4096) return "That is too long (4096 characters at most).";
  if (/\s/.test(v)) return "Remove the spaces and line breaks.";
  return undefined;
}

/** The request for a provider, name and secret. */
export function addBody(p: ProviderView, name: string, secret: string): AddAccountBody {
  if (p.runner === "codex") return { runner: "codex", name };
  if (p.runner === "claude") return { runner: "claude", name, token: secret };
  return { runner: "pi", name, provider: p.id, key: secret };
}

/** The runner folder the account will have, for the hint under the name box. */
export const accountPrefix = (p: ProviderView | undefined): string => (p === undefined ? "<runner>" : p.runner);
