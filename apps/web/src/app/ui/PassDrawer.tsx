// One pass in a side drawer: the facts, the prompt, what the assistant said. Text only, never HTML.
import { Box, CloseButton, Drawer, Flex, HStack, Link, Portal, Skeleton, Stack, Text } from "@chakra-ui/react";
import type { PassDetail } from "@squad/contract";
import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { Link as RouterLink } from "react-router";
import { diffText, durationText, moneyText, tokensText, totalTokens } from "../lib/format.ts";
import { usePass } from "../queries.ts";
import { CopyButton, ErrorBlock, Fact, OutcomeBadge } from "./parts.tsx";

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium" });

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <Stack gap="2">
      <HStack justify="space-between">
        <Text fontSize="xs" fontWeight="600" color="fg.muted" textTransform="uppercase" letterSpacing="0.06em">
          {title}
        </Text>
        {aside}
      </HStack>
      {children}
    </Stack>
  );
}

function TextBlock({ text, tone = "plain", maxH = "280px" }: { text: string; tone?: "plain" | "final"; maxH?: string }) {
  return (
    <Box
      as="pre"
      fontFamily="mono"
      fontSize="xs"
      lineHeight="1.6"
      whiteSpace="pre-wrap"
      overflowWrap="anywhere"
      p="3"
      rounded="lg"
      borderWidth="1px"
      borderColor={tone === "final" ? "brand.emphasized" : "border"}
      bg={tone === "final" ? "brand.subtle" : "bg.subtle"}
      maxH={maxH}
      overflowY="auto"
    >
      {text}
    </Box>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <HStack gap="2" p="3" rounded="lg" bg="bg.warning" color="fg.warning" fontSize="sm" borderWidth="1px" borderColor="orange.muted" align="flex-start">
      <Box pt="0.5">
        <Info size={15} />
      </Box>
      <Text>{children}</Text>
    </HStack>
  );
}

function Body({ p }: { p: PassDetail }) {
  const t = p.tokens;
  return (
    <Stack gap="6">
      <Box>
        <Fact label="Account">
          {p.account === undefined ? (
            <Text color="fg.subtle">none found</Text>
          ) : (
            <Link asChild color="brand.fg" fontWeight="500">
              <RouterLink to={`/accounts/${p.account}`}>{p.account}</RouterLink>
            </Link>
          )}
        </Fact>
        <Fact label="Started">{when.format(Date.parse(p.startedAt))}</Fact>
        <Fact label="Duration">{durationText(p.startedAt, p.endedAt)}</Fact>
        <Fact label="Caller">
          {p.caller.flow} · {p.caller.action}
        </Fact>
        <Fact label="Task">{p.task === undefined ? "-" : `${p.task.kind} ${p.task.id}`}</Fact>
        <Fact label="Model">
          <Text fontFamily="mono" fontSize="xs">
            {p.model}
          </Text>
        </Fact>
        {p.failKind === undefined && p.failCode === undefined ? null : (
          <Fact label="Failure">
            {p.failKind ?? ""} {p.failCode === undefined ? "" : <Text as="span" fontFamily="mono" fontSize="xs">({p.failCode})</Text>}
          </Fact>
        )}
      </Box>

      <Section title="Tokens">
        <Box>
          <Fact label="Input">{tokensText(t.input)}</Fact>
          <Fact label="Output">{tokensText(t.output)}</Fact>
          <Fact label="Cache read">{tokensText(t.cacheRead)}</Fact>
          <Fact label="Cache write">{tokensText(t.cacheWrite)}</Fact>
          <Fact label="Reasoning">{tokensText(t.reasoning)}</Fact>
          <Fact label="Total">
            <Text fontWeight="600">{tokensText(totalTokens(t))}</Text>
          </Fact>
        </Box>
      </Section>

      <Section title="Cost">
        <Box>
          <Fact label="CLI cost">{moneyText(p.cliCostUsd) || "-"}</Fact>
          <Fact label="Catalog cost">{moneyText(p.catalogCostUsd) || "-"}</Fact>
          <Fact label="Catalog minus CLI">{diffText(p.cliCostUsd, p.catalogCostUsd) || "-"}</Fact>
        </Box>
      </Section>

      {p.expired === true ? <Note>The prompt or the stream was cleaned up by age, so part of this pass is gone.</Note> : null}
      {p.truncated === true ? <Note>The prompt or the transcript was cut at 256 KB.</Note> : null}

      <Section title="Prompt" aside={p.prompt === undefined ? null : <CopyButton value={p.prompt} label="Copy the prompt" />}>
        {p.prompt === undefined ? <Text fontSize="sm" color="fg.subtle">Not kept for this pass.</Text> : <TextBlock text={p.prompt} />}
      </Section>

      <Section title="Transcript">
        {p.transcript === undefined ? (
          <Text fontSize="sm" color="fg.subtle">{p.hasTranscript ? "Not loaded." : "Not kept for this pass."}</Text>
        ) : (
          <Stack gap="2">
            {p.transcript.texts.map((x, i) => (
              <TextBlock key={i} text={x} maxH="200px" />
            ))}
            <Text fontSize="xs" color="fg.muted" mt="1">
              Final answer
            </Text>
            <TextBlock text={p.transcript.final === "" ? "(empty)" : p.transcript.final} tone="final" maxH="360px" />
          </Stack>
        )}
      </Section>
    </Stack>
  );
}

export function PassDrawer({ passId, onClose }: { passId: string | undefined; onClose: () => void }) {
  const q = usePass(passId);
  return (
    <Drawer.Root open={passId !== undefined} onOpenChange={(d) => !d.open && onClose()} placement="end" size={{ base: "full", md: "md" }}>
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content>
            <Drawer.Header borderBottomWidth="1px" borderColor="border.subtle" pb="4">
              <Stack gap="1.5" minW="0" pr="8">
                <HStack gap="2">
                  <Drawer.Title fontSize="md" flex="none">
                    Pass
                  </Drawer.Title>
                  {q.data === undefined ? null : <OutcomeBadge outcome={q.data.outcome} />}
                </HStack>
                <Text fontFamily="mono" fontSize="xs" color="fg.muted" truncate>
                  {passId}
                </Text>
              </Stack>
            </Drawer.Header>
            <Drawer.Body py="5">
              {q.isPending ? (
                <Stack gap="3">
                  {Array.from({ length: 8 }, (_, i) => (
                    <Flex key={i} justify="space-between">
                      <Skeleton h="4" w="24" />
                      <Skeleton h="4" w="32" />
                    </Flex>
                  ))}
                  <Skeleton h="40" mt="4" rounded="lg" />
                </Stack>
              ) : q.isError ? (
                <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
              ) : (
                <Body p={q.data} />
              )}
            </Drawer.Body>
            <Drawer.CloseTrigger asChild top="4" insetEnd="4">
              <CloseButton size="sm" />
            </Drawer.CloseTrigger>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}
