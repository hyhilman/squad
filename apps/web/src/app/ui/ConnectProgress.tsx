// A started "use my computer" sign-in: the command to run on the person's own computer, then the state
// until the helper has sent the token. The page never sees the token.
import { Box, Code, HStack, Stack, Text } from "@chakra-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConnectStart, ConnectStatus } from "@squad/contract";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { connectStateText, isFinalConnect } from "../lib/connect.ts";
import { failureText } from "../lib/errors.ts";
import { POLL_MS } from "../lib/login.ts";
import { LoginStatusLine, Step } from "./LoginProgress.tsx";
import { CopyButton } from "./parts.tsx";

function CommandBox({ command, label }: { command: string; label: string }) {
  return (
    <HStack gap="2" align="flex-start" minW="0">
      <Code flex="1" minW="0" display="block" px="3" py="2" rounded="md" variant="surface" fontFamily="mono" fontSize="xs" whiteSpace="pre-wrap" wordBreak="break-all">
        {command}
      </Code>
      <CopyButton value={command} label={label} />
    </HStack>
  );
}

export function ConnectProgress({ start, onFinal }: { start: ConnectStart; onFinal?: (s: ConnectStatus) => void }) {
  const qc = useQueryClient();
  const [state, setState] = useState<ConnectStatus>({ connectId: start.connectId, state: "pending" });
  const [error, setError] = useState<string>();
  const connectId = start.connectId;

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const st = await api("connectStatus", { params: { connectId } });
        if (stop) return;
        setState(st);
        if (isFinalConnect(st.state)) {
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
  }, [connectId, qc]);

  return (
    <Stack gap="5">
      <Step n={1} title="Run this in a terminal on your computer">
        <Text fontSize="sm" color="fg.muted">
          It needs Node.js 22.18 or newer and Claude Code. Your browser opens; sign in with Claude there. The command works once, for 10 minutes.
        </Text>
        <CommandBox command={start.command} label="Copy the command" />
        <Text fontSize="xs" color="fg.muted">
          If squad is installed on your computer, this shorter command does the same:
        </Text>
        <CommandBox command={start.shortCommand} label="Copy the short command" />
      </Step>
      <Step n={2} title="Wait here">
        <Box>
          <LoginStatusLine state={state} {...(error === undefined ? {} : { error })} text={connectStateText(state)} />
        </Box>
      </Step>
    </Stack>
  );
}
