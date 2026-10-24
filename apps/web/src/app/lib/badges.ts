import type { Health } from "@squad/contract";

/** Ant Design Tag colors. */
export type BadgeColor = "success" | "error" | "warning" | "processing" | "default";

const HEALTH: Readonly<Record<Health, BadgeColor>> = {
  ok: "success",
  suspect: "warning",
  cooling: "processing",
  dead: "error",
  disabled: "default",
  moved: "default",
};

export const healthColor = (h: Health): BadgeColor => HEALTH[h];

/** A pass outcome is `ok`, `lost`, or the failure kind. Unset means the pass still runs. */
export function outcomeBadge(outcome: string | undefined): { text: string; color: BadgeColor } {
  if (outcome === undefined) return { text: "running", color: "processing" };
  if (outcome === "ok") return { text: "ok", color: "success" };
  if (outcome === "lost") return { text: "lost", color: "warning" };
  return { text: outcome, color: "error" };
}
