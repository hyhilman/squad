import { Box, Flex, HStack, Input, InputGroup, Link, Skeleton, Stack, Table, Text } from "@chakra-ui/react";
import type { AccountView, Health } from "@squad/contract";
import { Search, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Link as RouterLink, useNavigate, useSearchParams } from "react-router";
import { attentionOf } from "../lib/attention.ts";
import { agoText } from "../lib/format.ts";
import { lastPassByAccount } from "../lib/passFilter.ts";
import { useAccounts, useMe, usePasses } from "../queries.ts";
import { AccountMenu } from "../ui/actions.tsx";
import { AddAccount } from "../ui/AddAccount.tsx";
import { Chip, EmptyBlock, ErrorBlock, HealthBadge, PageHeader, Panel, ProviderLogo, RoomBar, logoOfRunner } from "../ui/parts.tsx";

type HealthFilter = "" | "attention" | Health;

function NameCell({ a }: { a: AccountView }) {
  return (
    <HStack gap="3" minW="0">
      <ProviderLogo logoId={logoOfRunner(a.runner)} name={a.runner} />
      <Box minW="0">
        <Link asChild fontWeight="500" fontSize="sm" color="fg" _hover={{ color: "brand.fg" }} onClick={(e) => e.stopPropagation()}>
          <RouterLink to={`/accounts/${a.account}`}>{a.name}</RouterLink>
        </Link>
        <Text fontSize="xs" color="fg.muted" truncate>
          {a.runner} · {a.kind}
          {a.busy ? " · busy" : ""}
        </Text>
      </Box>
    </HStack>
  );
}

const now = () => new Date();

