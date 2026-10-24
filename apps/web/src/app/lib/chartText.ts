// Axis and tooltip text for the charts. A bucket is a UTC start, so it is shown in UTC.
const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

const parse = (bucket: string): { t: number; hour: string | undefined } | undefined => {
  const m = /^(\d{4}-\d\d-\d\d)(?:T(\d\d:\d\d))?/.exec(bucket);
  if (m === null) return undefined;
  return { t: Date.parse(`${m[1]}T00:00:00Z`), hour: m[2] };
};

export function bucketTick(bucket: string): string {
  const p = parse(bucket);
  if (p === undefined) return bucket;
  return p.hour ?? day.format(p.t);
}

export function bucketTitle(bucket: string): string {
  const p = parse(bucket);
  if (p === undefined) return bucket;
  return p.hour === undefined ? weekday.format(p.t) : `${weekday.format(p.t)}, ${p.hour} UTC`;
}

export const timeTick = (ms: number): string => day.format(ms);

const DAY_MS = 86_400_000;

/** The UTC midnights from `from` to `to`, for a time axis that shows each day once. */
export function dayTicks(from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(from / DAY_MS) * DAY_MS; t <= to; t += DAY_MS) out.push(t);
  return out;
}
