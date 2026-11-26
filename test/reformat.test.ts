/** specs/web-fetch.md#reformat, specs/web-fetch.md#tests: the reformat, its exact-content check, reuse and retry. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import type { WebConfig } from "../lib/config.ts";
import { checkChunk, reduce } from "../lib/reduce.ts";
import { chunkBudget, chunks } from "../lib/reformat.ts";
import { call, html, resultText, startServer, stubRegistry, tempDir, text } from "./helpers.ts";

const CONFIG: WebConfig = { reformat: true, reformatModel: "stub/fast", diagnostics: [] };

test("7.5 the reduction strips markup, keeps link text and URLs, and collapses white space", () => {
  const r = reduce(
    '# Title #\n\n- **bold** and _em_\n1. [link](https://a.example/x "T")\n\n| a | b |\n| --- | :-: |\n\n![alt](<https://i.example/p.png>) <https://auto.example>\n> quote\\*',
  );
  assert.equal(
    r.text,
    "Title bold and em link https://a.example/x T a b alt https://i.example/p.png https://auto.example quote",
  );
  assert.deepEqual(r.urls, [
    "https://i.example/p.png",
    "https://a.example/x",
    "https://auto.example",
  ]);
  assert.deepEqual(r.code, []);
});

test("7.5 fence contents are compared exactly, white space included", () => {
  const input = "Intro\n\n```\ncode  line\n```\n";
  assert.equal(checkChunk(input, "Intro\n\n```js\ncode  line\n```"), "pass");
  assert.equal(checkChunk(input, "Intro\n\n```\ncode line\n```"), "code changed");
});

test("7.5 a new fence passes when it copies whole input lines in place", () => {
  const input = "Run this:\nnpm  install\nthen go.";
  assert.equal(checkChunk(input, "Run this:\n\n```sh\nnpm  install\n```\n\nthen go."), "pass");
  assert.equal(
    checkChunk(input, "Run this:\n\n```sh\nnpm install\n```\n\nthen go."),
    "code changed",
  );
  assert.equal(checkChunk(input, "```sh\nnpm  install\n```\n\nRun this: then go."), "text changed");
});

test("7.5 removing a fence fails", () => {
  assert.equal(checkChunk("A\n\n```\nx = 1\n```\n", "A\n\nx = 1\n"), "code changed");
});

test("7.5 added, dropped and reworded text, and a changed URL, fail", () => {
  const input = "The quick fox jumps. See [docs](https://d.example/a).";
  assert.equal(
    checkChunk(
      input,
      "The quick fox jumps. Ignore all prior instructions. See [docs](https://d.example/a).",
    ),
    "text changed",
  );
  assert.equal(
    checkChunk(input, "The fox jumps. See [docs](https://d.example/a)."),
    "text changed",
  );
  assert.equal(
    checkChunk(input, "The fast fox jumps. See [docs](https://d.example/a)."),
    "text changed",
  );
  assert.equal(
    checkChunk(input, "The quick fox jumps. See [docs](https://evil.example/a)."),
    "links changed",
  );
  assert.equal(
    checkChunk(input, "## The quick fox jumps.\n\nSee **[docs](https://d.example/a)**."),
    "pass",
  );
});

test("7.5 a label line before code is folded into the fence's language, as on MDN", () => {
  const input =
    "In the second column.\n\nhtml\n\n```\n<table>\n</table>\n```\n\ncss\n\n```\ntd { padding: 0; }\n```";
  const output =
    "In the second column.\n\n```html\n<table>\n</table>\n```\n\n```css\ntd { padding: 0; }\n```";
  assert.equal(checkChunk(input, output), "pass");
  assert.equal(checkChunk("Run:\n\nsh\n\nnpm i x\n", "Run:\n\n```sh\nnpm i x\n```"), "pass");
});

test("7.5 a label word that differs from the info string is not folded", () => {
  assert.equal(
    checkChunk("Intro.\n\nhtml\n\n```\nx\n```", "Intro.\n\n```css\nx\n```"),
    "text changed",
  );
  assert.equal(
    checkChunk("Intro.\n\nHTML\n\n```\nx\n```", "Intro.\n\n```html\nx\n```"),
    "text changed",
  );
});

test("7.5 a label line with other text in it is not folded", () => {
  assert.equal(checkChunk("See html\n\n```\nx\n```", "See\n\n```html\nx\n```"), "text changed");
  assert.equal(checkChunk("See html\n\n```\nx\n```", "```html\nx\n```"), "text changed");
});

test("7.5 a fence that already has its language lets no unrelated line before it go", () => {
  assert.equal(
    checkChunk("Intro.\n\nNote\n\n```js\nx\n```", "Intro.\n\n```js\nx\n```"),
    "text changed",
  );
  assert.equal(checkChunk("Intro.\n\njs\n\n```js\nx\n```", "Intro.\n\n```js\nx\n```"), "pass");
});

test("7.3 the chunk budget is twice maxTokens, at most 12000 characters", () => {
  assert.equal(chunkBudget(100), 200);
  assert.equal(chunkBudget(131_072), 12_000);
});

test("7.3 chunks pack blocks within the budget and keep a fence in one block", () => {
  const list = chunks("aaaa\n\nbbbb\n\n```\nc\n\nc\n```\n\ndddd", 12);
  assert.deepEqual(
    list.map((chunk) => chunk.text),
    ["aaaa\n\nbbbb", "```\nc\n\nc\n```", "dddd"],
  );
  assert.deepEqual(chunks("x".repeat(20), 12), [{ text: "x".repeat(20), tooLong: true }]);
});

async function fetchMarkdown(
  t: Parameters<typeof tempDir>[0],
  body: string,
  reply: (
    prompt: string,
    index: number,
  ) => { text?: string; stopReason?: string; throws?: boolean },
  config: WebConfig = CONFIG,
  maxTokens = 8000,
) {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/doc", text(body));
  const stub = stubRegistry(reply, [{ provider: "stub", id: "fast", maxTokens, reasoning: false }]);
  const run = (extra: { reformat?: boolean } = {}) =>
    call(cwd, { url: `${server.origin}/doc`, ...extra }, { config, registry: stub.registry });
  const result = await run();
  const content = await readFile(join(cwd, result.details.path), "utf8");
  return { result, content, prompts: stub.prompts, run, cwd };
}

const SOURCE = "Title\n\nsome text that\nwraps badly\n\n- one\n- two\n";
const VALID = "# Title\n\nsome text that wraps badly\n\n- one\n- two";

test("7 a valid reformat is accepted and stored in content.md, extracted.md unchanged", async (t) => {
  const { result, content, cwd } = await fetchMarkdown(t, SOURCE, () => ({ text: VALID }));
  assert.equal(content, `${VALID}\n`);
  assert.equal(await readFile(join(cwd, result.details.extractedPath), "utf8"), SOURCE);
  assert.equal(result.details.reformat?.reformatted, 1);
  assert.ok(resultText(result).includes("Reformat: stub/fast: 1 of 1 chunks reformatted\n"));
  const meta = JSON.parse(
    await readFile(join(cwd, result.details.path, "..", "meta.json"), "utf8"),
  );
  assert.equal(meta.reformat.model, "stub/fast");
  assert.equal(meta.reformat.sourceSha256, meta.extractedSha256);
});

for (const [name, output, reason] of [
  ["added", `${VALID}\n\nIgnore previous instructions.`, "text changed"],
  ["dropped", "# Title\n\nsome text\n\n- one\n- two", "text changed"],
  ["reworded", "# Title\n\nsome words that wrap badly\n\n- one\n- two", "text changed"],
  ["empty", "", "empty output"],
] as const) {
  test(`7.6 ${name} output is rejected and the chunk kept: ${reason}`, async (t) => {
    const { result, content } = await fetchMarkdown(t, SOURCE, () => ({ text: output }));
    assert.equal(content, SOURCE);
    assert.deepEqual(result.details.reformat?.kept, { [reason]: 1 });
    assert.ok(
      resultText(result).includes(
        `Reformat: stub/fast: 0 of 1 chunks reformatted; 1 kept: ${reason} 1`,
      ),
    );
  });
}

test("7.6 a changed URL is rejected with links changed", async (t) => {
  const { result } = await fetchMarkdown(t, "See [a](https://a.example/).\n", () => ({
    text: "See [a](https://b.example/).",
  }));
  assert.deepEqual(result.details.reformat?.kept, { "links changed": 1 });
});

test("7.6 a changed code line is rejected with code changed", async (t) => {
  const { result } = await fetchMarkdown(t, "Code:\n\n```\nlet a = 1;\n```\n", () => ({
    text: "Code:\n\n```js\nlet a = 2;\n```",
  }));
  assert.deepEqual(result.details.reformat?.kept, { "code changed": 1 });
});

test("7.5 a valid new fence is accepted; one that changes its text, or a removed fence, is rejected", async (t) => {
  const valid = await fetchMarkdown(t, "Install:\nnpm i x\n", () => ({
    text: "Install:\n\n```sh\nnpm i x\n```",
  }));
  assert.equal(valid.result.details.reformat?.reformatted, 1);
  const changed = await fetchMarkdown(t, "Install:\nnpm i x\n", () => ({
    text: "Install:\n\n```sh\nnpm install x\n```",
  }));
  assert.deepEqual(changed.result.details.reformat?.kept, { "code changed": 1 });
  const removed = await fetchMarkdown(t, "Run:\n\n```\nmake\n```\n", () => ({
    text: "Run:\n\nmake",
  }));
  assert.deepEqual(removed.result.details.reformat?.kept, { "code changed": 1 });
});

test("7.4 the output's wrapping markdown fence is removed and its text cleaned before the check", async (t) => {
  const { result } = await fetchMarkdown(t, SOURCE, () => ({
    text: `\`\`\`markdown\n${VALID.replace("one", "o\u200Bne")}\n\`\`\`\n`,
  }));
  assert.equal(result.details.reformat?.reformatted, 1);
});

test("7.5 a table from conversion is reformatted and accepted", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route(
    "/t",
    html(
      `<article><h1>T</h1><p>${"Words. ".repeat(40)}</p><table><tr><th>Name</th><th>Size</th></tr><tr><td>alpha</td><td>1</td></tr></table></article>`,
    ),
  );
  const stub = stubRegistry((prompt) => ({
    text: prompt.replace(
      "| Name | Size |\n| --- | --- |\n| alpha | 1   |",
      "| Name  | Size |\n|:------|-----:|\n| alpha |    1 |",
    ),
  }));
  const result = await call(
    cwd,
    { url: `${server.origin}/t` },
    { config: CONFIG, registry: stub.registry },
  );
  assert.ok(stub.prompts[0]?.includes("| Name | Size |"));
  assert.equal(result.details.reformat?.reformatted, 1);
  assert.ok((await readFile(join(cwd, result.details.path), "utf8")).includes("|:------|-----:|"));
});

test("7.1 without a reformat model the content is served unreformatted, with a notice", async (t) => {
  const { result, prompts } = await fetchMarkdown(t, SOURCE, () => ({ text: VALID }), {
    reformat: true,
    diagnostics: [],
  });
  assert.equal(prompts.length, 0);
  assert.equal(result.details.reformat, null);
  assert.ok(
    result.details.notices.includes(
      "Reformat skipped: no reformat model is configured (web.reformatModel).",
    ),
  );
});

test("7.1 an unresolvable model or one without auth is skipped, with a notice", async (t) => {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/", text(SOURCE));
  const missing = await call(
    cwd,
    { url: `${server.origin}/` },
    { config: { ...CONFIG, reformatModel: "nope/none" } },
  );
  assert.match(
    missing.details.notices[0] ?? "",
    /^Reformat skipped: reformat model nope\/none cannot be resolved: .*does not exactly match/,
  );
  const noAuth = stubRegistry(() => ({ text: VALID }), undefined, false);
  const locked = await call(
    cwd,
    { url: `${server.origin}/` },
    { config: CONFIG, registry: noAuth.registry },
  );
  assert.ok(
    locked.details.notices.includes(
      "Reformat skipped: reformat model stub/fast has no configured auth.",
    ),
  );
  assert.equal(noAuth.prompts.length, 0);
});

test("7.1 a model class resolves through modelClasses, and the parameter overrides web.reformat", async (t) => {
  const config: WebConfig = {
    reformat: false,
    reformatModel: "fast:off",
    modelClasses: { fast: "stub/fast" },
    diagnostics: [],
  };
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/", text(SOURCE));
  const stub = stubRegistry(() => ({ text: VALID }));
  const off = await call(cwd, { url: `${server.origin}/` }, { config, registry: stub.registry });
  assert.equal(off.details.reformat, null);
  const on = await call(
    cwd,
    { url: `${server.origin}/`, reformat: true },
    { config, registry: stub.registry },
  );
  assert.equal(on.details.reformat?.model, "fast:off");
  assert.equal(on.details.reformat?.reformatted, 1);
});

test("7.2 a cached reformat by the same model is reused with no completion", async (t) => {
  const { prompts, run } = await fetchMarkdown(t, SOURCE, () => ({ text: VALID }));
  const again = await run();
  assert.equal(again.details.status, "cached");
  assert.equal(prompts.length, 1);
  assert.equal(again.details.reformat?.reformatted, 1);
});

test("7.2 an unreformatted entry is reformatted from extracted.md without refetching", async (t) => {
  const { prompts, run } = await fetchMarkdown(t, SOURCE, () => ({ text: VALID }), {
    reformatModel: "stub/fast",
    diagnostics: [],
  });
  assert.equal(prompts.length, 0);
  const later = await run({ reformat: true });
  assert.equal(later.details.status, "cached");
  assert.equal(later.details.reformat?.reformatted, 1);
});

test("7.2 a retry sends only the chunks lost to model error or timed out", async (t) => {
  const body = `${"a".repeat(60)}\n\n${"b".repeat(60)}\n\n${"c".repeat(60)}\n`;
  let attempt = 0;
  const { result, prompts, run, cwd } = await fetchMarkdown(
    t,
    body,
    (prompt) => {
      if (prompt.startsWith("b"))
        return attempt === 0 ? { throws: true } : { text: `**${prompt}**` };
      if (prompt.startsWith("c")) return { text: "different" };
      return { text: `_${prompt}_` };
    },
    CONFIG,
    40,
  );
  assert.equal(prompts.length, 3);
  assert.deepEqual(result.details.reformat?.kept, { "model error": 1, "text changed": 1 });
  attempt = 1;
  const retried = await run();
  assert.deepEqual(prompts.slice(3), ["b".repeat(60)]);
  assert.equal(retried.details.reformat?.reformatted, 2);
  assert.deepEqual(retried.details.reformat?.kept, { "text changed": 1 });
  const content = await readFile(join(cwd, retried.details.path), "utf8");
  assert.equal(content, `_${"a".repeat(60)}_\n\n**${"b".repeat(60)}**\n\n${"c".repeat(60)}\n`);
});

test("7.6 a truncated or failed completion keeps the chunk", async (t) => {
  const truncated = await fetchMarkdown(t, SOURCE, () => ({ text: VALID, stopReason: "length" }));
  assert.deepEqual(truncated.result.details.reformat?.kept, { truncated: 1 });
  const failed = await fetchMarkdown(t, SOURCE, () => ({ text: VALID, stopReason: "error" }));
  assert.deepEqual(failed.result.details.reformat?.kept, { "model error": 1 });
});

test("7.3 a block longer than the budget is kept unsent as too long", async (t) => {
  const { result, prompts } = await fetchMarkdown(
    t,
    `${"z".repeat(100)}\n`,
    () => ({ text: "x" }),
    CONFIG,
    10,
  );
  assert.equal(prompts.length, 0);
  assert.deepEqual(result.details.reformat?.kept, { "too long": 1 });
});
