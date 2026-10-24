// The frame around every page: a top bar and a centred container. Nothing depends on the viewport
// height, so the app also works inside an iframe of another page.
import { Badge, Box, Button, Flex, HStack, IconButton, Menu, Portal, Stack, Text } from "@chakra-ui/react";
import type { Me } from "@squad/contract";
import { BarChart3, Boxes, Check, History, LayoutDashboard, LogOut, Menu as MenuIcon, Monitor, Moon, Sun, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router";
import { useColorMode, type ThemeChoice } from "./colorMode.ts";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/accounts", label: "Accounts", icon: Users, end: false },
  { to: "/passes", label: "Passes", icon: History, end: false },
  { to: "/usage", label: "Usage", icon: BarChart3, end: false },
] as const;

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
        <Flex boxSize="7" rounded="lg" bg="brand.solid" color="white" align="center" justify="center" shadow="sm">
          <Boxes size={16} strokeWidth={2.25} />
        </Flex>
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

async function signOut() {
  // /auth is outside the contract; the backend wants the same csrf proof as for a write.
  await fetch("/auth/logout", { method: "POST", headers: { "x-squad-csrf": "1" }, credentials: "same-origin" });
  window.location.assign("/");
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
            <Box px="2" py="1.5">
              <HStack gap="2" minW="0">
                <Text fontSize="sm" truncate flex="1">
                  {me.email}
                </Text>
                {me.admin ? <AdminBadge /> : null}
              </HStack>
            </Box>
            <Menu.Separator />
            {NAV.map(({ to, label, icon: I }) => (
              <Menu.Item key={to} value={to} onSelect={() => void navigate(to)} fontSize="sm">
                <I size={15} /> {label}
              </Menu.Item>
            ))}
            <Menu.Separator />
            {THEMES.map(({ value, label, icon: I }) => (
              <Menu.Item key={value} value={`theme-${value}`} onSelect={() => setChoice(value)} fontSize="sm">
                <I size={15} />
                <Box flex="1">{label} theme</Box>
                {choice === value ? <Check size={14} /> : null}
              </Menu.Item>
            ))}
            <Menu.Separator />
            <Menu.Item value="sign-out" onSelect={() => void signOut()} fontSize="sm">
              <LogOut size={15} /> Sign out
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

export function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <Box>
      <Box as="header" bg="surface" borderBottomWidth="1px" borderColor="border" position="sticky" top="0" zIndex="sticky">
        <Container>
          <Flex h="14" align="center" gap="6">
            <Wordmark />
            <Box hideBelow="md">
              <NavItems />
            </Box>
            <Box flex="1" />
            <HStack gap="2" hideBelow="md" minW="0">
              <Text fontSize="sm" color="fg.muted" truncate maxW="56" hideBelow="lg" title={me.email}>
                {me.email}
              </Text>
              {me.admin ? <AdminBadge /> : null}
              <ThemeMenu />
              <Button
                size="sm"
                variant="ghost"
                color="fg.muted"
                mr="-3"
                loading={busy}
                onClick={() => {
                  setBusy(true);
                  void signOut().finally(() => setBusy(false));
                }}
              >
                <LogOut size={15} /> Sign out
              </Button>
            </HStack>
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
