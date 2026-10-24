import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHome, layoutOf } from "../home.ts";
import { parseSecretToml, WEB_SETTINGS, loadWebConfig } from "./settings.ts";

const home = () => {
  const l = layoutOf(mkdtempSync(join(tmpdir(), "webcfg-")), {});
  ensureHome(l);
  return l;
};
const ENV = { SQUAD_WEB_URL: "https://squad.example.test", SQUAD_OIDC_ISSUER: "https://id.example.test", SQUAD_OIDC_CLIENT_ID: "squad" };
const secretPath = (h: ReturnType<typeof home>): string => join(h.root, "squad.secret.toml");

test("every web setting has a one-line why, and the list is pinned", () => {
  assert.deepEqual(WEB_SETTINGS.map((s) => s.key), ["SQUAD_WEB_URL", "SQUAD_WEB_PORT", "SQUAD_WEB_BIND", "SQUAD_OIDC_ISSUER", "SQUAD_OIDC_CLIENT_ID", "SQUAD_OIDC_GROUP", "SQUAD_OIDC_ADMIN_GROUP", "SQUAD_WEB_PROVIDERS", "SQUAD_WEB_FRAME_ANCESTORS", "SQUAD_WEB_API_ORIGINS", "SQUAD_WEB_BRAND_DIR"]);
  for (const s of WEB_SETTINGS) assert.ok(s.why.length > 0 && !s.why.includes("\n"), s.key);
});

test("the defaults: port 20140, bind 127.0.0.1, no group, https means Secure cookies", () => {
  const c = loadWebConfig(ENV, home());
  assert.equal(c.port, 20140);
  assert.equal(c.bind, "127.0.0.1");
  assert.equal(c.group, undefined);
  assert.equal(c.adminGroup, undefined, "unset = nobody is admin");
  assert.equal(c.secure, true);
  assert.equal(c.origin, "https://squad.example.test");
  assert.equal(c.url, "https://squad.example.test");
  assert.equal(loadWebConfig({ ...ENV, SQUAD_WEB_URL: "http://127.0.0.1:3000/" }, home()).secure, false);
});

test("frame ancestors: none by default; https origins and *.host origins only", () => {
  assert.equal(loadWebConfig(ENV, home()).frameAncestors, "'none'");
  assert.equal(loadWebConfig({ ...ENV, SQUAD_WEB_FRAME_ANCESTORS: "https://app.example.test, https://*.example.test" }, home()).frameAncestors, "https://app.example.test https://*.example.test");
  for (const bad of ["*", "http://app.example.test", "https://app.example.test/path", "app.example.test", "https://a.test;script-src *", "'unsafe-inline'", "https://*"]) {
    assert.throws(() => loadWebConfig({ ...ENV, SQUAD_WEB_FRAME_ANCESTORS: bad }, home()), /SQUAD_WEB_FRAME_ANCESTORS/, bad);
  }
});

test("api origins: none by default; exact https origins only", () => {
  assert.deepEqual(loadWebConfig(ENV, home()).apiOrigins, []);
  assert.deepEqual(loadWebConfig({ ...ENV, SQUAD_WEB_API_ORIGINS: "https://app.example.test, https://Other.example.test:8443" }, home()).apiOrigins, ["https://app.example.test", "https://other.example.test:8443"]);
  for (const bad of ["*", "http://app.example.test", "https://app.example.test/path", "https://app.example.test/", "app.example.test", "https://*.example.test", "https://a.test;x", "null"]) {
    assert.throws(() => loadWebConfig({ ...ENV, SQUAD_WEB_API_ORIGINS: bad }, home()), /SQUAD_WEB_API_ORIGINS/, bad);
  }
});

test("the first start writes a session key, mode 0600, and the second start keeps it", () => {
  const h = home();
  const a = loadWebConfig(ENV, h);
  assert.equal(a.sessionKey.length, 32);
  assert.equal(statSync(secretPath(h)).mode & 0o777, 0o600);
  assert.match(readFileSync(secretPath(h), "utf8"), /^session_key = "[A-Za-z0-9_-]+"\n$/);
  assert.deepEqual(loadWebConfig(ENV, h).sessionKey, a.sessionKey);
});

