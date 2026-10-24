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
