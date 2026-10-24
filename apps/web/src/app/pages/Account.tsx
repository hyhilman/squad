import { Box, Button, Flex, Grid, HStack, Link, Skeleton, Stack, Tabs, Text } from "@chakra-ui/react";
import type { AccountView, Runner } from "@squad/contract";
import { ChevronRight } from "lucide-react";
import { Link as RouterLink, useParams, useSearchParams } from "react-router";
import { agoText } from "../lib/format.ts";
import { isOwnerOf } from "../lib/login.ts";
import { useAccount, useMe, useRoomSeries } from "../queries.ts";
import { AccountButtons, FloorsForm, useAccountActions } from "../ui/actions.tsx";
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
          <RoomBar left={a.leftWeek} floor={a.floorWeek} label="Week window" />
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
          <Fact label="Owner">{a.ownerEmail === "" ? "-" : a.ownerEmail}</Fact>
          {a.loginEmail === undefined ? null : <Fact label="Seat email">{a.loginEmail}</Fact>}
          <Fact label="Consent">{a.consentAt === undefined ? "Not given" : at(a.consentAt)}</Fact>
          <Fact label="Floors">{`${a.floor5h}% · ${a.floorWeek}% (${a.floorSource === "owner" ? "set by the owner" : "the default"})`}</Fact>
        </Panel>
      </Stack>
    </Grid>
  );
}

function SettingsTab({ a }: { a: AccountView }) {
  const { actions, dialogs } = useAccountActions(a);
  const more = actions.filter((x) => x.key !== "floors");
  const text: Record<string, string> = {
    login: "The login is dead. Sign in again with the same seat.",
    consent: "Agree that squad may run passes on your account.",
    enable: a.health === "disabled" ? "Let passes use this account again." : "Stop passes from using this account. You can enable it again at any time.",
  };
  return (
    <Stack gap="6" maxW="2xl">
      <Panel title="Floors">
        <FloorsForm key={`${a.floor5h}-${a.floorWeek}-${a.floorSource}`} a={a} />
      </Panel>
      <Panel title="Account">
        <Stack gap="0">
          {more.map(({ key, label, icon: Icon, danger, primary, run }) => (
            <Flex key={key} gap="4" py="3" align="center" justify="space-between" borderBottomWidth="1px" borderColor="border.subtle" _last={{ borderBottomWidth: 0, pb: 0 }} _first={{ pt: 0 }}>
              <Box minW="0">
                <Text fontSize="sm" fontWeight="500">
                  {label}
                </Text>
                <Text fontSize="xs" color="fg.muted">
                  {text[key]}
                </Text>
              </Box>
              <Button size="sm" variant={primary === true ? "solid" : "outline"} colorPalette={primary === true ? "brand" : danger === true ? "red" : "gray"} onClick={run} flexShrink={0}>
                <Icon size={15} />
                {label}
              </Button>
            </Flex>
          ))}
        </Stack>
      </Panel>
      {dialogs}
    </Stack>
  );
}

export function Account() {
  const { runner = "", name = "" } = useParams();
  const q = useAccount(runner as Runner, name);
  const me = useMe().data;
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "overview";

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
            </HStack>
            <Text fontSize="sm" color="fg.muted" mt="0.5">
              {a.runner} · {a.kind} · {isOwnerOf(a, me) ? "yours" : `owned by ${a.ownerEmail === "" ? "nobody" : a.ownerEmail}`}
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
          <Tabs.Trigger value="settings">Settings</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="overview" p="0">
          <OverviewTab a={a} />
        </Tabs.Content>
        <Tabs.Content value="passes" p="0">
          <PassesBrowser account={a.account} />
        </Tabs.Content>
        <Tabs.Content value="settings" p="0">
          <SettingsTab a={a} />
        </Tabs.Content>
      </Tabs.Root>
    </>
  );
}
