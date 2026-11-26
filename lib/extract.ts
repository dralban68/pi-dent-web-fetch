/**
 * Content to Markdown (specs/web-fetch.md#content): the HTML pipeline of specs/web-fetch.md#html-pipeline, the
 * conversion of specs/web-fetch.md#conversion and the title of specs/web-fetch.md#title.
 */

import { Readability } from "@mozilla/readability";
import { tables } from "@truto/turndown-plugin-gfm";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

import type { ContentKind } from "./decode.ts";
import { sanitizeMarkdownHtml } from "./markdown-body.ts";
import { sanitizeDocument } from "./sanitize.ts";
import { cleanLine, cleanText } from "./text.ts";

/** Below this many characters of article text, the body fallback is used (specs/web-fetch.md#html-pipeline, step 5). */
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

const CELL_DELIMITER = /^(?=.*\|)(?=.*-)[ |:-]*$/;

/** A cell's content on one line: its lines joined with ` · ` (specs/web-fetch.md#conversion). */
export function cellText(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "" && !CELL_DELIMITER.test(line))
    .join(" · ")
    .replace(/(?<!\\)\|/g, "\\|");
}

/** Placeholders of a Markdown body (specs/web-fetch.md#markdown-bodies): each element `<prefix><n>` gives back `texts[n]`. */
interface Placeholders {
  readonly prefix: string;
  readonly texts: readonly string[];
}

function createConverter(placeholders?: Placeholders): TurndownService {
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
      return `${first ? "| " : " "}${cellText(content).padEnd(3, " ")} |`;
    },
  });
  if (placeholders !== undefined) {
    const upper = placeholders.prefix.toUpperCase();
    service.addRule("markdownText", {
      filter: (node) => node.nodeName.startsWith(upper),
      replacement(_content, node) {
        return placeholders.texts[Number(node.nodeName.slice(upper.length))] ?? "";
      },
    });
  }
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

/** Moves each `caption` before its table as a `p` (specs/web-fetch.md#conversion). */
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
 * Converts a sanitized element to Markdown (specs/web-fetch.md#conversion). Turndown gets the serialised HTML and
 * parses it with its own DOM, which implements the table API (`rows`) that its tables plugin
 * needs and linkedom lacks.
 */
export function toMarkdown(root: HTMLElement, service: TurndownService = converter): string {
  moveCaptions(root);
  const markdown = service.turndown(root.innerHTML).trim();
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
      // An unresolvable base falls back to the final URL (specs/web-fetch.md#html-pipeline, step 2).
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

/** The HTML pipeline of specs/web-fetch.md#html-pipeline. */
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
  const markdown = addHeading(cleanText(dropEmptySections(toMarkdown(root))), title);
  if (markdown.trim() === "") notices.push(NOTICE_EMPTY);
  return { markdown, title, notices };
}

const HEADING = /^(#{1,6})(?: |$)/;

/** specs/web-fetch.md#empty-sections: removes each heading whose section holds only empty and heading lines. */
export function dropEmptySections(markdown: string): string {
  const lines = markdown.split("\n");
  const levels: (number | undefined)[] = [];
  let fence: RegExp | undefined;
  for (const line of lines) {
    if (fence !== undefined) {
      if (fence.test(line)) fence = undefined;
      levels.push(undefined);
      continue;
    }
    const open = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(line)?.[1];
    if (open !== undefined) fence = new RegExp(`^ {0,3}\\${open.charAt(0)}{${open.length},} *$`);
    levels.push(HEADING.exec(line)?.[1]?.length);
  }
  const removed = new Set<number>();
  for (const [index, level] of levels.entries()) {
    if (level === undefined) continue;
    let content = false;
    for (let next = index + 1; next < lines.length; next += 1) {
      const other = levels[next];
      if (other !== undefined && other <= level) break;
      if (other === undefined && (lines[next] ?? "").trim() !== "") {
        content = true;
        break;
      }
    }
    if (content) continue;
    removed.add(index);
    for (
      let next = index + 1;
      next < lines.length && (lines[next] ?? "").trim() === "";
      next += 1
    ) {
      removed.add(next);
    }
  }
  if (removed.size === 0) return markdown;
  const kept = lines
    .filter((_line, index) => !removed.has(index))
    .join("\n")
    .trim();
  return kept === "" ? "" : `${kept}\n`;
}

/** The title of a Markdown body: the text after `# ` on the first line starting with it. */
function markdownTitle(markdown: string): string | null {
  const line = markdown.split("\n").find((candidate) => candidate.startsWith("# "));
  if (line === undefined) return null;
  const text = cleanLine(line.slice(2));
  return text === "" ? null : text;
}

/** specs/web-fetch.md#markdown-bodies: a Markdown or plain-text body with its embedded HTML sanitized and converted. */
function markdownBody(text: string, finalUrl: string): string {
  const sanitized = sanitizeMarkdownHtml(text, finalUrl);
  if (sanitized === undefined) return text;
  const root = sanitized.document.body ?? sanitized.document.documentElement;
  const service = createConverter({ prefix: sanitized.prefix, texts: sanitized.texts });
  return cleanText(dropEmptySections(toMarkdown(root, service)));
}

/** Content of any supported kind to the text of `extracted.md` (specs/web-fetch.md#markdown-bodies, specs/web-fetch.md#data-text). */
export function extract(kind: ContentKind, text: string, finalUrl: string): Extracted {
  if (kind === "html") return extractHtml(text, finalUrl);
  if (kind === "data") {
    // Data text (5.7): cleaned, stored as it stands; no Markdown, no sanitizing, no title.
    return { markdown: cleanText(text), title: null, notices: [] };
  }
  if (kind === "pdf" || kind === "binary") {
    // A stored file's text comes from specs/web-fetch.md#pdf (PDF) or is empty (5.8); the caller fills it in.
    return { markdown: "", title: null, notices: [] };
  }
  const markdown = markdownBody(cleanText(text), finalUrl);
  const notices = markdown.trim() === "" ? [NOTICE_EMPTY] : [];
  return { markdown, title: kind === "markdown" ? markdownTitle(markdown) : null, notices };
}
