// The pass history: filters, a table, paging with the `before` cursor, and the pass drawer. The open
// pass is in the URL (?pass=<id>), so a link to it can be shared or reloaded.
import { Box, Button, Flex, HStack, NativeSelect, Skeleton, Table, Text } from "@chakra-ui/react";
import type { PassView } from "@squad/contract";
import { ChevronLeft, ChevronRight, History } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { diffText, diffTone, moneyText, TONE_COLOR, tokensText, totalTokens } from "../lib/format.ts";
import { filterPasses, outcomeFromParam, type OutcomeGroup } from "../lib/passFilter.ts";
import { useAccounts, usePasses } from "../queries.ts";
import { PassDrawer } from "./PassDrawer.tsx";
import { EmptyBlock, ErrorBlock, OutcomeBadge, Panel } from "./parts.tsx";

const PAGE = 50;
const time = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <NativeSelect.Root size="sm" w={{ base: "full", sm: "auto" }} minW="40">
      <NativeSelect.Field aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} bg="surface">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  );
}

const num = { textAlign: "end", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } as const;

function Rows({ rows, onOpen, showAccount }: { rows: readonly PassView[]; onOpen: (id: string) => void; showAccount: boolean }) {
  return (
    <Table.ScrollArea>
      <Table.Root size="sm" interactive>
        <Table.Header>
          <Table.Row bg="bg.subtle">
            <Table.ColumnHeader ps="5">Time</Table.ColumnHeader>
            {showAccount ? <Table.ColumnHeader>Account</Table.ColumnHeader> : null}
            <Table.ColumnHeader hideBelow="lg">Caller and task</Table.ColumnHeader>
            <Table.ColumnHeader hideBelow="md">Model</Table.ColumnHeader>
            <Table.ColumnHeader>Outcome</Table.ColumnHeader>
            <Table.ColumnHeader {...num}>Tokens</Table.ColumnHeader>
            <Table.ColumnHeader {...num} hideBelow="md">CLI cost</Table.ColumnHeader>
            <Table.ColumnHeader {...num} hideBelow="md">Catalog</Table.ColumnHeader>
            <Table.ColumnHeader {...num} hideBelow="lg" pe="5">
              Diff
            </Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((p) => (
            <Table.Row key={p.passId} cursor="pointer" onClick={() => onOpen(p.passId)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(p.passId)} _focusVisible={{ outline: "2px solid", outlineColor: "brand.focusRing", outlineOffset: "-2px" }}>
              <Table.Cell ps="5" whiteSpace="nowrap" color="fg.muted" fontVariantNumeric="tabular-nums" title={p.startedAt}>
                {time.format(Date.parse(p.startedAt))}
              </Table.Cell>
              {showAccount ? (
                <Table.Cell fontWeight="500" whiteSpace="nowrap">
                  {p.account ?? <Text as="span" color="fg.subtle">none</Text>}
                  {p.accountRemoved === true ? (
                    <Text as="span" color="fg.subtle" fontWeight="400">
                      {" "}
                      (removed)
                    </Text>
                  ) : null}
                </Table.Cell>
              ) : null}
              <Table.Cell hideBelow="lg" maxW="52">
                <Text whiteSpace="nowrap" truncate>
                  {p.caller.flow} · {p.caller.action}
                </Text>
                <Text fontSize="xs" color="fg.muted" truncate>
                  {p.task === undefined ? "no task" : p.task.id}
                </Text>
              </Table.Cell>
              <Table.Cell hideBelow="md" fontFamily="mono" fontSize="xs" color="fg.muted" whiteSpace="nowrap">
                {p.model}
              </Table.Cell>
              <Table.Cell>
                <OutcomeBadge outcome={p.outcome} />
              </Table.Cell>
              <Table.Cell {...num}>{tokensText(totalTokens(p.tokens))}</Table.Cell>
              <Table.Cell {...num} hideBelow="md" color="fg.muted">
                {moneyText(p.cliCostUsd) || "-"}
              </Table.Cell>
              <Table.Cell {...num} hideBelow="md">
                {moneyText(p.catalogCostUsd) || "-"}
              </Table.Cell>
              <Table.Cell {...num} hideBelow="lg" color={TONE_COLOR[diffTone(p.cliCostUsd, p.catalogCostUsd)]} pe="5">
                {diffText(p.cliCostUsd, p.catalogCostUsd) || "-"}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Table.ScrollArea>
  );
}

export function PassesBrowser({ account: fixedAccount }: { account?: string }) {
  const [params, setParams] = useSearchParams();
  const accounts = useAccounts();
  const [account, setAccount] = useState("");
  const [runner, setRunner] = useState("");
  // A link such as the overview's "3 failed" opens this page with ?outcome=failed.
  const [outcome, setOutcome] = useState<string>(() => outcomeFromParam(params.get("outcome")));
  // The cursors of the pages before this one; the last is this page's `before`.
  const [cursors, setCursors] = useState<string[]>([]);
  const before = cursors.at(-1);
  const which = fixedAccount ?? (account === "" ? undefined : account);
  const q = usePasses(which, before, PAGE);
  const shown = filterPasses(q.data ?? [], { ...(runner === "" ? {} : { runner }), ...(outcome === "" ? {} : { outcome: outcome as OutcomeGroup }) });
  const passId = params.get("pass") ?? undefined;
  const open = (id: string) =>
    setParams((p) => {
      p.set("pass", id);
      return p;
    });
  const close = () =>
    setParams((p) => {
      p.delete("pass");
      return p;
    });
  const runners = [...new Set((accounts.data ?? []).map((a) => a.runner))].sort();
  const localFilter = runner !== "" || outcome !== "";

  return (
    <>
      <Flex gap="2" mb="4" wrap="wrap" align="center">
        {fixedAccount === undefined ? (
          <Select
            label="Account"
            value={account}
            onChange={(v) => {
              setAccount(v);
              setCursors([]);
            }}
            options={[{ value: "", label: "All accounts" }, ...(accounts.data ?? []).map((a) => ({ value: a.account, label: a.account }))]}
          />
        ) : null}
        {fixedAccount === undefined ? (
          <Select label="Runner" value={runner} onChange={setRunner} options={[{ value: "", label: "All runners" }, ...runners.map((r) => ({ value: r, label: r }))]} />
        ) : null}
        <Select
          label="Outcome"
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: "", label: "All outcomes" },
            { value: "ok", label: "ok" },
            { value: "failed", label: "failed" },
            { value: "lost", label: "lost" },
            { value: "running", label: "running" },
          ]}
        />
        {localFilter ? (
          <Text fontSize="xs" color="fg.subtle">
            Runner and outcome filter this page only.
          </Text>
        ) : null}
      </Flex>

      <Panel flush overflow="hidden">
        {q.isPending ? (
          <Box p="5">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} h="5" my="3" rounded="sm" />
            ))}
          </Box>
        ) : q.isError ? (
          <Box p="5">
            <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
          </Box>
        ) : shown.length === 0 ? (
          <EmptyBlock icon={History} title={q.data.length === 0 ? "No passes yet" : "No pass on this page matches"} description={q.data.length === 0 ? "A pass shows here once a flow runs an agent on an account." : "Change the filters, or look at older passes."} />
        ) : (
          <Rows rows={shown} onOpen={open} showAccount={fixedAccount === undefined} />
        )}
        <Flex justify="space-between" align="center" px="5" py="3" borderTopWidth="1px" borderColor="border.subtle" bg="bg.subtle">
          <Text fontSize="xs" color="fg.muted" fontVariantNumeric="tabular-nums">
            {q.data === undefined ? "" : `Page ${cursors.length + 1} · ${shown.length} of ${q.data.length} shown`}
          </Text>
          <HStack gap="2">
            <Button size="xs" variant="outline" colorPalette="gray" bg="surface" disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
              <ChevronLeft size={14} /> Newer
            </Button>
            <Button
              size="xs"
              variant="outline"
              colorPalette="gray"
              bg="surface"
              disabled={q.data === undefined || q.data.length < PAGE}
              onClick={() => {
                const last = q.data?.at(-1);
                if (last !== undefined) setCursors((c) => [...c, last.passId]);
              }}
            >
              Older <ChevronRight size={14} />
            </Button>
          </HStack>
        </Flex>
      </Panel>
      <PassDrawer passId={passId} onClose={close} />
    </>
  );
}
