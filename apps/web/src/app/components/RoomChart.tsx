import { Empty, theme } from "antd";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { roomRows } from "../lib/series.ts";
import type { RoomPoint } from "@squad/contract";
import { colorOf } from "../theme.tsx";

const C5 = colorOf(0);
const CW = colorOf(1);
const fmtTime = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Percent left over time, two lines. The floors are dashed lines in the same colors. */
export function RoomChart({ points, floor5h, floorWeek }: { points: readonly RoomPoint[]; floor5h: number; floorWeek: number }) {
  const { token } = theme.useToken();
  const data = roomRows(points);
  if (data.length === 0) return <Empty description="No usage reads in this time yet." />;
  return (
    <div style={{ width: "100%", height: 280 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid stroke={token.colorBorderSecondary} strokeDasharray="2 4" />
          <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(t: number) => fmtTime(t)} stroke={token.colorTextSecondary} tick={{ fill: token.colorTextSecondary, fontSize: 12 }} minTickGap={48} />
          <YAxis domain={[0, 100]} unit="%" stroke={token.colorTextSecondary} tick={{ fill: token.colorTextSecondary, fontSize: 12 }} width={48} label={{ value: "Room left (%)", angle: -90, position: "insideLeft", fill: token.colorTextSecondary, fontSize: 12 }} />
          <Tooltip labelFormatter={(t) => fmtTime(Number(t))} formatter={(v) => `${String(v)}%`} contentStyle={{ background: token.colorBgElevated, border: `1px solid ${token.colorBorder}`, color: token.colorText }} />
          <Legend />
          <ReferenceLine y={floor5h} stroke={C5} strokeDasharray="6 4" label={{ value: `5h floor ${floor5h}%`, fill: C5, fontSize: 11, position: "insideBottomLeft" }} />
          <ReferenceLine y={floorWeek} stroke={CW} strokeDasharray="6 4" label={{ value: `week floor ${floorWeek}%`, fill: CW, fontSize: 11, position: "insideTopRight" }} />
          <Line name="5-hour left" dataKey="left5h" stroke={C5} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          <Line name="Week left" dataKey="leftWeek" stroke={CW} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
