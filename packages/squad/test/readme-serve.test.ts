// The README's provider mode section lists the routes of `squad serve`: it must list exactly SERVE_ROUTES.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SERVE_ROUTES } from "@squad/contract";

const README = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "README.md");

test("the README's provider mode route table is exactly SERVE_ROUTES", () => {
  const text = readFileSync(README, "utf8");
  const section = text.slice(text.indexOf("## Provider mode"), text.indexOf("## Web view"));
  const listed = [...section.matchAll(/^\| `(GET|POST|PUT|DELETE) (\/api\/[^`]+)` \|/gm)].map((m) => `${m[1]} ${m[2]}`).sort();
  assert.deepEqual(listed, Object.values(SERVE_ROUTES).map((r) => `${r.method} ${r.path}`).sort());
});
