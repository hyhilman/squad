import { Badge, Box, Button, Flex, HStack, Link, Skeleton, Stack, Table, Text } from "@chakra-ui/react";
import type { CatalogModelView } from "@squad/contract";
import { ArrowDown, ArrowUp, ArrowUpDown, BookOpen, ChevronLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { Link as RouterLink, useParams } from "react-router";
import { cheapestIds, contextText, modelPath, perMillionText, sortModels, type ModelSort, type PriceColumn } from "../lib/catalog.ts";
import { useCatalogProvider } from "../queries.ts";
import { AddAccount } from "../ui/AddAccount.tsx";
import { EmptyBlock, ErrorBlock, Hint, InUseBadge, PageHeader, Panel, ProviderLogo, RunnerBadge } from "../ui/parts.tsx";

const PRICE_COLS: { key: PriceColumn; label: string }[] = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cacheRead", label: "Cache read" },
  { key: "cacheWrite", label: "Cache write" },
];

export function BackToCatalog() {
  return (
    <Link asChild fontSize="sm" color="fg.muted" mb="3" _hover={{ color: "fg" }} display="inline-flex" alignItems="center" gap="1">
      <RouterLink to="/catalog">
        <ChevronLeft size={15} /> Catalog
      </RouterLink>
    </Link>
  );
}

/** A price cell: the cheapest of its column gets a soft green. */
/** `bleed`: in a table cell the green pad reaches past the text, so the numbers stay in line. */
export function PriceCell({ v, cheapest, bleed = true }: { v: number | undefined; cheapest: boolean; bleed?: boolean }) {
  return (
    <Box
      as="span"
      display="inline-block"
      px="1.5"
      py="0.5"
      mx={bleed ? "-1.5" : "0"}
      rounded="md"
      fontVariantNumeric="tabular-nums"
      color={v === undefined ? "fg.subtle" : cheapest ? "green.fg" : "fg"}
      bg={cheapest ? "green.subtle" : undefined}
      fontWeight={cheapest ? "600" : undefined}
      title={cheapest ? "The lowest price in this column" : undefined}
    >
      {perMillionText(v)}
    </Box>
  );
}

function SortHead({ col, label, sort, onSort, end = false, first = false }: { col: ModelSort; label: string; sort: { key: ModelSort; dir: "asc" | "desc" }; onSort: (k: ModelSort) => void; end?: boolean; first?: boolean }) {
  const on = sort.key === col;
  const Icon = !on ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <Table.ColumnHeader ps={first ? "5" : undefined} textAlign={end ? "end" : undefined} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : undefined} whiteSpace="nowrap">
      <Button variant="plain" size="xs" px="0" h="auto" minW="0" fontSize="inherit" fontWeight="inherit" color="inherit" onClick={() => onSort(col)} gap="1">
        {label}
        <Box opacity={on ? 1 : 0.5}>
          <Icon size={12} />
        </Box>
      </Button>
    </Table.ColumnHeader>
  );
}

function OthersLink({ m }: { m: CatalogModelView }) {
  if (m.otherProviders === 0) {
    return (
      <Text as="span" fontSize="sm" color="fg.subtle">
        only here
      </Text>
    );
  }
  return (
    <Link asChild fontSize="sm" color="brand.fg" whiteSpace="nowrap">
      <RouterLink to={modelPath(m.id)}>
        {m.otherProviders} other provider{m.otherProviders === 1 ? "" : "s"}
      </RouterLink>
    </Link>
  );
}

function ModelName({ m }: { m: CatalogModelView }) {
  return (
    <Box minW="0">
      <HStack gap="2">
        <Text fontSize="sm" fontWeight="500" truncate>
          {m.name}
        </Text>
        {m.reasoning ? (
          <Badge size="xs" colorPalette="purple" variant="subtle" flexShrink={0}>
            reasoning
          </Badge>
        ) : null}
      </HStack>
      <Text fontSize="xs" color="fg.subtle" fontFamily="mono" truncate>
        {m.id}
      </Text>
    </Box>
  );
}

