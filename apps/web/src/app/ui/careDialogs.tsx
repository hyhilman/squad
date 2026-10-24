// The dialogs of the account acts that spend, replace or delete something: Test, Use limit reset,
// Log in again (claude), Replace key, Stop sharing and Remove. Each asks first, then shows the
// result in place. A secret lives only in its dialog while it is open.
import { Box, Button, CloseButton, Dialog, Field, HStack, Input, NativeSelect, Portal, RadioCard, SimpleGrid, Spinner, Stack, Text } from "@chakra-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import { LIMIT_RESET_WHICH, type AccountView, type ConnectStart, type LimitResetResult, type LimitResetWhich, type LoginStart, type Runner, type TestResult } from "@squad/contract";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { api } from "../api.ts";
import { confirmMatches, pickTestModel } from "../lib/accountActions.ts";
import { CLAUDE_WAYS, type ClaudeWay } from "../lib/connect.ts";
import { failureText } from "../lib/errors.ts";
import { secretError } from "../lib/providers.ts";
import { useAccountModels } from "../queries.ts";
import { ConnectProgress } from "./ConnectProgress.tsx";
import { LoginProgress } from "./LoginProgress.tsx";
import { toastOk } from "./toaster.tsx";

const paramsOf = (a: AccountView) => ({ runner: a.runner as Runner, name: a.name });

