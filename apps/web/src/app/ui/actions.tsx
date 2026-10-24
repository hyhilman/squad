// The acts on one account: floors, disable or enable, consent, log in again. The accounts table shows
// them in a "⋯" menu, the account page as buttons; both use this one hook.
import { Button, CloseButton, Dialog, HStack, IconButton, Menu, Portal, Stack, Text } from "@chakra-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import type { AccountView, LoginStart, Runner } from "@squad/contract";
import { CirclePause, CirclePlay, LogIn, MoreHorizontal, ShieldCheck, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { failureText } from "../lib/errors.ts";
import { floorBody } from "../lib/floors.ts";
import { canLogInAgain, isOwnerOf } from "../lib/login.ts";
import { useMe } from "../queries.ts";
import { FloorEditor } from "./FloorEditor.tsx";
import { LoginProgress } from "./LoginProgress.tsx";
import { toastError, toastOk } from "./toaster.tsx";

export interface Action {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly danger?: boolean;
  readonly primary?: boolean;
  readonly run: () => void;
}

const paramsOf = (a: AccountView) => ({ runner: a.runner as Runner, name: a.name });

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

export function useAccountActions(a: AccountView): { actions: Action[]; dialogs: ReactNode } {
  const qc = useQueryClient();
  const me = useMe().data;
  const [dialog, setDialog] = useState<"floors" | "enable" | "login" | undefined>();
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<LoginStart>();
  const disabled = a.health === "disabled";
  const owner = isOwnerOf(a, me);
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

  const actions: Action[] = [
    ...(owner && canLogInAgain(a) ? [{ key: "login", label: "Log in again", icon: LogIn, primary: true, run: () => void startLogin() }] : []),
    { key: "floors", label: "Floors", icon: SlidersHorizontal, run: () => setDialog("floors") },
    ...(owner && a.consentAt === undefined
      ? [{ key: "consent", label: "Give consent", icon: ShieldCheck, run: () => void run("Consent recorded.", () => api("consent", { params: paramsOf(a), body: { agree: true } })) }]
      : []),
    { key: "enable", label: disabled ? "Enable" : "Disable", icon: disabled ? CirclePlay : CirclePause, danger: !disabled, run: () => setDialog("enable") },
  ];

  const dialogs = (
    <>
      <SimpleDialog open={dialog === "floors"} onClose={close} title={`Floors of ${a.account}`}>
        <FloorsForm a={a} onSaved={close} onCancel={close} />
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
    </>
  );
  return { actions, dialogs };
}

/** The "⋯" menu in a table row. */
export function AccountMenu({ a }: { a: AccountView }) {
  const { actions, dialogs } = useAccountActions(a);
  return (
    <>
      <Menu.Root positioning={{ placement: "bottom-end" }}>
        <Menu.Trigger asChild>
          <IconButton variant="ghost" size="xs" aria-label={`Actions for ${a.account}`} color="fg.muted">
            <MoreHorizontal size={16} />
          </IconButton>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content minW="44">
              {actions.map(({ key, label, icon: Icon, danger, run }) => (
                <Menu.Item key={key} value={key} onSelect={run} color={danger === true ? "fg.error" : undefined} _hover={danger === true ? { bg: "bg.error" } : undefined} fontSize="sm">
                  <Icon size={15} />
                  {label}
                </Menu.Item>
              ))}
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
      {dialogs}
    </>
  );
}

/** The same acts as buttons, for the account page header. */
export function AccountButtons({ a }: { a: AccountView }) {
  const { actions, dialogs } = useAccountActions(a);
  return (
    <>
      <HStack gap="2" wrap="wrap">
        {actions.map(({ key, label, icon: Icon, danger, primary, run }) => (
          <Button key={key} size="sm" variant={primary === true ? "solid" : "outline"} colorPalette={primary === true ? "brand" : danger === true ? "red" : "gray"} onClick={run}>
            <Icon size={15} />
            {label}
          </Button>
        ))}
      </HStack>
      {dialogs}
    </>
  );
}
