import { Box, Flex, HStack, Input, InputGroup, LinkBox, LinkOverlay, SimpleGrid, Skeleton, Text } from "@chakra-ui/react";
import type { CatalogProviderView } from "@squad/contract";
import { BookOpen, ChevronRight, Search } from "lucide-react";
import { useState } from "react";
import { Link as RouterLink } from "react-router";
import { filterProviders, perMillionText, providerPath, runnersOf, type ProviderFilter } from "../lib/catalog.ts";
import { useCatalogProviders } from "../queries.ts";
import { Chip, EmptyBlock, ErrorBlock, InUseBadge, PageHeader, ProviderLogo, RunnerBadge } from "../ui/parts.tsx";

function ProviderCard({ p }: { p: CatalogProviderView }) {
  return (
    <LinkBox
      bg="surface"
      borderWidth="1px"
      borderColor="border"
      rounded="xl"
      shadow="xs"
      p="4"
      minW="0"
      transition="border-color 0.15s, box-shadow 0.15s"
      _hover={{ borderColor: "border.emphasized", shadow: "sm" }}
    >
      <HStack gap="3" align="flex-start" minW="0">
        <ProviderLogo logoId={p.id} name={p.name} size={10} />
        <Box flex="1" minW="0">
          <HStack gap="2" minW="0">
            <LinkOverlay asChild>
              <RouterLink to={providerPath(p.id)}>
                <Text fontSize="sm" fontWeight="600" truncate>
                  {p.name}
                </Text>
              </RouterLink>
            </LinkOverlay>
            <RunnerBadge runner={p.runner} />
          </HStack>
          <Text fontSize="xs" color="fg.subtle" fontFamily="mono" truncate>
            {p.id}
          </Text>
        </Box>
        <Box color="fg.subtle" flexShrink={0} pt="0.5">
          <ChevronRight size={15} aria-hidden />
        </Box>
      </HStack>
      <Flex mt="4" justify="space-between" align="center" gap="2" wrap="wrap">
        <Text fontSize="sm" color="fg.muted" fontVariantNumeric="tabular-nums">
          {p.models} model{p.models === 1 ? "" : "s"}
          {p.cheapest === undefined ? null : (
            <>
              {" · from "}
              <Text as="span" color="fg" fontWeight="500">
                {perMillionText(p.cheapest.input)}
              </Text>
              {p.cheapest.input === 0 ? null : " / 1M in"}
            </>
          )}
        </Text>
        {p.accounts > 0 ? <InUseBadge n={p.accounts} /> : null}
      </Flex>
    </LinkBox>
  );
}

export function Catalog() {
  const providers = useCatalogProviders();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<ProviderFilter>("all");
  const list = providers.data ?? [];
  const shown = filterProviders(list, q, filter);
  const inUse = list.filter((p) => p.accounts > 0).length;

  return (
    <>
      <PageHeader title="Catalog" description="The providers and models in squad's copy of the model catalog, with their prices per 1M tokens." />
      <Flex gap="3" mb="5" wrap="wrap" align="center">
        <InputGroup startElement={<Search size={15} />} w={{ base: "full", md: "64" }}>
          <Input size="sm" placeholder="Search providers" value={q} onChange={(e) => setQ(e.target.value)} bg="surface" />
        </InputGroup>
        <HStack gap="1.5" wrap="wrap">
          <Chip active={filter === "all"} onClick={() => setFilter("all")}>
            All
          </Chip>
          <Chip active={filter === "in-use"} onClick={() => setFilter(filter === "in-use" ? "all" : "in-use")}>
            In use{inUse > 0 ? ` · ${inUse}` : ""}
          </Chip>
          <Box w="1px" h="5" bg="border" mx="1" />
          {runnersOf(list).map((r) => (
            <Chip key={r} active={filter === r} onClick={() => setFilter(filter === r ? "all" : r)}>
              {r}
            </Chip>
          ))}
        </HStack>
      </Flex>
      {providers.isPending ? (
        <SimpleGrid columns={{ base: 1, sm: 2, lg: 3 }} gap="4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} h="28" rounded="xl" />
          ))}
        </SimpleGrid>
      ) : providers.isError ? (
        <ErrorBlock error={providers.error} onRetry={() => void providers.refetch()} />
      ) : list.length === 0 ? (
        <EmptyBlock icon={BookOpen} title="No catalog yet" description="squad has no saved copy of the catalog. It fetches one in the background; check again later." />
      ) : shown.length === 0 ? (
        <EmptyBlock icon={Search} title="No provider matches" description="Change the search or the filter." />
      ) : (
        <SimpleGrid columns={{ base: 1, sm: 2, lg: 3 }} gap="4">
          {shown.map((p) => (
            <ProviderCard key={p.id} p={p} />
          ))}
        </SimpleGrid>
      )}
    </>
  );
}
