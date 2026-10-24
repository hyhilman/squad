// Refine's data provider over the contract. A resource name maps to contract routes; anything else is
// refused, so a page cannot reach a route the contract does not have.
import type { BaseRecord, DataProvider, GetListParams, GetListResponse, GetOneParams, GetOneResponse } from "@refinedev/core";
import type { Runner, UsageBy } from "@squad/contract";
import { api } from "./api.ts";

/** An account's Refine id is `<runner>/<name>`. */
const splitId = (id: unknown): { runner: Runner; name: string } => {
  const [runner, ...rest] = String(id).split("/");
  return { runner: runner as Runner, name: rest.join("/") };
};

const unsupported = (what: string): never => {
  throw new Error(`squad web: ${what} is not in the contract`);
};

export const dataProvider: DataProvider = {
  getApiUrl: () => "/api",
  getList: async <TData extends BaseRecord = BaseRecord>({ resource, filters }: GetListParams): Promise<GetListResponse<TData>> => {
    if (resource === "accounts") {
      const data = await api("listAccounts", {});
      return { data: data.map((a) => ({ ...a, id: a.account })) as unknown as TData[], total: data.length };
    }
    if (resource === "usage") {
      const by = (filters?.find((f) => "field" in f && f.field === "by")?.value as UsageBy | undefined) ?? "account";
      const since = filters?.find((f) => "field" in f && f.field === "since")?.value as string | undefined;
      const data = await api("usage", { query: { by, ...(since === undefined ? {} : { since }) } });
      return { data: data.map((r) => ({ ...r, id: r.key })) as unknown as TData[], total: data.length };
    }
    return unsupported(`list ${resource}`);
  },
  getOne: async <TData extends BaseRecord = BaseRecord>({ resource, id }: GetOneParams): Promise<GetOneResponse<TData>> => {
    if (resource !== "accounts") return unsupported(`get ${resource}`);
    const a = await api("getAccount", { params: splitId(id) });
    return { data: { ...a, id: a.account } as unknown as TData };
  },
  create: async ({ resource }) => unsupported(`create ${resource}`),
  update: async ({ resource }) => unsupported(`update ${resource}`),
  deleteOne: async ({ resource }) => unsupported(`delete ${resource}`),
};
