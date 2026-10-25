// Small building blocks every page uses, so spacing, type and colour stay the same everywhere.
import { Badge, Box, Button, Clipboard, EmptyState, Flex, HStack, IconButton, LinkBox, LinkOverlay, Portal, Skeleton, Stack, Text, Tooltip, VStack } from "@chakra-ui/react";
import type { AccountView, Health } from "@squad/contract";
import { AlertTriangle, Check, ChevronRight, Copy, Inbox, type LucideIcon } from "lucide-react";
import { Link as RouterLink } from "react-router";
import { useState, type ReactNode } from "react";
import { healthColor, outcomeBadge, type BadgeColor } from "../lib/badges.ts";
import { failureText } from "../lib/errors.ts";
import { badgeLetter, logoIdOf, logoSrc } from "../lib/providers.ts";
import { CAP_HINT, NO_CAP_HINT, balanceRunway, keyCell, type BalanceTone, type RunwayBadge } from "../lib/keyUse.ts";
import { availableHint, floorHint, roomParts, roomState } from "../lib/room.ts";
import { fiveHourResetBadge, weekResetBadge, type WeekBadge, type WeekTone } from "../lib/weekReset.ts";

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

/**
 * A number card. With `to`, the whole card opens that page; `action` (a button) sits above the
 * card's link, so the two never nest.
 */
