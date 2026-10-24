import { Box, Flex, HStack, Link, SimpleGrid, Skeleton, Stack, Text } from "@chakra-ui/react";
import { Activity, CheckCircle2, Coins, DollarSign, Users } from "lucide-react";
import { Link as RouterLink } from "react-router";
import { countHealth, needsAttention } from "../lib/attention.ts";
import { compactNumber, moneyText, tokensText } from "../lib/format.ts";
import { seriesTotals, utcDay } from "../lib/totals.ts";
import { useAccounts, useUsageSeries } from "../queries.ts";
import { TokensChart } from "../ui/charts.tsx";
import { EmptyBlock, ErrorBlock, HealthBadge, PageHeader, Panel, ProviderLogo, RoomBar, StatCard, logoOfRunner } from "../ui/parts.tsx";

export function Overview() {
  const accounts = useAccounts();
  const series = useUsageSeries("day", "7d");
  const today = utcDay(new Date());
  const t = seriesTotals(series.data ?? [], today);
  const week = seriesTotals(series.data ?? []);
  const h = countHealth(accounts.data ?? []);
  const attention = needsAttention(accounts.data ?? []);

  return (
    <>
      <PageHeader title="Overview" description="How your accounts and passes are doing today (UTC)." />
      <SimpleGrid columns={{ base: 2, xl: 4 }} gap={{ base: "3", md: "4" }} mb="6">
        <StatCard
          label="Healthy accounts"
          icon={Users}
          loading={accounts.isPending}
          value={
            <>
              {h.ok}
              <Text as="span" fontSize="md" color="fg.subtle" fontWeight="500">
                {" "}
                / {h.total}
              </Text>
            </>
          }
          hint={h.attention === 0 ? "Nothing needs attention" : `${h.attention} need${h.attention === 1 ? "s" : ""} attention`}
        />
        <StatCard label="Passes today" icon={Activity} loading={series.isPending} value={tokensText(t.passes)} hint={`${tokensText(week.passes)} in the last 7 days`} />
        <StatCard label="Tokens today" icon={Coins} loading={series.isPending} value={compactNumber(t.tokens)} hint={`${tokensText(t.tokens)} tokens`} />
        <StatCard
          label="Cost today"
          icon={DollarSign}
          loading={series.isPending}
          value={moneyText(t.catalogCostUsd) || "$0.00"}
          hint={t.cliCostUsd === undefined ? "At catalog prices" : `At catalog prices; CLI said ${moneyText(t.cliCostUsd)}`}
        />
      </SimpleGrid>

      <Stack gap="6">
        <Panel title="Needs attention" description="Dead, cooling, or at the floor. The pool skips these accounts." flush>
          {accounts.isPending ? (
            <Stack gap="3" px="5" pb="5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} h="12" rounded="md" />
              ))}
            </Stack>
          ) : accounts.isError ? (
            <Box px="5" pb="5">
              <ErrorBlock error={accounts.error} onRetry={() => void accounts.refetch()} />
            </Box>
          ) : attention.length === 0 ? (
            <EmptyBlock compact icon={CheckCircle2} title="All accounts are fine" description="No account is dead, cooling or at its floor." />
          ) : (
            <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">
              {attention.map(({ account: a, reason }) => (
                <Link asChild key={a.account} borderBottomWidth="1px" borderColor="border.subtle" _last={{ borderBottomWidth: 0, roundedBottom: "xl" }} _hover={{ textDecoration: "none", bg: "bg.subtle" }} display="block" color="inherit">
                  <RouterLink to={`/accounts/${a.account}`}>
                    <Flex px="5" py="3" gap="4" align="center" wrap={{ base: "wrap", md: "nowrap" }}>
                      <HStack gap="3" flex="1" minW="0">
                        <ProviderLogo logoId={logoOfRunner(a.runner)} name={a.runner} />
                        <Box minW="0">
                          <Text fontSize="sm" fontWeight="500" truncate>
                            {a.account}
                          </Text>
                          <Text fontSize="xs" color="fg.muted">
                            {reason}
                          </Text>
                        </Box>
                      </HStack>
                      <HStack gap="6" flexShrink={0} w={{ base: "full", md: "auto" }}>
                        <RoomBar left={a.left5h} floor={a.floor5h} width="200px" label="5h" />
                        <RoomBar left={a.leftWeek} floor={a.floorWeek} width="200px" label="Week" />
                        <Box w="20" textAlign="right" hideBelow="md">
                          <HealthBadge health={a.health} />
                        </Box>
                      </HStack>
                    </Flex>
                  </RouterLink>
                </Link>
              ))}
            </Stack>
          )}
        </Panel>

        <Panel title="Tokens, last 7 days" description="All tokens per UTC day, by account.">
          {series.isPending ? <Skeleton h="260px" rounded="md" /> : series.isError ? <ErrorBlock error={series.error} onRetry={() => void series.refetch()} /> : series.data.length === 0 ? <EmptyBlock title="No passes in the last 7 days" /> : <TokensChart points={series.data} />}
        </Panel>
      </Stack>
    </>
  );
}
