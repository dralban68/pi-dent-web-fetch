/**
 * specs/web-fetch.md#sanitizer, specs/web-fetch.md#tests: each sanitizer rule is shown with a page that hides
 * `INJECTION-<rule>` that way; the string must be absent from the extraction, content.md and the
 * result, while the visible text around it stays.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { HIDDEN_TOKENS, REMOVED_ELEMENTS } from "../lib/sanitize.ts";
import { ATTRIBUTE_CASES, STYLE_CASES, VOID } from "./cases.ts";
import { call, html, resultText, startServer, tempDir } from "./helpers.ts";

const FILLER = `<p>${"Visible prose that every reader of this page can see and read. ".repeat(6)}</p>`;

/** Serves `hidden` inside an article between visible markers; returns the stored and returned texts. */
async function fetchHidden(t: Parameters<typeof tempDir>[0], hidden: string, head?: string) {
  const server = await startServer(t);
  const cwd = await tempDir(t);
  server.route(
    "/page",
    html(
      `<article><h1>Heading</h1>${FILLER}<p>VISIBLE-BEFORE ${hidden} VISIBLE-AFTER</p>${FILLER}</article>`,
      head,
    ),
  );
  const result = await call(cwd, { url: `${server.origin}/page` });
  return {
    extracted: await readFile(join(cwd, result.details.extractedPath), "utf8"),
    content: await readFile(join(cwd, result.details.path), "utf8"),
    result: resultText(result),
  };
}

async function assertHidden(
  t: Parameters<typeof tempDir>[0],
  rule: string,
  hidden: string,
  head?: string,
) {
  const out = await fetchHidden(t, hidden, head);
  for (const [name, value] of Object.entries(out)) {
    assert.ok(!value.includes(`INJECTION-${rule}`), `${name} holds INJECTION-${rule}:\n${value}`);
    assert.ok(
      value.includes("VISIBLE-BEFORE") && value.includes("VISIBLE-AFTER"),
      `${name} lost visible text`,
    );
  }
}

test("10 control: text a reader sees reaches the output", async (t) => {
  const out = await fetchHidden(t, "<span>INJECTION-control</span>");
  assert.ok(out.extracted.includes("INJECTION-control"));
  assert.ok(out.result.includes("INJECTION-control"));
});

for (const tag of REMOVED_ELEMENTS) {
  if (tag === "annotation" || tag === "annotation-xml") continue;
  test(`6.1 removes ${tag} elements`, async (t) => {
    const hidden = VOID.has(tag)
      ? `<${tag} title="INJECTION-${tag}" value="INJECTION-${tag}" content="INJECTION-${tag}" alt="INJECTION-${tag}">`
      : `<${tag}>INJECTION-${tag}</${tag}>`;
    await assertHidden(t, tag, hidden);
  });
}

test("6.1 removes annotation and annotation-xml, and keeps a math element's text", async (t) => {
  const out = await fetchHidden(
    t,
    "<math><mi>MATHTEXT</mi><annotation>INJECTION-annotation</annotation><annotation-xml>INJECTION-annotation-xml</annotation-xml></math>",
  );
  assert.ok(out.extracted.includes("MATHTEXT"));
  assert.ok(!out.extracted.includes("INJECTION-annotation"));
});

test("6.1 removes comments, processing instructions and CDATA sections", async (t) => {
  await assertHidden(
    t,
    "comment",
    "<!-- INJECTION-comment --><?pi INJECTION-comment?><![CDATA[INJECTION-comment]]>",
  );
});

test("6.1 removes everything in head", async (t) => {
  await assertHidden(
    t,
    "head",
    "",
    "<title>T</title><style>INJECTION-head</style><script>INJECTION-head</script>",
  );
});

test("6.1 removes a dialog without open, and keeps an open one", async (t) => {
  await assertHidden(t, "dialog", "<dialog>INJECTION-dialog</dialog>");
  const out = await fetchHidden(t, "<dialog open>OPEN-DIALOG</dialog>");
  assert.ok(out.extracted.includes("OPEN-DIALOG"));
});

test("6.1 removes an img whose width or height is 0 or 1", async (t) => {
  await assertHidden(
    t,
    "pixel",
    '<img src="/p.png" width="1" alt="INJECTION-pixel"><img src="/q.png" height=" 0 " alt="INJECTION-pixel">',
  );
});

test("6.1 removes a label inside a form and keeps one outside", async (t) => {
  await assertHidden(t, "label", "<form><label>INJECTION-label</label></form>");
  const out = await fetchHidden(t, "<label>OUTSIDE-LABEL</label>");
  assert.ok(out.extracted.includes("OUTSIDE-LABEL"));
});

for (const [rule, hidden] of ATTRIBUTE_CASES) {
  test(`6.2 removes an element with ${rule}`, async (t) => assertHidden(t, rule, hidden));
}

