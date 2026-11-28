/** specs/web-fetch.md#package: every runtime import survives an install with `dependencies` only. */

import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};

const runtimeFiles = (): string[] => [
  join(root, "index.ts"),
  ...readdirSync(join(root, "lib"), { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".ts"))
    .map((path) => join(root, "lib", path)),
];

test("2.2 every bare specifier of index.ts and lib/ names a dependency or peer package", () => {
  // A bare specifier missing from the manifest resolves in a development checkout through the
  // devDependencies (specs/web-fetch.md#package); the staged load below cannot see one the
  // host's own closure also reaches, so the scan checks the manifest directly.
  const specifiers = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\.meta\.resolve\s*\(\s*["']([^"']+)["']\s*\)/g,
  ].flatMap((pattern) =>
    runtimeFiles().flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(pattern)]
        .map((m) => m[1])
        .filter((specifier): specifier is string => specifier !== undefined),
    ),
  );
  const bare = specifiers.filter((specifier) => !/^(node:|\.|\/|#)/.test(specifier));
  assert.ok(bare.length > 0, "the scan found no bare specifier; its patterns match nothing");
  const unlisted = bare.filter((specifier) => {
    const [first = "", second = ""] = specifier.split("/");
    const name = first.startsWith("@") ? `${first}/${second}` : first;
    return !(name in manifest.dependencies) && !(name in manifest.peerDependencies);
  });
  assert.deepEqual(
    [...new Set(unlisted)],
    [],
    "bare specifiers outside dependencies and peerDependencies",
  );
});

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
