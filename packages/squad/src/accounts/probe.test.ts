import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emptyHealth, type HealthRow } from "./health.ts";
import { dueProbes } from "./probe.ts";
import type { AccountRow } from "./store.ts";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const ago = (s: number): string => new Date(NOW.getTime() - s * 1000).toISOString();
const acct = (name: string, more: Partial<AccountRow> = {}): AccountRow => ({ id: `codex/${name}`, runner: "codex", name, kind: "login", ownerEmail: null, state: "active", deadCode: null, deadAt: null, floor5h: null, floorWeek: null, createdAt: "x", consentAt: "2026-01-01T00:00:00.000Z", loginEmail: null, consentBy: "cli", ...more });
const hm = (...rows: HealthRow[]) => new Map(rows.map((r) => [r.account, r]));

test("dueProbes: suspect accounts with no pass in the last hour", () => {
  const accounts = [acct("a"), acct("b"), acct("c"), acct("d"), acct("e", { state: "dead" }), acct("f")];
  const h = hm(
    { ...emptyHealth("codex/a"), suspectSince: ago(10), lastUsedAt: ago(7200) },
    { ...emptyHealth("codex/b"), suspectSince: ago(10), lastUsedAt: ago(600) },
    { ...emptyHealth("codex/c"), suspectSince: ago(10) },
    { ...emptyHealth("codex/d"), lastUsedAt: ago(7200) },
    { ...emptyHealth("codex/e"), suspectSince: ago(10) },
    { ...emptyHealth("codex/f"), suspectSince: ago(10), lastUsedAt: ago(3600) },
  );
  assert.deepEqual(dueProbes(accounts, h, NOW).map((a) => a.id), ["codex/a", "codex/c", "codex/f"]);
});

test("dueProbes is empty when SQUAD_NO_AUTO_PROBE=1", () => {
  const h = hm({ ...emptyHealth("codex/a"), suspectSince: ago(10) });
  assert.deepEqual(dueProbes([acct("a")], h, NOW, { SQUAD_NO_AUTO_PROBE: "1" }), []);
});

test("dueProbes leaves out an account its owner does not share: a probe there would only be refused", () => {
  const h = hm({ ...emptyHealth("codex/a"), suspectSince: ago(10) }, { ...emptyHealth("codex/b"), suspectSince: ago(10) });
  assert.deepEqual(dueProbes([acct("a", { consentAt: null, consentBy: null }), acct("b")], h, NOW).map((a) => a.id), ["codex/b"]);
});
