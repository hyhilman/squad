// The build vendors @squad/contract inside the package. This points its imports at the copy.
import { dirname, relative } from "node:path";

/** Replaces the "@squad/contract" specifier in `code` (a file at `file`) with a path to `vendorIndex`. */
export function rewriteContractSpecifier(code: string, file: string, vendorIndex: string): string {
  let rel = relative(dirname(file), vendorIndex).split("\\").join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return code.replace(/(["'])@squad\/contract\1/g, (_m, q: string) => `${q}${rel}${q}`);
}
