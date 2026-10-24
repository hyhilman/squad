import assert from "node:assert/strict";
import { test } from "node:test";
import { failedText, filterPasses, outcomeFromParam, lastPassByAccount, outcomeGroup, runnerOf } from "./passFilter.ts";

const p = (passId: string, account: string | undefined, outcome: string | undefined, startedAt = "2026-10-24T10:00:00Z") => ({
  passId, startedAt, ...(account === undefined ? {} : { account }), ...(outcome === undefined ? {} : { outcome }),
});

test("runnerOf: the part before the slash", () => {
  assert.equal(runnerOf("codex/alice"), "codex");
  assert.equal(runnerOf(undefined), undefined);
});

test("outcomeGroup: ok, running, lost, else failed", () => {
  assert.equal(outcomeGroup(undefined), "running");
  assert.equal(outcomeGroup("ok"), "ok");
  assert.equal(outcomeGroup("lost"), "lost");
  assert.equal(outcomeGroup("rate-limit"), "failed");
});

test("filterPasses: by runner and by outcome group; empty filter keeps all", () => {
  const list = [p("1", "codex/a", "ok"), p("2", "claude/b", "auth"), p("3", undefined, "no-account"), p("4", "codex/c", undefined)];
  assert.deepEqual(filterPasses(list, {}).map((x) => x.passId), ["1", "2", "3", "4"]);
  assert.deepEqual(filterPasses(list, { runner: "codex" }).map((x) => x.passId), ["1", "4"]);
  assert.deepEqual(filterPasses(list, { outcome: "failed" }).map((x) => x.passId), ["2", "3"]);
  assert.deepEqual(filterPasses(list, { runner: "codex", outcome: "running" }).map((x) => x.passId), ["4"]);
});

test("lastPassByAccount: the latest start per account", () => {
  const m = lastPassByAccount([p("1", "codex/a", "ok", "2026-10-24T10:00:00Z"), p("2", "codex/a", "ok", "2026-10-24T12:00:00Z"), p("3", undefined, "x")]);
  assert.deepEqual(m, { "codex/a": "2026-10-24T12:00:00Z" });
});

test("failedText counts failed passes; a full page shows a plus", () => {
  const p = (outcome?: string) => ({ startedAt: "2026-10-24T01:00:00Z", ...(outcome === undefined ? {} : { outcome }) });
  assert.equal(failedText([p("ok"), p("fail"), p("busy"), p(), p("lost")], 200), "1 failed", "busy is a lost race, not a failure");
  assert.equal(failedText([p("ok")], 200), "");
  assert.equal(failedText(Array.from({ length: 200 }, () => p("fail")), 200), "200+ failed");
});

test("outcomeFromParam takes only a known outcome from the URL", () => {
  assert.equal(outcomeFromParam("failed"), "failed");
  assert.equal(outcomeFromParam("ok"), "ok");
  assert.equal(outcomeFromParam("<script>"), "");
  assert.equal(outcomeFromParam(null), "");
});
