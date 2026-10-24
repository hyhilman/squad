// Signed out inside a frame. The identity server refuses to be framed, so sign-in opens in a popup.
// The frame shares the session cookie with it (same site), so this page asks /api/me every 2 s, and
// once it answers it closes the popup and reloads.
import { Box, Button, Flex, Link, Stack, Text } from "@chakra-ui/react";
import { Boxes, LogIn } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { LogoLoader } from "./Loader.tsx";

const POLL_MS = 2000;

export function SignInCard({ url }: { url: string }) {
  const popup = useRef<Window | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [done, setDone] = useState(false);

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
          setDone(true);
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
    popup.current = window.open(url, "squad-sign-in", "popup,width=520,height=680");
    setBlocked(popup.current === null);
    setWaiting(true);
  };

  if (done) return <LogoLoader text="Finishing sign-in…" />;
  return (
    <Flex justify="center" px="4" py="16">
      <Box w="full" maxW="sm" bg="surface" borderWidth="1px" borderColor="border" rounded="xl" shadow="sm" p="8" textAlign="center">
        <Flex boxSize="10" mx="auto" rounded="xl" bg="brand.solid" color="white" align="center" justify="center">
          <Boxes size={20} />
        </Flex>
        <Text mt="4" fontSize="lg" fontWeight="600">
          Sign in to squad
        </Text>
        <Text mt="1" fontSize="sm" color="fg.muted">
          Sign-in opens in a new window. This page reloads when you are done.
        </Text>
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
