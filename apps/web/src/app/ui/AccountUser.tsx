// The account user (which provider account this is) next to its squad owner.
import { Box, Link, Text } from "@chakra-ui/react";
import type { AccountView } from "@squad/contract";
import { accountUser } from "../lib/accountUser.ts";
import { useAccountActions } from "./actions.tsx";

/** Two lines, like the Account column: the account user on top, the owner small and grey below. An unknown user says why on hover. */
export function AccountUserText({ a }: { a: AccountView }) {
  const u = accountUser(a);
  return (
    <Box minW="0" title={u.hint === undefined ? u.text : `${u.text}: ${u.hint}`}>
      <Text fontSize="sm" truncate fontWeight={u.user === undefined ? undefined : "500"} color={u.user === undefined ? "fg.subtle" : "fg"} fontStyle={u.user === undefined ? "italic" : undefined}>
        {u.user ?? "unknown account user"}
      </Text>
      <Text fontSize="xs" color="fg.muted" truncate>
        {u.owner === "-" ? "no owner" : `owner ${u.owner}`}
      </Text>
    </Box>
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
