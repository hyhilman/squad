import { useOne } from "@refinedev/core";
import { useQueryClient } from "@tanstack/react-query";
import type { AccountView, LoginStart, Runner } from "@squad/contract";
import { App, Button, Card, Descriptions, Form, Input, Popconfirm, Skeleton, Space, Tag, Typography } from "antd";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api.ts";
import { ErrorNote } from "../components/ErrorNote.tsx";
import { LoginProgress } from "../components/LoginProgress.tsx";
import { PassesTable } from "../components/PassesTable.tsx";
import { Room } from "../components/Room.tsx";
import { RoomChart } from "../components/RoomChart.tsx";
import { healthColor } from "../lib/badges.ts";
import { failureText } from "../lib/errors.ts";
import { floorBody, parseFloor } from "../lib/floors.ts";
import { agoText } from "../lib/format.ts";
import { canLogInAgain } from "../lib/login.ts";
import { usePasses, useRoomSeries } from "../queries.ts";

const floorRule = { validator: (_: unknown, v: string | undefined) => { const r = parseFloor(v ?? ""); return r.ok ? Promise.resolve() : Promise.reject(new Error(r.error)); } };

export function Account() {
  const { runner, name } = useParams();
  const id = `${runner}/${name}`;
  const { result, query } = useOne<AccountView & { id: string }>({ resource: "accounts", id });
  if (query.isLoading) return <Skeleton active />;
  if (query.isError || result === undefined) return <ErrorNote error={query.error ?? new Error("not loaded")} />;
  return <AccountBody a={result} />;
}

function AccountBody({ a }: { a: AccountView }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<LoginStart>();
  const params = { runner: a.runner as Runner, name: a.name };
  const room = useRoomSeries(params.runner, params.name, "7d");
  const passes = usePasses(a.account, undefined, 10);

  // One guard for every action: show the plain error, refresh the data on success.
  const run = async (ok: string, act: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await act();
      await qc.invalidateQueries();
      void message.success(ok);
    } catch (e) {
      void message.error(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  const disabled = a.health === "disabled";
  const startLogin = async () => {
    setBusy(true);
    try {
      setStarted(await api("startLogin", { params }));
    } catch (e) {
      void message.error(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <div>
        <Link to="/accounts">Back to accounts</Link>
        <Typography.Title level={3} style={{ margin: "4px 0 0" }}>
          {a.account}
        </Typography.Title>
      </div>

      {started === undefined ? null : (
        <Card title="Log in again">
          <LoginProgress start={started} />
        </Card>
      )}

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
            <Room value={a.left5h} />
          </Descriptions.Item>
          <Descriptions.Item label="Week left">
            <Room value={a.leftWeek} />
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

      <Card title="Floors" extra={<Typography.Text type="secondary">The percent of each window to keep free. Leave a box empty for the default.</Typography.Text>}>
        <Form
          key={`${a.floor5h}/${a.floorWeek}/${a.floorSource}`}
          layout="vertical"
          style={{ maxWidth: 360 }}
          initialValues={{ f5: a.floorSource === "owner" ? String(a.floor5h) : "", fw: a.floorSource === "owner" ? String(a.floorWeek) : "" }}
          onFinish={(v: { f5?: string; fw?: string }) => {
            const b = floorBody(v.f5 ?? "", v.fw ?? "");
            if (!b.ok) return void message.error(b.errors.join(" "));
            void run("Floors saved.", () => api("setFloor", { params, body: b.body }));
          }}
        >
          <Form.Item name="f5" label="5-hour floor (%)" rules={[floorRule]}>
            <Input inputMode="numeric" placeholder="default" />
          </Form.Item>
          <Form.Item name="fw" label="Week floor (%)" rules={[floorRule]}>
            <Input inputMode="numeric" placeholder="default" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>
            Save floors
          </Button>
        </Form>
      </Card>

      <Card title="Actions">
        <Space wrap>
          <Popconfirm
            title={disabled ? `Enable ${a.account}?` : `Disable ${a.account}?`}
            description={disabled ? undefined : "No pass will use it until you enable it again."}
            okText={disabled ? "Enable" : "Disable"}
            onConfirm={() => run(disabled ? "Account enabled." : "Account disabled.", () => api("setEnabled", { params, body: { enabled: disabled } }))}
          >
            <Button danger={!disabled} disabled={busy}>
              {disabled ? "Enable" : "Disable"}
            </Button>
          </Popconfirm>
          {a.consentAt === undefined ? (
            <Button disabled={busy} onClick={() => void run("Consent recorded.", () => api("consent", { params, body: { agree: true } }))}>
              Give consent
            </Button>
          ) : null}
          {canLogInAgain(a) ? (
            <Button disabled={busy} onClick={() => void startLogin()}>
              Log in again
            </Button>
          ) : null}
        </Space>
      </Card>

      <Card title="Recent passes" extra={<Link to={`/passes?account=${encodeURIComponent(a.account)}`}>All passes</Link>}>
        {passes.isError ? <ErrorNote error={passes.error} /> : <PassesTable rows={passes.data ?? []} loading={passes.isLoading} showAccount={false} />}
      </Card>
    </Space>
  );
}
