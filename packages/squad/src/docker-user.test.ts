import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { containerUser, isRootless } from "./docker-user.ts";

// Real `docker info --format '{{json .SecurityOptions}}'` answers from a rootful and a rootless daemon.
const ROOTFUL = readFileSync(new URL("../test/fixtures/captures/docker/security-options-rootful.json", import.meta.url), "utf8");
const ROOTLESS = readFileSync(new URL("../test/fixtures/captures/docker/security-options-rootless.json", import.meta.url), "utf8");

test("isRootless reads the rootless option from a real capture, and only that", () => {
  assert.equal(isRootless(ROOTLESS), true);
  assert.equal(isRootless(ROOTFUL), false);
  assert.equal(isRootless("not json"), false);
  assert.equal(isRootless('{"name":"rootless"}'), false);
  assert.equal(isRootless('["name=rootlessish"]'), false);
});

test("containerUser: null on a rootless daemon, the host user on a rootful one or when docker info fails", () => {
  const host = { uid: process.getuid!(), gid: process.getgid!() };
  assert.equal(containerUser("docker", () => ROOTLESS), null);
  assert.deepEqual(containerUser("docker", () => ROOTFUL), host);
  assert.deepEqual(containerUser("docker", () => null), host);
});
