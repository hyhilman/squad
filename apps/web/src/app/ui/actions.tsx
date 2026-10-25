// The acts on one account (lib/accountActions.ts says which a person may take). The accounts table
// shows them in a "⋯" menu; the account page shows the urgent ones and Test as buttons, the rest in a
// "⋯" menu. Both use this one hook.
import { Box, Button, CloseButton, Dialog, Field, HStack, IconButton, Input, InputGroup, Menu, Portal, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import type { AccountView, LoginStart, Runner } from "@squad/contract";
import { CirclePause, CirclePlay, FlaskConical, KeyRound, LogIn, MoreHorizontal, RotateCcw, ShieldCheck, ShieldOff, SlidersHorizontal, TimerReset, Trash2, type LucideIcon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { failureText } from "../lib/errors.ts";
import { floorBody } from "../lib/floors.ts";
import { BALANCE_HELP, CAP_HINT, balanceLine, capInput, capsBody, parseBalance, usdText } from "../lib/keyUse.ts";
import { accountActions, splitActions, type ActionKey } from "../lib/accountActions.ts";
import { useMe } from "../queries.ts";
import { FloorEditor } from "./FloorEditor.tsx";
import { Hint } from "./parts.tsx";
import { LoginProgress } from "./LoginProgress.tsx";
import { ClaudeLoginDialog, KeyDialog, LimitDialog, RemoveDialog, Shell, TestDialog } from "./careDialogs.tsx";
import { toastError, toastOk } from "./toaster.tsx";

export interface Action {
  readonly key: ActionKey;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly danger?: boolean;
  readonly primary?: boolean;
  readonly run: () => void;
}

const paramsOf = (a: AccountView) => ({ runner: a.runner as Runner, name: a.name });

/**
 * The caps form of a key account: dollars per window, empty = no cap. A key has no window from its
 * provider, so it has no floor that could act: the caps take the floors' place. Under the caps, the
 * balance the owner reads in the provider's console; saving a changed one stamps a new time.
 */
export function CapsForm({ a, onSaved, onCancel }: { a: AccountView; onSaved?: () => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const start = [capInput(a.cap5h), capInput(a.capWeek), capInput(a.cap30d)] as const;
  const [c5, setC5] = useState<string>(start[0]);
  const [cw, setCw] = useState<string>(start[1]);
  const balanceStart = capInput(a.balanceUsd);
  const [bal, setBal] = useState<string>(balanceStart);
  const [busy, setBusy] = useState(false);
  const capsDirty = c5 !== start[0] || cw !== start[1];
  const balanceDirty = bal.trim() !== balanceStart;
  const now = balanceLine(a);
  const save = async () => {
    // The page sets no 30-day cap; one set through the API or the CLI stays as it is.
    const b = capsBody(c5, cw, start[2]);
    const nb = parseBalance(bal);
    // Check both first, so a bad balance never leaves the caps half saved.
    const errors = [...(b.ok ? [] : b.errors), ...(nb.ok ? [] : [`Balance: ${nb.error}`])];
    if (!b.ok || !nb.ok) return void toastError(errors.join(" "));
    setBusy(true);
    try {
      if (capsDirty) await api("setCaps", { params: paramsOf(a), body: b.body });
      // Only a changed box sends the balance: sending it stamps a new time.
      if (balanceDirty) await api("setBalance", { params: paramsOf(a), body: { balance: nb.value } });
      await qc.invalidateQueries();
      toastOk("Saved.");
      onSaved?.();
    } catch (e) {
      toastError(failureText(e));
    } finally {
      setBusy(false);
    }
  };
  const rows = [
    { label: "5-hour cap", value: c5, set: setC5, used: a.used5h, span: "last 5 hours" },
    { label: "7-day cap", value: cw, set: setCw, used: a.usedWeek, span: "last 7 days" },
  ];
  return (
    <Stack gap="5">
      <Box>
        <Hint text={CAP_HINT}>
          <Text fontSize="sm" fontWeight="600" w="fit-content" cursor="help" textDecoration="underline dotted" textUnderlineOffset="3px">
            Caps (dollars)
          </Text>
        </Hint>
        <Text mt="1" fontSize="sm" color="fg.muted">
          {CAP_HINT} Leave a box empty for no cap.
        </Text>
      </Box>
      <SimpleGrid columns={{ base: 1, sm: 2 }} gap="4">
        {rows.map((r) => (
          <Field.Root key={r.label}>
            <Field.Label fontSize="sm">{r.label}</Field.Label>
            <InputGroup startElement="$">
              <Input size="sm" inputMode="decimal" placeholder="∞ (no cap)" value={r.value} onChange={(e) => r.set(e.target.value)} aria-label={`${r.label} in dollars`} fontVariantNumeric="tabular-nums" />
            </InputGroup>
            <Field.HelperText fontSize="xs" fontVariantNumeric="tabular-nums">
              {usdText(r.used ?? 0)} used in the {r.span}
            </Field.HelperText>
          </Field.Root>
        ))}
      </SimpleGrid>
      <Field.Root>
        <Field.Label fontSize="sm">Balance now</Field.Label>
        <InputGroup startElement="$" maxW={{ base: "full", sm: "calc(50% - 0.5rem)" }}>
          <Input size="sm" inputMode="decimal" placeholder="No balance" value={bal} onChange={(e) => setBal(e.target.value)} aria-label="Balance now in dollars" fontVariantNumeric="tabular-nums" />
        </InputGroup>
        <Field.HelperText fontSize="xs">{BALANCE_HELP}</Field.HelperText>
        {now === undefined ? null : (
          <Field.HelperText fontSize="xs" fontVariantNumeric="tabular-nums">
            {now.text}. {now.hint}
          </Field.HelperText>
        )}
      </Field.Root>
      <HStack justify="flex-end" gap="2">
        {onCancel === undefined ? null : (
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button colorPalette="brand" size="sm" onClick={() => void save()} loading={busy} disabled={!capsDirty && !balanceDirty}>
          Save
        </Button>
      </HStack>
    </Stack>
  );
}

/** The floors form: one editor per window and a Save button. */
export function FloorsForm({ a, onSaved, onCancel }: { a: AccountView; onSaved?: () => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const own = a.floorSource === "owner";
  const [f5, setF5] = useState(own ? String(a.floor5h) : "");
  const [fw, setFw] = useState(own ? String(a.floorWeek) : "");
  const [busy, setBusy] = useState(false);
  const dirty = f5 !== (own ? String(a.floor5h) : "") || fw !== (own ? String(a.floorWeek) : "");
  const save = async () => {
    const b = floorBody(f5, fw);
    if (!b.ok) return void toastError(b.errors.join(" "));
    setBusy(true);
    try {
      await api("setFloor", { params: paramsOf(a), body: b.body });
      await qc.invalidateQueries();
      toastOk("Floors saved.");
      onSaved?.();
    } catch (e) {
      toastError(failureText(e));
    } finally {
      setBusy(false);
    }
  };
  const hint = own ? "" : ` The default now is ${a.floor5h}% and ${a.floorWeek}%.`;
  return (
    <Stack gap="6">
      <Text fontSize="sm" color="fg.muted">
        The share of each window kept free for the owner. A pass only takes the room above the floor.{hint}
      </Text>
      <FloorEditor label="5-hour floor" help="Kept free in the 5-hour window." value={f5} onChange={setF5} fallback={a.floor5h} />
      <FloorEditor label="Week floor" help="Kept free in the week window." value={fw} onChange={setFw} fallback={a.floorWeek} />
      <HStack justify="flex-end" gap="2">
        {onCancel === undefined ? null : (
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button colorPalette="brand" size="sm" onClick={() => void save()} loading={busy} disabled={!dirty}>
          Save floors
        </Button>
      </HStack>
    </Stack>
  );
}

function SimpleDialog({ open, onClose, title, children, footer, size = "md" }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg" }) {
  return (
    <Dialog.Root open={open} onOpenChange={(d) => !d.open && onClose()} size={size} placement="center" lazyMount unmountOnExit>
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

type DialogKey = "floors" | "enable" | "login" | "claude" | "key" | "test" | "limit" | "remove" | "unshare";

export function useAccountActions(a: AccountView): { actions: Action[]; dialogs: ReactNode } {
  const qc = useQueryClient();
  const me = useMe().data;
  const [dialog, setDialog] = useState<DialogKey | undefined>();
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<LoginStart>();
  const disabled = a.health === "disabled";
  const close = () => setDialog(undefined);

  const run = async (ok: string, act: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await act();
      await qc.invalidateQueries();
      toastOk(ok);
      close();
    } catch (e) {
      toastError(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  const startLogin = async () => {
    try {
      setStarted(await api("startLogin", { params: paramsOf(a) }));
      setDialog("login");
    } catch (e) {
      toastError(failureText(e));
    }
  };

  const ALL: Readonly<Record<ActionKey, Omit<Action, "key">>> = {
    share: { label: "Share again", icon: ShieldCheck, primary: true, run: () => void run("Sharing again: squad may run passes on it.", () => api("consent", { params: paramsOf(a), body: { agree: true } })) },
    unshare: { label: "Stop sharing", icon: ShieldOff, run: () => setDialog("unshare") },
    login: { label: "Log in again", icon: LogIn, primary: a.health === "dead", run: () => (a.runner === "claude" ? setDialog("claude") : void startLogin()) },
    key: { label: "Replace key", icon: KeyRound, run: () => setDialog("key") },
    test: { label: "Test", icon: FlaskConical, run: () => setDialog("test") },
    reset: { label: "Reset health", icon: RotateCcw, run: () => void run("Health reset.", () => api("resetHealth", { params: paramsOf(a) })) },
    limit: { label: "Use limit reset", icon: TimerReset, run: () => setDialog("limit") },
    floors: { label: a.kind === "key" ? "Caps & balance" : "Floors", icon: SlidersHorizontal, run: () => setDialog("floors") },
    enable: { label: disabled ? "Enable" : "Disable", icon: disabled ? CirclePlay : CirclePause, danger: !disabled, run: () => setDialog("enable") },
    remove: { label: "Remove", icon: Trash2, danger: true, run: () => setDialog("remove") },
  };
  const actions: Action[] = accountActions(a, me).map((key) => ({ key, ...ALL[key] }));

  const dialogs = (
    <>
      <SimpleDialog open={dialog === "floors"} onClose={close} title={a.kind === "key" ? `Caps and balance of ${a.account}` : `Floors of ${a.account}`}>
        {a.kind === "key" ? <CapsForm a={a} onSaved={close} onCancel={close} /> : <FloorsForm a={a} onSaved={close} onCancel={close} />}
      </SimpleDialog>
      <SimpleDialog
        open={dialog === "enable"}
        onClose={close}
        size="sm"
        title={disabled ? `Enable ${a.account}?` : `Disable ${a.account}?`}
        footer={
          <>
            <Button variant="outline" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button
              size="sm"
              colorPalette={disabled ? "brand" : "red"}
              loading={busy}
              onClick={() => void run(disabled ? "Account enabled." : "Account disabled.", () => api("setEnabled", { params: paramsOf(a), body: { enabled: disabled } }))}
            >
              {disabled ? "Enable" : "Disable"}
            </Button>
          </>
        }
      >
        <Text fontSize="sm" color="fg.muted">
          {disabled ? "Passes may use this account again." : "No pass will use this account until you enable it again. A pass that runs now goes on to its end."}
        </Text>
      </SimpleDialog>
      <SimpleDialog open={dialog === "login"} onClose={close} title={`Log in again: ${a.account}`} size="lg">
        {started === undefined ? null : <LoginProgress start={started} />}
      </SimpleDialog>
      {dialog === "unshare" ? (
        <Shell
          title={`Stop sharing ${a.account}?`}
          onClose={close}
          size="sm"
          footer={
            <>
              <Button variant="outline" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button size="sm" colorPalette="red" loading={busy} onClick={() => void run("Stopped sharing: squad refuses every pass on it.", () => api("consent", { params: paramsOf(a), body: { agree: false } }))}>
                Stop sharing
              </Button>
            </>
          }
        >
          <Text fontSize="sm" color="fg.muted">
            squad will refuse every pass on this account until you share it again. A pass that runs now goes on to its end.
          </Text>
        </Shell>
      ) : null}
      {dialog === "test" ? <TestDialog a={a} onClose={close} title={`Test ${a.account}`} /> : null}
      {dialog === "limit" ? <LimitDialog a={a} onClose={close} title={`Use a limit reset: ${a.account}`} /> : null}
      {dialog === "claude" ? <ClaudeLoginDialog a={a} onClose={close} title={`Log in again: ${a.account}`} /> : null}
      {dialog === "key" ? <KeyDialog a={a} onClose={close} title={`Replace key: ${a.account}`} /> : null}
      {dialog === "remove" ? <RemoveDialog a={a} onClose={close} title={`Remove ${a.account}?`} /> : null}
    </>
  );
  return { actions, dialogs };
}

function MenuItems({ actions }: { actions: readonly Action[] }) {
  return (
    <>
      {actions.map(({ key, label, icon: Icon, danger, run }, i) => (
        <Fragment key={key}>
          {key === "remove" && i > 0 ? <Menu.Separator /> : null}
          <Menu.Item value={key} onSelect={run} color={danger === true ? "fg.error" : undefined} _hover={danger === true ? { bg: "bg.error" } : undefined} fontSize="sm">
            <Icon size={15} />
            {label}
          </Menu.Item>
        </Fragment>
      ))}
    </>
  );
}

function MoreMenu({ a, actions, size = "xs", variant = "ghost" }: { a: AccountView; actions: readonly Action[]; size?: "xs" | "sm"; variant?: "ghost" | "outline" }) {
  if (actions.length === 0) return null;
  return (
    <Menu.Root positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger asChild>
        <IconButton variant={variant} size={size} aria-label={`Actions for ${a.account}`} color="fg.muted">
          <MoreHorizontal size={16} />
        </IconButton>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="48">
            <MenuItems actions={actions} />
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

/** The "⋯" menu in a table row: every act. */
export function AccountMenu({ a }: { a: AccountView }) {
  const { actions, dialogs } = useAccountActions(a);
  return (
    <>
      <MoreMenu a={a} actions={actions} />
      {dialogs}
    </>
  );
}

/** The account page header: the urgent acts and Test as buttons, the rest in a "⋯" menu. */
export function AccountButtons({ a }: { a: AccountView }) {
  const { actions, dialogs } = useAccountActions(a);
  const split = splitActions(actions.map((x) => x.key), a);
  const primary = actions.filter((x) => split.primary.includes(x.key));
  const menu = actions.filter((x) => split.menu.includes(x.key));
  return (
    <>
      <HStack gap="2" wrap="wrap">
        {primary.map(({ key, label, icon: Icon, danger, primary: solid, run }) => (
          <Button key={key} size="sm" variant={solid === true ? "solid" : "outline"} colorPalette={solid === true ? "brand" : danger === true ? "red" : "gray"} onClick={run}>
            <Icon size={15} />
            {label}
          </Button>
        ))}
        <MoreMenu a={a} actions={menu} size="sm" variant="outline" />
      </HStack>
      {dialogs}
    </>
  );
}
