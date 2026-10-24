// The same rule as the pool's pick (packages/squad/src/pool/pick.ts): an account at or under its
// floor is skipped. "near" warns 10 points before that.
export type RoomState = "ok" | "near" | "held";

export function roomState(left: number, floor: number): RoomState {
  if (left <= floor) return "held";
  return left - floor <= 10 ? "near" : "ok";
}
