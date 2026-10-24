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
export function addBody(p: ProviderView, name: string, secret = ""): AddAccountBody {
  if (p.runner === "codex") return { runner: "codex", name };
  // No token: the server runs the setup-token sign-in itself.
  if (p.runner === "claude") return secret === "" ? { runner: "claude", name } : { runner: "claude", name, token: secret };
  return { runner: "pi", name, provider: p.id, key: secret };
}

/** The runner folder the account will have, for the hint under the name box. */
export const accountPrefix = (p: ProviderView | undefined): string => (p === undefined ? "<runner>" : p.runner);

// ---- the provider picker ----

export interface PickerItem {
  readonly id: string;
  readonly name: string;
  /** The catalog logo to ask for (/logos/<logoId>.svg). */
  readonly logoId: string;
  /** The small line under the name. */
  readonly sub: string;
  readonly accounts: number;
  /** The catalog page to link (/catalog/<catalogId>); unset when the catalog lists no model for it, so there is no page. */
  readonly catalogId?: string;
}
export interface PickerGroup {
  readonly label: string;
  readonly items: readonly PickerItem[];
}

/** A pi provider with no models is hidden. The seats (codex, claude) always show. */
export const visibleProviders = (list: readonly ProviderView[]): ProviderView[] => list.filter((p) => p.runner !== "pi" || p.models > 0);

/** The catalog keeps the seats' logos under the company names. */
export const logoIdOf = (p: Pick<ProviderView, "id" | "runner">): string => (p.runner === "codex" ? "openai" : p.runner === "claude" ? "anthropic" : p.id);

export const logoSrc = (logoId: string): string => `/logos/${encodeURIComponent(logoId)}.svg`;

/** The letter on the badge shown when a logo is missing. */
export const badgeLetter = (name: string): string => /[A-Za-z0-9]/.exec(name)?.[0]?.toUpperCase() ?? "?";

export function providerSub(p: Pick<ProviderView, "runner" | "models">): string {
  if (p.runner === "codex") return "device login";
  if (p.runner === "claude") return "setup-token";
  return `API key · ${p.models} model${p.models === 1 ? "" : "s"}`;
}

// The catalog names the seats' providers openai and anthropic, as it names their logos.
const itemOf = (p: ProviderView): PickerItem => ({ id: p.id, name: p.name, logoId: logoIdOf(p), sub: providerSub(p), accounts: p.accounts, ...(p.models > 0 ? { catalogId: logoIdOf(p) } : {}) });

/**
 * The picker's groups: Seats, In use (pi providers the person already has an account for, most first),
 * Built into pi, From the catalog. A provider sits in the first group that fits. The search matches the
 * name or the id. Empty groups are left out.
 */
export function pickerGroups(list: readonly ProviderView[], query = ""): PickerGroup[] {
  const q = query.trim().toLowerCase();
  const shown = visibleProviders(list).filter((p) => q === "" || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  const seats = shown.filter((p) => p.runner !== "pi");
  const pi = shown.filter((p) => p.runner === "pi");
  const used = pi.filter((p) => p.accounts > 0).sort((a, b) => b.accounts - a.accounts);
  const rest = pi.filter((p) => p.accounts === 0);
  return [
    { label: "Seats", items: seats.map(itemOf) },
    { label: "In use", items: used.map(itemOf) },
    { label: "Built into pi", items: rest.filter((p) => p.builtin === true).map(itemOf) },
    { label: "From the catalog", items: rest.filter((p) => p.builtin !== true).map(itemOf) },
  ].filter((g) => g.items.length > 0);
}
