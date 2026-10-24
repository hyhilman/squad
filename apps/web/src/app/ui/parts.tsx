// Small building blocks every page uses, so spacing, type and colour stay the same everywhere.
import { Badge, Box, Button, Clipboard, EmptyState, Flex, HStack, IconButton, Skeleton, Stack, Text, VStack } from "@chakra-ui/react";
import type { Health } from "@squad/contract";
import { AlertTriangle, Check, Copy, Inbox, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { healthColor, outcomeBadge, type BadgeColor } from "../lib/badges.ts";
import { failureText } from "../lib/errors.ts";
import { badgeLetter, logoIdOf, logoSrc } from "../lib/providers.ts";
import { roomLabel, roomState } from "../lib/room.ts";

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <Flex gap="4" align={{ base: "stretch", sm: "flex-end" }} justify="space-between" direction={{ base: "column", sm: "row" }} mb="6">
      <Box minW="0">
        <Text as="h1" fontSize="2xl" fontWeight="600" letterSpacing="-0.02em" lineHeight="1.25">
          {title}
        </Text>
        {description === undefined ? null : (
          <Text mt="1" color="fg.muted" fontSize="sm">
            {description}
          </Text>
        )}
      </Box>
      {actions === undefined ? null : (
        <HStack gap="2" flexShrink={0}>
          {actions}
        </HStack>
      )}
    </Flex>
  );
}

/** A card: white on the grey page, a hairline border. */
/** `flush`: the body has no padding (a table that runs to the edges); the title keeps its own. */
export function Panel({ title, description, actions, children, flush = false, ...rest }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean } & React.ComponentProps<typeof Box>) {
  const p = "5";
  return (
    <Box bg="surface" borderWidth="1px" borderColor="border" rounded="xl" shadow="xs" minW="0" {...rest}>
      {title === undefined ? null : (
        <Flex px={p} pt={p} pb="3" justify="space-between" align="flex-start" gap="3">
          <Box minW="0">
            <Text fontSize="sm" fontWeight="600">
              {title}
            </Text>
            {description === undefined ? null : (
              <Text fontSize="xs" color="fg.muted" mt="0.5">
                {description}
              </Text>
            )}
          </Box>
          {actions}
        </Flex>
      )}
      <Box px={flush ? "0" : p} pb={flush ? "0" : p} pt={title === undefined && !flush ? p : "0"}>
        {children}
      </Box>
    </Box>
  );
}

export function StatCard({ label, icon: Icon, value, hint, loading }: { label: string; icon: LucideIcon; value: ReactNode; hint?: ReactNode; loading?: boolean }) {
  return (
    <Box bg="surface" borderWidth="1px" borderColor="border" rounded="xl" shadow="xs" p={{ base: "4", md: "5" }} minW="0">
      <HStack gap="2" color="fg.muted" minW="0">
        <Box flexShrink={0}>
          <Icon size={15} strokeWidth={2} aria-hidden />
        </Box>
        <Text fontSize="sm" lineClamp={2}>
          {label}
        </Text>
      </HStack>
      {loading === true ? (
        <Skeleton h="8" w="24" mt="3" rounded="md" />
      ) : (
        <Text mt="2" fontSize={{ base: "xl", md: "2xl" }} fontWeight="600" letterSpacing="-0.02em" lineHeight="1.3" truncate>
          {value}
        </Text>
      )}
      <Text mt="1" fontSize="xs" color="fg.subtle" minH="4" lineClamp={2}>
        {loading === true ? "" : hint}
      </Text>
    </Box>
  );
}

export function EmptyBlock({ icon: Icon = Inbox, title, description, action, compact = false }: { icon?: LucideIcon; title: string; description?: string; action?: ReactNode; compact?: boolean }) {
  return (
    <EmptyState.Root size="sm" py={compact ? "4" : "10"}>
      <EmptyState.Content>
        <EmptyState.Indicator>
          <Flex boxSize="10" rounded="full" bg="bg.muted" align="center" justify="center" color="fg.muted">
            <Icon size={18} />
          </Flex>
        </EmptyState.Indicator>
        <VStack textAlign="center" gap="1">
          <EmptyState.Title fontSize="sm" fontWeight="600">
            {title}
          </EmptyState.Title>
          {description === undefined ? null : (
            <EmptyState.Description fontSize="sm" color="fg.muted" maxW="sm">
              {description}
            </EmptyState.Description>
          )}
        </VStack>
        {action}
      </EmptyState.Content>
    </EmptyState.Root>
  );
}

/** The backend's message, in plain words (lib/errors.ts). */
export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Flex gap="3" align="flex-start" p="4" rounded="lg" borderWidth="1px" borderColor="red.muted" bg="bg.error" color="fg.error">
      <Box pt="0.5">
        <AlertTriangle size={16} />
      </Box>
      <Box flex="1" fontSize="sm">
        <Text fontWeight="500">Could not load this.</Text>
        <Text mt="0.5">{failureText(error)}</Text>
      </Box>
      {onRetry === undefined ? null : (
        <Button size="xs" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Flex>
  );
}