export function Accounts() {
  const accounts = useAccounts();
  const me = useMe().data;
  const recent = usePasses(undefined, undefined, 200);
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [runner, setRunner] = useState("");
  const [params] = useSearchParams();
  // The overview links here with ?health=attention; any other value is no filter.
  const [health, setHealth] = useState<HealthFilter>(() => (params.get("health") === "attention" ? "attention" : ""));
  const last = useMemo(() => lastPassByAccount(recent.data ?? []), [recent.data]);
  const list = accounts.data ?? [];
  const runners = [...new Set(list.map((a) => a.runner))].sort();
  const healths = [...new Set(list.map((a) => a.health))].sort();
  const needle = q.trim().toLowerCase();
  const shown = list.filter(
    (a) =>
      (needle === "" || a.account.toLowerCase().includes(needle) || a.ownerEmail.toLowerCase().includes(needle)) &&
      (runner === "" || a.runner === runner) &&
      (health === "" || (health === "attention" ? attentionOf(a) !== undefined : a.health === health)),
  );
  const admin = me?.admin === true;

  return (
    <>
      <PageHeader title="Accounts" description="The seats and keys squad can run passes on, and the room left in each." actions={<AddAccount />} />

      <Flex gap="3" mb="4" wrap="wrap" align="center">
        <InputGroup startElement={<Search size={15} />} w={{ base: "full", md: "64" }}>
          <Input size="sm" placeholder="Search accounts" value={q} onChange={(e) => setQ(e.target.value)} bg="surface" />
        </InputGroup>
        <HStack gap="1.5" wrap="wrap">
          <Chip active={runner === ""} onClick={() => setRunner("")}>
            All runners
          </Chip>
          {runners.map((r) => (
            <Chip key={r} active={runner === r} onClick={() => setRunner(runner === r ? "" : r)}>
              {r}
            </Chip>
          ))}
        </HStack>
        <Box w="1px" h="5" bg="border" hideBelow="md" />
        <HStack gap="1.5" wrap="wrap">
          <Chip active={health === ""} onClick={() => setHealth("")}>
            Any health
          </Chip>
          <Chip active={health === "attention"} onClick={() => setHealth(health === "attention" ? "" : "attention")}>
            Needs attention
          </Chip>
          {healths.map((h) => (
            <Chip key={h} active={health === h} onClick={() => setHealth(health === h ? "" : h)}>
              {h}
            </Chip>
          ))}
        </HStack>
      </Flex>

      <Panel flush overflow="hidden">
        {accounts.isPending ? (
          <Stack p="5" gap="4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} h="10" rounded="md" />
            ))}
          </Stack>
        ) : accounts.isError ? (
          <Box p="5">
            <ErrorBlock error={accounts.error} onRetry={() => void accounts.refetch()} />
          </Box>
        ) : list.length === 0 ? (
          <EmptyBlock icon={Users} title="No accounts yet" description="Add a seat or an API key to let squad run passes on it." action={<AddAccount />} />
        ) : shown.length === 0 ? (
          <EmptyBlock icon={Search} title="No account matches" description="Change the search or the filters." />
        ) : (
          <>
            {/* Phone: one card per account. */}
            <Stack hideFrom="md" gap="0">
              {shown.map((a) => (
                <Box key={a.account} px="4" py="4" borderBottomWidth="1px" borderColor="border.subtle" _last={{ borderBottomWidth: 0 }}>
                  <Flex justify="space-between" align="flex-start" gap="2">
                    <NameCell a={a} />
                    <HStack gap="1" flexShrink={0}>
                      <HealthBadge health={a.health} />
                      <AccountMenu a={a} />
                    </HStack>
                  </Flex>
                  <Stack gap="3" mt="3" pl="11">
                    <RoomBar left={a.left5h} floor={a.floor5h} label="5-hour" />
                    <RoomBar left={a.leftWeek} floor={a.floorWeek} label="Week" />
                    <Text fontSize="xs" color="fg.subtle">
                      {admin ? `${a.ownerEmail} · ` : ""}last pass {last[a.account] === undefined ? "-" : agoText(last[a.account], now())}
                    </Text>
                  </Stack>
                </Box>
              ))}
            </Stack>
            {/* Wider: a table. */}
            <Table.ScrollArea hideBelow="md">
              <Table.Root size="md" interactive>
                <Table.Header>
                  <Table.Row bg="bg.subtle">
                    <Table.ColumnHeader ps="5">Account</Table.ColumnHeader>
                    {admin ? <Table.ColumnHeader hideBelow="xl">Owner</Table.ColumnHeader> : null}
                    <Table.ColumnHeader>Health</Table.ColumnHeader>
                    <Table.ColumnHeader w="190px">5-hour room</Table.ColumnHeader>
                    <Table.ColumnHeader w="190px">Week room</Table.ColumnHeader>
                    <Table.ColumnHeader hideBelow="lg" textAlign="end">
                      Last pass
                    </Table.ColumnHeader>
                    <Table.ColumnHeader w="12" pe="4" />
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {shown.map((a) => (
                    <Table.Row key={a.account} cursor="pointer" onClick={() => void navigate(`/accounts/${a.account}`)}>
                      <Table.Cell ps="5" py="3.5">
                        <NameCell a={a} />
                      </Table.Cell>
                      {admin ? (
                        <Table.Cell hideBelow="xl" color="fg.muted" fontSize="sm" maxW="56" truncate>
                          {a.ownerEmail}
                        </Table.Cell>
                      ) : null}
                      <Table.Cell>
                        <HealthBadge health={a.health} />
                      </Table.Cell>
                      <Table.Cell>
                        <RoomBar left={a.left5h} floor={a.floor5h} width="200px" />
                      </Table.Cell>
                      <Table.Cell>
                        <RoomBar left={a.leftWeek} floor={a.floorWeek} width="200px" />
                      </Table.Cell>
                      <Table.Cell hideBelow="lg" textAlign="end" color="fg.muted" fontSize="sm" whiteSpace="nowrap">
                        {last[a.account] === undefined ? "-" : agoText(last[a.account], now())}
                      </Table.Cell>
                      <Table.Cell pe="4" textAlign="end" onClick={(e) => e.stopPropagation()}>
                        <AccountMenu a={a} />
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Table.ScrollArea>
          </>
        )}
      </Panel>
    </>
  );
}
