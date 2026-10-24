import { useList } from "@refinedev/core";
import type { AccountView } from "@squad/contract";
import { Button, Flex, Select, Space, Typography } from "antd";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { ErrorNote } from "../components/ErrorNote.tsx";
import { PassesTable } from "../components/PassesTable.tsx";
import { usePasses } from "../queries.ts";

const PAGE = 25;

/** Newest first. "Next" moves to older passes with the last pass id as the `before` cursor. */
export function Passes() {
  const [sp, setSp] = useSearchParams();
  const account = sp.get("account") ?? undefined;
  // The cursors of the pages already seen; the last one is the page on screen.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const before = cursors[cursors.length - 1];
  const { result } = useList<AccountView & { id: string }>({ resource: "accounts", pagination: { mode: "off" } });
  const q = usePasses(account, before, PAGE);
  const rows = q.data ?? [];
  const last = rows[rows.length - 1];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Flex justify="space-between" align="center" wrap gap="small">
        <Typography.Title level={3} style={{ margin: 0 }}>
          Passes
        </Typography.Title>
        <Select
          allowClear
          showSearch
          placeholder="All accounts"
          style={{ minWidth: 220 }}
          value={account}
          options={result.data.map((a) => ({ value: a.account, label: a.account }))}
          onChange={(v: string | undefined) => {
            setCursors([undefined]);
            setSp(v === undefined ? {} : { account: v });
          }}
        />
      </Flex>
      {q.isError ? <ErrorNote error={q.error} /> : null}
      <PassesTable rows={rows} loading={q.isLoading} showAccount />
      <Flex justify="end" gap="small">
        <Button disabled={cursors.length === 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
          Newer
        </Button>
        <Button disabled={rows.length < PAGE || last === undefined} onClick={() => last && setCursors((c) => [...c, last.passId])}>
          Older
        </Button>
      </Flex>
    </Space>
  );
}