const PALETTE: Readonly<Record<BadgeColor, string>> = { success: "green", error: "red", warning: "orange", processing: "blue", default: "gray" };

function DotBadge({ color, children }: { color: BadgeColor; children: ReactNode }) {
  return (
    <Badge colorPalette={PALETTE[color]} variant="subtle" size="sm" rounded="full" px="2" gap="1.5" fontWeight="500">
      <Box boxSize="1.5" rounded="full" bg="colorPalette.solid" flexShrink={0} />
      {children}
    </Badge>
  );
}

export const HealthBadge = ({ health }: { health: Health }) => <DotBadge color={healthColor(health)}>{health}</DotBadge>;

export function OutcomeBadge({ outcome }: { outcome: string | undefined }) {
  const b = outcomeBadge(outcome);
  return <DotBadge color={b.color}>{b.text}</DotBadge>;
}

// An account has no provider id, so only the seats (codex, claude) get a logo; a pi account gets a letter.
export const logoOfRunner = (runner: string): string | undefined => (runner === "codex" || runner === "claude" ? logoIdOf({ id: runner, runner }) : undefined);

/** A provider logo from the backend (/logos/<id>.svg), or a letter when there is none. */
export function ProviderLogo({ logoId, name, size = 8 }: { logoId: string | undefined; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const px = size * 4;
  return (
    <Flex boxSize={`${px}px`} flexShrink={0} rounded="lg" bg="bg.muted" borderWidth="1px" borderColor="border.subtle" align="center" justify="center" overflow="hidden">
      {logoId === undefined || failed ? (
        <Text fontSize={px >= 40 ? "md" : "xs"} fontWeight="600" color="fg.muted">
          {badgeLetter(name)}
        </Text>
      ) : (
        // The catalog's logos are one colour (currentColor = black in an <img>), so dark mode inverts them.
        <Box asChild boxSize="60%" _dark={{ filter: "invert(1)" }}>
          <img src={logoSrc(logoId)} alt="" onError={() => setFailed(true)} />
        </Box>
      )}
    </Flex>
  );
}

const ROOM_COLOR = { blue: "room.blue", yellow: "room.yellow", orange: "room.orange", red: "room.red" } as const;

/**
 * The room left in one window. The part under the floor is grey (the owner keeps it); the part above
 * takes the state colour; a tick marks the floor.
 */
export function RoomBar({ left, floor, width = "100%", label }: { left: number | undefined; floor: number; width?: string; label?: string }) {
  const l = Math.max(0, Math.min(100, left ?? 0));
  const f = Math.max(0, Math.min(100, floor));
  const color = left === undefined ? "room.track" : ROOM_COLOR[roomState(l, f)];
  return (
    <Stack gap="1.5" w={width} minW="0">
      <Flex justify="space-between" gap="2" fontSize="xs" lineHeight="1">
        {label === undefined ? null : <Text color="fg.muted">{label}</Text>}
        <Text color={left === undefined ? "fg.subtle" : "fg"} fontVariantNumeric="tabular-nums" whiteSpace="nowrap">
          {roomLabel(left, floor)}
        </Text>
      </Flex>
      <Box position="relative" h="1.5" rounded="full" bg="room.track" aria-hidden>
        <Box position="absolute" insetY="0" left="0" roundedLeft="full" bg="room.floor" style={{ width: `${Math.min(l, f)}%` }} />
        {l > f ? <Box position="absolute" insetY="0" bg={color} roundedRight="full" style={{ left: `${f}%`, width: `${l - f}%` }} /> : null}
        {f > 0 ? <Box position="absolute" top="-3px" bottom="-3px" w="2px" rounded="full" bg="room.tick" style={{ left: `calc(${f}% - 1px)` }} /> : null}
      </Box>
    </Stack>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  return (
    <Clipboard.Root value={value}>
      <Clipboard.Trigger asChild>
        <IconButton variant="outline" size="sm" aria-label={label}>
          <Clipboard.Indicator copied={<Check size={14} />}>
            <Copy size={14} />
          </Clipboard.Indicator>
        </IconButton>
      </Clipboard.Trigger>
    </Clipboard.Root>
  );
}

/** A label and a value, for fact lists. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Flex justify="space-between" gap="4" py="2" borderBottomWidth="1px" borderColor="border.subtle" _last={{ borderBottomWidth: 0 }} fontSize="sm" minW="0">
      <Text color="fg.muted" flexShrink={0}>
        {label}
      </Text>
      <Box textAlign="right" minW="0" overflowWrap="anywhere" fontVariantNumeric="tabular-nums">
        {children}
      </Box>
    </Flex>
  );
}
