// Finds the files the code reads at run time. The code runs from two layouts: the source tree
// (`src/`, in development) and the installed package (`dist/`, where the build copies these folders).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where each bundled folder lives in the source tree, relative to the folder that holds this file. */
const SOURCE_TREE = { assets: "../assets", images: "../../../images", webapp: "../../../apps/web/dist" } as const;

/** A folder that must hold this file to count. The web app is never a folder of code: `dist/web/` holds compiled server code. */
const MARKER: Record<string, string> = { webapp: "index.html" };

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `rel` starts with `assets`, `images` or `webapp`. Tries the installed copy (next to this file) first,
 * then the source tree. When neither exists it returns the first, so an error names a real place.
 * `root` is for tests.
 */
export function bundledPath(rel: string, root: string = HERE): string {
  const [head = "", ...tail] = rel.split("/");
  if (!Object.hasOwn(SOURCE_TREE, head)) throw new Error(`not a bundled folder: ${head}`);
  const marker = MARKER[head];
  const installedHead = resolve(root, head);
  const sourceHead = resolve(root, SOURCE_TREE[head as keyof typeof SOURCE_TREE]);
  const installed = resolve(root, rel);
  const source = resolve(join(sourceHead, ...tail));
  const usable = (p: string, headDir: string): boolean => existsSync(p) && (marker === undefined || existsSync(join(headDir, marker)));
  return usable(installed, installedHead) || !usable(source, sourceHead) ? installed : source;
}
