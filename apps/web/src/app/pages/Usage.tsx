import { Box, Flex, SegmentGroup, SimpleGrid, Skeleton, Table, Text } from "@chakra-ui/react";
import { Activity, Coins, DollarSign, Receipt } from "lucide-react";
import { useState } from "react";
import { costCompare, DIFF_HINT, diffText, diffTone, moneyText, TONE_COLOR, compactNumber, tokensText } from "../lib/format.ts";
import { RANGES, sinceFor, type Bucket, type Range } from "../lib/range.ts";
import { seriesTotals } from "../lib/totals.ts";
import { useUsageByModel, useUsageSeries } from "../queries.ts";
import { TokensChart } from "../ui/charts.tsx";
import { EmptyBlock, ErrorBlock, PageHeader, Panel, StatCard } from "../ui/parts.tsx";

function Segments<T extends string>({ value, onChange, items, label, disabled }: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[]; label: string; disabled?: boolean }) {
  return (
    <SegmentGroup.Root size="sm" value={value} onValueChange={(d) => d.value !== null && onChange(d.value as T)} aria-label={label} disabled={disabled} bg="surface">
      <SegmentGroup.Indicator bg="bg.emphasized" shadow="none" />
      <SegmentGroup.Items items={items} px="3" />
    </SegmentGroup.Root>
  );
}

const num = { textAlign: "end", fontVariantNumeric: "tabular-nums" } as const;

export function Usage() {
  const [range, setRange] = useState<Range>("30d");
  const [by, setBy] = useState<Bucket>("day");
  const since = sinceFor(range, by);
  const series = useUsageSeries(by, since);
  const models = useUsageByModel(since);
  const t = seriesTotals(series.data ?? []);
  const compare = costCompare(models.data ?? []);

  return (
    <>
      <PageHeader
        title="Usage"
        description="Tokens and cost across every account you can see."
        actions={
          <Flex gap="2" wrap="wrap">
            <Segments label="Range" value={range} onChange={setRange} items={RANGES.map((r) => ({ value: r, label: r }))} disabled={by === "hour"} />
            <Segments label="Bucket" value={by} onChange={setBy} items={[{ value: "day", label: "Day" }, { value: "hour", label: "Hour" }]} />
          </Flex>
        }
      />
      {by === "hour" ? (
        <Text fontSize="xs" color="fg.muted" mt="-4" mb="4">
          Hour buckets cover the last 7 days.
        </Text>
      ) : null}
      <SimpleGrid columns={{ base: 2, xl: 4 }} gap={{ base: "3", md: "4" }} mb="6">
        <StatCard label="Tokens" icon={Coins} loading={series.isPending} value={compactNumber(t.tokens)} hint={`${tokensText(t.tokens)} tokens`} />
        <StatCard label="Passes" icon={Activity} loading={series.isPending} value={tokensText(t.passes)} hint={`In the last ${since}`} />
        <StatCard label="CLI cost" icon={Receipt} loading={series.isPending} value={moneyText(t.cliCostUsd) || "-"} hint="As pi and claude said" />
        <StatCard label="Catalog cost" icon={DollarSign} loading={series.isPending} value={moneyText(t.catalogCostUsd) || "-"} hint="At catalog prices" />
      </SimpleGrid>

      <Panel title="Tokens by account" description={`All tokens per UTC ${by}, stacked by account.`} mb="6">
        {series.isPending ? <Skeleton h="300px" rounded="md" /> : series.isError ? <ErrorBlock error={series.error} onRetry={() => void series.refetch()} /> : series.data.length === 0 ? <EmptyBlock title="No passes in this range" /> : <TokensChart points={series.data} height={300} />}
      </Panel>

      <Panel title="CLI cost and catalog cost by model" description="Spent vs catalog is the CLI cost minus the catalog cost, and its share of the catalog cost: red means the agent spent more than the catalog price." flush overflow="hidden">
        <Box px="0">
          {models.isPending ? (
            <Box p="5">
              <Skeleton h="32" rounded="md" />
            </Box>
          ) : models.isError ? (
            <Box p="5">
              <ErrorBlock error={models.error} />
            </Box>
          ) : compare.length === 0 ? (
            <EmptyBlock title="No cost in this range" description="A cost shows once a pass has a CLI cost or a catalog price." />
          ) : (
            <Table.ScrollArea>
              <Table.Root size="sm">
                <Table.Header>
                  <Table.Row bg="bg.subtle">
                    <Table.ColumnHeader ps="5">Model</Table.ColumnHeader>
                    <Table.ColumnHeader {...num} hideBelow="md">
                      Passes
                    </Table.ColumnHeader>
                    <Table.ColumnHeader {...num}>CLI cost</Table.ColumnHeader>
                    <Table.ColumnHeader {...num}>Catalog cost</Table.ColumnHeader>
                    <Table.ColumnHeader {...num} pe="5" title={DIFF_HINT}>
                      Spent vs catalog
                    </Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {compare.map((r) => (
                    <Table.Row key={r.key}>
                      <Table.Cell ps="5" fontFamily="mono" fontSize="xs" whiteSpace="nowrap">
                        {r.key}
                      </Table.Cell>
                      <Table.Cell {...num} hideBelow="md">
                        {tokensText(r.passes)}
                      </Table.Cell>
                      <Table.Cell {...num} color="fg.muted">
                        {moneyText(r.cliCostUsd) || "-"}
                      </Table.Cell>
                      <Table.Cell {...num}>{moneyText(r.catalogCostUsd) || "-"}</Table.Cell>
                      <Table.Cell {...num} pe="5" fontWeight="500" color={TONE_COLOR[diffTone(r.cliCostUsd, r.catalogCostUsd)]}>
                        {diffText(r.cliCostUsd, r.catalogCostUsd) || "-"}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Table.ScrollArea>
          )}
        </Box>
      </Panel>
    </>
  );
}
