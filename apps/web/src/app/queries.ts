// Server reads for the pages that Refine's data provider does not cover. Still only through `api`.
import { useQuery } from "@tanstack/react-query";
import type { Runner } from "@squad/contract";
import { api } from "./api.ts";

export const useRoomSeries = (runner: Runner, name: string, since: string) =>
  useQuery({ queryKey: ["room", runner, name, since], queryFn: () => api("roomSeries", { params: { runner, name }, query: { since } }) });

export const usePasses = (account: string | undefined, before: string | undefined, limit: number) =>
  useQuery({
    queryKey: ["passes", account ?? "", before ?? "", limit],
    queryFn: () => api("listPasses", { query: { limit, ...(account === undefined ? {} : { account }), ...(before === undefined ? {} : { before }) } }),
  });

export const usePass = (passId: string) => useQuery({ queryKey: ["pass", passId], queryFn: () => api("getPass", { params: { passId } }) });

export const useUsageSeries = (by: "day" | "hour", since: string) =>
  useQuery({ queryKey: ["usageSeries", by, since], queryFn: () => api("usageSeries", { query: { by, since } }) });

export const useUsageByAccount = (since: string) =>
  useQuery({ queryKey: ["usageAccount", since], queryFn: () => api("usage", { query: { by: "account", since } }) });
