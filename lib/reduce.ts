/** The exact-content check of the reformat (specs/web-fetch.md#exact-content-check). */

export interface Reduction {
  /** Fence contents, in order, exact. */
  readonly code: readonly string[];
  /** Link, image and autolink destinations, in order of appearance. */
  readonly urls: readonly string[];
  readonly text: string;
}

const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;

/** Step 1: fence contents to the code list; fence lines removed, content lines kept. */
function fences(lines: readonly string[]): { lines: string[]; code: string[] } {
  const out: string[] = [];
  const code: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const open = FENCE_OPEN.exec(line)?.[1];
    if (open === undefined) {
      out.push(line);
      index += 1;
      continue;
    }
    const char = open.charAt(0);
    const close = new RegExp(`^ {0,3}\\${char}{${open.length},} *$`);
    const content: string[] = [];
    index += 1;
    while (index < lines.length && !close.test(lines[index] ?? "")) {
      content.push(lines[index] ?? "");
      index += 1;
    }
    index += 1;
    code.push(content.join("\n"));
    out.push(...content);
  }
  return { lines: out, code };
}

const DROPPED_LINE = /^ *(?:(?:= *)+|(?:- *)+|(?:\* *)+|(?:_ *)+)$/;
const TABLE_DELIMITER = /^[ |:-]*-[ |:-]*$/;

function stripPrefixes(line: string): string {
  let current = line;
  for (;;) {
    let next = current.replace(/^ *> ?/, "");
    if (next === current) next = current.replace(/^ *(?:[-*+]|\d{1,9}[.)])(?: +|$)/, "");
    if (next === current) next = current.replace(/^ *\[[ xX]\](?: +|$)/, "");
    if (next === current && /^ *#{1,6}(?: |$)/.test(current)) {
      next = current.replace(/^ *#{1,6}(?: +|$)/, "").replace(/[ #]+$/, "");
    }
    if (next === current) return current;
    current = next;
  }
}

const DEST = String.raw`(<[^<>\n]*>|[^\s()]*)`;
const TITLE = String.raw`(?:\s+("[^"]*"|'[^']*'))?`;
const IMAGE = new RegExp(String.raw`!\[([^\[\]]*)\]\(\s*${DEST}${TITLE}\s*\)`, "g");
const LINK = new RegExp(String.raw`\[([^\[\]]*)\]\(\s*${DEST}${TITLE}\s*\)`, "g");
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]*:[^<>\s]*)>/g;

function unbracket(dest: string): string {
  return dest.startsWith("<") && dest.endsWith(">") ? dest.slice(1, -1) : dest;
}

