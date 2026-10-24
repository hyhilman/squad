import { strict as assert } from "node:assert";
import { test } from "node:test";
import { logLine, makeLog } from "./log.ts";

const AT = new Date("2026-10-24T00:00:00.000Z");

test("one logfmt line; unsafe values are quoted; undefined fields are left out", () => {
  const line = logLine("info", "pass-end", { pass: "01J", msg: "a b", eq: "x=y", n: 3, gone: undefined }, AT);
  assert.equal(line, 'ts=2026-10-24T00:00:00.000Z level=info event=pass-end pass=01J msg="a b" eq="x=y" n=3');
});

test("a line is never JSON and never spans two lines", () => {
  const out: string[] = [];
  makeLog((l) => out.push(l)).warn("x", { msg: "one\ntwo" });
  assert.equal(out.length, 1);
  assert.ok(!out[0]!.startsWith("{"));
  assert.ok(!out[0]!.includes("\n"));
});
