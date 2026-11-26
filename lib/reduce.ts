/** The exact-content check of the reformat (specs/web-fetch.md, Section 7.5). */

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

/** The reduction of a Markdown text (Section 7.5, steps 1 to 7). */
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

/** Whether `content` equals a run of one or more consecutive whole lines of `input`. */
function isLineRun(content: string, inputLines: readonly string[]): boolean {
  if (content === "") return true;
  const wanted = content.split("\n");
  for (let start = 0; start + wanted.length <= inputLines.length; start += 1) {
    if (wanted.every((line, offset) => inputLines[start + offset] === line)) return true;
  }
  return false;
}

/** The code check of Section 7.5: existing fences kept exactly, new fences copy input lines. */
export function codeCheck(
  input: string,
  inputCode: readonly string[],
  outputCode: readonly string[],
) {
  const inputLines = input.split("\n");
  let next = 0;
  for (const content of outputCode) {
    if (next < inputCode.length && inputCode[next] === content) {
      next += 1;
    } else if (!isLineRun(content, inputLines)) {
      return false;
    }
  }
  return next === inputCode.length;
}

export type CheckResult = "pass" | "code changed" | "links changed" | "text changed";

/** The exact-content check of a chunk and its processed output (Section 7.5). */
export function checkChunk(input: string, output: string): CheckResult {
  const a = reduce(input);
  const b = reduce(output);
  if (!codeCheck(input, a.code, b.code)) return "code changed";
  const urlsA = sorted(a.urls);
  const urlsB = sorted(b.urls);
  if (urlsA.length !== urlsB.length || urlsA.some((url, i) => url !== urlsB[i])) {
    return "links changed";
  }
  return a.text === b.text ? "pass" : "text changed";
}
