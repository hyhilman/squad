import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findForbidden } from "@squad/contract";
import { addAccount, getAccount } from "../accounts/store.ts";
import { ensureHome, layoutOf } from "../home.ts";
import { makeLog } from "../log.ts";
import { openStore } from "../store/db.ts";
import { CONNECT_LIFE_MS, ConnectPairs, PAIR_SHAPE, WRONG_ALL_PER_MINUTE, WRONG_PER_MINUTE, clientKeyOf, connectCommand, newPairCode, squadVersion } from "./connect.ts";
import { LoginRefused } from "./device-login.ts";

const T0 = new Date("2026-10-24T12:00:00.000Z").getTime();
const TOKEN = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE_-FAKE";
const ORIGIN = "https://squad.example.test";

function rig(env: Record<string, string> = {}) {
  const home = layoutOf(mkdtempSync(join(tmpdir(), "connect-")), {});
  ensureHome(home);
  const store = openStore({ dbPath: home.db, spoolDir: home.spool });
  const logs: string[] = [];
  const clock = { now: T0 };
  const pairs = new ConnectPairs({ env, home, store, log: makeLog((l) => logs.push(l)), now: () => new Date(clock.now), origin: ORIGIN, version: "1.2.3" });
  return { home, store, logs, clock, pairs };
}
const refused = (fn: () => unknown, status: number, code: string): LoginRefused => {
  try { fn(); } catch (e) { assert.ok(e instanceof LoginRefused, String(e)); assert.equal(e.status, status); assert.equal(e.code, code); return e; }
  throw new assert.AssertionError({ message: "expected a refusal" });
};
/** Nothing that left the module may hold the token. */
const clean = (r: ReturnType<typeof rig>, ...answers: unknown[]): void => {
  const all = r.logs.join("\n") + JSON.stringify(answers);
  assert.ok(!all.includes("oat01") && !all.includes(TOKEN.slice(13)), "the token reached an answer or a log line");
  assert.equal(findForbidden(answers), undefined);
};

test("a pair code is 256 random bits in base64url that starts with a letter or digit and never looks like a key", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const c = newPairCode();
    assert.match(c, PAIR_SHAPE);
    assert.equal(c.length, 43);
    assert.ok(!c.startsWith("sk-") && findForbidden(c) === undefined);
    seen.add(c);
  }
  assert.equal(seen.size, 2000);
  // A code from a source that gives a bad first draw is drawn again.
  const draws = ["-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"];
  assert.equal(newPairCode(() => draws.shift() ?? "GoodAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), "GoodAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
});

test("the command is npx of the release tarball of this version, with the public origin and the code", () => {
  const code = "A".repeat(43);
  assert.deepEqual(connectCommand("0.1.0-rc.3", ORIGIN, code), {
    command: `npx -y https://github.com/hyhilman/squad/releases/download/v0.1.0-rc.3/squad-0.1.0-rc.3.tgz connect --url ${ORIGIN} --pair ${code}`,
    shortCommand: `squad connect --url ${ORIGIN} --pair ${code}`,
  });
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(squadVersion(), pkg.version);
});

test("start gives a fresh code and the command; status is for the owner only (others get 404)", () => {
  const r = rig();
  const s = r.pairs.start("Alice@Example.test", "c1");
  assert.match(s.pairCode, PAIR_SHAPE);
  assert.equal(s.expiresAt, new Date(T0 + CONNECT_LIFE_MS).toISOString());
  assert.equal(CONNECT_LIFE_MS, 10 * 60_000);
  assert.ok(s.command.endsWith(`connect --url ${ORIGIN} --pair ${s.pairCode}`) && s.command.includes("/v1.2.3/squad-1.2.3.tgz"));
  assert.deepEqual(r.pairs.status("alice@example.test", s.connectId), { connectId: s.connectId, state: "pending" });
  refused(() => r.pairs.status("bob@example.test", s.connectId), 404, "not-found");
  refused(() => r.pairs.status("alice@example.test", "nope"), 404, "not-found");
  assert.ok(r.logs.some((l) => /event=connect_started/.test(l) && /account=claude\/c1/.test(l)));
  assert.ok(!r.logs.join("\n").includes(s.pairCode), "the code is never logged");
  // The server keeps only a hash: the code is in no field of the module.
  assert.ok(!JSON.stringify([...(r.pairs as unknown as { entries: Map<string, unknown> }).entries.values()]).includes(s.pairCode));
  r.store.close();
});