export function StatCard({ label, icon: Icon, value, hint, loading, to, action }: { label: string; icon: LucideIcon; value: ReactNode; hint?: ReactNode; loading?: boolean; to?: string; action?: ReactNode }) {
  return (
    <LinkBox
      bg="surface"
      borderWidth="1px"
      borderColor="border"
      rounded="xl"
      shadow="xs"
      p={{ base: "4", md: "5" }}
      minW="0"
      transition="border-color 0.15s, box-shadow 0.15s"
      _hover={to === undefined ? undefined : { borderColor: "border.emphasized", shadow: "sm" }}
    >
      <HStack gap="2" color="fg.muted" minW="0">
        <Box flexShrink={0}>
          <Icon size={15} strokeWidth={2} aria-hidden />
        </Box>
        <Text fontSize="sm" lineClamp={2} flex="1">
          {to === undefined ? (
            label
          ) : (
            <LinkOverlay asChild>
              <RouterLink to={to}>{label}</RouterLink>
            </LinkOverlay>
          )}
        </Text>
        {to === undefined ? null : (
          <Box flexShrink={0} color="fg.subtle">
            <ChevronRight size={14} aria-hidden />
          </Box>
        )}
      </HStack>
      {loading === true ? (
        <Skeleton h="8" w="24" mt="3" rounded="md" />
      ) : (
        <HStack mt="2" gap="3" justify="space-between" align="center" minW="0">
          <Text fontSize={{ base: "xl", md: "2xl" }} fontWeight="600" letterSpacing="-0.02em" lineHeight="1.3" truncate>
            {value}
          </Text>
          {action === undefined ? null : (
            <Box position="relative" zIndex="1" flexShrink={0}>
              {action}
            </Box>
          )}
        </HStack>
      )}
      <Text mt="1" fontSize="xs" color="fg.subtle" minH="4" lineClamp={2}>
        {loading === true ? "" : hint}
      </Text>
    </LinkBox>
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

/** A short hover note on any element. */
export function Hint({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip.Root openDelay={200} closeDelay={50}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Portal>
        <Tooltip.Positioner>
          <Tooltip.Content maxW="64" fontSize="xs">{text}</Tooltip.Content>
        </Tooltip.Positioner>
      </Portal>
    </Tooltip.Root>
  );
}

/** A coloured dot and a short label; the hover note says what the number means. */
function Legend({ color, text, hint }: { color: string; text: string; hint: string }) {
  return (
    <Hint text={hint}>
      <HStack gap="1.5" cursor="help" tabIndex={0} whiteSpace="nowrap">
        <Box boxSize="2" rounded="full" bg={color} flexShrink={0} />
        <Text fontVariantNumeric="tabular-nums">{text}</Text>
      </HStack>
    </Hint>
  );
}

/**
 * The room left in one window. The part under the floor is grey (the owner keeps it); the part above
 * takes the state colour; a tick marks the floor. Under the bar, the floor sits on the left and what
 * is available sits on the right, each in its own colour.
 */
const BADGE_PALETTE: Readonly<Record<WeekTone | BalanceTone, string>> = { red: "red", orange: "orange", yellow: "yellow", grey: "gray" };

/** When the week window resets: red under a day, yellow under three, grey after. The hover says the exact time. */
export function WeekResetBadge({ resetsWeek }: { resetsWeek: string | undefined }) {
  return <ResetBadge b={weekResetBadge(resetsWeek, new Date())} />;
}

/** A reset badge, or a key's balance badge: the same pill, with the exact facts on hover. */
function ResetBadge({ b }: { b: { readonly text: string; readonly tone: WeekTone | BalanceTone; readonly title: string } | undefined }) {
  if (b === undefined) return null;
  return (
    <Hint text={b.title}>
      <Badge colorPalette={BADGE_PALETTE[b.tone]} variant={b.tone === "grey" ? "outline" : "subtle"} size="sm" rounded="full" fontWeight="500" tabIndex={0} cursor="help" w="fit-content" whiteSpace="nowrap">
        {b.text}
      </Badge>
    </Hint>
  );
}

/**
 * Pass `resets5h` on a 5-hour bar or `resetsWeek` on a week bar for its reset badge. `keepResetLine` holds
 * the badge line empty when there is no badge, so table rows keep one height.
 */
export function RoomBar({ left, floor, width = "100%", label, resets5h, resetsWeek, keepResetLine = false }: { left: number | undefined; floor: number; width?: string; label?: string; resets5h?: string; resetsWeek?: string; keepResetLine?: boolean }) {
  const now = new Date();
  const badge = resetsWeek !== undefined ? weekResetBadge(resetsWeek, now) : fiveHourResetBadge(resets5h, now);
  const l = Math.max(0, Math.min(100, left ?? 0));
  const f = Math.max(0, Math.min(100, floor));
  const color = left === undefined ? "room.track" : ROOM_COLOR[roomState(l, f)];
  const parts = roomParts(left, f);
  return (
    <Stack gap="1.5" w={width} minW="0">
      {label === undefined ? null : (
        <Text fontSize="xs" lineHeight="1" color="fg.muted">
          {label}
        </Text>
      )}
      <Box position="relative" h="1.5" rounded="full" bg="room.track" aria-hidden>
        <Box position="absolute" insetY="0" left="0" roundedLeft="full" bg="room.floor" style={{ width: `${Math.min(l, f)}%` }} />
        {l > f ? <Box position="absolute" insetY="0" bg={color} roundedRight="full" style={{ left: `${f}%`, width: `${l - f}%` }} /> : null}
        {f > 0 ? <Box position="absolute" top="-3px" bottom="-3px" w="2px" rounded="full" bg="room.tick" style={{ left: `calc(${f}% - 1px)` }} /> : null}
      </Box>
      <Flex justify="space-between" gap="2" fontSize="xs" lineHeight="1" color="fg.muted">
        <Legend color="room.floor" text={`Floor ${f}%`} hint={floorHint(f)} />
        {parts.available === undefined ? (
          <Text color="fg.subtle">no read yet</Text>
        ) : (
          <Legend color={color} text={`${parts.available}% available`} hint={availableHint(parts)} />
        )}
      </Flex>
      {keepResetLine && badge === undefined ? <Box h="5" aria-hidden /> : <ResetBadge b={badge} />}
    </Stack>
  );
}

const CAP_COLOR = { blue: "room.blue", yellow: "room.yellow", red: "room.red" } as const;

/**
 * What a key's own passes used in one window, in dollars, as a bar of used over cap: red when reached,
 * yellow above 80%. With no cap the bar is the same, empty, with "Cap ∞" on the right. Under it, where a
 * seat shows its reset badge, a key with an entered balance shows how long that lasts in this window.
 */
export function KeyUseBar({ used, cap, span, width = "100%", label, badge, keepResetLine = false }: { used: number | undefined; cap: number | undefined; span: string; width?: string; label?: string; badge?: RunwayBadge; keepResetLine?: boolean }) {
  const c = keyCell(used, cap);
  const usedHint = `Used by squad's own passes in the last ${span}. squad cannot see use outside squad.`;
  return (
    <Stack gap="1.5" w={width} minW="0">
      {label === undefined ? null : (
        <Text fontSize="xs" lineHeight="1" color="fg.muted">
          {label}
        </Text>
      )}
      <Box position="relative" h="1.5" rounded="full" bg="room.track" aria-hidden>
        {c.pct > 0 ? <Box position="absolute" insetY="0" left="0" rounded="full" bg={CAP_COLOR[c.tone]} style={{ width: `${c.pct}%` }} /> : null}
      </Box>
      {/* Use on the left and the cap on the right, the way a seat shows its floor and what is available. */}
      <Flex justify="space-between" gap="2" fontSize="xs" lineHeight="1" color="fg.muted">
        <Legend color={CAP_COLOR[c.tone]} text={c.usedText} hint={usedHint} />
        <Legend color="room.floor" text={c.capText} hint={cap === undefined ? NO_CAP_HINT : CAP_HINT} />
      </Flex>
      {badge !== undefined ? <ResetBadge b={badge} /> : keepResetLine ? <Box h="5" aria-hidden /> : null}
    </Stack>
  );
}

/** One window of an account: a seat's room bar, or what a key used. */
export function AccountRoom({ a, window, width, label, keepResetLine = false }: { a: AccountView; window: "5h" | "week"; width?: string; label?: string; keepResetLine?: boolean }) {
  const w = width === undefined ? {} : { width };
  const l = label === undefined ? {} : { label };
  if (a.kind === "key") {
    const badge = balanceRunway(a, window);
    const n = badge === undefined ? {} : { badge };
    return window === "5h" ? (
      <KeyUseBar used={a.used5h} cap={a.cap5h} span="5 hours" {...w} {...l} {...n} keepResetLine={keepResetLine} />
    ) : (
      <KeyUseBar used={a.usedWeek} cap={a.capWeek} span="7 days" {...w} {...l} {...n} keepResetLine={keepResetLine} />
    );
  }
  return window === "5h" ? (
    <RoomBar left={a.left5h} floor={a.floor5h} resets5h={a.resets5h} {...w} {...l} keepResetLine={keepResetLine} />
  ) : (
    <RoomBar left={a.leftWeek} floor={a.floorWeek} resetsWeek={a.resetsWeek} {...w} {...l} keepResetLine={keepResetLine} />
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

/** A filter chip: dark when on. */
export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      size="xs"
      rounded="full"
      px="3"
      variant="outline"
      bg={active ? "fg" : "surface"}
      color={active ? "bg" : "fg.muted"}
      borderColor={active ? "fg" : "border"}
      _hover={{ bg: active ? "fg" : "bg.muted" }}
      onClick={onClick}
      aria-pressed={active}
      fontWeight="500"
    >
      {children}
    </Button>
  );
}

/** The runner that serves a catalog provider. */
export function RunnerBadge({ runner }: { runner: string }) {
  return (
    <Badge size="sm" variant="outline" fontFamily="mono" fontWeight="500" color="fg.muted" flexShrink={0}>
      {runner}
    </Badge>
  );
}

/** The person has accounts of this provider. */
export function InUseBadge({ n }: { n: number }) {
  return (
    <Badge size="sm" colorPalette="green" variant="subtle" flexShrink={0} fontVariantNumeric="tabular-nums">
      In use · {n}
    </Badge>
  );
}
