// The squad owner of an account, and the link that fills an unknown account user.
import { Link, Text } from "@chakra-ui/react";
import type { AccountView } from "@squad/contract";
import { accountUser } from "../lib/accountUser.ts";
import { useAccountActions } from "./actions.tsx";

/** The squad owner, for the Owner column. The account page also shows the account user. */
export function OwnerText({ a }: { a: AccountView }) {
  const owner = accountUser(a).owner;
  return (
    <Text fontSize="sm" truncate title={owner} color={owner === "-" ? "fg.subtle" : "fg"} fontStyle={owner === "-" ? "italic" : undefined}>
      {owner === "-" ? "no owner" : owner}
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