export function CatalogProvider() {
  const id = useParams().provider ?? "";
  const q = useCatalogProvider(id);
  const [sort, setSort] = useState<{ key: ModelSort; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const models = useMemo(() => sortModels(q.data?.models ?? [], sort.key, sort.dir), [q.data, sort]);
  const cheap = useMemo(() => Object.fromEntries(PRICE_COLS.map((c) => [c.key, cheapestIds(q.data?.models ?? [], c.key)])) as Record<PriceColumn, Set<string>>, [q.data]);
  const onSort = (k: ModelSort) => setSort((s) => (s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: "asc" }));

  if (q.isPending) {
    return (
      <Stack gap="4">
        <Skeleton h="16" rounded="xl" />
        <Skeleton h="72" rounded="xl" />
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
  const p = q.data.provider;
  return (
    <>
      <Box>
        <BackToCatalog />
      </Box>
      <PageHeader
        title={
          <HStack gap="3" minW="0">
            <ProviderLogo logoId={p.id} name={p.name} size={10} />
            <Box minW="0">
              <HStack gap="2" minW="0">
                <Text as="span" truncate>
                  {p.name}
                </Text>
                <RunnerBadge runner={p.runner} />
                {p.accounts > 0 ? <InUseBadge n={p.accounts} /> : null}
              </HStack>
            </Box>
          </HStack>
        }
        description={`${p.models} model${p.models === 1 ? "" : "s"}, prices in dollars per 1M tokens. Runs on ${p.runner}.`}
        actions={
          p.offered && p.addAs !== undefined ? (
            <AddAccount preselect={p.addAs} />
          ) : (
            <Hint text="squad does not offer this provider for new accounts here.">
              <Button size="sm" variant="outline" disabled>
                Not offered
              </Button>
            </Hint>
          )
        }
      />
      <Panel flush overflow="hidden">
        {models.length === 0 ? (
          <EmptyBlock icon={BookOpen} title="No models" description="The catalog lists no priced model for this provider." />
        ) : (
          <>
            {/* Phone: one card per model, in the chosen order. */}
            <Stack hideFrom="md" gap="0">
              {models.map((m) => (
                <Box key={m.id} px="4" py="3.5" borderBottomWidth="1px" borderColor="border.subtle" _last={{ borderBottomWidth: 0 }}>
                  <ModelName m={m} />
                  <Flex mt="2" gap="4" rowGap="1" wrap="wrap" fontSize="sm">
                    <Text color="fg.muted">
                      In <PriceCell v={m.price?.input} cheapest={cheap.input.has(m.id)} bleed={false} />
                    </Text>
                    <Text color="fg.muted">
                      Out <PriceCell v={m.price?.output} cheapest={cheap.output.has(m.id)} bleed={false} />
                    </Text>
                    <Text color="fg.muted">Context {contextText(m.context)}</Text>
                  </Flex>
                  <Box mt="1.5">
                    <OthersLink m={m} />
                  </Box>
                </Box>
              ))}
            </Stack>
            <Table.ScrollArea hideBelow="md">
              <Table.Root size="md">
                <Table.Header>
                  <Table.Row bg="bg.subtle">
                    <SortHead col="name" label="Model" sort={sort} onSort={onSort} first />
                    <SortHead col="context" label="Context" sort={sort} onSort={onSort} end />
                    {PRICE_COLS.map((c) => (
                      <SortHead key={c.key} col={c.key} label={c.label} sort={sort} onSort={onSort} end />
                    ))}
                    <Table.ColumnHeader pe="5" textAlign="end">
                      Compare
                    </Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {models.map((m) => (
                    <Table.Row key={m.id}>
                      <Table.Cell ps="5" py="3" maxW="72">
                        <ModelName m={m} />
                      </Table.Cell>
                      <Table.Cell textAlign="end" fontSize="sm" color="fg.muted" fontVariantNumeric="tabular-nums">
                        {contextText(m.context)}
                      </Table.Cell>
                      {PRICE_COLS.map((c) => (
                        <Table.Cell key={c.key} textAlign="end" fontSize="sm">
                          <PriceCell v={m.price?.[c.key]} cheapest={cheap[c.key].has(m.id)} />
                        </Table.Cell>
                      ))}
                      <Table.Cell pe="5" textAlign="end">
                        <OthersLink m={m} />
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
