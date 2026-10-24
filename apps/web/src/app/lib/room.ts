// The colour of a room bar follows the room left above the owner's floor, which is what a pass may
// still take. The pool skips an account at or under its floor (packages/squad/src/pool/pick.ts).
export type RoomState = "blue" | "yellow" | "orange" | "red";

export function roomState(left: number, floor: number): RoomState {
  const usable = left - floor;
  if (usable > 50) return "blue";
  if (usable > 25) return "yellow";
  if (usable > 5) return "orange";
  return "red";
}

export const roomLabel = (left: number | undefined, floor: number): string => (left === undefined ? "no read yet" : `${left}% · floor ${floor}%`);

export interface RoomParts {
  readonly floor: number;
  /** The room above the floor, which passes may use; undefined when there is no read. */
  readonly available: number | undefined;
  readonly left: number | undefined;
}

export const roomParts = (left: number | undefined, floor: number): RoomParts => ({
  floor,
  available: left === undefined ? undefined : Math.max(0, left - floor),
  left,
});

export const floorHint = (floor: number): string => `Floor: the minimum capacity of this seat that is never shared (${floor}%).`;

export function availableHint(p: RoomParts): string {
  if (p.left === undefined || p.available === undefined) return "No usage read yet.";
  if (p.available === 0) return `Nothing to share: ${p.left}% is left, under the ${p.floor}% floor.`;
  return `${p.available}% can still be shared: ${p.left}% of the window is left, minus the ${p.floor}% floor.`;
}
