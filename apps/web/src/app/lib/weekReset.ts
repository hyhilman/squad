// The badge on a week room bar: how soon the week window resets. Red under a day, yellow under three
// days (both also put the account in Overview → Needs attention), else grey with the weekday. Every
// badge starts with "Week resets", so they read the same.

export type WeekTone = "red" | "yellow" | "grey";

export interface WeekBadge {
  readonly tone: WeekTone;
  readonly text: string;
  /** The exact local time, for the hover note. */
  readonly title: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The badge, or undefined when there is no reset time ahead. `timeZone` is for tests; the page uses the browser's. */
export function weekResetBadge(resetsWeek: string | undefined, now: Date, timeZone?: string): WeekBadge | undefined {
  const t = resetsWeek === undefined ? NaN : Date.parse(resetsWeek);
  if (!Number.isFinite(t) || t <= now.getTime()) return undefined;
  const left = t - now.getTime();
  const zone = timeZone === undefined ? {} : { timeZone };
  const title = `Resets ${new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short", ...zone }).format(t)}`;
  if (left < DAY) return { tone: "red", text: `Week resets in ${Math.max(1, Math.round(left / HOUR))} h`, title };
  if (left < 3 * DAY) {
    const d = Math.floor(left / DAY);
    const h = Math.floor((left - d * DAY) / HOUR);
    return { tone: "yellow", text: `Week resets in ${d} d${h === 0 ? "" : ` ${h} h`}`, title };
  }
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", ...zone }).format(t);
  const time = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...zone }).format(t);
  return { tone: "grey", text: `Week resets ${day} ${time}`, title };
}

/** The week resets within three days (a red or yellow badge). */
export const weekSoon = (resetsWeek: string | undefined, now: Date): boolean => {
  const tone = weekResetBadge(resetsWeek, now, "UTC")?.tone;
  return tone === "red" || tone === "yellow";
};
