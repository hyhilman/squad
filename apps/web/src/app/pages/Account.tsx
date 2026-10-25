import { Badge, Box, Flex, Grid, HStack, Link, Skeleton, Stack, Tabs, Text } from "@chakra-ui/react";
import type { AccountView, Runner } from "@squad/contract";
import { ChevronRight } from "lucide-react";
import { Link as RouterLink, useParams, useSearchParams } from "react-router";
import { agoText } from "../lib/format.ts";
import { UNKNOWN_USER_HINT } from "../lib/accountUser.ts";
import { isOwnerOf } from "../lib/login.ts";
import { FillAccountUser } from "../ui/AccountUser.tsx";
import { useAccount, useMe, useRoomSeries } from "../queries.ts";
import { AccountButtons } from "../ui/actions.tsx";
import { RoomChart } from "../ui/charts.tsx";
import { PassesBrowser } from "../ui/PassesBrowser.tsx";
import { EmptyBlock, ErrorBlock, Fact, HealthBadge, Panel, ProviderLogo, RoomBar, logoOfRunner } from "../ui/parts.tsx";

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const at = (iso: string | undefined) => (iso === undefined ? "-" : when.format(Date.parse(iso)));

function OverviewTab({ a }: { a: AccountView }) {
  const room = useRoomSeries(a.runner as Runner, a.name, "7d");
  return (
    <Grid templateColumns={{ base: "1fr", lg: "minmax(0, 2fr) minmax(0, 1fr)" }} gap="6" alignItems="start">
      <Panel title="Room left" description={a.readAt === undefined ? "No usage read yet." : `Read ${agoText(a.readAt, new Date())}. The grey part is the floor the owner keeps.`}>
        <Grid templateColumns={{ base: "1fr", sm: "1fr 1fr" }} gap="6" mb="6">
          <RoomBar left={a.left5h} floor={a.floor5h} label="5-hour window" />
          <RoomBar left={a.leftWeek} floor={a.floorWeek} label="Week window" resetsWeek={a.resetsWeek} />
        </Grid>
        <Text fontSize="xs" fontWeight="600" color="fg.muted" textTransform="uppercase" letterSpacing="0.06em" mb="2">
          Last 7 days
        </Text>
        {room.isPending ? (
          <Skeleton h="240px" rounded="md" />
        ) : room.isError ? (
          <ErrorBlock error={room.error} onRetry={() => void room.refetch()} />
        ) : room.data.length === 0 ? (
          <EmptyBlock title="No readings in the last 7 days" description="A reading comes from a usage read or from a pass." />
        ) : (
          <RoomChart points={room.data} floor5h={a.floor5h} floorWeek={a.floorWeek} />
        )}
      </Panel>
      <Stack gap="6">
        <Panel title="Status">
          <Fact label="Health">
            <HealthBadge health={a.health} />
          </Fact>
          <Fact label="In use now">{a.busy ? "Yes, a pass holds it" : "No"}</Fact>
          {a.coolUntil === undefined ? null : <Fact label="Cooling until">{at(a.coolUntil)}</Fact>}
          <Fact label="Last error code">
            {a.lastCode === undefined ? (
              "-"
            ) : (
              <Text as="span" fontFamily="mono" fontSize="xs">
                {a.lastCode}
              </Text>
            )}
          </Fact>
          <Fact label="Pools">{a.pools.length === 0 ? "-" : a.pools.join(", ")}</Fact>
        </Panel>
        <Panel title="Owner">
          <Fact label="Account user">
            {a.loginEmail === undefined ? (
              <Stack gap="0.5" align="flex-end">
                <Text as="span" color="fg.subtle" fontStyle="italic" title={UNKNOWN_USER_HINT}>
                  unknown
                </Text>
                <FillAccountUser a={a} />
              </Stack>
            ) : (
              a.loginEmail
            )}
          </Fact>
          <Fact label="Owner">{a.ownerEmail === "" ? "-" : a.ownerEmail}</Fact>
          <Fact label="Shared">{a.sharing ? `Since ${at(a.consentAt)}${a.consentBy === undefined ? "" : ` (by ${a.consentBy})`}` : "No: squad refuses every pass"}</Fact>
          <Fact label="Floors">{`${a.floor5h}% · ${a.floorWeek}% (${a.floorSource === "owner" ? "set by the owner" : "the default"})`}</Fact>
        </Panel>
      </Stack>
    </Grid>
  );
}

export function Account() {
  const { runner = "", name = "" } = useParams();
  const q = useAccount(runner as Runner, name);
  const me = useMe().data;
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "passes" ? "passes" : "overview";

  const crumbs = (
    <HStack gap="1" fontSize="sm" color="fg.muted" mb="4">
      <Link asChild color="fg.muted" _hover={{ color: "fg" }}>
        <RouterLink to="/accounts">Accounts</RouterLink>
      </Link>
      <ChevronRight size={14} />
      <Text color="fg">
        {runner}/{name}
      </Text>
    </HStack>
  );

  if (q.isPending) {
    return (
      <>
        {crumbs}
        <HStack gap="4" mb="8">
          <Skeleton boxSize="12" rounded="xl" />
          <Stack gap="2">
            <Skeleton h="6" w="48" />
            <Skeleton h="4" w="64" />
          </Stack>
        </HStack>
        <Skeleton h="80" rounded="xl" />
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        {crumbs}
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const a = q.data;
  return (
    <>
      {crumbs}
      <Flex gap="4" mb="6" align={{ base: "flex-start", md: "center" }} justify="space-between" direction={{ base: "column", md: "row" }}>
        <HStack gap="4" minW="0">
          <ProviderLogo logoId={logoOfRunner(a.runner)} name={a.runner} size={12} />
          <Box minW="0">
            <HStack gap="3" wrap="wrap">
              <Text as="h1" fontSize="2xl" fontWeight="600" letterSpacing="-0.02em" lineHeight="1.25">
                {a.name}
              </Text>
              <HealthBadge health={a.health} />
              {a.sharing || a.health === "removed" ? null : (
                <Badge colorPalette="orange" variant="outline" size="sm" rounded="full">
                  not shared
                </Badge>
              )}
            </HStack>
            <Text fontSize="sm" color="fg.muted" mt="0.5">
              <Text as="span" color={a.loginEmail === undefined ? "fg.subtle" : "fg"} title={a.loginEmail === undefined ? UNKNOWN_USER_HINT : undefined}>
                {a.loginEmail ?? "unknown account user"}
              </Text>
              {` · owned by ${a.ownerEmail === "" ? "nobody" : a.ownerEmail}${isOwnerOf(a, me) ? " (you)" : ""} · ${a.runner} ${a.kind}`}
            </Text>
          </Box>
        </HStack>
        <AccountButtons a={a} />
      </Flex>

      <Tabs.Root
        value={tab}
        onValueChange={(d) =>
          setParams((p) => {
            p.set("tab", d.value);
            p.delete("pass");
            return p;
          })
        }
        variant="line"
        colorPalette="brand"
        lazyMount
      >
        <Tabs.List mb="6">
          <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
          <Tabs.Trigger value="passes">Passes</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="overview" p="0">
          <OverviewTab a={a} />
        </Tabs.Content>
        <Tabs.Content value="passes" p="0">
          <PassesBrowser account={a.account} />
        </Tabs.Content>
      </Tabs.Root>
    </>
  );
}
