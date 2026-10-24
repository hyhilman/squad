import { Badge, Box, Flex, HStack, Link, Skeleton, Stack, Table, Text } from "@chakra-ui/react";
import type { CatalogOffer } from "@squad/contract";
import { Link as RouterLink, useParams } from "react-router";
import { contextText, perMillionText, providerPath } from "../lib/catalog.ts";
import { useCatalogModel } from "../queries.ts";
import { PriceHistoryChart } from "../ui/charts.tsx";
import { ErrorBlock, PageHeader, Panel, ProviderLogo, RunnerBadge } from "../ui/parts.tsx";
import { BackToCatalog, PriceCell } from "./CatalogProvider.tsx";

function Status({ o, alone }: { o: CatalogOffer; alone: boolean }) {
  return (
    <HStack gap="1.5" wrap="wrap" justify={{ md: "flex-end" }}>
      {o.cheapest && !alone ? (
        <Badge size="sm" colorPalette="green" variant="solid">
          Cheapest
        </Badge>
      ) : null}
      {o.accounts > 0 ? (
        <Badge size="sm" colorPalette="green" variant="subtle">
          You have an account{o.accounts > 1 ? ` · ${o.accounts}` : ""}
        </Badge>
      ) : null}
      {o.offered ? (
        <Badge size="sm" colorPalette="brand" variant="subtle">
          Offered
        </Badge>
      ) : (
        <Badge size="sm" variant="outline" color="fg.subtle">
          Not offered
        </Badge>
      )}
    </HStack>
  );
}

function ProviderName({ o }: { o: CatalogOffer }) {
  return (
    <HStack gap="3" minW="0">
      <ProviderLogo logoId={o.provider} name={o.providerName} />
      <Box minW="0">
        <Link asChild fontSize="sm" fontWeight="500" color="fg" _hover={{ color: "brand.fg" }}>
          <RouterLink to={providerPath(o.provider)}>{o.providerName}</RouterLink>
        </Link>
        <HStack gap="1.5">
          <Text fontSize="xs" color="fg.subtle" fontFamily="mono" truncate>
            {o.provider}
          </Text>
          <RunnerBadge runner={o.runner} />
        </HStack>
      </Box>
    </HStack>
  );
}

export function CatalogModel() {
  // A splat, not a :param: a model id may hold a slash.
  const modelId = useParams()["*"] ?? "";
  const q = useCatalogModel(modelId);

  if (q.isPending) {
    return (
      <Stack gap="4">
        <Skeleton h="16" rounded="xl" />
        <Skeleton h="60" rounded="xl" />
      </Stack>
    );
  }
  if (q.isError) {
    return (
      <>
        <BackToCatalog />
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const m = q.data;
  const names = Object.fromEntries(m.offers.map((o) => [o.provider, o.providerName]));
  const best = m.offers.find((o) => o.cheapest);
  // With one provider there is nothing to compare, so no row is marked cheapest.
  const alone = m.offers.length < 2;
  return (
    <>
      <Box>
        <BackToCatalog />
      </Box>
      <PageHeader
        title={m.name}
        description={
          <>
            <Text as="span" fontFamily="mono">
              {m.modelId}
            </Text>
            {` · ${m.offers.length} provider${m.offers.length === 1 ? "" : "s"}`}
            {best?.price == null ? "" : ` · from ${perMillionText(best.price.input)}${best.price.input === 0 ? "" : " / 1M in"} at ${best.providerName}`}
          </>
        }
      />
      <Panel title="Providers" description="Cheapest input price first. Prices in dollars per 1M tokens." flush overflow="hidden" mb="6">
        <Stack hideFrom="md" gap="0">
          {m.offers.map((o) => (
            <Box key={o.provider} px="4" py="3.5" borderTopWidth="1px" borderColor="border.subtle" bg={o.cheapest && !alone ? "green.subtle/40" : undefined}>
              <ProviderName o={o} />
              <Flex mt="2" gap="4" rowGap="1" wrap="wrap" fontSize="sm" color="fg.muted">
                <Text>
                  In <PriceCell v={o.price?.input} cheapest={false} />
                </Text>
                <Text>
                  Out <PriceCell v={o.price?.output} cheapest={false} />
                </Text>
                <Text>Context {contextText(o.context)}</Text>
              </Flex>
              <Box mt="2">
                <Status o={o} alone={alone} />
              </Box>
            </Box>
          ))}
        </Stack>
        <Table.ScrollArea hideBelow="md">
          <Table.Root size="md">
            <Table.Header>
              <Table.Row bg="bg.subtle">
                <Table.ColumnHeader ps="5">Provider</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Input</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Output</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Cache read</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Cache write</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Context</Table.ColumnHeader>
                <Table.ColumnHeader pe="5" textAlign="end" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {m.offers.map((o) => (
                <Table.Row key={o.provider} bg={o.cheapest && !alone ? "green.subtle/40" : undefined}>
                  <Table.Cell ps="5" py="3">
                    <ProviderName o={o} />
                  </Table.Cell>
                  {(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => (
                    <Table.Cell key={k} textAlign="end" fontSize="sm" fontVariantNumeric="tabular-nums" fontWeight={o.cheapest && !alone && k === "input" ? "600" : undefined} color={o.price?.[k] === undefined ? "fg.subtle" : undefined}>
                      {perMillionText(o.price?.[k])}
                    </Table.Cell>
                  ))}
                  <Table.Cell textAlign="end" fontSize="sm" color="fg.muted" fontVariantNumeric="tabular-nums">
                    {contextText(o.context)}
                  </Table.Cell>
                  <Table.Cell pe="5" textAlign="end">
                    <Status o={o} alone={alone} />
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Table.ScrollArea>
      </Panel>
      {m.history.length > 1 ? (
        <Panel title="Input price history" description="The input price per 1M tokens each time squad saw it change, over the last 90 days.">
          <PriceHistoryChart history={m.history} names={names} />
        </Panel>
      ) : null}
      {m.offers.length === 1 ? (
        <Text fontSize="sm" color="fg.muted">
          Only one provider lists this exact model id. squad matches models by their exact id, so the same model under another id is not shown here.
        </Text>
      ) : null}
    </>
  );
}
