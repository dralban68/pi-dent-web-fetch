/** specs/web-fetch.md, Sections 4 and 9: cache location, entries, freshness, stale copies, result. */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { call, html, resultText, startServer, tempDir, text } from "./helpers.ts";

const PAGE = `<article><h1>Cached</h1><p>${"Text worth caching for later reading. ".repeat(10)}</p></article>`;

async function readMeta(cwd: string, path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(cwd, path, "..", "meta.json"), "utf8"));
}

async function age(cwd: string, path: string, hours: number): Promise<void> {
  const file = join(cwd, path, "..", "meta.json");
  const meta = JSON.parse(await readFile(file, "utf8"));
  meta.fetchedAt = new Date(Date.now() - hours * 3_600_000).toISOString();
  await writeFile(file, JSON.stringify(meta));
}

test("4.1 creates the cache directory with a .gitignore of *", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/", html(PAGE));
  await call(cwd, { url: `${server.origin}/` });
  assert.equal(await readFile(join(cwd, ".pi", "web-cache", ".gitignore"), "utf8"), "*\n");
});

test("4.1 leaves an existing cache .gitignore and the project's own unchanged", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/", html(PAGE));
  await mkdir(join(cwd, ".pi", "web-cache"), { recursive: true });
  await writeFile(join(cwd, ".pi", "web-cache", ".gitignore"), "custom\n");
  await call(cwd, { url: `${server.origin}/` });
  assert.equal(await readFile(join(cwd, ".pi", "web-cache", ".gitignore"), "utf8"), "custom\n");
  await assert.rejects(readFile(join(cwd, ".gitignore")), { code: "ENOENT" });
});

test("4.2 an entry holds extracted.md, content.md and meta.json with every field", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/doc", (_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      etag: '"v1"',
      "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT",
    });
    res.end(`<html><head><title>Doc</title></head><body>${PAGE}</body></html>`);
  });
  const result = await call(cwd, { url: `${server.origin}/doc#part` });
  const { details } = result;
  const port = new URL(server.origin).port;
  assert.match(
    details.path,
    new RegExp(`^\\.pi/web-cache/127\\.0\\.0\\.1_${port}/doc-[0-9a-f]{8}/content\\.md$`),
  );
  assert.equal(details.absolutePath, join(cwd, details.path));
  assert.equal(details.extractedPath, details.path.replace("content.md", "extracted.md"));
  const dir = join(cwd, details.path, "..");
  assert.deepEqual((await readdir(dir)).toSorted(), ["content.md", "extracted.md", "meta.json"]);
  const meta = await readMeta(cwd, details.path);
  assert.deepEqual(Object.keys(meta).toSorted(), [
    "bytes",
    "canonicalUrl",
    "contentType",
    "etag",
    "extractedSha256",
    "fetchedAt",
    "finalUrl",
    "lastModified",
    "reformat",
    "status",
    "title",
    "url",
  ]);
  assert.equal(meta.url, `${server.origin}/doc#part`);
  assert.equal(meta.canonicalUrl, `${server.origin}/doc`);
  assert.equal(meta.status, 200);
  assert.equal(meta.etag, '"v1"');
  assert.equal(meta.lastModified, "Wed, 01 Jan 2025 00:00:00 GMT");
  assert.equal(meta.contentType, "text/html; charset=utf-8");
  assert.equal(meta.title, "Doc");
  assert.equal(meta.reformat, null);
  assert.match(String(meta.fetchedAt), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(
    await readFile(join(dir, "content.md"), "utf8"),
    await readFile(join(dir, "extracted.md"), "utf8"),
  );
});

test("4.2 URLs with one canonical form share one entry", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/a", html(PAGE));
  const first = await call(cwd, { url: `${server.origin}/a?x=1&utm_campaign=c` });
  const second = await call(cwd, { url: `${server.origin}/a?x=1#y` });
  assert.equal(first.details.path, second.details.path);
  assert.equal(second.details.status, "cached");
});

test("4.4 a fresh entry is served from disk with no request", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/", html(PAGE));
  await call(cwd, { url: `${server.origin}/` });
  const again = await call(cwd, { url: `${server.origin}/` });
  assert.equal(again.details.status, "cached");
  assert.equal(server.requests.length, 1);
  assert.ok(resultText(again).startsWith("WebFetch: cached\n"));
});