test("start refuses a bad name, an existing account, a second start for a name, a dry run and the kill switch", () => {
  const r = rig();
  refused(() => r.pairs.start("alice@example.test", "Bad Name"), 400, "bad-request");
  addAccount(r.store.db, { runner: "claude", name: "taken", kind: "token", ownerEmail: "x@example.test" }, new Date(T0));
  refused(() => r.pairs.start("alice@example.test", "taken"), 409, "conflict");
  r.pairs.start("alice@example.test", "twice");
  refused(() => r.pairs.start("bob@example.test", "twice"), 409, "conflict");
  for (const env of [{ SQUAD_DRY_RUN: "1" }, { SQUAD_NO_WEB_LOGIN: "1" }] as Record<string, string>[]) {
    const q = rig(env);
    refused(() => q.pairs.start("alice@example.test", "c1"), 501, "disabled");
    q.store.close();
  }
  r.store.close();
});

test("the helper may send the account user's email with the token; it is kept as the account user; none stays unknown", () => {
  const r = rig();
  const s = r.pairs.start("alice@example.test", "c1");
  r.pairs.redeem("10.0.0.1", s.pairCode, TOKEN, "alice.personal@example.test");
  assert.equal(getAccount(r.store.db, "claude/c1")!.loginEmail, "alice.personal@example.test");
  const t = r.pairs.start("alice@example.test", "c2");
  r.pairs.redeem("10.0.0.1", t.pairCode, TOKEN);
  assert.equal(getAccount(r.store.db, "claude/c2")!.loginEmail, null);
  r.store.close();
});

test("the token with the right code makes the owner's token account (file 0600), once; the token shows nowhere", () => {
  const r = rig();
  const s = r.pairs.start("Alice@Example.test", "c1");
  const res = r.pairs.redeem("10.0.0.1", s.pairCode, TOKEN);
  assert.deepEqual(res, { account: "claude/c1" });
  const dir = join(r.home.accounts, "claude", "c1");
  assert.equal(readFileSync(join(dir, "token"), "utf8"), TOKEN);
  assert.equal(statSync(join(dir, "token")).mode & 0o777, 0o600);
  const row = getAccount(r.store.db, "claude/c1")!;
  assert.equal(row.kind, "token");
  assert.equal(row.ownerEmail, "alice@example.test");
  const st = r.pairs.status("alice@example.test", s.connectId);
  assert.deepEqual(st, { connectId: s.connectId, state: "done", account: "claude/c1" });
  // Single use: the same code again is a plain 404.
  refused(() => r.pairs.redeem("10.0.0.1", s.pairCode, TOKEN), 404, "not-found");
  assert.ok(r.logs.some((l) => /event=connect_done/.test(l) && /account=claude\/c1/.test(l)));
  clean(r, res, st, row);
  r.store.close();
});

test("a wrong code is a 404 with no detail; an expired one too, and its status says expired", () => {
  const r = rig();
  const s = r.pairs.start("alice@example.test", "c1");
  const e = refused(() => r.pairs.redeem("10.0.0.1", "B".repeat(43), TOKEN), 404, "not-found");
  assert.equal(e.message, "not found");
  refused(() => r.pairs.redeem("10.0.0.1", s.pairCode.slice(0, -1), TOKEN), 404, "not-found");
  r.clock.now = T0 + CONNECT_LIFE_MS + 1;
  refused(() => r.pairs.redeem("10.0.0.2", s.pairCode, TOKEN), 404, "not-found");
  assert.deepEqual(r.pairs.status("alice@example.test", s.connectId), { connectId: s.connectId, state: "expired" });
  assert.equal(getAccount(r.store.db, "claude/c1"), undefined);
  assert.ok(r.logs.some((l) => /event=connect_failed/.test(l) && /reason=expired/.test(l)));
  // The name is free again once the code expired.
  r.pairs.start("alice@example.test", "c1");
  clean(r);
  r.store.close();
});

test("after 30 wrong codes in a minute an address gets 429 for every code, the right one too; other addresses are not held", () => {
  const r = rig();
  const s = r.pairs.start("alice@example.test", "c1");
  assert.equal(WRONG_PER_MINUTE, 30);
  for (let i = 0; i < 30; i++) refused(() => r.pairs.redeem("10.0.0.9", `${"C".repeat(42)}${i}`, TOKEN), 404, "not-found");
  refused(() => r.pairs.redeem("10.0.0.9", "D".repeat(43), TOKEN), 429, "too-many");
  refused(() => r.pairs.redeem("10.0.0.9", s.pairCode, TOKEN), 429, "too-many");
  assert.equal(r.pairs.status("alice@example.test", s.connectId).state, "pending", "a held try does not use the code");
  r.clock.now = T0 + 61_000;
  assert.deepEqual(r.pairs.redeem("10.0.0.9", s.pairCode, TOKEN), { account: "claude/c1" }, "the minute passed");
  const t = r.pairs.start("alice@example.test", "c2");
  for (let i = 0; i < 30; i++) refused(() => r.pairs.redeem("10.0.0.9", `${"E".repeat(42)}${i}`, TOKEN), 404, "not-found");
  assert.deepEqual(r.pairs.redeem("10.0.0.10", t.pairCode, TOKEN), { account: "claude/c2" });
  r.store.close();
});

