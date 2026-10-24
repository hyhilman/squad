// A started login: the link, then the code to type (codex device login) or a box for the code the
// sign-in page shows (claude setup-token). Polls the state until it is final.
import { Box, Button, Code, Flex, HStack, Input, Spinner, Stack, Text } from "@chakra-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import type { LoginStart, LoginStatus } from "@squad/contract";
import { CheckCircle2, ExternalLink, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { failureText } from "../lib/errors.ts";
import { isFinalLogin, loginStateText, POLL_MS } from "../lib/login.ts";
import { CopyButton } from "./parts.tsx";

function StepNumber({ n }: { n: number }) {
  return (
    <Flex boxSize="6" rounded="full" bg="bg.muted" color="fg.muted" fontSize="xs" fontWeight="600" align="center" justify="center" flexShrink={0}>
      {n}
    </Flex>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <HStack align="flex-start" gap="3">
      <StepNumber n={n} />
      <Stack gap="2" flex="1" minW="0" pt="0.5">
        <Text fontSize="sm" fontWeight="500">
          {title}
        </Text>
        {children}
      </Stack>
    </HStack>
  );
}

function LinkRow({ url }: { url: string }) {
  return (
    <HStack gap="2" minW="0">
      <Flex flex="1" minW="0" h="9" px="3" align="center" rounded="md" bg="bg.subtle" borderWidth="1px" borderColor="border" fontSize="sm" fontFamily="mono">
        <Text truncate>{url}</Text>
      </Flex>
      <CopyButton value={url} label="Copy the link" />
      <Button asChild size="sm" colorPalette="brand">
        <a href={url} target="_blank" rel="noreferrer">
          Open <ExternalLink size={14} />
        </a>
      </Button>
    </HStack>
  );
}

export function LoginStatusLine({ state, error, pendingText }: { state: LoginStatus; error?: string; pendingText?: string }) {
  const tone = error !== undefined || state.state === "failed" || state.state === "expired" ? "error" : state.state === "done" ? "success" : "info";
  return (
    <HStack
      gap="2.5"
      p="3"
      rounded="lg"
      fontSize="sm"
      bg={tone === "error" ? "bg.error" : tone === "success" ? "bg.success" : "bg.subtle"}
      color={tone === "error" ? "fg.error" : tone === "success" ? "fg.success" : "fg.muted"}
      borderWidth="1px"
      borderColor={tone === "error" ? "red.muted" : tone === "success" ? "green.muted" : "border"}
      aria-live="polite"
    >
      {tone === "info" ? <Spinner size="xs" /> : tone === "success" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
      <Text>{error ?? (state.state === "pending" && pendingText !== undefined ? pendingText : loginStateText(state))}</Text>
    </HStack>
  );
}

export function LoginProgress({ start, onFinal }: { start: LoginStart; onFinal?: (s: LoginStatus) => void }) {
  const qc = useQueryClient();
  const [state, setState] = useState<LoginStatus>({ loginId: start.loginId, state: "pending" });
  const [error, setError] = useState<string>();
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
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

  // The server takes the code once; the box locks after the first send.
  const sendCode = async () => {
    setSending(true);
    try {
      setState(await api("submitLoginCode", { params: { loginId }, body: { code: code.trim() } }));
      setSent(true);
    } catch (e) {
      setError(failureText(e));
      setSent(true);
    } finally {
      setSending(false);
    }
  };

  const final = isFinalLogin(state.state);
  return (
    <Stack gap="5">
      <Step n={1} title={start.needsCode === true ? "Open the sign-in page and sign in with Claude" : "Open the login page"}>
        <LinkRow url={start.verifyUrl} />
      </Step>
      {start.needsCode === true ? (
        <Step n={2} title="Paste the code the page shows you">
          <HStack gap="2">
            <Input
              size="sm"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste the code"
              fontFamily="mono"
              autoComplete="off"
              spellCheck={false}
              disabled={sent || final}
            />
            <Button size="sm" colorPalette="brand" onClick={() => void sendCode()} loading={sending} disabled={sent || final || code.trim() === ""}>
              Send code
            </Button>
          </HStack>
        </Step>
      ) : (
        <Step n={2} title="Enter this code on that page">
          <HStack gap="3">
            <Code fontSize="2xl" fontWeight="600" letterSpacing="0.12em" px="4" py="2" rounded="lg" variant="surface" fontFamily="mono">
              {start.userCode}
            </Code>
            <CopyButton value={start.userCode ?? ""} label="Copy the code" />
          </HStack>
        </Step>
      )}
      <Box>
        <LoginStatusLine state={state} {...(error === undefined ? {} : { error })} {...(sent ? { pendingText: "Code sent. Finishing the sign-in…" } : {})} />
      </Box>
    </Stack>
  );
}
