import type { UsageRow } from "@squad/contract";
import { Card, Flex, Segmented, Space, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useState } from "react";
import { UsageCharts } from "../components/UsageCharts.tsx";
import { ErrorNote } from "../components/ErrorNote.tsx";
import { costText, hasCost, tokensText, totalTokens } from "../lib/format.ts";
import { RANGES, sinceFor, type Bucket, type Range } from "../lib/range.ts";
import { useUsageByAccount, useUsageSeries } from "../queries.ts";

export function Usage() {
  const [range, setRange] = useState<Range>("7d");
  const [by, setBy] = useState<Bucket>("day");
  const since = sinceFor(range, by);
  const series = useUsageSeries(by, since);
  const totals = useUsageByAccount(since);
  const rows = totals.data ?? [];
  const num = (title: string, f: (r: UsageRow) => number) => ({ title, align: "right" as const, sorter: (a: UsageRow, b: UsageRow) => f(a) - f(b), render: (_: unknown, r: UsageRow) => tokensText(f(r)) });
  const columns: ColumnsType<UsageRow> = [
    { title: "Account", dataIndex: "key", sorter: (a, b) => a.key.localeCompare(b.key) },
    num("Passes", (r) => r.passes),
    num("Input", (r) => r.input),
    num("Output", (r) => r.output),
    num("Cache read", (r) => r.cacheRead),
    num("Cache write", (r) => r.cacheWrite),
    num("Reasoning", (r) => r.reasoning),
    { ...num("Total tokens", totalTokens), defaultSortOrder: "descend" },
    ...(hasCost(rows) ? [{ title: "Cost", align: "right" as const, render: (_: unknown, r: UsageRow) => costText(r.costUsd) }] : []),
  ];
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Flex justify="space-between" align="center" wrap gap="small">
        <Typography.Title level={3} style={{ margin: 0 }}>
          Usage
        </Typography.Title>
        <Space wrap>
          <Segmented<Range> options={[...RANGES]} value={range} onChange={setRange} />
          <Segmented<Bucket> options={[{ label: "By day", value: "day" }, { label: "By hour", value: "hour" }]} value={by} onChange={setBy} />
        </Space>
      </Flex>
      {by === "hour" && range !== "7d" ? <Typography.Text type="secondary">Hour buckets show the last 7 days at most.</Typography.Text> : null}
      <Card title={`Tokens per ${by}, by account`} loading={series.isLoading}>
        {series.isError ? <ErrorNote error={series.error} /> : <UsageCharts points={series.data ?? []} />}
      </Card>
      <Card title="Totals by account">
        {totals.isError ? <ErrorNote error={totals.error} /> : null}
        <Table<UsageRow> rowKey="key" size="small" loading={totals.isLoading} dataSource={[...rows]} columns={columns} pagination={false} scroll={{ x: "max-content" }} locale={{ emptyText: "No usage in this time." }} />
      </Card>
    </Space>
  );
}
