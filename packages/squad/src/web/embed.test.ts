import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { createEmbed, MAX_USED, type EmbedConfig } from "./embed.ts";

const URL_ = "https://squad.example.test";
const KEY = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex");
const T0 = 1_800_000_000;
const JTI = "AAAAAAAAAAAAAAAAAAAAAA";
/** The shared test vector: the hub is built to this exact text. */
const VECTOR = "eyJ2IjoxLCJhdWQiOiJodHRwczovL3NxdWFkLmV4YW1wbGUudGVzdCIsImVtYWlsIjoiYWRhQGV4YW1wbGUudGVzdCIsIm5hbWUiOiJBZGEiLCJncm91cHMiOlsiZGV2Il0sImlhdCI6MTgwMDAwMDAwMCwiZXhwIjoxODAwMDAwMDYwLCJqdGkiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBIn0.nTu_UMwziiLSrGoJt_ZCrtlu4RJADi-gUdqE2LNARpA";

type Payload = Record<string, unknown>;
const base = (): Payload => ({ v: 1, aud: URL_, email: "ada@example.test", name: "Ada", groups: ["dev"], iat: T0, exp: T0 + 60, jti: JTI });
function sign(p: Payload, key: Buffer = KEY): string {
  const b = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
  return `${b}.${createHmac("sha256", key).update(b).digest("base64url")}`;
}

/** A checker whose clock is `clock.s` (epoch seconds) and which started at T0. */
function rig(extra: Partial<EmbedConfig> = {}) {
  const clock = { s: T0 };
  const e = createEmbed({ key: KEY, url: URL_, ...extra }, { now: () => clock.s * 1000 });
  return { e, clock };
}
const why = (r: ReturnType<ReturnType<typeof rig>["e"]["check"]>): string => (r.ok ? "ok" : r.reason);

test("the shared test vector is accepted at any second from iat to exp - 1", () => {
  for (const s of [T0, T0 + 30, T0 + 59]) {
    const { e, clock } = rig();
    clock.s = s;
    assert.deepEqual(e.check(VECTOR), { ok: true, who: { email: "ada@example.test", name: "Ada", groups: ["dev"] } });
  }
});

test("the vector is our own signing too: sign() gives the same ticket", () => {
  assert.equal(sign(base()), VECTOR);
});

test("bad shape: not two base64url parts, empty, too long, not a string", () => {
  const { e } = rig();
  for (const t of ["", "abc", "a.b.c", ".x", "x.", "a b.c", "a+b.c", "a=.b", undefined, null, 5]) assert.equal(why(e.check(t)), "bad-shape", String(t));
});

test("too long is the first check: over 8192 characters is refused before any decoding", () => {
  const { e } = rig();
  assert.equal(why(e.check("a".repeat(8193))), "too-long");
  assert.equal(why(e.check(`${"a".repeat(9000)}.b`)), "too-long");
  assert.equal(why(e.check("%".repeat(8193))), "too-long", "not even the shape is looked at");
  assert.equal(why(e.check("a".repeat(8192))), "bad-shape", "8192 is still looked at");
});

test("bad mac: a changed signature, a changed body, another key", () => {
  const { e } = rig();
  const [b, s] = VECTOR.split(".") as [string, string];
  assert.equal(why(e.check(`${b}.${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}`)), "bad-mac");
  assert.equal(why(e.check(`${b}A.${s}`)), "bad-mac");
  assert.equal(why(e.check(sign(base(), Buffer.alloc(32, 7)))), "bad-mac");
  assert.equal(why(e.check(`${b}.short`)), "bad-mac");
});

test("bad payload: not JSON, not an object, an extra field, a missing field, a wrong type", () => {
  const { e } = rig();
  const signText = (text: string): string => {
    const b = Buffer.from(text).toString("base64url");
    return `${b}.${createHmac("sha256", KEY).update(b).digest("base64url")}`;
  };
  assert.equal(why(e.check(signText("not json"))), "bad-payload");
  assert.equal(why(e.check(signText("[1]"))), "bad-payload");
  assert.equal(why(e.check(signText("null"))), "bad-payload");
  assert.equal(why(e.check(sign({ ...base(), extra: 1 }))), "bad-payload");
  for (const k of Object.keys(base())) {
    const p = base();
    delete p[k];
    assert.equal(why(e.check(sign(p))), "bad-payload", `missing ${k}`);
  }
  const wrong: Payload[] = [
    { v: "1" }, { aud: 5 }, { email: "" }, { email: 5 }, { name: null }, { groups: "dev" }, { groups: [1] },
    { iat: 1.5 }, { iat: "1" }, { exp: null }, { jti: 5 }, { jti: "short" }, { jti: "A".repeat(23) }, { jti: "AAAAAAAAAAAAAAAAAAAA!A" },
  ];
  for (const w of wrong) assert.equal(why(e.check(sign({ ...base(), ...w }))), "bad-payload", JSON.stringify(w));
});

