export const RANGES = ["7d", "30d", "90d"] as const;
export type Range = (typeof RANGES)[number];
export type Bucket = "day" | "hour";

/** The `since` value for the API. Hour buckets over 90 days would be 2000+ bars, so they stop at 7 days. */
export const sinceFor = (range: Range, by: Bucket): string => (by === "hour" ? "7d" : range);
