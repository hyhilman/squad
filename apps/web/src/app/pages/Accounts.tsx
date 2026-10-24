import { useGetIdentity, useList } from "@refinedev/core";
import type { AccountView, Me } from "@squad/contract";
import { Alert, Empty, Flex, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link } from "react-router";
import { AccountActions } from "../components/AccountActions.tsx";
import { AddAccount } from "../components/AddAccount.tsx";
import { ErrorNote } from "../components/ErrorNote.tsx";
import { Room } from "../components/Room.tsx";
import { healthColor } from "../lib/badges.ts";
import { agoText, roomByRunner } from "../lib/format.ts";

const filtersOf = (rows: readonly AccountView[], pick: (a: AccountView) => string) =>
  [...new Set(rows.map(pick))].sort().map((v) => ({ text: v, value: v }));

const cmp = (a: number | undefined, b: number | undefined) => (a ?? -1) - (b ?? -1);

/** The accounts the signed-in person may see: their own, or all for an admin. */
export function Accounts() {
  const { data: me } = useGetIdentity<Me>();
  const { result, query } = useList<AccountView & { id: string }>({ resource: "accounts", pagination: { mode: "off" } });
  const rows = result.data;
  const now = new Date();
  const columns: ColumnsType<AccountView> = [
    {
      title: "Account",
      dataIndex: "account",
      sorter: (a, b) => a.account.localeCompare(b.account),
      defaultSortOrder: "ascend",
      render: (v: string, a) => (
        <Space>
          <Link to={`/accounts/${v}`}>{v}</Link>
          {a.busy ? <Tag color="processing">busy</Tag> : null}
        </Space>
      ),
    },
    { title: "Runner", dataIndex: "runner", filters: filtersOf(rows, (a) => a.runner), onFilter: (v, a) => a.runner === v },
    { title: "Kind", dataIndex: "kind", filters: filtersOf(rows, (a) => a.kind), onFilter: (v, a) => a.kind === v },
    ...(me?.admin === true
      ? [{ title: "Owner", dataIndex: "ownerEmail", filters: filtersOf(rows, (a) => a.ownerEmail), onFilter: (v: unknown, a: AccountView) => a.ownerEmail === v, sorter: (a: AccountView, b: AccountView) => a.ownerEmail.localeCompare(b.ownerEmail) }]
      : []),
    {
      title: "Health",
      dataIndex: "health",
      filters: filtersOf(rows, (a) => a.health),
      onFilter: (v, a) => a.health === v,
      render: (h: AccountView["health"]) => <Tag color={healthColor(h)}>{h}</Tag>,
    },
    { title: "5-hour left", dataIndex: "left5h", sorter: (a, b) => cmp(a.left5h, b.left5h), render: (v: number | undefined) => <Room value={v} /> },
    { title: "Week left", dataIndex: "leftWeek", sorter: (a, b) => cmp(a.leftWeek, b.leftWeek), render: (v: number | undefined) => <Room value={v} /> },
    { title: "Last read", dataIndex: "readAt", sorter: (a, b) => Date.parse(a.readAt ?? "") - Date.parse(b.readAt ?? "") || 0, render: (v: string | undefined) => agoText(v, now) },
    { title: "Actions", key: "actions", fixed: "right", render: (_: unknown, a) => <AccountActions a={a} compact /> },
  ];
  const rooms = roomByRunner(rows);
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Flex justify="space-between" align="center" wrap gap="small">
        <Typography.Title level={3} style={{ margin: 0 }}>
          Accounts
        </Typography.Title>
        <AddAccount />
      </Flex>
      {query.isError ? <ErrorNote error={query.error} /> : null}
      {rooms.length > 0 ? (
        <Alert
          type="info"
          message={rooms.map((r) => `${r.runner}: ${r.accounts} account${r.accounts === 1 ? "" : "s"}${r.read === 0 ? ", no usage read yet" : `, average left (${r.read} read) 5-hour ${r.left5h ?? "?"}%, week ${r.leftWeek ?? "?"}%`}`).join(". ")}
        />
      ) : null}
      <Table<AccountView>
        rowKey="account"
        loading={query.isLoading}
        dataSource={[...rows]}
        columns={columns}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: <Empty description="No accounts yet. Add an account to start." /> }}
      />
    </Space>
  );
}
