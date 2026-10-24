import type { SetFloorBody } from "@squad/contract";

export type FloorParse = { ok: true; value: number | null } | { ok: false; error: string };

/** Empty = back to the default (null). Otherwise a whole number from 0 to 100. */
export function parseFloor(text: string): FloorParse {
  const t = text.trim();
  if (t === "") return { ok: true, value: null };
  if (!/^\d{1,3}$/.test(t)) return { ok: false, error: "Use a whole number from 0 to 100, or leave it empty." };
  const n = Number(t);
  if (n > 100) return { ok: false, error: "Use a whole number from 0 to 100, or leave it empty." };
  return { ok: true, value: n };
}

export function floorBody(text5h: string, textWeek: string): { ok: true; body: SetFloorBody } | { ok: false; errors: string[] } {
  const a = parseFloor(text5h);
  const b = parseFloor(textWeek);
  if (a.ok && b.ok) return { ok: true, body: { floor5h: a.value, floorWeek: b.value } };
  const errors: string[] = [];
  if (!a.ok) errors.push(`5-hour floor: ${a.error}`);
  if (!b.ok) errors.push(`Week floor: ${b.error}`);
  return { ok: false, errors };
}
