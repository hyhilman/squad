// Every server read, each through the contract's `call` (api.ts).
import { QueryCache, QueryClient, MutationCache, useQuery } from "@tanstack/react-query";
import { ApiFailure, type Runner } from "@squad/contract";
import { api } from "./api.ts";

// Signed out: never a move by itself (lib/signin.ts). A 401 elsewhere only asks /api/me again, and
// its 401 brings up the Gate's signed-out card.
const onError = (e: unknown, key?: readonly unknown[]) => {
  if (!(e instanceof ApiFailure && e.status === 401)) return;
  if (key?.[0] !== "me") void queryClient.refetchQueries({ queryKey: ["me"] });
};

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (e, q) => onError(e, q.queryKey) }),
  mutationCache: new MutationCache({ onError: (e) => onError(e) }),
  defaultOptions: {
    queries: {
      // A 4xx will not change on a retry.
      retry: (n, e) => !(e instanceof ApiFailure && e.status < 500) && n < 2,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
});

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api("me", {}), staleTime: Infinity });

export const useAccounts = () => useQuery({ queryKey: ["accounts"], queryFn: () => api("listAccounts", {}) });

export const useAccount = (runner: Runner, name: string) =>
  useQuery({ queryKey: ["accounts", runner, name], queryFn: () => api("getAccount", { params: { runner, name } }) });

export const useRoomSeries = (runner: Runner, name: string, since: string) =>
  useQuery({ queryKey: ["room", runner, name, since], queryFn: () => api("roomSeries", { params: { runner, name }, query: { since } }) });

/** Today's passes (UTC), newest first, one page: enough to count today's failures. */
export const TODAY_PAGE = 200;
export const useTodayPasses = (day: string) =>
  useQuery({ queryKey: ["passes", "today", day], queryFn: () => api("listPasses", { query: { since: `${day}T00:00:00Z`, limit: TODAY_PAGE } }) });

export const usePasses = (account: string | undefined, before: string | undefined, limit: number) =>
  useQuery({
    queryKey: ["passes", account ?? "", before ?? "", limit],
    queryFn: () => api("listPasses", { query: { limit, ...(account === undefined ? {} : { account }), ...(before === undefined ? {} : { before }) } }),
  });

export const usePass = (passId: string | undefined) =>
  useQuery({ queryKey: ["pass", passId], queryFn: () => api("getPass", { params: { passId: passId ?? "" } }), enabled: passId !== undefined });

export const useUsageSeries = (by: "day" | "hour", since: string, account?: string) =>
  useQuery({
    queryKey: ["usageSeries", by, since, account ?? ""],
    queryFn: () => api("usageSeries", { query: { by, since, ...(account === undefined ? {} : { account }) } }),
  });

export const useUsageByModel = (since: string) =>
  useQuery({ queryKey: ["usageModel", since], queryFn: () => api("usage", { query: { by: "model", since } }) });

/** Only while the Add account dialog is open. */
export const useProviders = (enabled: boolean) => useQuery({ queryKey: ["providers"], queryFn: () => api("listProviders", {}), enabled, staleTime: 60_000 });

/** Only while the Test dialog is open. */
export const useAccountModels = (runner: Runner, name: string, enabled: boolean) =>
  useQuery({ queryKey: ["models", runner, name], queryFn: () => api("accountModels", { params: { runner, name } }), enabled, staleTime: 60_000 });
// The catalog changes slowly (squad renews its copy every few hours).
export const useCatalogProviders = () => useQuery({ queryKey: ["catalog", "providers"], queryFn: () => api("catalogProviders", {}), staleTime: 60_000 });

export const useCatalogProvider = (provider: string) =>
  useQuery({ queryKey: ["catalog", "provider", provider], queryFn: () => api("catalogProvider", { params: { provider } }), staleTime: 60_000 });

export const useCatalogModel = (modelId: string) =>
  useQuery({ queryKey: ["catalog", "model", modelId], queryFn: () => api("catalogModel", { params: { modelId } }), staleTime: 60_000, enabled: modelId !== "" });
