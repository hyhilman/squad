import { Flex, Tooltip, Typography, theme } from "antd";
import { pctText } from "../lib/format.ts";
import { roomState } from "../lib/room.ts";

/**
 * Percent left as a small bar, with the owner's floor drawn in: the shaded part from 0 to the floor
 * is kept for the owner, and a pass only takes the room above it.
 */
export function Room({ value, floor }: { value: number | undefined; floor?: number }) {
  const { token } = theme.useToken();
  if (value === undefined) return <Typography.Text type="secondary">unknown</Typography.Text>;
  const f = floor ?? 0;
  const state = roomState(value, f);
  const color = { blue: token.colorPrimary, yellow: token.yellow6, orange: token.orange6, red: token.colorError }[state];
  const label = floor === undefined ? pctText(value) : `${pctText(value)} · floor ${pctText(f)}`;
  const usable = Math.max(0, value - f);
  const tip = value <= f ? "At or under the floor: no pass will use this window." : `${pctText(usable)} left above the floor.`;
  return (
    <Tooltip title={tip}>
      <Flex align="center" gap={8} style={{ minWidth: 170 }} aria-label={`${value}% left, floor ${f}%`}>
        <div style={{ position: "relative", flex: 1, height: 8, borderRadius: 4, background: token.colorFillSecondary, overflow: "hidden" }}>
          <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, Math.max(0, value))}%`, background: color, borderRadius: 4 }} />
          {f > 0 ? (
            <>
              {/* The part kept for the owner is grey: a pass never takes it. */}
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(f, value)}%`, background: token.colorTextQuaternary }} />
              <div style={{ position: "absolute", left: `calc(${f}% - 1px)`, top: -2, bottom: -2, width: 2, background: token.colorText }} />
            </>
          ) : null}
        </div>
        <Typography.Text style={{ whiteSpace: "nowrap", fontSize: 12, color: state === "red" ? token.colorError : undefined }}>{label}</Typography.Text>
      </Flex>
    </Tooltip>
  );
}
