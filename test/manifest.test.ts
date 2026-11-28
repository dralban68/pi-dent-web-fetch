/** specs/web-fetch.md#package: the extension loads when only its `dependencies` are installed. */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};

test("2.2 the entry module loads with only the packages of `dependencies` installed", async (t) => {
  // The host installs the package with its devDependencies omitted and supplies the peer
  // packages itself (specs/web-fetch.md#package), so a development checkout, where the
  // devDependencies are present, hides every import that only resolves with them.
  const stage = mkdtempSync(join(tmpdir(), "pi-dent-web-fetch-load-"));
  t.after(() => rmSync(stage, { recursive: true, force: true }));
  cpSync(join(root, "package.json"), join(stage, "package.json"));
  cpSync(join(root, "index.ts"), join(stage, "index.ts"));
  cpSync(join(root, "lib"), join(stage, "lib"), { recursive: true });
  const stageModules = join(stage, "node_modules");
  mkdirSync(stageModules);
  for (const name of Object.keys(manifest.dependencies)) {
    const target = join(stageModules, name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(join(root, "node_modules", name), target, "dir");
  }
  const result = await discoverAndLoadExtensions([join(stage, "index.ts")], stage);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
});
