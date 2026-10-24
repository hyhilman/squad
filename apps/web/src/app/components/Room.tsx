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
  const color = state === "held" ? token.colorError : state === "near" ? token.colorWarning : token.colorPrimary;
  const label = floor === undefined ? pctText(value) : `${pctText(value)} · floor ${pctText(f)}`;
  const tip = state === "held" ? "At or under the floor: no pass will use this window." : state === "near" ? "Close to the floor." : "Room above the floor.";
  return (
    <Tooltip title={tip}>
      <Flex align="center" gap={8} style={{ minWidth: 170 }} aria-label={`${value}% left, floor ${f}%`}>
        <div style={{ position: "relative", flex: 1, height: 8, borderRadius: 4, background: token.colorFillSecondary, overflow: "hidden" }}>
          <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, Math.max(0, value))}%`, background: color, borderRadius: 4 }} />
          {f > 0 ? (
            <>
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${f}%`, background: token.colorBgMask, opacity: 0.35 }} />
              <div style={{ position: "absolute", left: `calc(${f}% - 1px)`, top: -2, bottom: -2, width: 2, background: token.colorText }} />
            </>
          ) : null}
        </div>
        <Typography.Text style={{ whiteSpace: "nowrap", fontSize: 12, color: state === "held" ? token.colorError : undefined }}>{label}</Typography.Text>
      </Flex>
    </Tooltip>
  );
}