test("wrong version, wrong audience", () => {
  const { e } = rig();
  assert.equal(why(e.check(sign({ ...base(), v: 2 }))), "bad-version");
  assert.equal(why(e.check(sign({ ...base(), aud: `${URL_}/` }))), "bad-aud");
  assert.equal(why(e.check(sign({ ...base(), aud: "https://other.example.test" }))), "bad-aud");
});

test("the lifetime is 1 to 60 seconds", () => {
  const { e } = rig();
  assert.equal(why(e.check(sign({ ...base(), exp: T0 + 61 }))), "bad-lifetime");
  assert.equal(why(e.check(sign({ ...base(), exp: T0 }))), "bad-lifetime");
  assert.equal(why(e.check(sign({ ...base(), exp: T0 - 5 }))), "bad-lifetime");
  assert.equal(why(e.check(sign({ ...base(), exp: T0 + 1, jti: "BBBBBBBBBBBBBBBBBBBBBB" }))), "ok");
});

test("an expired ticket, an iat too far ahead, a ticket from before the start", () => {
  const { e, clock } = rig();
  clock.s = T0 + 60;
  assert.equal(why(e.check(sign(base()))), "expired");
  clock.s = T0;
  assert.equal(why(e.check(sign({ ...base(), iat: T0 + 61, exp: T0 + 100 }))), "future");
  assert.equal(why(e.check(sign({ ...base(), iat: T0 + 60, exp: T0 + 100, jti: "CCCCCCCCCCCCCCCCCCCCCC" }))), "ok", "60 s of clock skew is allowed");
  assert.equal(why(e.check(sign({ ...base(), iat: T0 - 1, exp: T0 + 30, jti: "DDDDDDDDDDDDDDDDDDDDDD" }))), "before-start");
});

test("a ticket works once; the id is forgotten after its exp, and a refused ticket does not spend its id", () => {
  const { e, clock } = rig();
  assert.equal(why(e.check(sign({ ...base(), v: 2 }))), "bad-version");
  assert.equal(why(e.check(VECTOR)), "ok");
  assert.equal(why(e.check(VECTOR)), "reused");
  clock.s = T0 + 60;
  assert.equal(why(e.check(VECTOR)), "expired", "past exp the id is dropped, and the time check refuses it");
});

test("at the cap, a new ticket is refused and an old id is not forgotten", () => {
  const { e, clock } = rig();
  const id = (n: number): string => n.toString(36).padStart(22, "A");
  clock.s = T0;
  for (let n = 0; n < MAX_USED; n++) assert.equal(why(e.check(sign({ ...base(), jti: id(n) }))), "ok", String(n));
  assert.equal(why(e.check(sign({ ...base(), jti: id(MAX_USED) }))), "memory-full");
  assert.equal(why(e.check(sign({ ...base(), jti: id(0) }))), "reused");
  clock.s = T0 + 60;
  assert.equal(why(e.check(sign({ ...base(), iat: T0 + 60, exp: T0 + 100, jti: id(MAX_USED) }))), "ok", "the full map has room again once ids pass their exp");
});

test("the group rule: set = the ticket must hold it; unset = any group", () => {
  assert.equal(why(rig({ group: "ops" }).e.check(VECTOR)), "not-in-group");
  assert.equal(why(rig({ group: "dev" }).e.check(VECTOR)), "ok");
  const { e } = rig();
  assert.equal(why(e.check(sign({ ...base(), groups: [] }))), "ok");
});

test("a name that is empty is kept as given (the session falls back to the email)", () => {
  const { e } = rig();
  assert.deepEqual(e.check(sign({ ...base(), name: "" })), { ok: true, who: { email: "ada@example.test", name: "", groups: ["dev"] } });
});

test("no refusal carries the ticket or a claim", () => {
  const { e } = rig();
  const r = e.check(sign({ ...base(), email: "secret-person@example.test", v: 2 }));
  assert.ok(!r.ok);
  assert.ok(!JSON.stringify(r).includes("secret-person"));
  assert.match(r.reason, /^[a-z-]+$/);
});
