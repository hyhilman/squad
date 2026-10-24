import { pctText } from "./lib/format.ts";

/** Percent left as a bar plus text. A <meter> needs no inline style, which the CSP would block. */
export function Room({ value }: { value: number | undefined }) {
  if (value === undefined) return <span className="muted">unknown</span>;
  return (
    <span>
      <meter min={0} max={100} value={value} aria-label={`${value}% left`} />
      {pctText(value)}
    </span>
  );
}
