// The frame around every page: a top bar and a centred container. Nothing depends on the viewport
// height, so the app also works inside an iframe of another page.
import { Badge, Box, Button, Flex, HStack, IconButton, Menu, Portal, Stack, Text } from "@chakra-ui/react";
import { AUTH_PATHS, SIGNED_OUT_PATH, SIGNED_OUT_PROVIDER_TAB, type LogoutEverywhere, type Me } from "@squad/contract";
import { BarChart3, BookOpen, Check, ChevronDown, History, LayoutDashboard, LogOut, Menu as MenuIcon, Monitor, Moon, Sun, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router";
import { inFrame } from "../lib/embed.ts";
import { BrandLogo } from "./BrandLogo.tsx";
import { useColorMode, type ThemeChoice } from "./colorMode.ts";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/accounts", label: "Accounts", icon: Users, end: false },
  { to: "/passes", label: "Passes", icon: History, end: false },
  { to: "/usage", label: "Usage", icon: BarChart3, end: false },
  { to: "/catalog", label: "Catalog", icon: BookOpen, end: false },
] as const;

// In a frame the parent page owns who is signed in and the look: the bar shows the nav only.
const FRAMED = typeof window !== "undefined" && inFrame(window);

/** The one width every page and the bar line up to. */
export function Container({ children, ...rest }: { children: ReactNode } & React.ComponentProps<typeof Box>) {
  return (
    <Box maxW="1200px" mx="auto" px={{ base: "4", md: "6" }} {...rest}>
      {children}
    </Box>
  );
}

function Wordmark() {
  return (
    <HStack gap="2" asChild>
      <NavLink to="/" aria-label="squad home">
        <BrandLogo size={8} />
        <Text fontSize="md" fontWeight="650" letterSpacing="-0.02em">
          squad
        </Text>
      </NavLink>
    </HStack>
  );
}

