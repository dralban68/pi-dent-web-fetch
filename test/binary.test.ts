/** Stored files and data text (specs/web-fetch.md#timeout-and-cap, specs/web-fetch.md#entry-layout, specs/web-fetch.md#data-text, specs/web-fetch.md#stored-files). */

import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { MAX_BODY_BYTES, MAX_STORED_BYTES } from "../lib/http.ts";
import { call, startServer, tempDir, type Handler } from "./helpers.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const ZIP = Buffer.from("PK\x03\x04 a zip body is served byte-identical, not parsed", "latin1");

function bytes(type: string, body: Buffer, extra: Record<string, string> = {}): Handler {
  return (_req, res) => {
    res.writeHead(200, { "content-type": type, ...extra });
    res.end(body);
  };
}

const HOST = (origin: string): string => `127.0.0.1_${new URL(origin).port}`;

async function entryDir(cwd: string, origin: string, slug?: string): Promise<string> {
  const base = join(cwd, ".pi", "web-cache", HOST(origin));
  const names = await readdir(base);
  const name = slug === undefined ? names[0] : names.find((entry) => entry.startsWith(`${slug}-`));
  if (name === undefined) throw new Error(`no entry under ${base}`);
  return join(base, name);
}

const textOf = (result: { content: { type: string; text?: string }[] }): string =>
  result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";

test("5.8 a PNG is stored byte-identical as file.png, named in meta.json and the result", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/pic.png", bytes("image/png", PNG));
  const result = await call(cwd, { url: `${server.origin}/pic.png` });
  const dir = await entryDir(cwd, server.origin);
  assert.ok((await readFile(join(dir, "file.png"))).equals(PNG), "byte-identical");
  assert.equal(await readFile(join(cwd, result.details.path), "utf8"), "");
  const text = textOf(result);
  assert.match(text, new RegExp(`File: .*file\\.png \\(${PNG.length} bytes\\)`));
  assert.match(text, /Absolute file: /);
  assert.match(text, /File type: image\/png/);
  assert.ok(
    !text.includes("The page produced no text."),
    "a stored file states no empty-text notice",
  );
  assert.match(result.details.file?.path ?? "", /file\.png$/);
  assert.equal(result.details.file?.bytes, PNG.length);
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
  assert.equal(meta.fileName, "file.png");
  assert.equal(meta.fileBytes, PNG.length);
  assert.equal(meta.bytes, PNG.length);
  assert.equal(meta.title, null);
});

test("5.8 a zip is stored byte-identical with the map's extension", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/bundle", bytes("application/zip", ZIP));
  const result = await call(cwd, { url: `${server.origin}/bundle` });
  const dir = await entryDir(cwd, server.origin);
  assert.ok((await readFile(join(dir, "file.zip"))).equals(ZIP));
  assert.equal(result.details.file?.bytes, ZIP.length);
});

test("5.8 an unknown type falls back to the URL extension, else to bin", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  const body = Buffer.from("opaque");
  server.route("/data/some.file.DATA", bytes("application/octet-stream", body));
  server.route("/data/bare", bytes("application/octet-stream", body));
  const named = await call(cwd, { url: `${server.origin}/data/some.file.DATA` });
  const dir = await entryDir(cwd, server.origin, "data-some-file-data");
  assert.ok((await readFile(join(dir, "file.data"))).equals(body));
  assert.equal(named.details.file?.contentType, "application/octet-stream");
  await call(cwd, { url: `${server.origin}/data/bare` });
  const bare = await entryDir(cwd, server.origin, "data-bare");
  const meta = JSON.parse(await readFile(join(bare, "meta.json"), "utf8"));
  assert.equal(meta.fileName, "file.bin");
});

test("5.8 a hostile Content-Disposition cannot name the file, escape the entry, or reach the result", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route(
    "/trap",
    bytes("application/octet-stream", PNG, {
      "content-disposition":
        "attachment; filename=\"../../../../pwned.sh\"; filename*=utf-8''%2e%2e%2fpwned",
    }),
  );
  const result = await call(cwd, { url: `${server.origin}/trap` });
  const dir = await entryDir(cwd, server.origin);
  const files = await readdir(dir);
  assert.deepEqual(
    files.filter((name) => !name.startsWith(".")),
    ["content.md", "file.bin", "meta.json"],
  );
  const meta = await readFile(join(dir, "meta.json"), "utf8");
  assert.ok(!meta.includes("pwned"));
  assert.ok(!textOf(result).includes("pwned"));
});

