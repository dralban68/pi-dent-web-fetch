/**
 * specs/web-fetch.md, Sections 5.5 and 10: HTML embedded in a Markdown body is sanitized, as a
 * block and inline; hidden HTML takes the Markdown text inside it along; code is kept verbatim.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { HIDDEN_TOKENS, REMOVED_ELEMENTS } from "../lib/sanitize.ts";
import { ATTRIBUTE_CASES, STYLE_CASES, VOID } from "./cases.ts";
import { call, resultText, startServer, tempDir, text } from "./helpers.ts";

const PROSE = "Visible Markdown prose that every reader sees.";
const RAW_HTML = /(?<!\\)<[A-Za-z/!?]/;

async function fetchBody(t: TestContext, body: string) {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route("/doc.md", text(`# Doc\n\n${PROSE}\n\n${body}\n\nVISIBLE-AFTER\n`));
  const result = await call(cwd, { url: `${server.origin}/doc.md` });
  return {
    extracted: await readFile(join(cwd, result.details.extractedPath), "utf8"),
    content: await readFile(join(cwd, result.details.path), "utf8"),
    result: resultText(result),
  };
}

async function assertHidden(t: TestContext, rule: string, body: string) {
  const out = await fetchBody(t, body);
  for (const [name, value] of Object.entries(out)) {
    assert.ok(!value.includes(`INJECTION-${rule}`), `${name} holds INJECTION-${rule}:\n${value}`);
    assert.ok(value.includes(PROSE), `${name} lost the prose`);
  }
  assert.ok(!RAW_HTML.test(out.extracted), `raw HTML left:\n${out.extracted}`);
}

/** A hiding method as an opening-tag attribute string, for a `div` block and a `span`. */
const METHODS: [string, string][] = [
  ...ATTRIBUTE_CASES.map(([rule, element]): [string, string] => [
    rule,
    /^<span([^>]*)>/.exec(element)?.[1] ?? "",
  ]),
  ...STYLE_CASES.map(([rule, style]): [string, string] => [rule, ` style="${style}"`]),
  ...HIDDEN_TOKENS.map((token): [string, string] => [`class-${token}`, ` class="${token}"`]),
  ...HIDDEN_TOKENS.map((token): [string, string] => [`id-${token}`, ` id="${token}"`]),
];

for (const [rule, attributes] of METHODS) {
  test(`5.5 a hidden HTML block or inline element in Markdown takes its text along: ${rule}`, async (t) => {
    await assertHidden(
      t,
      rule,
      `<div${attributes}>\n\n**INJECTION-${rule}** in Markdown\n\n</div>`,
    );
    await assertHidden(t, rule, `Shown <span${attributes}>INJECTION-${rule}</span> shown.`);
  });
}

for (const tag of REMOVED_ELEMENTS) {
  if (tag === "annotation" || tag === "annotation-xml") continue;
  test(`5.5 a removed ${tag} element in Markdown is gone with its content`, async (t) => {
    if (VOID.has(tag)) {
      await assertHidden(
        t,
        tag,
        `Shown <${tag} title="INJECTION-${tag}" value="INJECTION-${tag}"> shown.`,
      );
      return;
    }
    await assertHidden(t, tag, `<${tag}>\n\nINJECTION-${tag}\n\n</${tag}>`);
    await assertHidden(t, tag, `Shown <${tag}>INJECTION-${tag}</${tag}> shown.`);
  });
}

test("5.5 a closed dialog, a pixel image, an annotation and HTML comments in Markdown are removed", async (t) => {
  await assertHidden(t, "dialog", "<dialog>INJECTION-dialog</dialog>");
  await assertHidden(t, "pixel", 'An <img src="/p.png" width="1" alt="INJECTION-pixel"> image.');
  await assertHidden(
    t,
    "annotation",
    "<math><mi>x</mi><annotation>INJECTION-annotation</annotation></math>",
  );
  await assertHidden(
    t,
    "comment",
    "Before <!-- INJECTION-comment --> after.\n\n<!--\nINJECTION-comment\n-->",
  );
});

test("5.5 an unclosed hidden element hides the rest of the body", async (t) => {
  const out = await fetchBody(t, '<div class="sr-only">\n\nINJECTION-unclosed and more');
  assert.ok(out.extracted.includes(PROSE));
  assert.ok(!out.extracted.includes("INJECTION-unclosed"));
  assert.ok(!out.extracted.includes("VISIBLE-AFTER"));
});

test("5.5 refused link schemes and attributes in Markdown HTML are dropped", async (t) => {
  await assertHidden(
    t,
    "js",
    '<a href="javascript:INJECTION-js" title="INJECTION-js">link text</a>',
  );
  const out = await fetchBody(t, '<a href="https://ok.example/">fine</a> and <b>bold</b>');
  assert.ok(out.extracted.includes("[fine](https://ok.example/) and **bold**"));
});

test("5.5 code spans, fenced and indented code keep embedded HTML verbatim", async (t) => {
  const body =
    "Inline `<div hidden>span</div>` code.\n\n```html\n<div hidden>fenced</div>\n```\n\n    <div hidden>indented</div>\n\nAnd <span hidden>INJECTION-mixed</span> too.";
  const out = await fetchBody(t, body);
  assert.ok(out.extracted.includes("Inline `<div hidden>span</div>` code."));
  assert.ok(out.extracted.includes("```html\n<div hidden>fenced</div>\n```"));
  assert.ok(out.extracted.includes("    <div hidden>indented</div>"));
  assert.ok(!out.extracted.includes("INJECTION-mixed"));
});

test("5.5 a body without HTML is stored as text-cleaned only", async (t) => {
  const out = await fetchBody(
    t,
    "a < b and <https://auto.example> and <me@mail.example>\n\n## Empty\n\n## Next",
  );
  assert.ok(
    out.extracted.endsWith(
      `${PROSE}\n\na < b and <https://auto.example> and <me@mail.example>\n\n## Empty\n\n## Next\n\nVISIBLE-AFTER\n`,
    ),
  );
});

test("5.5 a body cannot name a placeholder to bring back hidden text", async (t) => {
  await assertHidden(
    t,
    "placeholder",
    "<div hidden>INJECTION-placeholder</div>\n\n<pi-md-0>x</pi-md-0><x-md-1>x</x-md-1>",
  );
});
