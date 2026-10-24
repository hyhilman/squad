import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MANUAL_REDIRECT, linkFromOpened } from "./claude-token.ts";

// Fakes with the shape of the URL that squad-claude:2.1.310 gave to $BROWSER; the values are made up.
const Q_HEAD = "code=true&client_id=00000000-0000-4000-8000-000000000000&response_type=code";
const Q_TAIL = "scope=user%3Ainference&code_challenge=FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE000&code_challenge_method=S256&state=FAKESTATEFAKESTATE000";
const opened = (redirect: string, base = "https://claude.com/cai/oauth/authorize"): string => `${base}?${Q_HEAD}&redirect_uri=${redirect}&${Q_TAIL}`;
const LOCAL = "http%3A%2F%2Flocalhost%3A43117%2Fcallback";
const MANUAL = `https://claude.com/cai/oauth/authorize?${Q_HEAD}&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&${Q_TAIL}`;

test("the opened URL becomes the manual link: only redirect_uri changes, every other byte stays", () => {
  assert.equal(MANUAL_REDIRECT, "https://platform.claude.com/oauth/code/callback");
  assert.equal(linkFromOpened(`${opened(LOCAL)}\n`), MANUAL);
  assert.equal(linkFromOpened(opened(LOCAL)), MANUAL, "no newline is fine");
  assert.equal(linkFromOpened(opened("http%3A%2F%2Flocalhost%3A1%2Fcallback")), MANUAL);
});

test("a look-alike page is refused", () => {
  for (const base of [
    "https://claude.com.evil.example/cai/oauth/authorize", "https://evilclaude.com/cai/oauth/authorize", "https://www.claude.com/cai/oauth/authorize",
    "http://claude.com/cai/oauth/authorize", "https://claude.com/cai/oauth/authorize/x", "https://claude.com/cai/oauth/authorizex",
    "https://claude.com@evil.example/cai/oauth/authorize", "https://user:pw@claude.com/cai/oauth/authorize", "https://claude.com:8443/cai/oauth/authorize",
    "https://claude.com:443/cai/oauth/authorize", "https://claude.com/CAI/oauth/authorize", "https://claude.com/cai/oauth/../oauth/authorize",
    "https://claude.com\\@evil.example/cai/oauth/authorize", "https://CLAUDE.com/cai/oauth/authorize ", "javascript://claude.com/cai/oauth/authorize",
  ]) {
    assert.equal(linkFromOpened(opened(LOCAL, base)), undefined, base);
  }
  assert.equal(linkFromOpened(`${opened(LOCAL)}#frag`), undefined, "no fragment");
});

test("redirect_uri must be exactly http://localhost:<port>/callback, once", () => {
  for (const r of [
    "https%3A%2F%2Flocalhost%3A43117%2Fcallback", "http%3A%2F%2F127.0.0.1%3A43117%2Fcallback", "http%3A%2F%2Flocalhost.evil.example%3A43117%2Fcallback",
    "http%3A%2F%2Flocalhost%2Fcallback", "http%3A%2F%2Flocalhost%3A43117%2Fcallback%2Fx", "http%3A%2F%2Flocalhost%3A43117%2Fcallback%3Fa%3Db",
    "http%3A%2F%2Fevil%40localhost%3A43117%2Fcallback", "http%3A%2F%2Flocalhost%3A99999%2Fcallback", "http%3A%2F%2Flocalhost%3Aabc%2Fcallback",
    "https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback", "", "%ZZ",
  ]) {
    assert.equal(linkFromOpened(opened(r)), undefined, r);
  }
  assert.equal(linkFromOpened(`${opened(LOCAL)}&redirect_uri=${LOCAL}`), undefined, "twice");
  assert.equal(linkFromOpened(`https://claude.com/cai/oauth/authorize?${Q_HEAD}&${Q_TAIL}`), undefined, "missing");
});

test("anything but one URL line is refused", () => {
  for (const bad of ["", "\n", `${opened(LOCAL)}\n\n`, `${opened(LOCAL)}\nsecond`, ` ${opened(LOCAL)}`, `${opened(LOCAL)} x`, `${opened(LOCAL)}\r\n`, `${opened(LOCAL)}\u0000`, `${opened(LOCAL)}&x=${"a".repeat(9000)}`]) {
    assert.equal(linkFromOpened(bad), undefined, JSON.stringify(bad.slice(-20)));
  }
});
