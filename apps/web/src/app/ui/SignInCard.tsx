// Signed out: a card with one Sign in button. Nothing signs in by itself (lib/signin.ts).
// At the top level the button loads the backend's sign-in page. In a frame the identity server
// refuses to be framed, so sign-in opens in a popup; the frame shares the session cookie with it
// (same site), so this page asks /api/me every 2 s, and once it answers it closes the popup and
// reloads.
import { Box, Button, Flex, Link, Stack, Text } from "@chakra-ui/react";
import { LogIn } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import type { SignInPlan } from "../lib/signin.ts";
import { BrandLogo } from "./BrandLogo.tsx";
import { LogoLoader } from "./Loader.tsx";

const POLL_MS = 2000;

const NOTES = {
  "signed-out": "You're signed out.",
  "squad-only": "You're signed out of squad. Your sign-in provider has no sign-out link, so you may still be signed in there.",
  "provider-tab": "You're signed out. Your sign-in provider's sign-out opened in a new tab.",
} as const;

export function SignInCard({ plan, note }: { plan: SignInPlan; note?: keyof typeof NOTES | undefined }) {
  const popup = useRef<Window | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [leaving, setLeaving] = useState<string>();

  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    const timer = setInterval(() => {
      // Closed without signing in: let the person try again.
      if (popup.current?.closed === true) setWaiting(false);
      api("me", {}).then(
        () => {
          if (stop) return;
          popup.current?.close();
          setLeaving("Finishing sign-in…");
          window.location.reload();
        },
        () => {},
      );
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [waiting]);

  const open = () => {
    if (plan.kind === "redirect") {
      setLeaving("Signing in…");
      window.location.assign(plan.url);
      return;
    }
    popup.current = window.open(plan.url, "squad-sign-in", "popup,width=520,height=680");
    setBlocked(popup.current === null);
    setWaiting(true);
  };

  if (leaving !== undefined) return <LogoLoader text={leaving} />;
  return (
    <Flex justify="center" align="center" px="4" py="16" minH={plan.kind === "redirect" ? "80vh" : undefined}>
      <Box w="full" maxW="sm" bg="surface" borderWidth="1px" borderColor="border" rounded="xl" shadow="sm" p="8" textAlign="center">
        <Flex justify="center">
          <BrandLogo size="20" />
        </Flex>
        {note === undefined ? null : (
          <Text mt="4" fontSize="sm" fontWeight="500" color="fg" data-testid="signed-out-note">
            {NOTES[note]}
          </Text>
        )}
        <Text mt={note === undefined ? "4" : "2"} fontSize="lg" fontWeight="600">
          Sign in to squad
        </Text>
        {plan.kind === "popup" ? (
          <Text mt="1" fontSize="sm" color="fg.muted">
            Sign-in opens in a new window. This page reloads when you are done.
          </Text>
        ) : null}
        <Stack mt="6" gap="3" align="center">
          <Button colorPalette="brand" w="full" onClick={open} loading={waiting && !blocked} loadingText="Waiting for sign-in…">
            <LogIn size={16} /> Sign in
          </Button>
          {blocked ? (
            <Text fontSize="sm" color="fg.muted">
              The browser blocked the window.{" "}
              <Link as="button" color="brand.fg" fontWeight="500" onClick={open}>
                Open sign-in
              </Link>
            </Text>
          ) : waiting ? (
            <Link as="button" fontSize="sm" color="fg.muted" onClick={open}>
              Open the sign-in window again
            </Link>
          ) : null}
        </Stack>
      </Box>
    </Flex>
  );
}
