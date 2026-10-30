// The link that fills an unknown account user.
import { Link } from "@chakra-ui/react";
import type { AccountView } from "@squad/contract";
import { accountUser } from "../lib/accountUser.ts";
import { useAccountActions } from "./actions.tsx";

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
