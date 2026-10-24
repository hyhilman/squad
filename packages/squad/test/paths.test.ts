import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledPath } from "../src/paths.ts";

// A fake package: <t>/pkg/{src|dist}, with the repo folders two levels above pkg for the source tree.
function tree(): string {
  return mkdtempSync(join(tmpdir(), "squad-paths-"));
}

test("installed layout: finds the copy next to the code", () => {
  const t = tree();
  mkdirSync(join(t, "dist/assets"), { recursive: true });
  writeFileSync(join(t, "dist/assets/a.toml"), "x");
  assert.equal(bundledPath("assets/a.toml", join(t, "dist")), join(t, "dist/assets/a.toml"));
});

test("source layout: falls back to the repo folders", () => {
  const t = tree();
  mkdirSync(join(t, "packages/squad/src"), { recursive: true });
  mkdirSync(join(t, "packages/squad/assets"), { recursive: true });
  mkdirSync(join(t, "images"), { recursive: true });
  mkdirSync(join(t, "apps/web/dist"), { recursive: true });
  writeFileSync(join(t, "packages/squad/assets/a.toml"), "x");
  const root = join(t, "packages/squad/src");
  assert.equal(bundledPath("assets/a.toml", root), join(t, "packages/squad/assets/a.toml"));
  assert.equal(bundledPath("images", root), join(t, "images"));
  assert.equal(bundledPath("web", root), join(t, "apps/web/dist"));
});

test("the installed copy wins when both exist", () => {
  const t = tree();
  mkdirSync(join(t, "dist/images"), { recursive: true });
  mkdirSync(join(t, "images"), { recursive: true });
  assert.equal(bundledPath("images", join(t, "dist")), join(t, "dist/images"));
});

test("a missing folder returns the first candidate, so the error names a real place", () => {
  const t = tree();
  assert.equal(bundledPath("web", join(t, "dist")), join(t, "dist/web"));
});
