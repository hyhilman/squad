import { useGetIdentity } from "@refinedev/core";
import { useQueryClient } from "@tanstack/react-query";
import type { AccountView, LoginStart, Me, Runner } from "@squad/contract";
import { EditOutlined, LoginOutlined, StopOutlined, CheckOutlined, SafetyOutlined } from "@ant-design/icons";
import { App, Button, Checkbox, Flex, Form, InputNumber, Modal, Popconfirm, Slider, Space, Tooltip, Typography } from "antd";
import { useState } from "react";
import { api } from "../api.ts";
import { failureText } from "../lib/errors.ts";
import { floorBody, parseFloor } from "../lib/floors.ts";
import { canLogInAgain, isOwnerOf } from "../lib/login.ts";
import { LoginProgress } from "./LoginProgress.tsx";

const floorRule = { validator: (_: unknown, v: string | undefined) => { const r = parseFloor(v ?? ""); return r.ok ? Promise.resolve() : Promise.reject(new Error(r.error)); } };

/**
 * The actions on one account: floors, disable or enable, consent, log in again. The same buttons sit
 * in the account page header and, as icons, in each row of the accounts table.
 */
export function AccountActions({ a, compact = false }: { a: AccountView; compact?: boolean }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { data: me } = useGetIdentity<Me>();
  const [busy, setBusy] = useState(false);
  const [floorsOpen, setFloorsOpen] = useState(false);
  const [started, setStarted] = useState<LoginStart>();
  const [form] = Form.useForm<{ f5?: string; fw?: string }>();
  const params = { runner: a.runner as Runner, name: a.name };
  const disabled = a.health === "disabled";
  const owner = isOwnerOf(a, me);

  // One guard for every action: show the plain error, refresh the data on success.
  const run = async (ok: string, act: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await act();
      await qc.invalidateQueries();
      void message.success(ok);
      return true;
    } catch (e) {
      void message.error(failureText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

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

  const saveFloors = async () => {
    const v = await form.validateFields();
    const b = floorBody(v.f5 ?? "", v.fw ?? "");
    if (!b.ok) return void message.error(b.errors.join(" "));
    if (await run("Floors saved.", () => api("setFloor", { params, body: b.body }))) setFloorsOpen(false);
  };

  // In the table the buttons are icons with a tooltip; in the page header they carry words.
  const btn = (label: string, icon: React.ReactNode, props: React.ComponentProps<typeof Button>) =>
    compact ? (
      <Tooltip title={label}>
        <Button size="small" icon={icon} aria-label={label} {...props} />
      </Tooltip>
    ) : (
      <Button icon={icon} {...props}>
        {label}
      </Button>
    );

  return (
    <>
      <Space wrap size={compact ? 4 : "small"}>
        {btn("Floors", <EditOutlined />, {
          disabled: busy,
          onClick: () => {
            form.setFieldsValue({ f5: a.floorSource === "owner" ? String(a.floor5h) : "", fw: a.floorSource === "owner" ? String(a.floorWeek) : "" });
            setFloorsOpen(true);
          },
        })}
        <Popconfirm
          title={disabled ? `Enable ${a.account}?` : `Disable ${a.account}?`}
          description={disabled ? undefined : "No pass will use it until you enable it again."}
          okText={disabled ? "Enable" : "Disable"}
          onConfirm={() => run(disabled ? "Account enabled." : "Account disabled.", () => api("setEnabled", { params, body: { enabled: disabled } }))}
        >
          {btn(disabled ? "Enable" : "Disable", disabled ? <CheckOutlined /> : <StopOutlined />, { danger: !disabled, disabled: busy })}
        </Popconfirm>
        {owner && a.consentAt === undefined
          ? btn("Give consent", <SafetyOutlined />, { disabled: busy, onClick: () => void run("Consent recorded.", () => api("consent", { params, body: { agree: true } })) })
          : null}
        {owner && canLogInAgain(a) ? btn("Log in again", <LoginOutlined />, { type: "primary", disabled: busy, onClick: () => void startLogin() }) : null}
      </Space>

      <Modal title={`Floors of ${a.account}`} open={floorsOpen} onOk={() => void saveFloors()} okText="Save" confirmLoading={busy} onCancel={() => setFloorsOpen(false)} destroyOnHidden>
        <Typography.Paragraph type="secondary">The percent of each window to keep free for the owner. A pass only takes the room above it.</Typography.Paragraph>
        <Form form={form} layout="vertical">
          <Form.Item name="f5" label="5-hour floor" rules={[floorRule]}>
            <FloorField fallback={a.floorSource === "owner" ? undefined : a.floor5h} />
          </Form.Item>
          <Form.Item name="fw" label="Week floor" rules={[floorRule]}>
            <FloorField fallback={a.floorSource === "owner" ? undefined : a.floorWeek} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={`Log in again: ${a.account}`} open={started !== undefined} footer={null} onCancel={() => setStarted(undefined)} destroyOnHidden>
        {started === undefined ? null : <LoginProgress start={started} />}
      </Modal>
    </>
  );
}

/**
 * One floor: a slider and a number box, or the default. The form keeps text ("" = the default), so
 * the same floorBody check runs as before.
 */
function FloorField({ value, onChange, fallback }: { value?: string; onChange?: (v: string) => void; fallback: number | undefined }) {
  const isDefault = value === undefined || value === "";
  const n = isDefault ? (fallback ?? 10) : Number(value);
  return (
    <Flex vertical gap={4}>
      <Checkbox checked={isDefault} onChange={(e) => onChange?.(e.target.checked ? "" : String(n))}>
        Use the default{fallback === undefined ? "" : ` (${fallback}%)`}
      </Checkbox>
      <Flex align="center" gap={12}>
        <Slider style={{ flex: 1 }} min={0} max={100} value={n} disabled={isDefault} onChange={(v) => onChange?.(String(v))} tooltip={{ formatter: (v) => `${v}%` }} />
        <InputNumber min={0} max={100} value={n} disabled={isDefault} addonAfter="%" style={{ width: 110 }} onChange={(v) => onChange?.(v === null ? "" : String(v))} />
      </Flex>
    </Flex>
  );
}
