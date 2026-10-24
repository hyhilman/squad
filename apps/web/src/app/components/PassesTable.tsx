import type { PassView } from "@squad/contract";
import { Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useNavigate } from "react-router";
import { outcomeBadge } from "../lib/badges.ts";
import { diffText, moneyText, totalTokens, tokensText } from "../lib/format.ts";

export function PassesTable({ rows, loading, showAccount }: { rows: readonly PassView[]; loading: boolean; showAccount: boolean }) {
  const navigate = useNavigate();
  const columns: ColumnsType<PassView> = [
    { title: "Time", dataIndex: "startedAt", render: (v: string) => new Date(v).toLocaleString(), width: 170 },
    ...(showAccount ? [{ title: "Account", dataIndex: "account", render: (v: string | undefined) => v ?? <Typography.Text type="secondary">none</Typography.Text> }] : []),
    { title: "Caller", render: (_: unknown, p: PassView) => `${p.caller.flow} / ${p.caller.action}` },
    { title: "Task", render: (_: unknown, p: PassView) => (p.task === undefined ? "" : `${p.task.kind} ${p.task.id}`) },
    { title: "Model", dataIndex: "model" },
    {
      title: "Outcome",
      render: (_: unknown, p: PassView) => {
        const b = outcomeBadge(p.outcome);
        return <Tag color={b.color}>{b.text}</Tag>;
      },
    },
    { title: "Tokens", align: "right", render: (_: unknown, p: PassView) => tokensText(totalTokens(p.tokens)) },
    { title: "CLI cost", align: "right", render: (_: unknown, p: PassView) => moneyText(p.cliCostUsd) },
    { title: "Catalog cost", align: "right", render: (_: unknown, p: PassView) => moneyText(p.catalogCostUsd) },
    { title: <Tooltip title="Catalog cost minus CLI cost">Diff</Tooltip>, align: "right", render: (_: unknown, p: PassView) => diffText(p.cliCostUsd, p.catalogCostUsd) },
  ];
  return (
    <Table<PassView>
      rowKey="passId"
      size="small"
      loading={loading}
      dataSource={[...rows]}
      columns={columns}
      pagination={false}
      scroll={{ x: "max-content" }}
      locale={{ emptyText: "No passes yet." }}
      onRow={(p) => ({ onClick: () => navigate(`/passes/${encodeURIComponent(p.passId)}`), style: { cursor: "pointer" } })}
    />
  );
}