test("4.4 an old entry is revalidated with its validators; a 304 changes only fetchedAt", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/", (req, res) => {
    if (req.headers["if-none-match"] === '"v1"') return void res.writeHead(304).end();
    res.writeHead(200, {
      "content-type": "text/markdown",
      etag: '"v1"',
      "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT",
    });
    res.end("# Page\n");
  });
  const first = await call(cwd, { url: `${server.origin}/` });
  await age(cwd, first.details.path, 25);
  const before = await readMeta(cwd, first.details.path);
  const second = await call(cwd, { url: `${server.origin}/` });
  assert.equal(second.details.status, "revalidated");
  assert.equal(server.requests[1]?.headers["if-none-match"], '"v1"');
  assert.equal(server.requests[1]?.headers["if-modified-since"], "Wed, 01 Jan 2025 00:00:00 GMT");
  const after = await readMeta(cwd, first.details.path);
  assert.notEqual(after.fetchedAt, before.fetchedAt);
  assert.deepEqual({ ...after, fetchedAt: null }, { ...before, fetchedAt: null });
});

test("4.4 maxAgeHours 0 revalidates at once; refresh fetches with no validators", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  let version = 1;
  server.route("/", (_req, res) => {
    res.writeHead(200, { "content-type": "text/markdown", etag: `"v${version}"` });
    res.end(`# Version ${version}\n`);
  });
  await call(cwd, { url: `${server.origin}/` });
  version = 2;
  const zero = await call(cwd, { url: `${server.origin}/`, maxAgeHours: 0 });
  assert.equal(zero.details.status, "fetched");
  assert.equal(server.requests[1]?.headers["if-none-match"], '"v1"');
  const refreshed = await call(cwd, { url: `${server.origin}/`, refresh: true });
  assert.equal(refreshed.details.status, "fetched");
  assert.equal(server.requests[2]?.headers["if-none-match"], undefined);
  assert.equal(refreshed.details.title, "Version 2");
});

test("2.1 refuses a negative maxAgeHours", async (t) => {
  await assert.rejects(call(await tempDir(t), { url: "https://example.com/", maxAgeHours: -1 }), {
    message: "WebFetch: maxAgeHours must be a number of 0 or more",
  });
});

test("4.5 a failed refetch serves the entry as stale, with its date", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  let fail = false;
  server.route("/", (_req, res) => {
    if (fail) return void res.writeHead(500).end();
    res.writeHead(200, { "content-type": "text/markdown" }).end("# Kept\n");
  });
  const first = await call(cwd, { url: `${server.origin}/` });
  fail = true;
  const stale = await call(cwd, { url: `${server.origin}/`, refresh: true });
  assert.equal(stale.details.status, "stale");
  assert.ok(
    stale.details.notices.includes(
      `Refetch failed (WebFetch: HTTP 500 from ${server.origin}/); serving the copy fetched at ${first.details.fetchedAt}.`,
    ),
  );
  assert.ok(resultText(stale).includes("# Kept"));
});

test("4.5 a body past the cap on refetch also serves the stale copy", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  let big = false;
  server.route("/", (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(big ? "a".repeat(10 * 1024 * 1024 + 1) : "small");
  });
  await call(cwd, { url: `${server.origin}/` });
  big = true;
  const stale = await call(cwd, { url: `${server.origin}/`, refresh: true });
  assert.equal(stale.details.status, "stale");
  assert.match(stale.details.notices[0] ?? "", /exceeds 10485760 bytes; nothing was cached/);
});

test("4.5 an invalid URL is an error even when nothing could be served", async (t) => {
  await assert.rejects(call(await tempDir(t), { url: "mailto:a@b" }), /only http and https/);
});

test("4.2 an unreadable entry is replaced, with a notice", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/", text("# Fine\n"));
  const first = await call(cwd, { url: `${server.origin}/` });
  await writeFile(join(cwd, first.details.path, "..", "meta.json"), "{ not json");
  const second = await call(cwd, { url: `${server.origin}/` });
  assert.equal(second.details.status, "fetched");
  assert.ok(
    second.details.notices.includes("The cache entry was unreadable and has been replaced."),
  );
});

test("9.1 the result lists the paths, status, title, URL, date, length, and a preview cut at 4000", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  const body = `# Long\n\n${"x".repeat(5000)}\n`;
  server.route("/long", text(body));
  const result = await call(cwd, { url: `${server.origin}/long` });
  const lines = resultText(result).split("\n");
  const { details } = result;
  assert.deepEqual(lines.slice(0, 10), [
    "WebFetch: fetched",
    `Path: ${details.path}`,
    `Absolute path: ${details.absolutePath}`,
    `Extracted: ${details.extractedPath}`,
    "Title: Long",
    `URL: ${server.origin}/long`,
    `Fetched at: ${details.fetchedAt}`,
    `Length: ${body.length} characters`,
    "Reformat: none",
    "",
  ]);
  assert.equal(details.previewLength, 4000);
  assert.equal(
    lines.at(-1),
    `[${body.length - 4000} more characters; read the rest from ${details.path}]`,
  );
});

test("9.1 the preview does not split a surrogate pair", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/emoji", text(`${"a".repeat(3999)}😀tail`, "text/plain"));
  const result = await call(cwd, { url: `${server.origin}/emoji` });
  assert.equal(result.details.previewLength, 3999);
});
