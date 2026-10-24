import { Progress, Typography } from "antd";
import { pctText } from "../lib/format.ts";

/** Percent left as a small bar. Low room turns red. */
export function Room({ value }: { value: number | undefined }) {
  if (value === undefined) return <Typography.Text type="secondary">unknown</Typography.Text>;
  return (
    <Progress
      percent={value}
      size="small"
      format={() => pctText(value)}
      status={value <= 10 ? "exception" : "normal"}
      aria-label={`${value}% left`}
      style={{ minWidth: 110, margin: 0 }}
    />
  );
}
