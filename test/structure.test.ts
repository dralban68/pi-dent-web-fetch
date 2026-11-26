/** specs/web-fetch.md, Sections 5.3 and 5.6: empty sections and table cells with block content. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { checkChunk } from "../lib/reduce.ts";
import { call, html, startServer, tempDir } from "./helpers.ts";

const PROSE = `<p>${"Readable words that fill the article body. ".repeat(8)}</p>`;

async function extracted(t: TestContext, body: string): Promise<string> {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/", html(`<article>${body}</article>`));
  const result = await call(cwd, { url: `${server.origin}/` });
  return readFile(join(cwd, result.details.extractedPath), "utf8");
}

test("5.6 removes a heading whose section is empty, as MDN's live-example 'Result' is", async (t) => {
  const md = await extracted(
    t,
    `<h2>Example</h2>${PROSE}<h4>Result</h4><iframe src="/live"></iframe><h2>Technical summary</h2>${PROSE}`,
  );
  assert.ok(!md.includes("#### Result"), md);
  assert.match(md, /## Example\n\n.+\n\n## Technical summary\n/);
});

test("5.6 keeps a heading whose subsection holds content, and removes nested empty ones", async (t) => {
  const md = await extracted(
    t,
    `<h2>Parent</h2><h3>Child</h3>${PROSE}<h2>Empty parent</h2><h3>Empty child</h3><h2>Last</h2>${PROSE}`,
  );
  assert.ok(md.includes("## Parent\n\n### Child\n\n"), md);
  assert.ok(!md.includes("Empty parent") && !md.includes("Empty child"), md);
  assert.ok(md.includes("## Last\n\n"));
});

test("5.3 a table cell holding a list keeps one line, its items joined with ' · '", async (t) => {
  const md = await extracted(
    t,
    `${PROSE}<table><tr><th>Element</th><th>Parents</th></tr><tr><td>tr</td><td><p>Either:</p><ul><li>table</li><li>tbody</li></ul></td></tr></table>`,
  );
  assert.ok(md.includes("| tr  | Either: · - table · - tbody |"), md);
});

test("5.3 a table cell holding a nested table keeps its rows apart with ' · '", async (t) => {
  const md = await extracted(
    t,
    `${PROSE}<table><tr><th>Outer</th><th>Detail</th></tr><tr><td>x</td><td><table><tr><th>k</th><th>v</th></tr><tr><td>a</td><td>1</td></tr></table></td></tr></table>`,
  );
  assert.ok(md.includes("| x   | \\| k \\| v \\| · \\| a \\| 1 \\| |"), md);
});

test("7.5 the ' · ' separator is text: keeping it passes, dropping or replacing it fails", () => {
  const input = "| tr | Either: · - table · - tbody |";
  assert.equal(checkChunk(input, "| tr  | Either: · - table · - tbody |"), "pass");
  assert.equal(checkChunk(input, "| tr | Either: - table - tbody |"), "text changed");
  assert.equal(checkChunk(input, "| tr | Either:<br>- table<br>- tbody |"), "text changed");
});
