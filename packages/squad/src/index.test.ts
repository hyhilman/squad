import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as lib from "./index.ts";

test("the library entry exports runPass, roomOf, listAccounts and usageBy", () => {
  for (const name of ["runPass", "roomOf", "listAccounts", "usageBy"]) assert.equal(typeof (lib as Record<string, unknown>)[name], "function", name);
});
