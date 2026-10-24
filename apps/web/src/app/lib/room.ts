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
