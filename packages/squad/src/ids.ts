// Pass ids are ULIDs: 48 bits of milliseconds, then 80 random bits, in Crockford base32. They sort by
// time as plain strings, so a folder listing of pass logs is in start order.
import { randomBytes } from "node:crypto";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now(), rand: Buffer = randomBytes(10)): string {
  if (!Number.isInteger(now) || now < 0 || now > 2 ** 48 - 1) throw new Error(`ulid: bad time ${now}`);
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  // 80 random bits as 16 base32 digits, 5 bits each.
  let bits = 0n;
  for (const b of rand.subarray(0, 10)) bits = (bits << 8n) | BigInt(b);
  let tail = "";
  for (let i = 0; i < 16; i++) {
    tail = B32[Number(bits & 31n)] + tail;
    bits >>= 5n;
  }
  return time + tail;
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The same 128 bits as a UUID string, for claude's `--session-id`, which takes only a UUID. A ULID is
 * 128 bits, so the map is one to one: two conversations never share a transcript name. claude 2.1.310
 * takes it without the v4 version bits. Lower or upper case in; lower case out.
 */
export function uuidOfUlid(id: string): string {
  const up = id.toUpperCase();
  if (!ULID_RE.test(up) || up[0]! > "7") throw new Error(`not a ulid: ${JSON.stringify(id)}`);
  let n = 0n;
  for (const c of up) n = (n << 5n) | BigInt(B32.indexOf(c));
  const h = n.toString(16).padStart(32, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
