/**
 * The sanitizer (specs/web-fetch.md, Section 6): removes what a reader of the rendered page would
 * not see. Deterministic: its only inputs are the DOM and the fixed lists below.
 */

import { styleHides } from "./style.ts";
import { cleanText, collapseSpace } from "./text.ts";

/** Section 6.1. */
export const REMOVED_ELEMENTS: readonly string[] = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "svg",
  "canvas",
  "audio",
  "video",
  "source",
  "track",
  "map",
  "area",
  "form",
  "input",
  "button",
  "select",
  "option",
  "optgroup",
  "datalist",
  "textarea",
  "link",
  "meta",
  "base",
  "param",
  "portal",
  "annotation",
  "annotation-xml",
];

/** Section 6.2.2. */
export const HIDDEN_TOKENS: readonly string[] = [
  "a11y-hidden",
  "assistive-text",
  "cloak",
  "d-none",
  "element-hidden",
  "element-invisible",
  "hidden",
  "hide",
  "invisible",
  "is-hidden",
  "ng-hide",
  "off-screen",
  "offscreen",
  "screen-reader-only",
  "screen-reader-text",
  "screenreader-only",
  "skip-link",
  "sr-only",
  "sr-only-focusable",
  "u-hidden",
  "ui-helper-hidden-accessible",
  "visually-hidden",
  "visually-hidden-focusable",
  "visuallyhidden",
];

const REMOVED = new Set(REMOVED_ELEMENTS);
const TOKENS = new Set(HIDDEN_TOKENS);
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE;
}

function name(element: Element): string {
  return element.localName.toLowerCase();
}

function attribute(element: Element, attr: string): string | null {
  return element.getAttribute(attr);
}

/** Whether an element is removed by Section 6.1 or 6.2. */
function isRemoved(element: Element): boolean {
  const tag = name(element);
  if (REMOVED.has(tag)) return true;
  if (tag === "dialog" && !element.hasAttribute("open")) return true;
  if (tag === "img") {
    for (const size of ["width", "height"]) {
      const value = attribute(element, size)?.trim();
      if (value === "0" || value === "1") return true;
    }
  }
  if (element.hasAttribute("hidden") || element.hasAttribute("inert")) return true;
  if (element.hasAttribute("popover")) return true;
  if (attribute(element, "aria-hidden")?.trim().toLowerCase() === "true") return true;
  const style = attribute(element, "style");
  if (style !== null && styleHides(style)) return true;
  const classes = (attribute(element, "class") ?? "").toLowerCase().split(/[\t\n\f\r ]+/);
  if (classes.some((token) => TOKENS.has(token))) return true;
  const id = attribute(element, "id");
  return id !== null && TOKENS.has(id.toLowerCase());
}

function resolved(value: string, base: string): URL | undefined {
  try {
    return new URL(value.trim(), base);
  } catch {
    // An unresolvable URL is handled as a refused scheme by the caller (Section 6.3).
    return undefined;
  }
}

/** Replaces an element by its children. */
function unwrap(element: Element): void {
  const parent = element.parentNode;
  if (parent === null) return;
  while (element.firstChild !== null) parent.insertBefore(element.firstChild, element);
  element.remove();
}

/** Section 6.3: keeps `href` on `a`, `src` and `alt` on `img`, `open` on `dialog`; unwraps a refused link. */
function cleanAttributes(element: Element, base: string): void {
  const tag = name(element);
  const keep = new Map<string, string>();
  if (tag === "a") {
    const href = attribute(element, "href");
    const url = href === null ? undefined : resolved(href, base);
    if (url === undefined || !["http:", "https:", "mailto:"].includes(url.protocol)) {
      unwrap(element);
      return;
    }
    keep.set("href", url.href);
  }
  if (tag === "img") {
    const src = attribute(element, "src");
    const url = src === null ? undefined : resolved(src, base);
    if (url !== undefined && (url.protocol === "http:" || url.protocol === "https:")) {
      keep.set("src", url.href);
    }
    const alt = attribute(element, "alt");
    if (alt !== null) keep.set("alt", collapseSpace(cleanText(alt)).trim());
  }
  if (tag === "dialog") keep.set("open", "");
  for (const attr of Array.from(element.attributes)) element.removeAttribute(attr.name);
  for (const [key, value] of keep) element.setAttribute(key, value);
}

function sanitizeNode(node: Node, base: string, inPre: boolean): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      const text = cleanText(child.textContent ?? "");
      child.textContent = inPre ? text : collapseSpace(text);
      continue;
    }
    if (!isElement(child)) {
      child.parentNode?.removeChild(child);
      continue;
    }
    if (isRemoved(child)) {
      child.remove();
      continue;
    }
    const tag = name(child);
    const pre = inPre || tag === "pre";
    if (tag === "math") {
      sanitizeNode(child, base, pre);
      const text = child.ownerDocument.createTextNode(child.textContent ?? "");
      child.replaceWith(text);
      continue;
    }
    sanitizeNode(child, base, pre);
    cleanAttributes(child, base);
  }
}

/**
 * Sanitizes a document in place (Section 6): drops `head` and every non-element, non-text node,
 * removes hidden and removed elements, cleans attributes and text. `base` resolves URLs.
 */
export function sanitizeDocument(document: Document, base: string): void {
  document.head?.remove();
  const root = document.documentElement;
  for (const child of Array.from(document.childNodes)) {
    if (child !== root && child.nodeType !== 10) child.parentNode?.removeChild(child);
  }
  if (root === null) return;
  // linkedom splits text at character references; merged, each run is collapsed as a whole.
  root.normalize();
  sanitizeNode(root, base, false);
  cleanAttributes(root, base);
  root.normalize();
}
