// A host-side lock for the moves that need one: a login that swaps a folder, an import that moves a
// login out of another home. A pass never takes its account lock here: that one lives in the
// container (see images/entry.sh). This lock is held for a few milliseconds by a small `flock`
// child, and it is taken without waiting. A running pass holds the same file in its container, so
// the `-n` fails while one runs.
//
// Node has no flock, so the child holds it: `flock -n <file> sh -c 'echo held; read'`. It frees when
// stdin closes, or when this process dies.

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/** Makes the empty lock file if it is missing. */
export function ensureLockFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, "a", 0o600));
}

/** Runs `fn` under the lock. Returns `"busy"` at once when someone holds it. */
export async function withHostLock<T>(lockFile: string, fn: () => T | Promise<T>): Promise<{ readonly value: T } | "busy"> {
  ensureLockFile(lockFile);
  const child = spawn("flock", ["-n", lockFile, "sh", "-c", "echo held; read x"], { stdio: ["pipe", "pipe", "ignore"] });
  const held = await new Promise<boolean>((resolve) => {
    let buf = "";
    child.stdout.on("data", (b: Buffer) => {
      buf += b.toString("utf8");
      if (buf.includes("held")) resolve(true);
    });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(false));
  });
  if (!held) return "busy";
  child.stdin.on("error", () => {});
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  try {
    return { value: await fn() };
  } finally {
    child.stdin.end();
    await closed;
  }
}
