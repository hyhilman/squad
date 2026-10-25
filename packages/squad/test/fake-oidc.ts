// A fake OIDC provider for tests: a node:http server on 127.0.0.1 with discovery, authorize, token
// and JWKS. It signs ID tokens with keys made in the test (RSA and EC). It never touches the network.
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

export const CLIENT_ID = "squad-test";

export type Claims = Record<string, unknown>;

export interface SignKey {
  readonly kid: string;
  readonly alg: "RS256" | "ES256";
  readonly priv: KeyObject;
  readonly jwk: Record<string, unknown>;
}

export function makeKey(alg: "RS256" | "ES256", kid: string): SignKey {
  const pair = alg === "RS256" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...(pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid, use: "sig", alg };
  return { kid, alg, priv: pair.privateKey, jwk };
}

const b64 = (v: Buffer | string): string => Buffer.from(v).toString("base64url");

/** A compact JWT. `signer` makes the signature from the signing input. */
export function jwt(header: Claims, claims: Claims, signer: (input: string) => Buffer): string {
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
  return `${input}.${b64(signer(input))}`;
}

export function signWith(key: SignKey): (input: string) => Buffer {
  return (input) => (key.alg === "RS256" ? sign("sha256", Buffer.from(input), key.priv) : sign("sha256", Buffer.from(input), { key: key.priv, dsaEncoding: "ieee-p1363" }));
}

export interface Pending {
  readonly nonce: string;
  readonly challenge: string;
  readonly redirectUri: string;
}

export interface FakeOidc {
  readonly issuer: string;
  /** Keys in the JWKS now, and the one that signs. Change them to test a rotation. */
  jwks: SignKey[];
  signer: SignKey;
  /** Changes the claims of the next ID tokens. */
  mutate: (claims: Claims) => void;
  /** Replaces the whole token (bad header, bad signature, ...). */
  forge: ((claims: Claims, key: SignKey) => string) | undefined;
  /** Status of the token endpoint; anything but 200 gives an error body. */
  tokenStatus: number;
  /** What the issuer field of the discovery document says. */
  discoveryIssuer: string | undefined;
  readonly tokenRequests: { auth: string | undefined; form: URLSearchParams; pkceOk: boolean }[];
  /** Whether discovery lists an end_session_endpoint (RP-initiated logout). */
  endSession: boolean;
  /** The query of each end-session request. */
  readonly endSessionRequests: URLSearchParams[];
  jwksFetches: number;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

export async function startFakeOidc(kind: "RS256" | "ES256" = "RS256"): Promise<FakeOidc> {
  const first = makeKey(kind, "k1");
  const codes = new Map<string, Pending>();
  let issuer = "";
  const p: FakeOidc = {
    get issuer() { return issuer; },
    jwks: [first],
    signer: first,
    mutate: () => {},
    forge: undefined,
    tokenStatus: 200,
    discoveryIssuer: undefined,
    tokenRequests: [],
    endSession: true,
    endSessionRequests: [],
    jwksFetches: 0,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, { issuer: p.discoveryIssuer ?? issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, ...(p.endSession ? { end_session_endpoint: `${issuer}/end-session` } : {}) });
    }
    if (url.pathname === "/end-session" && p.endSession) {
      // As a provider does: end its own session, then send the browser to the post-logout address,
      // or show its own signed-out page when there is none.
      p.endSessionRequests.push(url.searchParams);
      const back = url.searchParams.get("post_logout_redirect_uri");
      if (url.searchParams.get("client_id") !== CLIENT_ID) return json(400, { error: "invalid_request" });
      if (back === null) return json(200, { signedOut: true });
      res.writeHead(302, { location: back });
      return res.end();
    }
    if (url.pathname === "/jwks") {
      p.jwksFetches++;
      return json(200, { keys: p.jwks.map((k) => k.jwk) });
    }
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      const redirect = q.get("redirect_uri");
      if (q.get("response_type") !== "code" || q.get("client_id") !== CLIENT_ID || q.get("code_challenge_method") !== "S256" || redirect === null) return json(400, { error: "invalid_request" });
      const code = randomBytes(8).toString("hex");
      codes.set(code, { nonce: q.get("nonce") ?? "", challenge: q.get("code_challenge") ?? "", redirectUri: redirect });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state") ?? "");
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const pending = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const pkceOk = pending !== undefined && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === pending.challenge;
      p.tokenRequests.push({ auth: req.headers.authorization, form, pkceOk });
      if (p.tokenStatus !== 200) return json(p.tokenStatus, { error: "invalid_grant" });
      if (pending === undefined || !pkceOk || form.get("redirect_uri") !== pending.redirectUri) return json(400, { error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000);
      const claims: Claims = { iss: issuer, sub: "u1", aud: CLIENT_ID, exp: now + 600, iat: now, nonce: pending.nonce, email: "alice@example.test", email_verified: true, name: "Alice", groups: ["squad"] };
      p.mutate(claims);
      const id = p.forge !== undefined ? p.forge(claims, p.signer) : jwt({ alg: p.signer.alg, kid: p.signer.kid, typ: "JWT" }, claims, signWith(p.signer));
      return json(200, { access_token: "fake-access", token_type: "Bearer", id_token: id });
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return p;
}

export const hs256 = (claims: Claims, secret: string): string => jwt({ alg: "HS256", typ: "JWT" }, claims, (input) => createHmac("sha256", secret).update(input).digest());
