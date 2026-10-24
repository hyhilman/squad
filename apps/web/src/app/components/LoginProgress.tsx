// Shows a started device login: the link, the code, and the state. Polls until the state is final.
import { useQueryClient } from "@tanstack/react-query";
import type { LoginStart, LoginStatus } from "@squad/contract";
import { Alert, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { failureText } from "../lib/errors.ts";
import { isFinalLogin, loginStateText, POLL_MS } from "../lib/login.ts";

export function LoginProgress({ start, onFinal }: { start: LoginStart; onFinal?: (s: LoginStatus) => void }) {
  const qc = useQueryClient();
  const [state, setState] = useState<LoginStatus>({ loginId: start.loginId, state: "pending" });
  const [error, setError] = useState<string>();
  const loginId = start.loginId;

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const st = await api("loginStatus", { params: { loginId } });
        if (stop) return;
        setState(st);
        if (isFinalLogin(st.state)) {
          void qc.invalidateQueries();
          onFinal?.(st);
          return;
        }
      } catch (e) {
        if (!stop) setError(failureText(e));
        return;
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    timer = setTimeout(() => void poll(), POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // onFinal is not a dependency: a new function each render must not restart the poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginId, qc]);

  const type = state.state === "done" ? "success" : state.state === "pending" ? "info" : "error";
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph style={{ margin: 0 }}>
        Open <a href={start.verifyUrl} target="_blank" rel="noreferrer">{start.verifyUrl}</a> and enter this code:
      </Typography.Paragraph>
      <Typography.Text copyable code style={{ fontSize: 28, letterSpacing: 2 }}>
        {start.userCode}
      </Typography.Text>
      {error === undefined ? <Alert type={type} showIcon message={loginStateText(state)} /> : <Alert type="error" showIcon message={error} />}
    </Space>
  );
}
