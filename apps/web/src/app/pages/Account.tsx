import { useOne } from "@refinedev/core";
import type { AccountView, Runner } from "@squad/contract";
import { Card, Descriptions, Flex, Skeleton, Space, Tag, Typography } from "antd";
import { Link, useParams } from "react-router";
import { ErrorNote } from "../components/ErrorNote.tsx";
import { AccountActions } from "../components/AccountActions.tsx";
import { PassesTable } from "../components/PassesTable.tsx";
import { Room } from "../components/Room.tsx";
import { RoomChart } from "../components/RoomChart.tsx";
import { healthColor } from "../lib/badges.ts";
import { agoText } from "../lib/format.ts";
import { usePasses, useRoomSeries } from "../queries.ts";

export function Account() {
  const { runner, name } = useParams();
  const id = `${runner}/${name}`;
  const { result, query } = useOne<AccountView & { id: string }>({ resource: "accounts", id });
  if (query.isLoading) return <Skeleton active />;
  if (query.isError || result === undefined) return <ErrorNote error={query.error ?? new Error("not loaded")} />;
  return <AccountBody a={result} />;
}

function AccountBody({ a }: { a: AccountView }) {
  const room = useRoomSeries(a.runner as Runner, a.name, "7d");
  const passes = usePasses(a.account, undefined, 10);

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <div>
        <Link to="/accounts">Back to accounts</Link>
        <Flex justify="space-between" align="center" wrap gap="small" style={{ marginTop: 4 }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {a.account}
          </Typography.Title>
          <AccountActions a={a} />
        </Flex>
      </div>

      <Card title="Facts">
        <Descriptions column={{ xs: 1, sm: 1, md: 2 }} bordered size="small">
          <Descriptions.Item label="Kind">{a.kind}</Descriptions.Item>
          <Descriptions.Item label="Owner">{a.ownerEmail}</Descriptions.Item>
          <Descriptions.Item label="Login email">{a.loginEmail ?? "none"}</Descriptions.Item>
          <Descriptions.Item label="Pools">{a.pools.length === 0 ? "none" : a.pools.map((p) => <Tag key={p}>{p}</Tag>)}</Descriptions.Item>
          <Descriptions.Item label="Health">
            <Tag color={healthColor(a.health)}>{a.health}</Tag>
            {a.busy ? <Tag color="processing">busy</Tag> : null}
          </Descriptions.Item>
          <Descriptions.Item label="Last failure code">{a.lastCode ?? "none"}</Descriptions.Item>
          <Descriptions.Item label="Cooling until">{a.coolUntil === undefined ? "not cooling" : new Date(a.coolUntil).toLocaleString()}</Descriptions.Item>
          <Descriptions.Item label="Last read">{agoText(a.readAt, new Date())}</Descriptions.Item>
          <Descriptions.Item label="5-hour left">
            <Room value={a.left5h} floor={a.floor5h} />
          </Descriptions.Item>
          <Descriptions.Item label="Week left">
            <Room value={a.leftWeek} floor={a.floorWeek} />
          </Descriptions.Item>
          <Descriptions.Item label="Floors">
            5-hour {a.floor5h}%, week {a.floorWeek}% ({a.floorSource})
          </Descriptions.Item>
          <Descriptions.Item label="Consent">{a.consentAt === undefined ? "not given" : new Date(a.consentAt).toLocaleString()}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="Room left, last 7 days">
        {room.isError ? <ErrorNote error={room.error} /> : <RoomChart points={room.data ?? []} floor5h={a.floor5h} floorWeek={a.floorWeek} />}
      </Card>

      <Card title="Recent passes" extra={<Link to={`/passes?account=${encodeURIComponent(a.account)}`}>All passes</Link>}>
        {passes.isError ? <ErrorNote error={passes.error} /> : <PassesTable rows={passes.data ?? []} loading={passes.isLoading} showAccount={false} />}
      </Card>
    </Space>
  );
}
