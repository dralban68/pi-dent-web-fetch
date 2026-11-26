/** PDF text extraction (specs/web-fetch.md#stored-files, specs/web-fetch.md#pdf). */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { extractPdf } from "../lib/pdf.ts";
import { buildPdf, corruptPdf, formFixture, textRun } from "./helpers/pdf.ts";
import { call, startServer, tempDir, type Handler } from "./helpers.ts";

function pdf(bytes: Buffer): Handler {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "application/pdf" });
    res.end(bytes);
  };
}

async function entryDir(cwd: string, origin: string): Promise<string> {
  const base = join(cwd, ".pi", "web-cache", `127.0.0.1_${new URL(origin).port}`);
  const names = await readdir(base);
  const name = names[0];
  if (name === undefined) throw new Error(`no entry under ${base}`);
  return join(base, name);
}

const textOf = (result: { content: { type: string; text?: string }[] }): string =>
  result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";

test("5.9 a text PDF is stored as file.pdf and its text is extracted into ## Page sections", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  const doc = buildPdf([textRun({ text: "The quick brown fox", x: 72, y: 720 })]);
  server.route("/doc.pdf", pdf(doc));
  const result = await call(cwd, { url: `${server.origin}/doc.pdf` });
  const dir = await entryDir(cwd, server.origin);
  assert.ok((await readFile(join(dir, "file.pdf"))).equals(doc), "the body is stored unchanged");
  const markdown = await readFile(join(cwd, result.details.path), "utf8");
  assert.equal(markdown, "## Page 1\n\nThe quick brown fox\n\n");
  const text = textOf(result);
  assert.match(text, /File: .*file\.pdf \(\d+ bytes\)/);
  assert.match(text, /File type: application\/pdf/);
  assert.match(text, /Title: \(none\)/);
  assert.match(text, /## Page 1/);
  assert.ok(
    !text.includes("notice") && !result.details.notices.some((n) => n.includes("PDF")),
    "no PDF notices",
  );
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
  assert.equal(meta.fileName, "file.pdf");
  assert.equal(meta.fileBytes, doc.length);
});

test("5.9 text drawn in render mode 3 or 7, below 1 pt, or off the page, is absent", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  const doc = buildPdf([
    [
      textRun({ text: "Readable sentence stays.", x: 72, y: 720 }),
      textRun({ text: "INJECTION-invisible", x: 72, y: 700, mode: 3 }),
      textRun({ text: "INJECTION-clip", x: 72, y: 680, mode: 7 }),
      textRun({ text: "INJECTION-tiny", x: 72, y: 660, size: 0.5 }),
      textRun({ text: "INJECTION-offpage", x: 2000, y: 5000 }),
    ].join("\n"),
  ]);
  server.route("/hostile.pdf", pdf(doc));
  const result = await call(cwd, { url: `${server.origin}/hostile.pdf` });
  const markdown = await readFile(join(cwd, result.details.path), "utf8");
  assert.equal(markdown, "## Page 1\n\nReadable sentence stays.\n\n");
  assert.ok(!textOf(result).includes("INJECTION-"));
});

test("5.9 text inside a form XObject, through a scaling matrix, is extracted", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route(
    "/form.pdf",
    pdf(formFixture({ formText: "text inside a form", formMatrix: [2, 0, 0, 2, 50, 50] })),
  );
  const result = await call(cwd, { url: `${server.origin}/form.pdf` });
  const markdown = await readFile(join(cwd, result.details.path), "utf8");
  assert.match(markdown, /text inside a form/);
});

test("5.9 pages without text are omitted; later pages keep their numbers", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  const doc = buildPdf([
    textRun({ text: "First page has words.", x: 72, y: 720 }),
    "",
    textRun({ text: "Third page too.", x: 72, y: 720 }),
  ]);
  server.route("/pages.pdf", pdf(doc));
  const result = await call(cwd, { url: `${server.origin}/pages.pdf` });
  const markdown = await readFile(join(cwd, result.details.path), "utf8");
  assert.equal(markdown, "## Page 1\n\nFirst page has words.\n\n## Page 3\n\nThird page too.\n\n");
});