test("a token of the wrong shape uses up the code and fails the connect; an account made meanwhile fails it with exists", () => {
  const r = rig();
  const a = r.pairs.start("alice@example.test", "a1");
  for (const [i, bad] of ["", "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE", `${TOKEN} `, `${TOKEN}\n`, 7, undefined].entries()) {
    const q = r.pairs.start("alice@example.test", `b${i}`);
    const e = refused(() => r.pairs.redeem("10.0.0.1", q.pairCode, bad), 400, "bad-request");
    assert.ok(!e.message.includes("FAKE"));
    assert.deepEqual(r.pairs.status("alice@example.test", q.connectId), { connectId: q.connectId, state: "failed", reason: "bad-token" });
    refused(() => r.pairs.redeem("10.0.0.1", q.pairCode, TOKEN), 404, "not-found");
  }
  addAccount(r.store.db, { runner: "claude", name: "a1", kind: "token", ownerEmail: "x@example.test" }, new Date(T0));
  refused(() => r.pairs.redeem("10.0.0.1", a.pairCode, TOKEN), 409, "conflict");
  assert.deepEqual(r.pairs.status("alice@example.test", a.connectId), { connectId: a.connectId, state: "failed", reason: "exists" });
  clean(r);
  r.store.close();
});

test("the token route is off with the kill switch or a dry run", () => {
  const r = rig({ SQUAD_NO_WEB_LOGIN: "1" });
  refused(() => r.pairs.redeem("10.0.0.1", "A".repeat(43), TOKEN), 501, "disabled");
  r.store.close();
});

test("the client key: a loopback peer (the tunnel) with a valid cf-connecting-ip keys on that header; anything else keys on the peer", () => {
  for (const lo of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(clientKeyOf(lo, "203.0.113.7"), "203.0.113.7", lo);
  assert.equal(clientKeyOf("127.0.0.1", "2001:db8::1"), "2001:db8::1");
  assert.equal(clientKeyOf("127.0.0.1", undefined), "127.0.0.1");
  assert.equal(clientKeyOf("127.0.0.1", "not an ip"), "127.0.0.1");
  assert.equal(clientKeyOf("127.0.0.1", `1.2.3.4${"x".repeat(100)}`), "127.0.0.1");
  assert.equal(clientKeyOf("127.0.0.1", ["1.2.3.4", "5.6.7.8"]), "127.0.0.1", "a repeated header is not trusted");
  assert.equal(clientKeyOf("10.0.0.5", "203.0.113.7"), "10.0.0.5", "a header from a non-loopback peer is forgeable: ignored");
});

test("past 300 wrong codes in a minute from all addresses together, every try is refused until the minute ends", () => {
  const r = rig();
  const s = r.pairs.start("alice@example.test", "c1");
  assert.equal(WRONG_ALL_PER_MINUTE, 300);
  for (let i = 0; i < 300; i++) refused(() => r.pairs.redeem(`10.1.${Math.floor(i / 20)}.${i % 20}`, `${"G".repeat(40)}${String(i).padStart(3, "0")}`, TOKEN), 404, "not-found");
  refused(() => r.pairs.redeem("10.9.9.9", s.pairCode, TOKEN), 429, "too-many");
  assert.equal(r.pairs.status("alice@example.test", s.connectId).state, "pending");
  r.clock.now = T0 + 61_000;
  assert.deepEqual(r.pairs.redeem("10.9.9.9", s.pairCode, TOKEN), { account: "claude/c1" });
  r.store.close();
});

test("replace: a connect bound to the owner's own claude token account writes a new token into it; one for a missing account is refused", () => {
  const r = rig();
  addAccount(r.store.db, { runner: "claude", name: "t", kind: "token", ownerEmail: "alice@example.test", consent: false }, new Date(T0));
  mkdirSync(join(r.home.accounts, "claude", "t"), { recursive: true, mode: 0o700 });
  refused(() => r.pairs.start("alice@example.test", "missing", true), 404, "not-found");
  refused(() => r.pairs.start("bob@example.test", "t", true), 404, "not-found");
  const s = r.pairs.start("alice@example.test", "t", true);
  assert.deepEqual(r.pairs.redeem("10.0.0.1", s.pairCode, TOKEN), { account: "claude/t" });
  assert.equal(readFileSync(join(r.home.accounts, "claude", "t", "token"), "utf8"), TOKEN);
  assert.equal(getAccount(r.store.db, "claude/t")!.consentBy, "alice@example.test");
  clean(r);
  r.store.close();
});