/** A dialog that is open while it is mounted: the parent mounts it to open it, so its state starts fresh. */
export function Shell({ title, onClose, footer, children, size = "md" }: { title: string; onClose: () => void; footer?: ReactNode; children: ReactNode; size?: "sm" | "md" | "lg" }) {
  return (
    <Dialog.Root open onOpenChange={(d) => !d.open && onClose()} size={size} placement="center" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner px="4">
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title fontSize="md">{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>{children}</Dialog.Body>
            {footer === undefined ? null : <Dialog.Footer>{footer}</Dialog.Footer>}
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** One line of result: green, red or amber, with its icon. */
export function ResultLine({ tone, children }: { tone: "success" | "error" | "warning"; children: ReactNode }) {
  const palette = tone === "success" ? "green" : tone === "error" ? "red" : "orange";
  return (
    <HStack align="flex-start" gap="2.5" p="3" rounded="lg" fontSize="sm" bg={`bg.${tone}`} color={`fg.${tone}`} borderWidth="1px" borderColor={`${palette}.muted`} aria-live="polite">
      <Box pt="0.5" flexShrink={0}>
        {tone === "success" ? <CheckCircle2 size={16} /> : tone === "error" ? <XCircle size={16} /> : <AlertTriangle size={16} />}
      </Box>
      <Box minW="0">{children}</Box>
    </HStack>
  );
}

const Warn = ({ children }: { children: ReactNode }) => (
  <Text fontSize="sm" color="fg.muted">
    {children}
  </Text>
);

/** Footer buttons: Cancel (or Close once done) and the act. */
function Footer({ onClose, done, act }: { onClose: () => void; done: boolean; act?: ReactNode }) {
  return (
    <>
      <Button variant="outline" size="sm" onClick={onClose}>
        {done ? "Close" : "Cancel"}
      </Button>
      {done ? null : act}
    </>
  );
}

// ---- Test ----

export function TestDialog({ a, onClose, title }: { a: AccountView; onClose: () => void; title: string }) {
  const qc = useQueryClient();
  const models = useAccountModels(a.runner as Runner, a.name, true);
  const [picked, setPicked] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult>();
  const [error, setError] = useState<string>();
  const model = picked ?? (models.data === undefined ? "" : pickTestModel(models.data));
  const noModel = models.data !== undefined && models.data.models.length === 0 && models.data.defaultModel === undefined;
  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api("testAccount", { params: paramsOf(a), body: model === "" ? {} : { model } }));
      void qc.invalidateQueries();
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };
  const body = (
      <Stack gap="4">
        <Warn>squad runs one tiny real pass on this account, the same as squad probe on the host.</Warn>
        <ResultLine tone="warning">This spends a few tokens.</ResultLine>
        {models.isPending ? (
          <HStack gap="2" color="fg.muted" fontSize="sm">
            <Spinner size="xs" /> <Text>Loading the models…</Text>
          </HStack>
        ) : models.isError ? (
          <ResultLine tone="error">{failureText(models.error)}</ResultLine>
        ) : (
          <Field.Root disabled={result !== undefined || busy}>
            <Field.Label>Model</Field.Label>
            <NativeSelect.Root size="sm">
              <NativeSelect.Field value={model} onChange={(e) => setPicked(e.target.value)} aria-label="Model">
                {models.data.models.length === 0 && models.data.defaultModel !== undefined ? <option value="">{`${models.data.defaultModel} (the default)`}</option> : null}
                {models.data.models.map((m) => (
                  <option key={m} value={m}>
                    {m === models.data.defaultModel ? `${m} (the default)` : m}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
            <Field.HelperText>{noModel ? "This account lists no model and the server has no default test model." : models.data.models.length === 0 ? "This account lists no model: the server's default test model is used." : "The models this account serves."}</Field.HelperText>
          </Field.Root>
        )}
        {error === undefined ? null : <ResultLine tone="error">{error}</ResultLine>}
        {result === undefined ? null : result.ok ? (
          <ResultLine tone="success">
            <Text>
              The test passed on {result.model} in {(result.ms / 1000).toFixed(1)} s.
            </Text>
            {result.left5h === undefined && result.leftWeek === undefined ? null : (
              <Text fontSize="xs" mt="1">
                Room left: {result.left5h === undefined ? "-" : `${result.left5h}%`} (5 hours), {result.leftWeek === undefined ? "-" : `${result.leftWeek}%`} (week).
              </Text>
            )}
          </ResultLine>
        ) : (
          <ResultLine tone="error">
            <Text>
              The test failed: {result.failureKind}
              {result.failureCode === undefined ? "" : ` (${result.failureCode})`}.
            </Text>
            {result.failureKind === "no-account" ? (
              <Text fontSize="xs" mt="1">
                squad did not start the pass: the account is cooling, suspect, busy or not shared. Reset its health or share it first.
              </Text>
            ) : null}
          </ResultLine>
        )}
      </Stack>
    );
  const footer = (
      <Footer
        onClose={onClose}
        done={result !== undefined}
        act={
          <Button size="sm" colorPalette="brand" onClick={() => void run()} loading={busy} disabled={models.isPending || models.isError || noModel}>
            Run the test
          </Button>
        }
      />
    );
  return (
    <Shell title={title} onClose={onClose} footer={footer}>
      {body}
    </Shell>
  );
}

// ---- Use limit reset ----

const WHICH_TEXT: Readonly<Record<LimitResetWhich, { title: string; description: string }>> = {
  "5-hour": { title: "5-hour", description: "Refill the 5-hour session limit." },
  weekly: { title: "Weekly", description: "Refill the weekly limit." },
  full: { title: "Full", description: "Refill both limits." },
  fable: { title: "Fable", description: "Free up what Fable used this week." },
};

export function LimitDialog({ a, onClose, title }: { a: AccountView; onClose: () => void; title: string }) {
  const qc = useQueryClient();
  const [which, setWhich] = useState<LimitResetWhich>("5-hour");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LimitResetResult>();
  const [error, setError] = useState<string>();
  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api("limitReset", { params: { name: a.name }, body: { which } }));
      void qc.invalidateQueries();
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };
  const body = (
      <Stack gap="4">
        <RadioCard.Root value={which} onValueChange={(d) => setWhich(d.value as LimitResetWhich)} size="sm" colorPalette="brand" disabled={busy || result !== undefined}>
          <RadioCard.Label>Which limit</RadioCard.Label>
          <SimpleGrid columns={{ base: 1, sm: 2 }} gap="2">
            {LIMIT_RESET_WHICH.map((w) => (
              <RadioCard.Item key={w} value={w}>
                <RadioCard.ItemHiddenInput />
                <RadioCard.ItemControl>
                  <RadioCard.ItemContent>
                    <RadioCard.ItemText>{WHICH_TEXT[w].title}</RadioCard.ItemText>
                    <RadioCard.ItemDescription>{WHICH_TEXT[w].description}</RadioCard.ItemDescription>
                  </RadioCard.ItemContent>
                  <RadioCard.ItemIndicator />
                </RadioCard.ItemControl>
              </RadioCard.Item>
            ))}
          </SimpleGrid>
        </RadioCard.Root>
        <ResultLine tone="warning">This spends one of your limit resets. squad runs the real Claude Code and types /limit-reset for you. A login without the newer kinds of reset resets the 5-hour limit, whatever you pick.</ResultLine>
        {busy ? (
          <HStack gap="2" color="fg.muted" fontSize="sm">
            <Spinner size="xs" /> <Text>Claude Code is working. This can take up to a minute…</Text>
          </HStack>
        ) : null}
        {error === undefined ? null : <ResultLine tone="error">{error}</ResultLine>}
        {result === undefined ? null : <ResultLine tone={result.outcome === "done" ? "success" : result.outcome === "unknown" ? "warning" : "error"}>{result.message}</ResultLine>}
      </Stack>
    );
  const footer = (
      <Footer
        onClose={onClose}
        done={result !== undefined}
        act={
          <Button size="sm" colorPalette="brand" onClick={() => void run()} loading={busy}>
            Use one reset
          </Button>
        }
      />
    );
  return (
    <Shell title={title} onClose={onClose} footer={footer}>
      {body}
    </Shell>
  );
}

// ---- Log in again: claude ----

export function ClaudeLoginDialog({ a, onClose, title }: { a: AccountView; onClose: () => void; title: string }) {
  const qc = useQueryClient();
  const [way, setWay] = useState<ClaudeWay>("signin");
  const [token, setToken] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [start, setStart] = useState<LoginStart>();
  const [connect, setConnect] = useState<ConnectStart>();
  const [done, setDone] = useState(false);
  const tokenErr = way === "token" ? secretError(token) : undefined;
  const go = async () => {
    setTouched(true);
    if (tokenErr !== undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      if (way === "signin") setStart(await api("startLogin", { params: paramsOf(a) }));
      else if (way === "computer") setConnect(await api("startConnect", { body: { runner: "claude", name: a.name, replace: true } }));
      else {
        await api("replaceSecret", { params: paramsOf(a), body: { secret: token } });
        setToken("");
        setTouched(false);
        setDone(true);
        await qc.invalidateQueries();
        toastOk(`New token saved for ${a.account}.`);
      }
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };
  const started = start !== undefined || connect !== undefined;
  const body = (
      <Stack gap="4">
        {start !== undefined ? (
          <LoginProgress start={start} />
        ) : connect !== undefined ? (
          <ConnectProgress start={connect} />
        ) : (
          <>
            <Warn>The new token replaces the one squad holds now. When it works, the health is reset.</Warn>
            <RadioCard.Root value={way} onValueChange={(d) => setWay(d.value as ClaudeWay)} size="sm" colorPalette="brand">
              <RadioCard.Label>How to get the token</RadioCard.Label>
              <SimpleGrid columns={{ base: 1, md: 3 }} gap="2">
                {CLAUDE_WAYS.map((w) => (
                  <RadioCard.Item key={w.value} value={w.value}>
                    <RadioCard.ItemHiddenInput />
                    <RadioCard.ItemControl>
                      <RadioCard.ItemContent>
                        <RadioCard.ItemText>{w.title}</RadioCard.ItemText>
                        <RadioCard.ItemDescription>{w.description}</RadioCard.ItemDescription>
                      </RadioCard.ItemContent>
                      <RadioCard.ItemIndicator />
                    </RadioCard.ItemControl>
                  </RadioCard.Item>
                ))}
              </SimpleGrid>
            </RadioCard.Root>
            {way === "token" ? (
              <Field.Root invalid={touched && tokenErr !== undefined}>
                <Field.Label>Token</Field.Label>
                <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} fontFamily="mono" />
                {touched && tokenErr !== undefined ? <Field.ErrorText>{tokenErr}</Field.ErrorText> : <Field.HelperText>The output of claude setup-token.</Field.HelperText>}
              </Field.Root>
            ) : null}
            {done ? <ResultLine tone="success">New token saved. The account is ready.</ResultLine> : null}
          </>
        )}
        {error === undefined ? null : <ResultLine tone="error">{error}</ResultLine>}
      </Stack>
    );
  const footer = (
      <Footer
        onClose={onClose}
        done={started || done}
        act={
          <Button size="sm" colorPalette="brand" onClick={() => void go()} loading={busy}>
            {way === "signin" ? "Start sign-in" : way === "computer" ? "Get the command" : "Save token"}
          </Button>
        }
      />
    );
  return (
    <Shell title={title} onClose={onClose} footer={footer}>
      {body}
    </Shell>
  );
}

// ---- Replace key: pi ----

export function KeyDialog({ a, onClose, title }: { a: AccountView; onClose: () => void; title: string }) {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const [provider, setProvider] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const keyErr = secretError(key);
  const save = async () => {
    setTouched(true);
    if (keyErr !== undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await api("replaceSecret", { params: paramsOf(a), body: { secret: key, ...(provider.trim() === "" ? {} : { provider: provider.trim() }) } });
      setKey("");
      setTouched(false);
      setDone(true);
      await qc.invalidateQueries();
      toastOk(`New key saved for ${a.account}.`);
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };
  const body = (
      <Stack gap="4">
        <Warn>The new key replaces the one squad holds now. Keys for other providers in this account stay. When it is saved, the health is reset.</Warn>
        <Field.Root invalid={touched && keyErr !== undefined} disabled={done}>
          <Field.Label>New API key</Field.Label>
          <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} fontFamily="mono" />
          {touched && keyErr !== undefined ? <Field.ErrorText>{keyErr}</Field.ErrorText> : <Field.HelperText>Checked for shape only, never shown again.</Field.HelperText>}
        </Field.Root>
        <Field.Root disabled={done}>
          <Field.Label>Provider (only if the account has keys for several)</Field.Label>
          <Input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="opencode-go" autoComplete="off" spellCheck={false} size="sm" />
        </Field.Root>
        {error === undefined ? null : <ResultLine tone="error">{error}</ResultLine>}
        {done ? <ResultLine tone="success">New key saved. The account is ready.</ResultLine> : null}
      </Stack>
    );
  const footer = (
      <Footer
        onClose={onClose}
        done={done}
        act={
          <Button size="sm" colorPalette="brand" onClick={() => void save()} loading={busy}>
            Save key
          </Button>
        }
      />
    );
  return (
    <Shell title={title} onClose={onClose} footer={footer}>
      {body}
    </Shell>
  );
}

// ---- Remove ----

export function RemoveDialog({ a, onClose, title }: { a: AccountView; onClose: () => void; title: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [revoke, setRevoke] = useState<string>();
  const ok = confirmMatches(typed, a.account);
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api("removeAccount", { params: paramsOf(a), body: { confirm: typed.trim() } });
      setRevoke(r.revoke);
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    onClose();
    if (revoke !== undefined) {
      void qc.invalidateQueries();
      void navigate("/accounts");
    }
  };
  const body =
      revoke !== undefined ? (
        <Stack gap="3">
          <ResultLine tone="success">Removed {a.account}. Its pass history stays.</ResultLine>
          <Text fontSize="sm">{revoke}</Text>
        </Stack>
      ) : (
        <Stack gap="4">
          <Warn>squad deletes the account folder and stops using it. The pass history, usage and costs stay. The name can be used again later. While a pass holds the account, squad refuses: try again when it ends.</Warn>
          <Field.Root>
            <Field.Label>
              Type <Text as="span" fontFamily="mono" fontWeight="600">{a.account}</Text> to confirm
            </Field.Label>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} fontFamily="mono" aria-label="Account id to confirm" />
          </Field.Root>
          {error === undefined ? null : <ResultLine tone="error">{error}</ResultLine>}
        </Stack>
      );
  const footer = (
      <Footer
        onClose={close}
        done={revoke !== undefined}
        act={
          <Button size="sm" colorPalette="red" onClick={() => void remove()} loading={busy} disabled={!ok}>
            Remove account
          </Button>
        }
      />
    );
  return (
    <Shell title={title} onClose={onClose} footer={footer}>
      {body}
    </Shell>
  );
}