test("5.9 a PDF with no extractable text keeps the file with the stated notice", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/scanned.pdf", pdf(buildPdf([""])));
  const result = await call(cwd, { url: `${server.origin}/scanned.pdf` });
  const dir = await entryDir(cwd, server.origin);
  const files = await readdir(dir);
  assert.ok(files.includes("file.pdf"), "the file is kept");
  assert.equal(await readFile(join(cwd, result.details.path), "utf8"), "");
  assert.ok(result.details.notices.includes("No text found in the PDF; the file is kept."));
});

test("5.9 a corrupt PDF keeps the file with a failure notice, not a tool error", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/broken.pdf", pdf(corruptPdf()));
  const result = await call(cwd, { url: `${server.origin}/broken.pdf` });
  const dir = await entryDir(cwd, server.origin);
  assert.ok((await readdir(dir)).includes("file.pdf"));
  assert.match(
    result.details.notices[0] ?? "",
    /^PDF text extraction failed \(.*\); the file is kept without text\.$/,
  );
});

test("5.9 the extraction keeps up with a two-page document in the call's budget", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  const doc = buildPdf([
    textRun({ text: "Alpha page.", x: 72, y: 720 }),
    textRun({ text: "Beta page.", x: 72, y: 720 }),
  ]);
  server.route("/two.pdf", pdf(doc));
  const result = await call(cwd, { url: `${server.origin}/two.pdf` });
  assert.deepEqual(result.details.notices, []);
  const markdown = await readFile(join(cwd, result.details.path), "utf8");
  assert.ok(markdown.includes("Alpha page.") && markdown.includes("Beta page."));
});

test("5.9 an exhausted budget stops the worker and keeps what was extracted", async () => {
  const doc = buildPdf([textRun({ text: "Never read.", x: 72, y: 720 })]);
  const result = await extractPdf(doc, { timeoutMs: 0 });
  assert.equal(result.outcome, "timeout");
  assert.deepEqual(result.pages, []);
});

test("5.9 the abort signal stops the worker and ends the extraction as cancelled", async () => {
  const doc = buildPdf([textRun({ text: "Never read.", x: 72, y: 720 })]);
  const controller = new AbortController();
  const pending = extractPdf(doc, { timeoutMs: 20_000, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { message: "WebFetch: cancelled" });
});

test("5.9 the page limit stops extraction and reports it", async () => {
  const doc = buildPdf([
    textRun({ text: "One.", x: 72, y: 720 }),
    textRun({ text: "Two.", x: 72, y: 720 }),
    textRun({ text: "Three.", x: 72, y: 720 }),
  ]);
  const result = await extractPdf(doc, { timeoutMs: 20_000, pageLimit: 2 });
  assert.equal(result.outcome, "page-limit");
  assert.deepEqual(
    result.pages.map((page) => page.text),
    ["One.", "Two."],
  );
});

test("5.9 lines placed by Td under a scaled Tm keep their text, a hidden one among them does not", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  const stream = [
    "BT /F1 1 Tf 10 0 0 10 72 700 Tm (First scaled line.) Tj",
    "0 -1.2 Td (Second scaled line.) Tj",
    "0 -1.2 Td 3 Tr (INJECTION-scaled-invisible) Tj 0 Tr",
    "0 -1.2 Td (Fourth scaled line.) Tj ET",
  ].join("\n");
  server.route("/latex.pdf", pdf(buildPdf([stream])));
  const result = await call(cwd, { url: `${server.origin}/latex.pdf` });
  const markdown = await readFile(join(cwd, result.details.path), "utf8");
  assert.match(markdown, /First scaled line\./);
  assert.match(markdown, /Second scaled line\./);
  assert.match(markdown, /Fourth scaled line\./);
  assert.ok(!markdown.includes("INJECTION-"), markdown);
});

test("5.9 a hidden run that PDF.js merges into a visible item has its text removed", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  const stream =
    "BT /F1 12 Tf 72 720 Td (Visible start ) Tj 3 Tr (INJECTION-merged) Tj 0 Tr ( visible end.) Tj ET";
  server.route("/merged.pdf", pdf(buildPdf([stream])));
  const result = await call(cwd, { url: `${server.origin}/merged.pdf` });
  const markdown = await readFile(join(cwd, result.details.path), "utf8");
  assert.match(markdown, /Visible start/);
  assert.match(markdown, /visible end\./);
  assert.ok(!markdown.includes("INJECTION-"), markdown);
});