/** The reduction of a Markdown text (specs/web-fetch.md#exact-content-check, steps 1 to 7). */
export function reduce(markdown: string): Reduction {
  const { lines, code } = fences(markdown.split("\n"));
  const kept = lines
    .filter((line) => !DROPPED_LINE.test(line) && !TABLE_DELIMITER.test(line))
    .map(stripPrefixes);
  const urls: string[] = [];
  let text = kept.join("\n").replace(/\\([!-/:-@[-`{-~])/g, "$1");
  const link = (_match: string, label: string, dest: string, title: string | undefined) => {
    const url = unbracket(dest);
    urls.push(url);
    return `${label} ${url}${title === undefined ? "" : ` ${title.slice(1, -1)}`}`;
  };
  text = text.replace(IMAGE, link).replace(LINK, link);
  text = text.replace(AUTOLINK, (_match, url: string) => {
    urls.push(url);
    return ` ${url}`;
  });
  text = text
    .replace(/[*_~`|]/g, "")
    .replace(/[\t\n ]+/g, " ")
    .trim();
  return { code, urls, text };
}

function sorted(values: readonly string[]): string[] {
  return values.toSorted((a, b) => {
    if (a < b) return -1;
    return a > b ? 1 : 0;
  });
}

interface Fence {
  /** The opening line's info string, trimmed. */
  readonly info: string;
  readonly content: string;
  /** Line indexes of the opening and closing fence lines (`close` is past the end when unclosed). */
  readonly open: number;
  readonly close: number;
}

/** The fenced code blocks of a text, by the fence rule of step 1. */
function fenceBlocks(lines: readonly string[]): Fence[] {
  const out: Fence[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const open = FENCE_OPEN.exec(line)?.[1];
    if (open === undefined) {
      index += 1;
      continue;
    }
    const close = new RegExp(`^ {0,3}\\${open.charAt(0)}{${open.length},} *$`);
    const start = index;
    const content: string[] = [];
    index += 1;
    while (index < lines.length && !close.test(lines[index] ?? "")) {
      content.push(lines[index] ?? "");
      index += 1;
    }
    out.push({
      info: line.replace(/^ *[`~]+/, "").trim(),
      content: content.join("\n"),
      open: start,
      close: index,
    });
    index += 1;
  }
  return out;
}

/** The first run of input lines equal to `wanted` starting at or after `from`, else anywhere. */
function lineRun(
  wanted: readonly string[],
  lines: readonly string[],
  from: number,
): number | undefined {
  const matches = (start: number) => wanted.every((line, offset) => lines[start + offset] === line);
  for (let start = from; start + wanted.length <= lines.length; start += 1) {
    if (matches(start)) return start;
  }
  for (let start = 0; start < from && start + wanted.length <= lines.length; start += 1) {
    if (matches(start)) return start;
  }
  return undefined;
}

export interface CodeCheck {
  readonly ok: boolean;
  /** Input line indexes of label lines folded into a fence's info string. */
  readonly folded: ReadonlySet<number>;
}

/**
 * The code check of specs/web-fetch.md#exact-content-check: existing fences kept exactly, new fences copy input lines; and
 * the label lines folded into an output fence's one-word info string.
 */
export function codeCheck(input: string, output: string): CodeCheck {
  const inputLines = input.split("\n");
  const inputFences = fenceBlocks(inputLines);
  const inFence = new Set<number>();
  for (const fence of inputFences) {
    for (let line = fence.open; line <= fence.close; line += 1) inFence.add(line);
  }
  const folded = new Set<number>();
  let next = 0;
  let cursor = 0;
  for (const fence of fenceBlocks(output.split("\n"))) {
    let anchor: number;
    const existing = inputFences[next];
    if (existing !== undefined && existing.content === fence.content) {
      anchor = existing.open;
      cursor = existing.close + 1;
      next += 1;
    } else if (fence.content === "") {
      continue;
    } else {
      const wanted = fence.content.split("\n");
      const start = lineRun(wanted, inputLines, cursor);
      if (start === undefined) return { ok: false, folded };
      anchor = start;
      cursor = start + wanted.length;
    }
    if (!/^\S+$/.test(fence.info)) continue;
    let label = anchor - 1;
    while (label >= 0 && (inputLines[label] ?? "").trim() === "") label -= 1;
    if (label >= 0 && !inFence.has(label) && (inputLines[label] ?? "").trim() === fence.info) {
      folded.add(label);
    }
  }
  return { ok: next === inputFences.length, folded };
}

export type CheckResult = "pass" | "code changed" | "links changed" | "text changed";

/** The exact-content check of a chunk and its processed output (specs/web-fetch.md#exact-content-check). */
export function checkChunk(input: string, output: string): CheckResult {
  const code = codeCheck(input, output);
  if (!code.ok) return "code changed";
  const kept = input
    .split("\n")
    .map((line, index) => (code.folded.has(index) ? "" : line))
    .join("\n");
  const a = reduce(kept);
  const b = reduce(output);
  const urlsA = sorted(a.urls);
  const urlsB = sorted(b.urls);
  if (urlsA.length !== urlsB.length || urlsA.some((url, i) => url !== urlsB[i])) {
    return "links changed";
  }
  return a.text === b.text ? "pass" : "text changed";
}
