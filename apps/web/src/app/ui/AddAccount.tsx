// Add an account in steps: pick a provider, name it (and give the key or token), then follow the login.
// A secret lives only in this dialog while it is open; closing it clears it.
import { Badge, Box, useBreakpointValue, Button, Code, CloseButton, Dialog, Field, Flex, HStack, Input, InputGroup, Link, Portal, RadioCard, SimpleGrid, Skeleton, Stack, Text } from "@chakra-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConnectStart, ConnectStatus, LoginStart, LoginStatus, ProviderView } from "@squad/contract";
import { ArrowLeft, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink } from "react-router";
import { providerPath } from "../lib/catalog.ts";
import { api } from "../api.ts";
import { accountNameError, suggestName } from "../lib/accountName.ts";
import { CLAUDE_WAYS, submitTextFor, wayNeedsSecret, type ClaudeWay } from "../lib/connect.ts";
import { accountPrefix, addBody, logoIdOf, pickerGroups, providerSub, secretError, secretField, type PickerItem } from "../lib/providers.ts";
import { useMe, useProviders } from "../queries.ts";
import { ConnectProgress } from "./ConnectProgress.tsx";
import { LoginProgress } from "./LoginProgress.tsx";
import { EmptyBlock, ErrorBlock, ProviderLogo } from "./parts.tsx";
import { toastOk } from "./toaster.tsx";

/** A hint's `quoted` parts as code; plain text only, never HTML. */
const codeSpans = (text: string) =>
  text.split("`").map((part, i) =>
    i % 2 === 1 ? (
      <Code key={i} size="sm">
        {part}
      </Code>
    ) : (
      part
    ),
  );

function Tile({ item, onPick, onLeave }: { item: PickerItem; onPick: () => void; onLeave: () => void }) {
  // The pick button covers the tile (its ::before); the details link sits above it, so the two never nest.
  return (
    <Box
      position="relative"
      p="3"
      rounded="lg"
      borderWidth="1px"
      borderColor="border"
      bg="surface"
      transition="border-color 0.12s, background 0.12s, box-shadow 0.12s"
      _hover={{ borderColor: "brand.border", bg: "brand.subtle/40" }}
      _focusWithin={{ outline: "2px solid", outlineColor: "brand.focusRing", outlineOffset: "1px" }}
      minW="0"
    >
      <HStack gap="3" minW="0">
        <ProviderLogo logoId={item.logoId} name={item.name} size={9} />
        <Box minW="0" flex="1">
          <Box
            as="button"
            onClick={onPick}
            textAlign="left"
            display="block"
            w="full"
            fontSize="sm"
            fontWeight="500"
            truncate
            outline="none"
            _before={{ content: '""', position: "absolute", inset: "0", rounded: "lg" }}
          >
            {item.name}
          </Box>
          <HStack gap="1.5" minW="0" fontSize="xs">
            <Text color="fg.muted" truncate>
              {item.sub}
            </Text>
            {item.catalogId === undefined ? null : (
              <>
                <Text color="fg.subtle">·</Text>
                <Link asChild position="relative" zIndex="1" color="fg.muted" textDecoration="underline" textDecorationColor="border.emphasized" textUnderlineOffset="2px" _hover={{ color: "brand.fg" }} flexShrink={0}>
                  <RouterLink to={providerPath(item.catalogId)} onClick={onLeave} aria-label={`${item.name} details`}>
                    details
                  </RouterLink>
                </Link>
              </>
            )}
          </HStack>
        </Box>
        {item.accounts > 0 ? (
          <Badge size="sm" variant="subtle" flexShrink={0} fontVariantNumeric="tabular-nums">
            {item.accounts}
          </Badge>
        ) : null}
      </HStack>
    </Box>
  );
}

function Picker({ providers, onPick, onLeave }: { providers: readonly ProviderView[]; onPick: (p: ProviderView) => void; onLeave: () => void }) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => pickerGroups(providers, q), [providers, q]);
  return (
    <Stack gap="5">
      <InputGroup startElement={<Search size={15} />}>
        <Input placeholder="Search providers" value={q} onChange={(e) => setQ(e.target.value)} autoFocus size="md" />
      </InputGroup>
      {groups.length === 0 ? (
        <EmptyBlock icon={Search} title="No provider matches" description="Try another name, or clear the search." />
      ) : (
        groups.map((g) => (
          <Stack key={g.label} gap="2">
            <HStack gap="2">
              <Text fontSize="xs" fontWeight="600" color="fg.muted" textTransform="uppercase" letterSpacing="0.06em">
                {g.label}
              </Text>
              <Text fontSize="xs" color="fg.subtle">
                {g.items.length}
              </Text>
            </HStack>
            <SimpleGrid columns={{ base: 1, sm: 2, md: 3 }} gap="2">
              {g.items.map((i) => (
                <Tile key={i.id} item={i} onPick={() => onPick(providers.find((p) => p.id === i.id)!)} onLeave={onLeave} />
              ))}
            </SimpleGrid>
          </Stack>
        ))
      )}
    </Stack>
  );
}

