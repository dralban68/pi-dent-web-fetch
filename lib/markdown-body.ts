/**
 * Markdown bodies (specs/web-fetch.md, Section 5.5): the HTML embedded in a Markdown body is
 * sanitized like a page. Code is found first (fences, indented blocks, code spans), then the raw
 * HTML constructs of CommonMark 6.6 outside it; the Markdown text between them stands in the
 * parsed document as placeholder elements, so a removed element takes its Markdown text with it.
 */

import { randomBytes } from "node:crypto";

import { parseHTML } from "linkedom";

import { sanitizeDocument } from "./sanitize.ts";

export type Token = { readonly html: boolean; readonly text: string };

const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;

/** Code ranges [start, end) of fenced and indented code blocks (Section 5.5, step 1). */
function blockCode(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const lines = text.split("\n");
  let offset = 0;
  let fence: RegExp | undefined;
  let fenceStart = 0;
  let indented = false;
  let previousBlank = true;
  for (const line of lines) {
    const start = offset;
    const end = offset + line.length + 1;
    offset = end;
    if (fence !== undefined) {
      if (fence.test(line)) {
        ranges.push([fenceStart, end]);
        fence = undefined;
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line)?.[1];
    if (open !== undefined) {
      fence = new RegExp(`^ {0,3}\\${open.charAt(0)}{${open.length},} *$`);
      fenceStart = start;
      indented = false;
      continue;
    }
    const blank = line.trim() === "";
    const isIndented = /^(?: {4}|\t)/.test(line);
    if (!blank && isIndented && (previousBlank || indented)) {
      ranges.push([start, end]);
      indented = true;
    } else if (!blank) {
      indented = false;
    }
    previousBlank = blank;
  }
  if (fence !== undefined) ranges.push([fenceStart, text.length]);
  return ranges;
}

const WS0 = String.raw`[ \t]*\n?[ \t]*`;
const WS1 = String.raw`(?:[ \t]+\n?[ \t]*|[ \t]*\n[ \t]*)`;
const ATTRIBUTE = String.raw`(?:${WS1}[A-Za-z_:][A-Za-z0-9_.:-]*(?:${WS0}=${WS0}(?:[^\s"'=<>\x60]+|'[^']*'|"[^"]*"))?)`;
const HTML = new RegExp(
  [
    String.raw`<[A-Za-z][A-Za-z0-9-]*${ATTRIBUTE}*${WS0}\/?>`,
    String.raw`<\/[A-Za-z][A-Za-z0-9-]*${WS0}>`,
    String.raw`<!-->|<!--->|<!--[\s\S]*?-->`,
    String.raw`<\?[\s\S]*?\?>`,
    String.raw`<![A-Za-z][^>]*>`,
    String.raw`<!\[CDATA\[[\s\S]*?\]\]>`,
  ].join("|"),
  "y",
);

/** Splits a body into Markdown text and HTML constructs (Section 5.5, steps 1 and 2). */
export function tokenize(text: string): Token[] {
  const code = blockCode(text);
  const tokens: Token[] = [];
  let pending = "";
  const pushText = (value: string) => {
    pending += value;
  };
  const pushHtml = (value: string) => {
    if (pending !== "") tokens.push({ html: false, text: pending });
    pending = "";
    tokens.push({ html: true, text: value });
  };
  let index = 0;
  let next = 0;
  while (index < text.length) {
    const range = code[next];
    if (range !== undefined && index >= range[0]) {
      pushText(text.slice(index, range[1]));
      index = range[1];
      next += 1;
      continue;
    }
    const limit = range === undefined ? text.length : range[0];
    const char = text.charAt(index);
    if (char === "`") {
      const run = /^`+/.exec(text.slice(index, limit))?.[0] ?? "`";
      const closer = new RegExp(`(?<!\`)${run}(?!\`)`, "g");
      closer.lastIndex = index + run.length;
      const close = closer.exec(text.slice(0, limit));
      const end = close === null ? index + run.length : close.index + run.length;
      pushText(text.slice(index, end));
      index = end;
      continue;
    }
    if (char === "<") {
      HTML.lastIndex = index;
      const match = HTML.exec(text.slice(0, limit));
      if (match !== null) {
        pushHtml(match[0]);
        index += match[0].length;
        continue;
      }
    }
    pushText(char);
    index += 1;
  }
  if (pending !== "") tokens.push({ html: false, text: pending });
  return tokens;
}

export interface PlaceholderDocument {
  readonly document: Document;
  /** The placeholder element name prefix; the element `<prefix><n>` stands for `texts[n]`. */
  readonly prefix: string;
  readonly texts: readonly string[];
}

/**
 * Section 5.5, steps 4 and 5: the sanitized document, or `undefined` when the body has no HTML.
 * The prefix is random per call, so a body cannot name a placeholder and bring back text that a
 * removed element held.
 */
export function sanitizeMarkdownHtml(text: string, base: string): PlaceholderDocument | undefined {
  const tokens = tokenize(text);
  if (!tokens.some((token) => token.html)) return undefined;
  const prefix = `pi-md-${randomBytes(8).toString("hex")}-`;
  const texts: string[] = [];
  const html = tokens
    .map((token) => {
      if (token.html) return token.text;
      texts.push(token.text);
      const name = `${prefix}${texts.length - 1}`;
      return `<${name}>x</${name}>`;
    })
    .join("");
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`);
  sanitizeDocument(document, base);
  return { document, prefix, texts };
}
