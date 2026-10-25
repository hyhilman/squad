import { Box, Button, Flex, HStack, Link, SimpleGrid, Skeleton, Stack, Text } from "@chakra-ui/react";
import { Activity, CheckCircle2, Coins, DollarSign, TriangleAlert, Users } from "lucide-react";
import { Link as RouterLink } from "react-router";
import { countHealth, needsAttention } from "../lib/attention.ts";
import { compactNumber, moneyText, tokensText } from "../lib/format.ts";
import { seriesTotals, utcDay } from "../lib/totals.ts";
import { failedText } from "../lib/passFilter.ts";
import { TODAY_PAGE, useAccounts, useTodayPasses, useUsageSeries } from "../queries.ts";
import { TokensChart } from "../ui/charts.tsx";
import { EmptyBlock, ErrorBlock, HealthBadge, PageHeader, Panel, ProviderLogo, RoomBar, StatCard, logoOfRunner } from "../ui/parts.tsx";

export function Overview() {
  const accounts = useAccounts();
  const series = useUsageSeries("day", "7d");
  const today = utcDay(new Date());
  const todayPasses = useTodayPasses(today);
  const failed = failedText(todayPasses.data ?? [], TODAY_PAGE);
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
          to={h.attention === 0 ? "/accounts" : "/accounts?health=attention"}
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
        <StatCard
          label="Passes today"
          icon={Activity}
          to="/passes"
          loading={series.isPending}
          value={tokensText(t.passes)}
          hint={`${tokensText(week.passes)} in the last 7 days`}
          action={
            failed === "" ? undefined : (
              <Button asChild size="xs" colorPalette="red" variant="solid">
                <RouterLink to="/passes?outcome=failed">
                  <TriangleAlert size={12} aria-hidden />
                  {failed}
                </RouterLink>
              </Button>
            )
          }
        />
        <StatCard label="Tokens today" icon={Coins} to="/usage" loading={series.isPending} value={compactNumber(t.tokens)} hint={`${tokensText(t.tokens)} tokens`} />
        <StatCard
          label="Cost today"
          icon={DollarSign}
          to="/usage"
          loading={series.isPending}
          value={moneyText(t.catalogCostUsd) || "$0.00"}
          hint={t.cliCostUsd === undefined ? "At catalog prices" : `At catalog prices; CLI said ${moneyText(t.cliCostUsd)}`}
        />
      </SimpleGrid>

      <Stack gap="6">
        <Panel title="Needs attention" description="Dead, cooling, not shared or at the floor (the pool skips these), or the week resets within 3 days." flush>
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
            <EmptyBlock compact icon={CheckCircle2} title="All accounts are fine" description="No account is dead, cooling, not shared or at its floor, and no week resets soon." />
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
                      <Stack direction={{ base: "column", md: "row" }} gap={{ base: "3", md: "6" }} flexShrink={0} w={{ base: "full", md: "auto" }} align={{ base: "stretch", md: "flex-start" }}>
                        <Box w={{ base: "full", md: "200px" }} minW="0">
                          <RoomBar left={a.left5h} floor={a.floor5h} resets5h={a.resets5h} label="5h" />
                        </Box>
                        <Box w={{ base: "full", md: "200px" }} minW="0">
                          <RoomBar left={a.leftWeek} floor={a.floorWeek} label="Week" resetsWeek={a.resetsWeek} />
                        </Box>
                        <Box w="20" textAlign="right" hideBelow="md">
                          <HealthBadge health={a.health} />
                        </Box>
                      </Stack>
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
