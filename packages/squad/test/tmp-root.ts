// `npm test` loads this into every test file's process (`--import`). It gives that process its own
// temp root, and points SQUAD_HOME there, so no test ever opens a real home. The root goes when the
// process exits.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "squad-test-"));
process.env.TMPDIR = root;
process.env.SQUAD_HOME ??= join(root, "home");

process.on("exit", () => rmSync(root, { recursive: true, force: true }));