for (const [rule, style] of STYLE_CASES) {
  test(`6.2.1 removes an element whose inline style hides it: ${rule}`, async (t) =>
    assertHidden(t, rule, `<span style="${style}">INJECTION-${rule}</span>`));
}

test("6.2.1 keeps an element whose zero width does not clip its overflow", async (t) => {
  const out = await fetchHidden(t, '<span style="width: 0">SHOWN-WIDTH</span>');
  assert.ok(out.extracted.includes("SHOWN-WIDTH"));
});

for (const token of HIDDEN_TOKENS) {
  test(`6.2.2 removes an element whose class or id is ${token}`, async (t) => {
    await assertHidden(
      t,
      `class-${token}`,
      `<span class="x ${token.toUpperCase()} y">INJECTION-class-${token}</span>`,
    );
    await assertHidden(t, `id-${token}`, `<span id="${token}">INJECTION-id-${token}</span>`);
  });
}

test("6.2.2 matches whole tokens only", async (t) => {
  const out = await fetchHidden(t, '<span class="hidden-xs not-hidden">TOKEN-KEPT</span>');
  assert.ok(out.extracted.includes("TOKEN-KEPT"));
});

for (const scheme of ["javascript", "data", "vbscript"]) {
  test(`6.3 drops a ${scheme}: link and keeps its text`, async (t) => {
    await assertHidden(t, scheme, `<a href="${scheme}:INJECTION-${scheme}">LINKTEXT</a>`);
    const out = await fetchHidden(t, `<a href="${scheme}:x">LINKTEXT</a>`);
    assert.ok(out.extracted.includes("LINKTEXT"));
  });
}

test("6.3 drops a data: image source and every attribute but href, src and alt", async (t) => {
  await assertHidden(
    t,
    "attr",
    '<img src="data:text/plain,INJECTION-attr" alt="ALT"><a href="/x" title="INJECTION-attr" data-x="INJECTION-attr" onclick="INJECTION-attr">L</a><span title="INJECTION-attr">S</span>',
  );
});

test("6.3 makes links absolute against the base URL and keeps mailto", async (t) => {
  const out = await fetchHidden(
    t,
    '<a href="rel/doc">REL</a> <a href="mailto:a@b.example">MAIL</a>',
    '<title>T</title><base href="https://docs.example/root/">',
  );
  assert.ok(out.extracted.includes("[REL](https://docs.example/root/rel/doc)"));
  assert.ok(out.extracted.includes("[MAIL](mailto:a@b.example)"));
});

const CHARACTER_CASES: readonly [string, string][] = [
  ["zero-width", "\u200B\u200C\u200D\u200E\u200F"],
  ["bidi", "\u202A\u202B\u202C\u202D\u202E"],
  ["invisible-operators", "\u2060\u2061\u2062\u2063\u2064"],
  ["isolates", "\u2066\u2067\u2068\u2069"],
  ["bom-and-soft-hyphen", "\uFEFF\u00AD"],
  ["variation-selectors", "\uFE0F\u{E0100}"],
  ["controls", "\u0001\u0007\u001B\u007F\u0085\r"],
];
for (const [rule, chars] of CHARACTER_CASES) {
  test(`6.4 removes ${rule} characters`, async (t) => {
    const out = await fetchHidden(t, `JOIN${chars}ED`);
    for (const value of Object.values(out)) {
      assert.ok(value.includes("JOINED"));
      for (const char of chars)
        assert.ok(!value.includes(char), `${rule}: U+${char.codePointAt(0)?.toString(16)}`);
    }
  });
}

test("6.4 removes tag characters, so text spelled in them is gone", async (t) => {
  const spelled = [..."INJECTION-tags"]
    .map((c) => String.fromCodePoint(0xe0000 + (c.codePointAt(0) ?? 0)))
    .join("");
  const out = await fetchHidden(t, `TAG${spelled}END`);
  for (const value of Object.values(out)) {
    assert.ok(value.includes("TAGEND"));
    assert.ok(!/[\u{E0000}-\u{E007F}]/u.test(value));
  }
});

test("6.4 maps other white space to a space and keeps pre text", async (t) => {
  const out = await fetchHidden(t, "A\u00A0\u3000B</p><pre>  line one\n    line two</pre><p>");
  assert.ok(out.extracted.includes("A B"));
  assert.ok(out.extracted.includes("  line one\n    line two"));
});

test("5.3 writes no HTML tag: text that looks like markup is escaped", async (t) => {
  const out = await fetchHidden(t, "&lt;script&gt;alert(1)&lt;/script&gt; and &lt;!-- x --&gt;");
  assert.ok(out.extracted.includes("\\<script>alert(1)\\</script>"));
  assert.ok(!/(?<!\\)<[A-Za-z/!?]/.test(out.extracted));
});
