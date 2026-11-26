/** specs/web-fetch.md#entry-layout and specs/web-fetch.md#writing: no two files with the same text. */

import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import type { WebConfig } from "../lib/config.ts";
import { call, html, resultText, startServer, stubRegistry, tempDir, text } from "./helpers.ts";

const REFORMAT: WebConfig = { reformat: true, reformatModel: "stub/fast", diagnostics: [] };
const SOURCE = "Title\n\nsome text that\nwraps badly\n\n- one\n- two\n";
const VALID = "# Title\n\nsome text that wraps badly\n\n- one\n- two";

const files = async (cwd: string, path: string): Promise<string[]> =>
  (await readdir(join(cwd, path, ".."))).filter((name) => !name.startsWith(".")).toSorted();

test("4.2 a reformatted entry holds both files; a refetch that makes them equal removes extracted.md", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/doc", text(SOURCE));
  const { registry } = stubRegistry(() => ({ text: VALID }));
  const reformatted = await call(
    cwd,
    { url: `${server.origin}/doc` },
    { config: REFORMAT, registry },
  );
  const { path } = reformatted.details;
  assert.deepEqual(await files(cwd, path), ["content.md", "extracted.md", "meta.json"]);
  assert.equal(await readFile(join(cwd, reformatted.details.extractedPath), "utf8"), SOURCE);
  assert.ok(resultText(reformatted).includes(`Extracted: ${reformatted.details.extractedPath}\n`));
  const plain = await call(cwd, { url: `${server.origin}/doc`, refresh: true });
  assert.deepEqual(await files(cwd, path), ["content.md", "meta.json"]);
  assert.equal(plain.details.extractedPath, plain.details.path);
});

test("4.3 an older entry with two equal files loses extracted.md when rewritten", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/doc", text(SOURCE));
  const first = await call(cwd, { url: `${server.origin}/doc` });
  const dir = join(cwd, first.details.path, "..");
  await writeFile(join(dir, "extracted.md"), await readFile(join(dir, "content.md"), "utf8"));
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
  meta.fetchedAt = "2020-01-01T00:00:00.000Z";
  await writeFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  const again = await call(cwd, { url: `${server.origin}/doc` });
  assert.equal(again.details.status, "fetched");
  assert.deepEqual(await files(cwd, first.details.path), ["content.md", "meta.json"]);
});

test("4.2 an entry whose extracted.md was deleted is served from the cache", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/doc", text(SOURCE));
  const { registry } = stubRegistry(() => ({ text: VALID }));
  const first = await call(cwd, { url: `${server.origin}/doc` });
  await rm(join(cwd, first.details.path, "..", "extracted.md"), { force: true });
  const again = await call(cwd, { url: `${server.origin}/doc` });
  assert.equal(again.details.status, "cached");
  assert.equal(server.requests.length, 1);
  // The reformat reads the extraction from content.md.
  const reformatted = await call(
    cwd,
    { url: `${server.origin}/doc` },
    { config: REFORMAT, registry },
  );
  assert.equal(reformatted.details.reformat?.reformatted, 1);
  assert.equal(await readFile(join(cwd, reformatted.details.extractedPath), "utf8"), SOURCE);
});

test("4.2 without extracted.md, a content.md that no longer matches extractedSha256 is unreadable", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/doc", text(SOURCE));
  const { registry } = stubRegistry(() => ({ text: VALID }));
  const reformatted = await call(
    cwd,
    { url: `${server.origin}/doc` },
    { config: REFORMAT, registry },
  );
  await rm(join(cwd, reformatted.details.extractedPath), { force: true });
  const again = await call(cwd, { url: `${server.origin}/doc` });
  assert.equal(again.details.status, "fetched");
  assert.ok(
    again.details.notices.includes("The cache entry was unreadable and has been replaced."),
  );
});

test("5.4 a page whose extraction is only its title gets the title-only notice", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route(
    "/app",
    html('<div id="root"></div><script>render({"text":"hidden"})</script>', "<title>App</title>"),
  );
  const result = await call(cwd, { url: `${server.origin}/app` });
  assert.equal(await readFile(join(cwd, result.details.path), "utf8"), "# App\n");
  assert.ok(
    result.details.notices.includes(
      "The page produced no text beyond its title; it may be rendered by a script.",
    ),
  );
});
