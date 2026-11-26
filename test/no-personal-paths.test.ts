import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

/**
 * AGENTS.md Rules: no tracked file holds an absolute home path or the current user's name, except
 * the publishing fields of package.json. Placeholders such as `<absolute path of …>` are allowed.
 */

const root = join(import.meta.dirname, "..");
const PLACEHOLDER_HOMES = new Set(["u", "user"]);
const HOME_PATH = /(?:\/Users|\/home|[A-Za-z]:\\Users)[/\\]([A-Za-z0-9._-]+)/g;
const OWNER_FIELD = /^\s*"(?:author|homepage|bugs|url)":/;

async function trackedFiles(): Promise<{ path: string; lines: string[] }[]> {
  const { stdout } = await promisify(execFile)("git", ["ls-files", "-z"], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  const files = [];
  for (const path of stdout.split("\0").filter(Boolean)) {
    const text = readFileSync(join(root, path), "utf8");
    if (!text.includes("\0")) files.push({ path, lines: text.split("\n") });
  }
  return files;
}

test("no tracked file holds an absolute home path", async () => {
  const found: string[] = [];
  for (const { path, lines } of await trackedFiles()) {
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(HOME_PATH)) {
        if (!PLACEHOLDER_HOMES.has(match[1] ?? "")) found.push(`${path}:${index + 1}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(found, []);
});

test("no tracked file names the current user", async (t) => {
  // CI accounts have generic names (`runner`) that are ordinary words in this code.
  if (process.env.CI) return t.skip("CI account names are generic words");
  const name = userInfo().username;
  const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const found: string[] = [];
  for (const { path, lines } of await trackedFiles()) {
    for (const [index, line] of lines.entries()) {
      if (path === "package.json" && OWNER_FIELD.test(line)) continue;
      if (word.test(line)) found.push(`${path}:${index + 1}`);
    }
  }
  assert.deepEqual(found, []);
});
