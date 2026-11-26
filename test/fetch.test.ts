/** specs/web-fetch.md, Sections 3 and 5.1: the request, its guard and limits, and content types. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { MAX_BODY_BYTES, fetchPage } from "../lib/http.ts";
import { call, html, resultText, startServer, tempDir, text } from "./helpers.ts";

const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const PAGE = `<article><h1>Doc</h1><p>${"Plain readable words for the page body. ".repeat(10)}</p></article>`;

test("3.3 sends GET with the User-Agent, Accept and Accept-Encoding headers", async (t) => {
  const server = await startServer(t);
  server.route("/", html(PAGE));
  await call(await tempDir(t), { url: `${server.origin}/` });
  const req = server.requests[0];
  assert.equal(req?.method, "GET");
  assert.match(
    req?.headers["user-agent"] ?? "",
    new RegExp(
      `^pi-dent-web/${VERSION.replaceAll(".", "\\.")} \\(\\+https://github\\.com/.+/pi-dent-web#readme\\)$`,
    ),
  );
  assert.equal(req?.headers.accept, "text/markdown, text/html;q=0.9, text/plain;q=0.8");
  assert.equal(req?.headers["accept-encoding"], "gzip, deflate, br");
});

test("3.2 requests the canonical URL", async (t) => {
  const server = await startServer(t);
  server.route("/p", html(PAGE));
  await call(await tempDir(t), { url: `${server.origin}/p?z=1&utm_source=x&a=2#f` });
  assert.equal(server.requests[0]?.url, "/p?a=2&z=1");
});

test("3.4 refuses a loopback IP literal unless the test seam allows it", async (t) => {
  const server = await startServer(t);
  server.route("/", html(PAGE));
  await assert.rejects(call(await tempDir(t), { url: `${server.origin}/` }, { allowed: [] }), {
    message: `WebFetch: refused ${server.origin}/: 127.0.0.1 is a loopback address (127.0.0.1)`,
  });
  assert.equal(server.requests.length, 0);
});

test("3.4 refuses localhost names without resolving them", async (t) => {
  let resolved = false;
  const resolve = async () => {
    resolved = true;
    return ["93.184.215.14"];
  };
  await assert.rejects(call(await tempDir(t), { url: "http://api.LOCALHOST/x" }, { resolve }), {
    message: "WebFetch: refused http://api.localhost/x: api.localhost is a loopback name",
  });
  assert.equal(resolved, false);
});

test("3.4 refuses a host name that resolves to a private address, when any address is", async (t) => {
  const resolve = async () => ["93.184.215.14", "10.0.0.7"];
  await assert.rejects(call(await tempDir(t), { url: "https://intranet.example/" }, { resolve }), {
    message:
      "WebFetch: refused https://intranet.example/: intranet.example is a private address (10.0.0.7)",
  });
});

test("3.4 reports a resolution failure", async (t) => {
  const resolve = async () => {
    throw new Error("ENOTFOUND");
  };
  await assert.rejects(call(await tempDir(t), { url: "https://nowhere.example/" }, { resolve }), {
    message: "WebFetch: cannot resolve nowhere.example: ENOTFOUND",
  });
});

test("3.4 connects to the checked address and sends the host name", async (t) => {
  const server = await startServer(t);
  server.route("/", html(PAGE));
  const port = new URL(server.origin).port;
  const lookups: string[] = [];
  const resolve = async (host: string) => {
    lookups.push(host);
    return ["127.0.0.1"];
  };
  const result = await call(await tempDir(t), { url: `http://docs.example:${port}/` }, { resolve });
  assert.equal(result.details.status, "fetched");
  assert.deepEqual(lookups, ["docs.example"]);
  assert.equal(server.requests[0]?.headers.host, `docs.example:${port}`);
});

test("3.5 follows redirects by hand, checking each hop: a redirect to a private address is refused", async (t) => {
  const server = await startServer(t);
  server.route("/r", (_req, res) =>
    res.writeHead(302, { location: "http://169.254.169.254/latest" }).end(),
  );
  await assert.rejects(call(await tempDir(t), { url: `${server.origin}/r` }), {
    message:
      "WebFetch: refused http://169.254.169.254/latest: 169.254.169.254 is a link-local address (169.254.169.254)",
  });
});

test("3.5 a redirect to a host name that resolves to a private address is refused", async (t) => {
  const server = await startServer(t);
  server.route("/r", (_req, res) =>
    res.writeHead(307, { location: "http://admin.example/" }).end(),
  );
  const resolve = async () => ["192.168.1.1"];
  await assert.rejects(call(await tempDir(t), { url: `${server.origin}/r` }, { resolve }), {
    message:
      "WebFetch: refused http://admin.example/: admin.example is a private address (192.168.1.1)",
  });
});

test("3.5 a relative redirect is followed and its URL is the final URL", async (t) => {
  const server = await startServer(t);
  server.route("/old", (_req, res) => res.writeHead(301, { location: "/new" }).end());
  server.route("/new", html(PAGE));
  const result = await call(await tempDir(t), { url: `${server.origin}/old` });
  assert.equal(result.details.finalUrl, `${server.origin}/new`);
  assert.ok(resultText(result).includes(`URL: ${server.origin}/new`));
});

test("3.5 refuses a non-http redirect, a missing Location, and more than 5 redirects", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/ftp", (_req, res) =>
    res.writeHead(302, { location: "ftp://example.com/f" }).end(),
  );
  server.route("/none", (_req, res) => res.writeHead(302).end());
  for (let i = 0; i < 6; i += 1) {
    server.route(`/loop${i}`, (_req, res) =>
      res.writeHead(302, { location: `/loop${i + 1}` }).end(),
    );
  }
  server.route("/loop6", html(PAGE));
  await assert.rejects(call(cwd, { url: `${server.origin}/ftp` }), {
    message: "WebFetch: redirect to ftp://example.com/f refused: only http and https",
  });
  await assert.rejects(call(cwd, { url: `${server.origin}/none` }), {
    message: `WebFetch: redirect from ${server.origin}/none has no valid Location`,
  });
  await assert.rejects(call(cwd, { url: `${server.origin}/loop0` }), {
    message: `WebFetch: more than 5 redirects from ${server.origin}/loop0`,
  });
  const five = await call(cwd, { url: `${server.origin}/loop1` });
  assert.equal(five.details.finalUrl, `${server.origin}/loop6`);
});

test("3.6 a body past the cap is refused and nothing is cached; one at the cap is fetched", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/big", text("a".repeat(MAX_BODY_BYTES + 1), "text/plain"));
  server.route("/edge", text("a".repeat(MAX_BODY_BYTES), "text/plain"));
  await assert.rejects(call(cwd, { url: `${server.origin}/big` }), {
    message: `WebFetch: response from ${server.origin}/big exceeds ${MAX_BODY_BYTES} bytes; nothing was cached`,
  });
  await assert.rejects(readdir(join(cwd, ".pi", "web-cache")), { code: "ENOENT" });
  const edge = await call(cwd, { url: `${server.origin}/edge` });
  assert.equal(edge.details.length, MAX_BODY_BYTES);
});

test("3.6 the cap counts bytes after content decoding", async (t) => {
  const server = await startServer(t);
  server.route("/bomb", (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
    res.end(gzipSync(Buffer.alloc(MAX_BODY_BYTES + 1, 0x61)));
  });
  await assert.rejects(
    call(await tempDir(t), { url: `${server.origin}/bomb` }),
    /exceeds 10485760 bytes/,
  );
});

test("3.6 the call times out with the stated message", async (t) => {
  const server = await startServer(t);
  server.route("/slow", () => {});
  await assert.rejects(
    fetchPage({
      url: `${server.origin}/slow`,
      userAgent: "ua",
      resolve: async () => [],
      allowedAddresses: new Set(["127.0.0.1"]),
      timeoutMs: 100,
    }),
    { message: `WebFetch: timed out after 0.1 s fetching ${server.origin}/slow` },
  );
});

test("3.6 an aborted call is cancelled and writes nothing", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  const controller = new AbortController();
  server.route("/hang", () => controller.abort());
  await assert.rejects(call(cwd, { url: `${server.origin}/hang` }, { signal: controller.signal }), {
    message: "WebFetch: cancelled",
  });
  await assert.rejects(readdir(join(cwd, ".pi", "web-cache")), { code: "ENOENT" });
});

test("3.7 an HTTP error status is a tool error", async (t) => {
  const server = await startServer(t);
  await assert.rejects(call(await tempDir(t), { url: `${server.origin}/missing` }), {
    message: `WebFetch: HTTP 404 from ${server.origin}/missing`,
  });
});

test("3.7 a network failure names the hop", async (t) => {
  const server = await startServer(t);
  server.route("/drop", (req) => req.socket.destroy());
  await assert.rejects(call(await tempDir(t), { url: `${server.origin}/drop` }), (error: Error) =>
    error.message.startsWith(`WebFetch: fetching ${server.origin}/drop failed: `),
  );
});

test("3.7 decodes gzip, deflate and br bodies", async (t) => {
  const { brotliCompressSync, deflateSync } = await import("node:zlib");
  const server = await startServer(t);
  const cwd = await tempDir(t);
  const encoders = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync };
  for (const [name, encode] of Object.entries(encoders)) {
    server.route(`/${name}`, (_req, res) => {
      res.writeHead(200, { "content-type": "text/markdown", "content-encoding": name });
      res.end(encode(Buffer.from(`# Encoded ${name}\n`)));
    });
    const result = await call(cwd, { url: `${server.origin}/${name}` });
    assert.equal(result.details.title, `Encoded ${name}`);
  }
});

test("3.8 decodes by the header charset, else the meta charset, and reports an unknown label", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  const latin = Buffer.from(
    `<html><head><meta charset="iso-8859-1"><title>caf\xe9</title></head><body>${PAGE}</body></html>`,
    "latin1",
  );
  server.route("/meta", (_req, res) =>
    res.writeHead(200, { "content-type": "text/html" }).end(latin),
  );
  server.route("/odd", (_req, res) =>
    res.writeHead(200, { "content-type": "text/plain; charset=x-nonsense" }).end("plain"),
  );
  assert.equal((await call(cwd, { url: `${server.origin}/meta` })).details.title, "café");
  const odd = await call(cwd, { url: `${server.origin}/odd` });
  assert.ok(odd.details.notices.includes("Unknown charset x-nonsense; decoded as UTF-8."));
});

test("5.1 refuses other content types, naming the type", async (t) => {
  const server = await startServer(t);
  server.route("/f.pdf", (_req, res) =>
    res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF"),
  );
  server.route("/none", (_req, res) => res.writeHead(200).end("x"));
  const cwd = await tempDir(t);
  await assert.rejects(call(cwd, { url: `${server.origin}/f.pdf` }), {
    message: `WebFetch: unsupported content type application/pdf from ${server.origin}/f.pdf; only HTML, Markdown and plain text are fetched`,
  });
  await assert.rejects(
    call(cwd, { url: `${server.origin}/none` }),
    /unsupported content type none from/,
  );
});

test("5.1 stores Markdown and plain text with text cleaning only", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/md", text("intro\r\n# Title\u200B here\n\n  - item\n", "text/markdown"));
  server.route("/txt", text("line\u00A0one\n    indented\n", "text/plain"));
  const md = await call(cwd, { url: `${server.origin}/md` });
  assert.equal(
    await readFile(join(cwd, md.details.path), "utf8"),
    "intro\n# Title here\n\n  - item\n",
  );
  assert.equal(md.details.title, "Title here");
  const txt = await call(cwd, { url: `${server.origin}/txt` });
  assert.equal(await readFile(join(cwd, txt.details.path), "utf8"), "line one\n    indented\n");
  assert.equal(txt.details.title, null);
});

test("5.2 falls back to the whole body when extraction finds too little text, and says so", async (t) => {
  const server = await startServer(t);
  server.route("/short", html("<div>Short note.</div>"));
  const result = await call(await tempDir(t), { url: `${server.origin}/short` });
  assert.ok(
    result.details.notices.includes(
      "Main-content extraction found too little text; the whole page body is used.",
    ),
  );
  assert.ok(resultText(result).includes("Short note."));
});

test("5.4 adds the title as a heading when the content has none, else the first h1", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route(
    "/t",
    html(
      `<article><p>${"Words without a heading at all. ".repeat(10)}</p></article>`,
      "<title> The  Title </title>",
    ),
  );
  server.route(
    "/h",
    html(`<h1>Only H1</h1><article><p>${"Body words. ".repeat(30)}</p></article>`, ""),
  );
  const titled = await call(cwd, { url: `${server.origin}/t` });
  assert.ok((await readFile(join(cwd, titled.details.path), "utf8")).startsWith("# The Title\n\n"));
  assert.equal((await call(cwd, { url: `${server.origin}/h` })).details.title, "Only H1");
});

test("5.4 the title heading is escaped, so it holds no HTML tag", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route(
    "/e",
    html(
      `<article><p>${"Plain words. ".repeat(30)}</p></article>`,
      "<title>&lt;table&gt; *element*</title>",
    ),
  );
  const result = await call(cwd, { url: `${server.origin}/e` });
  assert.ok(
    (await readFile(join(cwd, result.details.path), "utf8")).startsWith(
      "# \\<table> \\*element\\*\n",
    ),
  );
  assert.equal(result.details.title, "<table> *element*");
});

test("5.3 converts a table to a GFM table and keeps its caption", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route(
    "/table",
    html(
      `<article><h1>Data</h1><p>${"Prose before the table. ".repeat(10)}</p><table><caption>Sizes</caption><thead><tr><th>Name</th><th>Size</th></tr></thead><tbody><tr><td>a|b</td><td>1</td></tr><tr><td>c</td><td>2</td></tr></tbody></table></article>`,
    ),
  );
  const result = await call(cwd, { url: `${server.origin}/table` });
  const content = await readFile(join(cwd, result.details.path), "utf8");
  assert.ok(
    content.includes("Sizes\n\n| Name | Size |\n| --- | --- |\n| a\\|b | 1   |\n| c   | 2   |"),
    content,
  );
});