test("3.6 a stored file past 50 MiB is refused with the stated cap; one at the cap is fetched", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  const over = Buffer.alloc(MAX_STORED_BYTES + 1, 0x62);
  const at = Buffer.alloc(MAX_STORED_BYTES, 0x62);
  server.route("/over", bytes("application/octet-stream", over));
  server.route("/at", bytes("application/octet-stream", at));
  await assert.rejects(call(cwd, { url: `${server.origin}/over` }), {
    message: `WebFetch: response from ${server.origin}/over exceeds ${MAX_STORED_BYTES} bytes; nothing was cached`,
  });
  await assert.rejects(readdir(join(cwd, ".pi", "web-cache")), { code: "ENOENT" });
  const fetched = await call(cwd, { url: `${server.origin}/at` });
  assert.equal(fetched.details.file?.bytes, MAX_STORED_BYTES);
  assert.equal(fetched.details.length, 0);
});

test("3.6 a text body keeps the 10 MiB cap while a binary may go past it", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/text", bytes("text/plain", Buffer.alloc(MAX_BODY_BYTES + 1, 0x61)));
  server.route("/bin", bytes("application/octet-stream", Buffer.alloc(MAX_BODY_BYTES + 1, 0x61)));
  await assert.rejects(call(cwd, { url: `${server.origin}/text` }), /exceeds 10485760 bytes/);
  const binary = await call(cwd, { url: `${server.origin}/bin` });
  assert.equal(binary.details.file?.bytes, MAX_BODY_BYTES + 1);
});

test("4.4 a fresh binary entry is served without a request; revalidation keeps the bytes", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/pic.png", bytes("image/png", PNG, { etag: '"v1"' }));
  const first = await call(cwd, { url: `${server.origin}/pic.png` });
  assert.equal(first.details.status, "fetched");
  const fresh = await call(cwd, { url: `${server.origin}/pic.png` });
  assert.equal(fresh.details.status, "cached");
  assert.equal(fresh.details.file?.bytes, PNG.length);
  assert.equal(server.requests.length, 1, "no network while fresh");
  const dir = await entryDir(cwd, server.origin);
  const stale = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
  stale.fetchedAt = "2020-01-01T00:00:00.000Z";
  await writeFile(join(dir, "meta.json"), `${JSON.stringify(stale, null, 2)}\n`);
  server.route("/pic.png", (req, res) => {
    assert.equal(req.headers["if-none-match"], '"v1"');
    res.writeHead(304, { etag: '"v1"' });
    res.end();
  });
  const revalidated = await call(cwd, { url: `${server.origin}/pic.png` });
  assert.equal(revalidated.details.status, "revalidated");
  assert.ok((await readFile(join(dir, "file.png"))).equals(PNG));
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
  assert.notEqual(meta.fetchedAt, "2020-01-01T00:00:00.000Z");
  server.route("/pic.png", bytes("image/png", Buffer.concat([PNG, PNG])));
  const replaced = await call(cwd, { url: `${server.origin}/pic.png`, refresh: true });
  assert.equal(replaced.details.status, "fetched");
  assert.ok((await readFile(join(dir, "file.png"))).equals(Buffer.concat([PNG, PNG])));
  const after = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
  assert.equal(after.fileBytes, PNG.length * 2);
});

test("5.7 JSON and XML data text is cleaned text with its structure intact", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  const json = '{"key": "value\u200B", "list": [1, 2]}\n';
  const xml =
    '<?xml version="1.0"?>\n<feed><entry>a &amp; b</entry><script>alert("x")</script></feed>';
  server.route("/data.json", bytes("application/json", Buffer.from(json)));
  server.route("/feed.xml", bytes("text/xml", Buffer.from(xml)));
  const jsonResult = await call(cwd, { url: `${server.origin}/data.json` });
  assert.equal(
    await readFile(join(cwd, jsonResult.details.path), "utf8"),
    '{"key": "value", "list": [1, 2]}\n',
  );
  assert.equal(jsonResult.details.title, null);
  const xmlResult = await call(cwd, { url: `${server.origin}/feed.xml` });
  const stored = await readFile(join(cwd, xmlResult.details.path), "utf8");
  assert.ok(stored.includes("<feed>") && stored.includes("<script>"), "XML tags are kept as text");
  assert.ok(stored.includes("a &amp; b"));
});