function NavItems() {
  return (
    <HStack as="nav" gap="1" aria-label="Main">
      {NAV.map(({ to, label, end }) => (
        <NavLink key={to} to={to} end={end}>
          {({ isActive }) => (
            <Box
              px="3"
              py="1.5"
              rounded="md"
              fontSize="sm"
              fontWeight="500"
              color={isActive ? "fg" : "fg.muted"}
              bg={isActive ? "bg.muted" : "transparent"}
              _hover={{ color: "fg", bg: "bg.muted" }}
              transition="background 0.12s, color 0.12s"
            >
              {label}
            </Box>
          )}
        </NavLink>
      ))}
    </HStack>
  );
}

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function ThemeMenu() {
  const { choice, mode, setChoice } = useColorMode();
  const Icon = mode === "dark" ? Moon : Sun;
  return (
    <Menu.Root positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger asChild>
        <IconButton variant="ghost" size="sm" aria-label="Theme" color="fg.muted">
          <Icon size={16} />
        </IconButton>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="36">
            {THEMES.map(({ value, label, icon: I }) => (
              <Menu.Item key={value} value={value} onSelect={() => setChoice(value)} fontSize="sm">
                <I size={15} />
                <Box flex="1">{label}</Box>
                {choice === value ? <Check size={14} /> : null}
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

// /auth is outside `call`; the backend wants the same csrf proof as for a write. Both end on the
// signed-out page, which never signs in by itself (lib/signin.ts).
async function signOut() {
  await fetch(AUTH_PATHS.logout, { method: "POST", headers: { "x-squad-csrf": "1" }, credentials: "same-origin" });
  window.location.assign(SIGNED_OUT_PATH);
}

/**
 * Ends squad's session, opens the provider's end-session page in a new tab and shows the signed-out
 * page here. The provider never has to send the browser back, so nothing is registered there.
 */
async function signOutEverywhere() {
  // Opened now, inside the click, so a popup blocker lets it through; it gets its address below.
  const tab = window.open("", "_blank");
  const res = await fetch(AUTH_PATHS.logoutEverywhere, { method: "POST", headers: { "x-squad-csrf": "1" }, credentials: "same-origin" });
  if (!res.ok) {
    tab?.close();
    return signOut();
  }
  const body = (await res.json()) as LogoutEverywhere;
  if (!body.provider || tab === null) {
    // No provider link, or the tab was blocked: go there in this tab instead.
    tab?.close();
    return window.location.assign(body.to);
  }
  tab.opener = null;
  tab.location.href = body.to;
  window.location.assign(`${SIGNED_OUT_PATH}?${SIGNED_OUT_PROVIDER_TAB}`);
}

function SignOutItems({ onPick }: { onPick: (everywhere: boolean) => void }) {
  return (
    <>
      <Menu.Item value="sign-out" onSelect={() => onPick(false)} fontSize="sm">
        <LogOut size={15} /> Sign out
      </Menu.Item>
      <Menu.Item value="sign-out-everywhere" onSelect={() => onPick(true)} fontSize="sm">
        <LogOut size={15} />
        <Box>
          <Text>Sign out everywhere</Text>
          <Text fontSize="xs" color="fg.muted">
            Also signs you out of your sign-in provider
          </Text>
        </Box>
      </Menu.Item>
    </>
  );
}

/** The person, and the two ways to sign out. */
function AccountMenu({ me }: { me: Me }) {
  const [busy, setBusy] = useState(false);
  const pick = (everywhere: boolean) => {
    setBusy(true);
    void (everywhere ? signOutEverywhere() : signOut()).catch(() => setBusy(false));
  };
  return (
    <Menu.Root positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger asChild>
        <Button size="sm" variant="ghost" color="fg.muted" mr="-3" loading={busy} aria-label="Account and sign out" minW="0">
          <Text truncate maxW="56" hideBelow="lg">
            {me.email}
          </Text>
          <Text hideFrom="lg">Account</Text>
          <ChevronDown size={14} />
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="64">
            <Box px="2" py="1.5">
              <Text fontSize="xs" color="fg.muted">
                Signed in as
              </Text>
              <Text fontSize="sm" truncate>
                {me.email}
              </Text>
            </Box>
            <Menu.Separator />
            <SignOutItems onPick={pick} />
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

function AdminBadge() {
  return (
    <Badge size="sm" colorPalette="brand" variant="subtle" flexShrink={0}>
      admin
    </Badge>
  );
}

/** On a phone: the nav, the person and sign out in one menu. */
function PhoneMenu({ me }: { me: Me }) {
  const navigate = useNavigate();
  const { choice, setChoice } = useColorMode();
  return (
    <Menu.Root positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger asChild>
        <IconButton variant="ghost" size="sm" aria-label="Open the menu">
          <MenuIcon size={18} />
        </IconButton>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="60">
            {FRAMED ? null : (
              <>
                <Box px="2" py="1.5">
                  <HStack gap="2" minW="0">
                    <Text fontSize="sm" truncate flex="1">
                      {me.email}
                    </Text>
                    {me.admin ? <AdminBadge /> : null}
                  </HStack>
                </Box>
                <Menu.Separator />
              </>
            )}
            {NAV.map(({ to, label, icon: I }) => (
              <Menu.Item key={to} value={to} onSelect={() => void navigate(to)} fontSize="sm">
                <I size={15} /> {label}
              </Menu.Item>
            ))}
            {FRAMED ? null : (
              <>
                <Menu.Separator />
                {THEMES.map(({ value, label, icon: I }) => (
                  <Menu.Item key={value} value={`theme-${value}`} onSelect={() => setChoice(value)} fontSize="sm">
                    <I size={15} />
                    <Box flex="1">{label} theme</Box>
                    {choice === value ? <Check size={14} /> : null}
                  </Menu.Item>
                ))}
                <Menu.Separator />
                <SignOutItems onPick={(everywhere) => void (everywhere ? signOutEverywhere() : signOut())} />
              </>
            )}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

export function Shell({ me, children }: { me: Me; children: ReactNode }) {
  return (
    <Box>
      <Box as="header" bg="surface" borderBottomWidth="1px" borderColor="border" position="sticky" top="0" zIndex="sticky">
        <Container>
          <Flex h="14" align="center" gap="6">
            {FRAMED ? null : <Wordmark />}
            <Box hideBelow="md" ms={FRAMED ? "-3" : undefined}>
              <NavItems />
            </Box>
            <Box flex="1" />
            {FRAMED ? null : (
              <HStack gap="2" hideBelow="md" minW="0">
                {me.admin ? <AdminBadge /> : null}
                <ThemeMenu />
                <AccountMenu me={me} />
              </HStack>
            )}
            <Box hideFrom="md" mr="-2">
              <PhoneMenu me={me} />
            </Box>
          </Flex>
        </Container>
      </Box>
      <Container as="main" py={{ base: "5", md: "8" }}>
        <Stack gap="0">{children}</Stack>
      </Container>
    </Box>
  );
}
