// The one place the app reaches the backend: the contract's typed `call`, same origin.
import { call, type Api, type RouteName } from "@squad/contract";

type Args<N extends RouteName> = Parameters<typeof call<N>>[3];

export const api = <N extends RouteName>(name: N, input: Args<N>): Promise<Api[N]["res"]> =>
  call((url, init) => fetch(url, init), "", name, input);