function Chosen({ p, onChange }: { p: ProviderView; onChange: () => void }) {
  return (
    <HStack gap="3" p="3" rounded="lg" bg="bg.subtle" borderWidth="1px" borderColor="border">
      <ProviderLogo logoId={logoIdOf(p)} name={p.name} size={9} />
      <Box flex="1" minW="0">
        <Text fontSize="sm" fontWeight="500" truncate>
          {p.name}
        </Text>
        <Text fontSize="xs" color="fg.muted">
          {providerSub(p)}
        </Text>
      </Box>
      <Button size="xs" variant="ghost" onClick={onChange}>
        Change
      </Button>
    </HStack>
  );
}

/**
 * `preselect`: a ProviderView id (such as `codex` or `engy`) to start on step 2 with. It is used once,
 * when the dialog opens, so Change and Back still go to the list.
 */
export function AddAccount({ preselect }: { preselect?: string } = {}) {
  const qc = useQueryClient();
  const me = useMe().data;
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<ProviderView>();
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [way, setWay] = useState<ClaudeWay>("signin");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [start, setStart] = useState<LoginStart>();
  const [connect, setConnect] = useState<ConnectStart>();
  const [final, setFinal] = useState<LoginStatus | ConnectStatus>();
  const providers = useProviders(open);
  const [pending, setPending] = useState<string>();
  useEffect(() => {
    if (pending === undefined || providers.data === undefined) return;
    const p = providers.data.find((x) => x.id === pending);
    if (p !== undefined) setProvider(p);
    setPending(undefined);
  }, [pending, providers.data]);
  const suggested = suggestName(me?.email);
  const size = useBreakpointValue({ base: "full", md: "xl" } as const) ?? "xl";

  const reset = () => {
    setProvider(undefined);
    setName("");
    setSecret("");
    setWay("signin");
    setTouched(false);
    setError(undefined);
    setStart(undefined);
    setConnect(undefined);
    setFinal(undefined);
  };
  const close = () => {
    setOpen(false);
    reset();
    void qc.invalidateQueries({ queryKey: ["accounts"] });
    void qc.invalidateQueries({ queryKey: ["catalog"] });
  };

  const usedName = name === "" ? suggested : name;
  const nameErr = accountNameError(usedName);
  // claude: only the token way needs a secret; pi always does.
  const needsSecret = provider !== undefined && (provider.runner === "pi" || (provider.runner === "claude" && wayNeedsSecret(way)));
  const field = secretField(provider);
  const secretErr = needsSecret ? secretError(secret) : undefined;
  const step = provider === undefined ? 1 : start === undefined && connect === undefined ? 2 : 3;

  const submit = async () => {
    setTouched(true);
    if (provider === undefined || nameErr !== undefined || secretErr !== undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      if (provider.runner === "claude" && way === "computer") {
        setConnect(await api("startConnect", { body: { runner: "claude", name: usedName } }));
        return;
      }
      const res = await api("addAccount", { body: addBody(provider, usedName, needsSecret ? secret : "") });
      setSecret("");
      if ("loginId" in res) {
        setStart(res);
      } else {
        toastOk(`Added ${res.account}.`);
        close();
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const titles = ["Choose a provider", "Name the account", connect !== undefined ? "Use my computer" : provider?.runner === "claude" ? "Sign in with Claude" : "Log in"] as const;
  const submitText = submitTextFor(provider?.runner, way);

  return (
    <>
      <Button
        colorPalette="brand"
        size="sm"
        onClick={() => {
          setPending(preselect);
          setOpen(true);
        }}
      >
        <Plus size={15} /> Add account
      </Button>
      <Dialog.Root open={open} onOpenChange={(d) => !d.open && close()} size={size} placement="center" scrollBehavior="inside" lazyMount unmountOnExit>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxH={{ md: "min(720px, 88dvh)" }} minH={{ md: "min(560px, 88dvh)" }}>
              <Dialog.Header flexDirection="column" alignItems="flex-start" gap="1" borderBottomWidth="1px" borderColor="border.subtle" pb="4">
                <Text fontSize="xs" color="fg.subtle" fontWeight="500">
                  Step {step} of {submitText === "Add account" && provider !== undefined ? 2 : 3}
                </Text>
                <Dialog.Title fontSize="lg">{titles[step - 1]}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body py="5">
                {step === 1 ? (
                  providers.isPending || (pending !== undefined && providers.data !== undefined) ? (
                    <Stack gap="3">
                      <Skeleton h="10" rounded="md" />
                      <SimpleGrid columns={{ base: 1, sm: 2, md: 3 }} gap="2">
                        {Array.from({ length: 9 }, (_, i) => (
                          <Skeleton key={i} h="16" rounded="lg" />
                        ))}
                      </SimpleGrid>
                    </Stack>
                  ) : providers.isError ? (
                    <ErrorBlock error={providers.error} onRetry={() => void providers.refetch()} />
                  ) : (
                    <Picker providers={providers.data} onPick={setProvider} onLeave={close} />
                  )
                ) : null}
                {step === 2 && provider !== undefined ? (
                  <Stack gap="5">
                    <Chosen p={provider} onChange={() => setProvider(undefined)} />
                    <Field.Root invalid={touched && nameErr !== undefined}>
                      <Field.Label>Account name</Field.Label>
                      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={suggested === "" ? "name" : suggested} autoComplete="off" spellCheck={false} />
                      {touched && nameErr !== undefined ? (
                        <Field.ErrorText>{nameErr}</Field.ErrorText>
                      ) : (
                        <Field.HelperText>
                          It will be {accountPrefix(provider)}/{usedName === "" ? "<name>" : usedName}. Lower-case letters, digits, dot, dash or underscore.
                        </Field.HelperText>
                      )}
                    </Field.Root>
                    {provider.runner === "claude" ? (
                      <RadioCard.Root value={way} onValueChange={(d) => setWay(d.value as ClaudeWay)} size="sm" colorPalette="brand">
                        <RadioCard.Label>How to get the token</RadioCard.Label>
                        <SimpleGrid columns={{ base: 1, md: 3 }} gap="2">
                          {CLAUDE_WAYS.map((w) => (
                            <RadioCard.Item key={w.value} value={w.value}>
                              <RadioCard.ItemHiddenInput />
                              <RadioCard.ItemControl>
                                <RadioCard.ItemContent>
                                  <RadioCard.ItemText>{w.title}</RadioCard.ItemText>
                                  <RadioCard.ItemDescription>{w.description}</RadioCard.ItemDescription>
                                </RadioCard.ItemContent>
                                <RadioCard.ItemIndicator />
                              </RadioCard.ItemControl>
                            </RadioCard.Item>
                          ))}
                        </SimpleGrid>
                      </RadioCard.Root>
                    ) : null}
                    {needsSecret && field.label !== undefined ? (
                      <Field.Root invalid={touched && secretErr !== undefined}>
                        <Field.Label>{field.label}</Field.Label>
                        <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} fontFamily="mono" />
                        {touched && secretErr !== undefined ? <Field.ErrorText>{secretErr}</Field.ErrorText> : <Field.HelperText>{codeSpans(field.hint ?? "")}</Field.HelperText>}
                      </Field.Root>
                    ) : null}
                    {provider.runner === "codex" ? (
                      <Text fontSize="sm" color="fg.muted">
                        Next you get a link and a code. Sign in with the ChatGPT seat this account should use.
                      </Text>
                    ) : null}
                    {error === undefined ? null : <ErrorBlock error={error} />}
                  </Stack>
                ) : null}
                {step === 3 && start !== undefined ? <LoginProgress start={start} onFinal={setFinal} /> : null}
                {step === 3 && connect !== undefined ? <ConnectProgress start={connect} onFinal={setFinal} /> : null}
              </Dialog.Body>
              {step === 1 ? null : (
                <Dialog.Footer borderTopWidth="1px" borderColor="border.subtle" pt="4">
                  {step === 2 ? (
                    <Flex w="full" justify="space-between" gap="2">
                      <Button variant="ghost" size="sm" onClick={() => setProvider(undefined)}>
                        <ArrowLeft size={15} /> Back
                      </Button>
                      <Button colorPalette="brand" size="sm" onClick={() => void submit()} loading={busy}>
                        {submitText}
                      </Button>
                    </Flex>
                  ) : (
                    <Button size="sm" colorPalette={final?.state === "done" ? "brand" : "gray"} variant={final?.state === "done" ? "solid" : "outline"} onClick={close}>
                      {final?.state === "done" ? "Done" : "Close"}
                    </Button>
                  )}
                </Dialog.Footer>
              )}
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
