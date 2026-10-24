// The account user (which provider account this is) next to its squad owner.
import { Link, Text } from "@chakra-ui/react";
import type { AccountView } from "@squad/contract";
import { accountUser } from "../lib/accountUser.ts";
import { useAccountActions } from "./actions.tsx";

/** `<account user> / <owner>`; a narrow column wraps it only after the slash. An unknown user says why on hover. */
export function AccountUserText({ a, ...rest }: { a: AccountView } & React.ComponentProps<typeof Text>) {
  const u = accountUser(a);
  return (
    <Text whiteSpace="normal" title={u.hint === undefined ? u.text : `${u.text}: ${u.hint}`} {...rest}>
      <Text as="span" whiteSpace="nowrap" color={u.user === undefined ? "fg.subtle" : "fg"} fontStyle={u.user === undefined ? "italic" : undefined}>
        {u.user ?? "unknown"}
      </Text>{" "}
      <Text as="span" whiteSpace="nowrap">
        / {u.owner}
      </Text>
    </Text>
  );
}

/**
 * For an unknown account user: a link that opens the account's Log in again flow, which fills it. Only
 * when the person may log in again (the owner) and a new sign-in can tell the user (codex, claude).
 */
export function FillAccountUser({ a }: { a: AccountView }) {
  const { actions, dialogs } = useAccountActions(a);
  const login = actions.find((x) => x.key === "login");
  if (a.loginEmail !== undefined || !accountUser(a).fillable || login === undefined) return null;
  return (
    <>
      <Link as="button" fontSize="xs" color="brand.fg" fontWeight="500" onClick={login.run}>
        Log in again to fill this
      </Link>
      {dialogs}
    </>
  );
}