test("the client secret comes from the secret file; the session key is added beside it", () => {
  const h = home();
  writeFileSync(secretPath(h), '# comment\noidc_client_secret = "s3cret"\n', { mode: 0o600 });
  const c = loadWebConfig(ENV, h);
  assert.equal(c.clientSecret, "s3cret");
  assert.match(readFileSync(secretPath(h), "utf8"), /oidc_client_secret = "s3cret"\nsession_key = "/);
});

test("a secret file that is not mode 0600 refuses the start, without printing its content", () => {
  const h = home();
  writeFileSync(secretPath(h), 'oidc_client_secret = "topsecretvalue"\n', { mode: 0o600 });
  chmodSync(secretPath(h), 0o640);
  assert.throws(() => loadWebConfig(ENV, h), (e: Error) => /0600/.test(e.message) && !e.message.includes("topsecretvalue"));
});

test("the secret file takes key = \"value\" lines only; the error names the line, not the text", () => {
  assert.deepEqual(parseSecretToml('a = "1"\n\n# x\nb_c = "two words"\n'), { a: "1", b_c: "two words" });
  for (const bad of ['a = 1', 'a = "x" # tail', '[table]', 'a = "x"\na = "y"', 'A = "x"', "a = 'x'", 'a = "unterminated', 'a="x"\nrubbish tokenvalue']) {
    assert.throws(() => parseSecretToml(bad), (e: Error) => /line \d+/.test(e.message) && !e.message.includes("tokenvalue"), bad);
  }
  const h = home();
  writeFileSync(secretPath(h), 'unknown_key = "x"\n', { mode: 0o600 });
  assert.throws(() => loadWebConfig(ENV, h), /unknown_key/);
});

test("a short or broken session_key is refused", () => {
  const h = home();
  writeFileSync(secretPath(h), 'session_key = "abc"\n', { mode: 0o600 });
  assert.throws(() => loadWebConfig(ENV, h), /session_key/);
});

test("missing or bad settings refuse the start", () => {
  const h = home();
  for (const k of ["SQUAD_WEB_URL", "SQUAD_OIDC_ISSUER", "SQUAD_OIDC_CLIENT_ID"]) {
    const env: Record<string, string> = { ...ENV };
    delete env[k];
    assert.throws(() => loadWebConfig(env, h), new RegExp(k), k);
  }
  assert.throws(() => loadWebConfig({ ...ENV, SQUAD_WEB_URL: "ftp://x" }, h), /SQUAD_WEB_URL/);
  assert.throws(() => loadWebConfig({ ...ENV, SQUAD_WEB_URL: "https://x.test/app" }, h), /SQUAD_WEB_URL/);
  assert.throws(() => loadWebConfig({ ...ENV, SQUAD_WEB_PORT: "99999" }, h), /SQUAD_WEB_PORT/);
  assert.throws(() => loadWebConfig({ ...ENV, SQUAD_OIDC_ISSUER: "http://id.example.test" }, h), /SQUAD_OIDC_ISSUER/);
  assert.equal(loadWebConfig({ ...ENV, SQUAD_OIDC_ISSUER: "http://127.0.0.1:9" }, h).issuer, "http://127.0.0.1:9", "plain http only for loopback");
});

test("SQUAD_NO_WEB_LOGIN=1 refuses the start (fail safe)", () => {
  assert.throws(() => loadWebConfig({ ...ENV, SQUAD_NO_WEB_LOGIN: "1" }, home()), /SQUAD_NO_WEB_LOGIN/);
  assert.ok(loadWebConfig({ ...ENV, SQUAD_NO_WEB_LOGIN: "0" }, home()));
});

test("SQUAD_OIDC_ADMIN_GROUP is read as is; an empty value is unset", () => {
  assert.equal(loadWebConfig({ ...ENV, SQUAD_OIDC_ADMIN_GROUP: "squad-admins" }, home()).adminGroup, "squad-admins");
  assert.equal(loadWebConfig({ ...ENV, SQUAD_OIDC_ADMIN_GROUP: "" }, home()).adminGroup, undefined);
});
