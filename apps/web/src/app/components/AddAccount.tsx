import { PlusOutlined } from "@ant-design/icons";
import { useGetIdentity } from "@refinedev/core";
import { useQueryClient } from "@tanstack/react-query";
import type { LoginStart, Me } from "@squad/contract";
import { App, Button, Form, Input, Modal, Select } from "antd";
import { useMemo, useState } from "react";
import { api } from "../api.ts";
import { accountNameError, suggestName } from "../lib/accountName.ts";
import { failureText } from "../lib/errors.ts";
import { accountPrefix, addBody, groupProviders, secretError, secretField } from "../lib/providers.ts";
import { useProviders } from "../queries.ts";
import { LoginProgress } from "./LoginProgress.tsx";

interface Values {
  provider?: string;
  name?: string;
  secret?: string;
}

/**
 * Picks a provider, asks for a name, and adds the account: a codex device login is followed to its end;
 * a claude token or a pi API key is sent once and the account exists at once. The secret lives only in the
 * form while it is open; closing the box clears it.
 */
export function AddAccount() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState<LoginStart>();
  const [form] = Form.useForm<Values>();
  const { data: me } = useGetIdentity<Me>();
  const providers = useProviders(open);
  const chosen = Form.useWatch("provider", form);
  const provider = providers.data?.find((p) => p.id === chosen);
  const field = secretField(provider);
  const groups = useMemo(() => groupProviders(providers.data ?? []), [providers.data]);
  const suggested = suggestName(me?.email);

  const close = () => {
    setOpen(false);
    setStart(undefined);
    form.resetFields();
  };

  // An empty name box takes the suggested name shown as the placeholder.
  const submit = async (v: Values) => {
    if (provider === undefined) return;
    const name = v.name === undefined || v.name === "" ? suggested : v.name;
    setBusy(true);
    try {
      const res = await api("addAccount", { body: addBody(provider, name, v.secret ?? "") });
      if ("loginId" in res) {
        setStart(res);
      } else {
        void message.success(`Added ${res.account}.`);
        void qc.invalidateQueries();
        close();
      }
    } catch (e) {
      void message.error(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
        Add account
      </Button>
      <Modal
        title="Add an account"
        open={open}
        onCancel={close}
        footer={start === undefined ? undefined : <Button onClick={close}>Close</Button>}
        okText={provider?.kind === "login" ? "Start login" : "Add account"}
        okButtonProps={{ disabled: provider === undefined }}
        confirmLoading={busy}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        {start === undefined ? (
          <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
            <Form.Item name="provider" label="Provider" rules={[{ required: true, message: "Pick a provider." }]}>
              <Select
                showSearch
                optionFilterProp="label"
                loading={providers.isLoading}
                options={groups.map((g) => ({ label: g.label, options: [...g.options] }))}
                placeholder="Search a provider"
                status={providers.isError ? "error" : undefined}
              />
            </Form.Item>
            <Form.Item
              name="name"
              label="Account name"
              extra={`Lower-case letters, digits, dot, dash or underscore. The account will be ${accountPrefix(provider)}/<name>.`}
              rules={[{ validator: (_, v: string | undefined) => { const err = accountNameError(v === undefined || v === "" ? suggested : v); return err === undefined ? Promise.resolve() : Promise.reject(new Error(err)); } }]}
            >
              <Input placeholder={suggested === "" ? "name" : suggested} autoComplete="off" />
            </Form.Item>
            {field.label === undefined ? null : (
              <Form.Item
                name="secret"
                label={field.label}
                extra={field.hint}
                rules={[{ validator: (_, v: string | undefined) => { const err = secretError(v); return err === undefined ? Promise.resolve() : Promise.reject(new Error(err)); } }]}
              >
                <Input.Password autoComplete="off" spellCheck={false} />
              </Form.Item>
            )}
          </Form>
        ) : (
          <LoginProgress start={start} />
        )}
      </Modal>
    </>
  );
}
