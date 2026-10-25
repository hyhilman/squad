// `@squad/contract/node`: the Node-only part of the SDK, kept out of the main entry so a browser
// bundle never pulls in node:http. Its public types name no Node type.
import { request } from "node:http";
import type { ByteStream, StreamFetchLike } from "./client.ts";

/**
 * A fetch that dials a unix socket, such as `squad serve`'s `<home>/serve.sock`. The host part of the
 * URL is ignored; the path and query are sent. Use it with `call` and `callStream`.
 */
export function nodeSocketFetch(socketPath: string): StreamFetchLike {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const u = new URL(url, "http://localhost");
      const req = request({ socketPath, method: init.method, path: `${u.pathname}${u.search}`, headers: { ...init.headers, ...(init.body === undefined ? {} : { "content-length": String(Buffer.byteLength(init.body)) }) } }, (res) => {
        // Chunks wait in a queue until the reader asks; the socket pauses while nobody reads.
        const queue: Uint8Array[] = [];
        let ended = false;
        let failed: Error | undefined;
        let wake: (() => void) | undefined;
        const poke = (): void => {
          const w = wake;
          wake = undefined;
          w?.();
        };
        res.on("data", (c: Buffer) => {
          queue.push(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
          res.pause();
          poke();
        });
        res.on("end", () => {
          ended = true;
          poke();
        });
        res.on("error", (e) => {
          failed = e;
          poke();
        });
        const body: ByteStream = {
          getReader: () => ({
            read: async () => {
              for (;;) {
                const next = queue.shift();
                if (next !== undefined) return { done: false, value: next };
                if (failed !== undefined) throw failed;
                if (ended) return { done: true, value: undefined };
                res.resume();
                await new Promise<void>((r) => (wake = r));
              }
            },
          }),
        };
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          body,
          json: async () => {
            const reader = body.getReader();
            const parts: Uint8Array[] = [];
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value !== undefined) parts.push(value);
            }
            return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
          },
        });
      });
      req.on("error", reject);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
}
