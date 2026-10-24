// A fake unsigned id_token for tests.
const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

// Shape test: the claim names are from a real login, the values are fake. The signature is junk.
export const fakeIdToken = (claims: Record<string, unknown> = {}): string =>
  `${b64u({ alg: "none", typ: "JWT" })}.${b64u({
    email: "alice@example.test",
    email_verified: true,
    name: "Alice Example",
    sub: "auth0|fake-sub",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-fake", chatgpt_plan_type: "plus", chatgpt_user_id: "user-fake" },
    ...claims,
  })}.c2ln`;

