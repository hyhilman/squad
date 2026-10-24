import { PlusOutlined } from "@ant-design/icons";
import type { LoginStart } from "@squad/contract";
import { App, Button, Form, Input, Modal } from "antd";
import { useState } from "react";
import { api } from "../api.ts";
import { accountNameError } from "../lib/accountName.ts";
import { failureText } from "../lib/errors.ts";
import { LoginProgress } from "./LoginProgress.tsx";

/** Asks for a name, starts a codex device login for a new account, and follows it. */
export function AddAccount() {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState<LoginStart>();
  const [form] = Form.useForm<{ name: string }>();

  const close = () => {
    setOpen(false);
    setStart(undefined);
    form.resetFields();
  };

  const submit = async ({ name }: { name: string }) => {
    setBusy(true);
    try {
      setStart(await api("addAccount", { body: { runner: "codex", name } }));
    } catch (e) {
      void message.error(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
        Add codex account
      </Button>
      <Modal title="Add a codex account" open={open} onCancel={close} footer={start === undefined ? undefined : <Button onClick={close}>Close</Button>} okText="Start login" confirmLoading={busy} onOk={() => form.submit()} destroyOnHidden>
        {start === undefined ? (
          <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
            <Form.Item
              name="name"
              label="Account name"
              extra="Lower-case letters, digits, dot, dash or underscore. The account will be codex/<name>."
              rules={[{ validator: (_, v: string | undefined) => (accountNameError(v ?? "") === undefined ? Promise.resolve() : Promise.reject(new Error(accountNameError(v ?? "")))) }]}
            >
              <Input autoFocus placeholder="alice" autoComplete="off" />
            </Form.Item>
          </Form>
        ) : (
          <LoginProgress start={start} />
        )}
      </Modal>
    </>
  );
}
