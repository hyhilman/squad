// The charts. Colours: one per account, from the checked categorical palette, the same on every chart
// (lib/colors.ts). Text uses the ink colours, never the series colour.
import { Box, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import type { CatalogPricePoint, RoomPoint, UsageSeriesPoint } from "@squad/contract";
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { bucketTick, bucketTitle, dayTicks, timeTick } from "../lib/chartText.ts";
import { historyRows, perMillionText } from "../lib/catalog.ts";
import { colorMap, SERIES_DARK, SERIES_LIGHT } from "../lib/colors.ts";
import { compactNumber, tokensText } from "../lib/format.ts";
import { pivotTokens, roomRows } from "../lib/series.ts";
import { useAccounts } from "../queries.ts";
import { useColorMode } from "./colorMode.ts";

const INK = {
  light: { grid: "#ececef", axis: "#d4d4d8", tick: "#71717a", surface: "#ffffff", cursor: "rgba(24,24,27,0.05)" },
  dark: { grid: "#1f1f23", axis: "#2e2e33", tick: "#8b8b96", surface: "#111113", cursor: "rgba(255,255,255,0.05)" },
} as const;

export function useChartInk() {
  const { mode } = useColorMode();
  return { ...INK[mode], series: mode === "dark" ? SERIES_DARK : SERIES_LIGHT };
}

/** Colour by account id over every account the person can see, so a colour never moves between charts. */
export function useAccountColors(extra: readonly string[] = []): Record<string, string> {
  const accounts = useAccounts();
  const { series } = useChartInk();
  return useMemo(() => colorMap([...(accounts.data ?? []).map((a) => a.account), ...extra], series), [accounts.data, extra, series]);
}

const tickStyle = (fill: string) => ({ fill, fontSize: 12 });
// Recharts sets its own text size; the axis text follows the page's small text instead.
const chartCss = { "& .recharts-cartesian-axis-tick-value": { fontSize: "12px", fontVariantNumeric: "tabular-nums" }, "& svg": { overflow: "visible" } } as const;

function TipBox({ title, rows, total }: { title: string; rows: { name: string; color: string; value: string }[]; total?: string }) {
  return (
    <Box bg="surface" borderWidth="1px" borderColor="border" rounded="lg" shadow="lg" px="3" py="2.5" minW="180px" fontSize="xs">
      <Text fontWeight="600" mb="1.5">
        {title}
      </Text>
      <Stack gap="1">
        {rows.map((r) => (
          <HStack key={r.name} justify="space-between" gap="4">
            <HStack gap="2" minW="0">
              <Box boxSize="2" rounded="sm" flexShrink={0} style={{ background: r.color }} />
              <Text color="fg.muted" truncate>
                {r.name}
              </Text>
            </HStack>
            <Text fontVariantNumeric="tabular-nums">{r.value}</Text>
          </HStack>
        ))}
      </Stack>
      {total === undefined ? null : (
        <HStack justify="space-between" mt="1.5" pt="1.5" borderTopWidth="1px" borderColor="border.subtle">
          <Text color="fg.muted">Total</Text>
          <Text fontWeight="600" fontVariantNumeric="tabular-nums">
            {total}
          </Text>
        </HStack>
      )}
    </Box>
  );
}

export function Legend({ items }: { items: { name: string; color: string; dashed?: boolean }[] }) {
  return (
    <Flex wrap="wrap" gap="4" rowGap="1.5" fontSize="xs" color="fg.muted">
      {items.map((i) => (
        <HStack key={i.name} gap="1.5">
          {i.dashed === true ? (
            <Box w="3" h="0" borderTopWidth="2px" borderStyle="dashed" style={{ borderColor: i.color }} />
          ) : (
            <Box boxSize="2.5" rounded="sm" style={{ background: i.color }} />
          )}
          <Text>{i.name}</Text>
        </HStack>
      ))}
    </Flex>
  );
}

/** Tokens per bucket, stacked by account. */
export function TokensChart({ points, height = 260 }: { points: readonly UsageSeriesPoint[]; height?: number }) {
  const ink = useChartInk();
  const { accounts, rows } = useMemo(() => pivotTokens(points), [points]);
  const colors = useAccountColors(accounts);
  // Hour buckets: one tick per day (at its 00:00), labelled with the day.
  const hourly = rows.some((r) => r.bucket.includes("T"));
  // Day buckets: every Nth day, counted back from the newest, so the gaps are even.
  const step = Math.ceil(rows.length / 10);
  const ticks = hourly
    ? rows.filter((r) => r.bucket.includes("T00:00")).map((r) => r.bucket)
    : step > 1
      ? rows.filter((_, i) => (rows.length - 1 - i) % step === 0).map((r) => r.bucket)
      : undefined;
  return (
    <Stack gap="3">
      <Box h={`${height}px`} mx="-2" css={chartCss}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="22%">
            <CartesianGrid vertical={false} stroke={ink.grid} />
            <XAxis dataKey="bucket" {...(ticks === undefined ? {} : { ticks, interval: 0 })} tickFormatter={(b: string) => bucketTick(hourly ? b.slice(0, 10) : b)} tick={tickStyle(ink.tick)} axisLine={{ stroke: ink.axis }} tickLine={false} minTickGap={16} tickMargin={8} />
            <YAxis tickFormatter={compactNumber} tick={tickStyle(ink.tick)} axisLine={false} tickLine={false} width={48} />
            <Tooltip
              cursor={{ fill: ink.cursor }}
              content={({ active, payload, label }) => {
                if (active !== true || payload === undefined || payload.length === 0) return null;
                const shown = payload.filter((p) => Number(p.value) > 0).reverse();
                const total = payload.reduce((s, p) => s + Number(p.value ?? 0), 0);
                return <TipBox title={bucketTitle(String(label))} rows={shown.map((p) => ({ name: String(p.dataKey), color: colors[String(p.dataKey)] ?? ink.tick, value: tokensText(Number(p.value)) }))} total={tokensText(total)} />;
              }}
            />
            {accounts.map((a, i) => (
              <Bar key={a} dataKey={a} stackId="t" fill={colors[a]} stroke={ink.surface} strokeWidth={1} radius={i === accounts.length - 1 ? [3, 3, 0, 0] : 0} maxBarSize={44} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </Box>
      <Legend items={accounts.map((a) => ({ name: a, color: colors[a] ?? ink.tick }))} />
    </Stack>
  );
}

/** The room left in the two windows over time, with the floors as dashed lines. */
export function RoomChart({ points, floor5h, floorWeek, height = 240 }: { points: readonly RoomPoint[]; floor5h: number; floorWeek: number; height?: number }) {
  const ink = useChartInk();
  const rows = useMemo(() => roomRows(points), [points]);
  const c5 = ink.series[0];
  const cw = ink.series[1];
  const ticks = rows.length === 0 ? [] : dayTicks(rows[0]!.t, rows.at(-1)!.t);
  const fmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <Stack gap="3">
      <Box h={`${height}px`} mx="-2" css={chartCss}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={ink.grid} />
            <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} ticks={ticks} tickFormatter={timeTick} tick={tickStyle(ink.tick)} axisLine={{ stroke: ink.axis }} tickLine={false} minTickGap={24} tickMargin={8} />
            <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v: number) => `${v}%`} tick={tickStyle(ink.tick)} axisLine={false} tickLine={false} width={48} />
            <ReferenceLine y={floor5h} stroke={c5} strokeDasharray="4 4" strokeOpacity={0.7} ifOverflow="extendDomain" />
            <ReferenceLine y={floorWeek} stroke={cw} strokeDasharray="4 4" strokeOpacity={0.7} ifOverflow="extendDomain" />
            <Tooltip
              cursor={{ stroke: ink.axis }}
              content={({ active, payload, label }) => {
                if (active !== true || payload === undefined || payload.length === 0) return null;
                return (
                  <TipBox
                    title={fmt.format(Number(label))}
                    rows={payload.filter((p) => p.value !== undefined).map((p) => ({ name: p.dataKey === "left5h" ? "5-hour left" : "Week left", color: p.dataKey === "left5h" ? c5 : cw, value: `${String(p.value)}%` }))}
                  />
                );
              }}
            />
            <Line dataKey="left5h" type="stepAfter" stroke={c5} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: ink.surface }} connectNulls isAnimationActive={false} />
            <Line dataKey="leftWeek" type="stepAfter" stroke={cw} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: ink.surface }} connectNulls isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </Box>
      <Legend
        items={[
          { name: "5-hour left", color: c5 },
          { name: "Week left", color: cw },
          { name: `5-hour floor ${floor5h}%`, color: c5, dashed: true },
          { name: `Week floor ${floorWeek}%`, color: cw, dashed: true },
        ]}
      />
    </Stack>
  );
}

