import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteContractSpecifier } from "../scripts/rewrite.ts";

const VENDOR = "/p/dist/vendor/contract/index.js";

test("a file at the top of dist gets a ./vendor path", () => {
  const out = rewriteContractSpecifier(`import { a } from "@squad/contract";\n`, "/p/dist/run.js", VENDOR);
  assert.equal(out, `import { a } from "./vendor/contract/index.js";\n`);
});

test("a nested file gets ../ steps", () => {
  const out = rewriteContractSpecifier(`export * from '@squad/contract';`, "/p/dist/web/server.d.ts", VENDOR);
  assert.equal(out, `export * from '../vendor/contract/index.js';`);
});

test("type imports and dynamic imports are rewritten too", () => {
  const src = `import type { X } from "@squad/contract";\nconst m = await import("@squad/contract");\n`;
  const out = rewriteContractSpecifier(src, "/p/dist/cli/squad.js", VENDOR);
  assert.equal(out, `import type { X } from "../vendor/contract/index.js";\nconst m = await import("../vendor/contract/index.js");\n`);
});

test("other specifiers are left alone", () => {
  const src = `import a from "@squad/contract-other";\nimport b from "node:fs";\nimport c from "./x.js";\n`;
  assert.equal(rewriteContractSpecifier(src, "/p/dist/run.js", VENDOR), src);
});
