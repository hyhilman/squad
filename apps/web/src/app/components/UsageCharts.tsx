import { Empty, theme } from "antd";
import type { UsageSeriesPoint } from "@squad/contract";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { bucketLabel, pivotPasses, pivotTokens } from "../lib/series.ts";
import { compactNumber, tokensText } from "../lib/format.ts";
import { colorOf } from "../theme.tsx";

export function UsageCharts({ points }: { points: readonly UsageSeriesPoint[] }) {
  const { token } = theme.useToken();
  const { accounts, rows } = pivotTokens(points);
  const passes = pivotPasses(points);
  if (rows.length === 0) return <Empty description="No usage in this time." />;
  const axis = { stroke: token.colorTextSecondary, tick: { fill: token.colorTextSecondary, fontSize: 12 } };
  const tip = { background: token.colorBgElevated, border: `1px solid ${token.colorBorder}`, color: token.colorText };
  const label = (v: unknown) => bucketLabel(String(v));
  const grid = <CartesianGrid stroke={token.colorBorderSecondary} strokeDasharray="2 4" vertical={false} />;
  return (
    <>
      <div role="img" aria-label="Tokens per bucket, stacked by account" style={{ width: "100%", height: 320 }}>
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            {grid}
            <XAxis dataKey="bucket" tickFormatter={(v: string) => bucketLabel(v)} {...axis} minTickGap={24} />
            <YAxis tickFormatter={compactNumber} width={56} {...axis} label={{ value: "Tokens", angle: -90, position: "insideLeft", fill: token.colorTextSecondary, fontSize: 12 }} />
            <Tooltip labelFormatter={label} formatter={(v) => `${tokensText(Number(v))} tokens`} contentStyle={tip} cursor={{ fill: token.colorFillTertiary }} />
            <Legend />
            {accounts.map((a, i) => (
              <Bar key={a} dataKey={a} stackId="t" fill={colorOf(i)} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div role="img" aria-label="Passes per bucket" style={{ width: "100%", height: 200, marginTop: 24 }}>
        <ResponsiveContainer>
          <BarChart data={passes} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            {grid}
            <XAxis dataKey="bucket" tickFormatter={(v: string) => bucketLabel(v)} {...axis} minTickGap={24} />
            <YAxis allowDecimals={false} width={56} {...axis} label={{ value: "Passes", angle: -90, position: "insideLeft", fill: token.colorTextSecondary, fontSize: 12 }} />
            <Tooltip labelFormatter={label} formatter={(v) => `${String(v)} passes`} contentStyle={tip} cursor={{ fill: token.colorFillTertiary }} />
            <Bar name="Passes" dataKey="passes" fill={token.colorPrimary} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