/** The input price per 1M of each provider over time, one step line per provider. */
export function PriceHistoryChart({ history, names, height = 220 }: { history: readonly CatalogPricePoint[]; names: Readonly<Record<string, string>>; height?: number }) {
  const ink = useChartInk();
  const { providers, rows } = useMemo(() => historyRows(history), [history]);
  const colors = useMemo(() => colorMap(providers, ink.series), [providers, ink.series]);
  const data = rows.map((r) => ({ ...r, t: Date.parse(String(r.at)) }));
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <Stack gap="3">
      <Box h={`${height}px`} mx="-2" css={chartCss}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={ink.grid} />
            <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(t: number) => day.format(t)} tick={tickStyle(ink.tick)} axisLine={{ stroke: ink.axis }} tickLine={false} minTickGap={24} tickMargin={8} />
            <YAxis tickFormatter={(v: number) => (v === 0 ? "$0" : perMillionText(v))} tick={tickStyle(ink.tick)} axisLine={false} tickLine={false} width={56} />
            <Tooltip
              cursor={{ stroke: ink.axis }}
              content={({ active, payload, label }) => {
                if (active !== true || payload === undefined || payload.length === 0) return null;
                return <TipBox title={day.format(Number(label))} rows={payload.map((p) => ({ name: names[String(p.dataKey)] ?? String(p.dataKey), color: colors[String(p.dataKey)] ?? ink.tick, value: perMillionText(Number(p.value)) }))} />;
              }}
            />
            {providers.map((p) => (
              <Line key={p} dataKey={p} type="stepAfter" stroke={colors[p]} strokeWidth={2} dot={{ r: 3, strokeWidth: 0, fill: colors[p] }} activeDot={{ r: 4, strokeWidth: 2, stroke: ink.surface }} connectNulls isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Box>
      <Legend items={providers.map((p) => ({ name: names[p] ?? p, color: colors[p] ?? ink.tick }))} />
    </Stack>
  );
}
