/**
 * Content to Markdown (specs/web-fetch.md, Section 5): the HTML pipeline of Section 5.2, the
 * conversion of Section 5.3 and the title of Section 5.4.
 */

import { Readability } from "@mozilla/readability";
import { tables } from "@truto/turndown-plugin-gfm";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

import type { ContentKind } from "./decode.ts";
import { sanitizeDocument } from "./sanitize.ts";
import { cleanLine, cleanText } from "./text.ts";

/** Below this many characters of article text, the body fallback is used (Section 5.2, step 5). */
export const MIN_ARTICLE_CHARS = 200;

export const NOTICE_FALLBACK =
  "Main-content extraction found too little text; the whole page body is used.";
export const NOTICE_EMPTY = "The page produced no text.";

export interface Extracted {
  readonly markdown: string;
  readonly title: string | null;
  readonly notices: readonly string[];
}

function parse(html: string): Document {
  return parseHTML(html).document;
}

function createConverter(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  service.use(tables);
  // Added after the plugin, so these win (turndown tries the last added rule first).
  service.addRule("tableCell", {
    filter: ["th", "td"],
    replacement(content, node) {
      const first = node.parentNode?.firstElementChild === node;
      const text = content.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
      return `${first ? "| " : " "}${text.padEnd(3, " ")} |`;
    },
  });
  service.addRule("img", {
    filter: "img",
    replacement(_content, node) {
      return cleanLine(node.getAttribute("alt") ?? "");
    },
  });
  const escape = service.escape.bind(service);
  service.escape = (text: string) => escape(text).replace(/<(?=[A-Za-z/!?])/g, "\\<");
  return service;
}

const converter = createConverter();

/** Moves each `caption` before its table as a `p` (Section 5.3). */
function moveCaptions(root: HTMLElement): void {
  for (const caption of Array.from(root.querySelectorAll("caption"))) {
    const table = caption.closest("table");
    const paragraph = caption.ownerDocument.createElement("p");
    while (caption.firstChild !== null) paragraph.append(caption.firstChild);
    caption.remove();
    if (table?.parentNode) table.parentNode.insertBefore(paragraph, table);
  }
}

/**
 * Converts a sanitized element to Markdown (Section 5.3). Turndown gets the serialised HTML and
 * parses it with its own DOM, which implements the table API (`rows`) that its tables plugin
 * needs and linkedom lacks.
 */
export function toMarkdown(root: HTMLElement): string {
  moveCaptions(root);
  const markdown = converter.turndown(root.innerHTML).trim();
  return markdown === "" ? "" : `${markdown}\n`;
}

function documentTitle(document: Document): string | null {
  const title = document.querySelector("title");
  const text = title === null ? "" : cleanLine(title.textContent ?? "");
  return text === "" ? null : text;
}

function firstH1(document: Document): string | null {
  const h1 = document.querySelector("h1");
  const text = h1 === null ? "" : cleanLine(h1.textContent ?? "");
  return text === "" ? null : text;
}

function baseUrl(document: Document, finalUrl: string): string {
  for (const base of document.querySelectorAll("base[href]")) {
    try {
      return new URL(base.getAttribute("href") ?? "", finalUrl).href;
    } catch {
      // An unresolvable base falls back to the final URL (Section 5.2, step 2).
      return finalUrl;
    }
  }
  return finalUrl;
}

function addHeading(markdown: string, title: string | null): string {
  if (title === null) return markdown;
  const first = markdown.split("\n").find((line) => line.trim() !== "");
  if (first?.startsWith("# ")) return markdown;
  const heading = `# ${converter.escape(title)}`;
  return markdown === "" ? `${heading}\n` : `${heading}\n\n${markdown}`;
}

/** The HTML pipeline of Section 5.2. */
export function extractHtml(html: string, finalUrl: string): Extracted {
  const notices: string[] = [];
  const document = parse(html);
  const base = baseUrl(document, finalUrl);
  const headTitle = documentTitle(document);
  sanitizeDocument(document, base);
  const title = headTitle ?? firstH1(document);

  const copy = parse(document.toString());
  const article = new Readability(copy).parse();
  const articleText = cleanText(article?.textContent ?? "").trim();
  let root: HTMLElement;
  if (article === null || articleText.length < MIN_ARTICLE_CHARS) {
    notices.push(NOTICE_FALLBACK);
    root = document.body ?? document.documentElement;
  } else {
    const fresh = parse(
      `<!doctype html><html><head></head><body>${article.content ?? ""}</body></html>`,
    );
    sanitizeDocument(fresh, base);
    root = fresh.body ?? fresh.documentElement;
  }
  const markdown = addHeading(cleanText(toMarkdown(root)), title);
  if (markdown.trim() === "") notices.push(NOTICE_EMPTY);
  return { markdown, title, notices };
}

/** The title of a Markdown body: the text after `# ` on the first line starting with it. */
function markdownTitle(markdown: string): string | null {
  const line = markdown.split("\n").find((candidate) => candidate.startsWith("# "));
  if (line === undefined) return null;
  const text = cleanLine(line.slice(2));
  return text === "" ? null : text;
}

/** Content of any supported kind to the text of `extracted.md`. */
export function extract(kind: ContentKind, text: string, finalUrl: string): Extracted {
  if (kind === "html") return extractHtml(text, finalUrl);
  const markdown = cleanText(text);
  const notices = markdown.trim() === "" ? [NOTICE_EMPTY] : [];
  return { markdown, title: kind === "markdown" ? markdownTitle(markdown) : null, notices };
}
