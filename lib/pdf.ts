/**
 * PDF text extraction (specs/web-fetch.md#pdf): a worker thread runs PDF.js (it ignores
 * cancellation, so the tool stops the worker at the call's time budget), and the page's
 * `getTextContent()` items are paired with the page's operator-list runs to drop text that a
 * reader cannot see: an invisible render mode, an effective font size below 1 pt, or a position
 * outside the page box.
 */

import { Worker } from "node:worker_threads";

import { WebFetchError, errorMessage } from "./errors.ts";
import { cleanText } from "./text.ts";

/** specs/web-fetch.md#pdf: at most this many pages are extracted. */
export const PAGE_LIMIT = 100;
/** specs/web-fetch.md#pdf: the pairing tolerance, in points. */
export const PAIR_TOLERANCE_PT = 1;
/** specs/web-fetch.md#pdf: an effective font size below this many points is dropped. */
export const MIN_FONT_PT = 1;
/** The call's whole budget of specs/web-fetch.md#timeout-and-cap, which the extraction shares. */
export const EXTRACTION_BUDGET_MS = 30_000;

export const NOTICE_PAGE_LIMIT = `PDF text extraction stopped at ${PAGE_LIMIT} pages.`;
export const NOTICE_TIMEOUT = "PDF text extraction timed out; the pages extracted so far are kept.";
export const NOTICE_NO_TEXT = "No text found in the PDF; the file is kept.";
export const noticeFailed = (reason: string): string =>
  `PDF text extraction failed (${reason}); the file is kept without text.`;

export interface PdfPage {
  readonly page: number;
  readonly text: string;
}

export interface PdfExtraction {
  readonly pages: readonly PdfPage[];
  readonly total: number | undefined;
  /** `complete`, `page-limit`, `timeout` or `failed`. */
  readonly outcome: "complete" | "page-limit" | "timeout" | "failed";
  readonly reason?: string;
}

/** A show-text operator (showText, showSpacedText, nextLineShowText, nextLineSetSpacingShowText). */
const SHOW_OPS = [44, 45, 46, 47];
/** Operators whose arguments the run tracker consumes. */
const RUN_OPS = [10, 11, 12, 31, 36, 37, 38, 39, 40, 41, 42, 43, 74, 75];

/** One show-text run: its origin, its effective font size, its render mode and its text. */
export interface TextRun {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly mode: number;
  readonly text: string;
}

/** A compact operator run from the worker: `op` plus its arguments, each a number, an array of
 * numbers (a matrix or box in one argument slot), or null for a non-numeric value. */
export interface RawRun {
  readonly op: number;
  readonly a?: readonly (number | readonly number[] | null)[];
  /** A show-text run's text: the Unicode of its glyphs. */
  readonly s?: string;
}

/** `Td tx ty`: the translation is in text space, so the text matrix's linear part scales it. */
function translate(tm: Matrix, tx: number, ty: number): Matrix {
  return [
    tm[0],
    tm[1],
    tm[2],
    tm[3],
    tm[4] + tx * tm[0] + ty * tm[2],
    tm[5] + tx * tm[1] + ty * tm[3],
  ];
}

/** A compact text item from the worker: string, end-of-line flag, origin. */
export interface RawItem {
  readonly s: string;
  readonly eol?: boolean;
  readonly t: readonly [number, number];
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Multiplies two matrices: `mul(m, n)` applies `n` first, then `m`. */
function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[1] + n[4],
    m[4] * n[2] + m[5] * n[3] + n[5],
  ];
}

interface GraphicsState {
  ctm: Matrix;
  fontSize: number;
  mode: number;
  rise: number;
  leading: number;
}

function cloneState(state: GraphicsState): GraphicsState {
  const ctm: Matrix = [...state.ctm];
  return { ...state, ctm };
}

/**
 * Tracks the graphics state over the page's operator runs, giving each show-text run its origin in
 * page space, its effective font size and its render mode (specs/web-fetch.md#pdf).
 */
export function trackRuns(rawRuns: readonly RawRun[]): TextRun[] {
  const runs: TextRun[] = [];
  let state: GraphicsState = { ctm: IDENTITY, fontSize: 0, mode: 0, rise: 0, leading: 0 };
  let tm: Matrix = IDENTITY;
  const stack: GraphicsState[] = [];
  for (const raw of rawRuns) {
    const a = raw.a ?? [];
    switch (raw.op) {
      case 10: // save
        stack.push(cloneState(state));
        break;
      case 11: // restore
        state = stack.pop() ?? state;
        break;
      case 12: // transform
        state.ctm = mul(scalarsMatrix(a), state.ctm);
        break;
      case 31: // beginText: Tm and Tlm reset to the identity (ISO 32000-2, 9.4.1).
        tm = IDENTITY;
        break;
      case 32: // endText
        break;
      case 36: // setLeading
        state.leading = num(a, 0) ?? 0;
        break;
      case 37: // setFont
        state.fontSize = num(a, 1) ?? 0;
        break;
      case 38: // setTextRenderingMode
        state.mode = num(a, 0) ?? 0;
        break;
      case 39: // setTextRise
        state.rise = num(a, 0) ?? 0;
        break;
      case 40: // moveText
        tm = translate(tm, num(a, 0) ?? 0, num(a, 1) ?? 0);
        break;
      case 41: // setLeadingMoveText
        state.leading = -(num(a, 1) ?? 0);
        tm = translate(tm, num(a, 0) ?? 0, num(a, 1) ?? 0);
        break;
      case 43: // nextLine: Td 0 -leading
        tm = translate(tm, 0, -state.leading);
        break;
      case 42: // setTextMatrix
        tm = scalarsMatrix(a);
        break;
      case 74: // paintFormXObjectBegin
        stack.push(cloneState(state));
        state.ctm = mul(matrix(a), state.ctm);
        break;
      case 75: // paintFormXObjectEnd
        state = stack.pop() ?? state;
        break;
      default:
        if (SHOW_OPS.includes(raw.op)) {
          if (raw.op === 46 || raw.op === 47) {
            // nextLineShowText and nextLineSetSpacingShowText: Td 0 -leading, then show.
            tm = translate(tm, 0, -state.leading);
          }
          const origin = translate(tm, 0, state.rise);
          runs.push({
            x: state.ctm[4] + state.ctm[0] * origin[4] + state.ctm[2] * origin[5],
            y: state.ctm[5] + state.ctm[1] * origin[4] + state.ctm[3] * origin[5],
            size:
              state.fontSize * Math.hypot(tm[2], tm[3]) * Math.hypot(state.ctm[2], state.ctm[3]),
            mode: state.mode,
            text: raw.s ?? "",
          });
        }
    }
  }
  return runs;
}

function num(a: readonly (number | readonly number[] | null)[], index: number): number | undefined {
  const value = a[index];
  return typeof value === "number" ? value : undefined;
}

/**
 * A matrix given as six arguments, or as one argument slot holding all six: PDF.js packs
 * `setTextMatrix` (and may pack `transform`) into one array.
 */
function scalarsMatrix(a: readonly (number | readonly number[] | null)[]): Matrix {
  if (Array.isArray(a[0])) return matrix(a, 0);
  return [
    num(a, 0) ?? 1,
    num(a, 1) ?? 0,
    num(a, 2) ?? 0,
    num(a, 3) ?? 1,
    num(a, 4) ?? 0,
    num(a, 5) ?? 0,
  ];
}

/** A matrix given in one argument slot (`paintFormXObjectBegin`'s first argument). */
function matrix(a: readonly (number | readonly number[] | null)[], index = 0): Matrix {
  const m = a[index];
  const v = Array.isArray(m) ? m : [];
  return [v[0] ?? 1, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1, v[4] ?? 0, v[5] ?? 0];
}

/** Whether an item's origin pairs with a run's origin (specs/web-fetch.md#pdf). */
function pairs(run: TextRun, item: RawItem): boolean {
  return (
    Math.abs(run.x - item.t[0]) <= PAIR_TOLERANCE_PT &&
    Math.abs(run.y - item.t[1]) <= PAIR_TOLERANCE_PT
  );
}

/** Whether a run is visible: not render mode 3 or 7, at least 1 pt, inside the page box. */
export function runVisible(run: TextRun, view: readonly [number, number, number, number]): boolean {
  if (run.mode === 3 || run.mode === 7) return false;
  if (run.size < MIN_FONT_PT) return false;
  const [x0, y0, x1, y1] = view;
  return run.x >= x0 && run.x <= x1 && run.y >= y0 && run.y <= y1;
}

/**
 * One page's text (specs/web-fetch.md#pdf). Items and runs are in stream order. An item whose origin pairs with
 * a later run starts from that run; an item that pairs with none continues the current run, since
 * PDF.js splits one run into several items. An item is kept when its run is visible. Runs passed
 * over between two paired items were merged by PDF.js into the earlier item, or dropped by it; the
 * text of each invisible one is removed from that item. The kept strings join with one space, an
 * end-of-line flag becoming one line feed; text cleaning (6.4) is applied.
 */
export function pageText(
  items: readonly RawItem[],
  rawRuns: readonly RawRun[],
  view: readonly [number, number, number, number],
): string {
  const runs = trackRuns(rawRuns);
  const kept: { s: string; eol: boolean }[] = [];
  let next = 0;
  let current: TextRun | undefined;
  let previousKept: { s: string; eol: boolean } | undefined;
  const stripHidden = (from: number, to: number): void => {
    if (previousKept === undefined) return;
    for (let index = from; index < to; index += 1) {
      const passed = runs[index];
      if (passed === undefined || runVisible(passed, view) || passed.text.trim() === "") continue;
      const at = previousKept.s.lastIndexOf(passed.text);
      if (at !== -1) {
        previousKept.s =
          previousKept.s.slice(0, at) + previousKept.s.slice(at + passed.text.length);
      }
    }
  };
  for (const item of items) {
    if (item.s === "") continue;
    let found = -1;
    for (let index = next; index < runs.length; index += 1) {
      const candidate = runs[index];
      if (candidate !== undefined && pairs(candidate, item)) {
        found = index;
        break;
      }
    }
    if (found !== -1) {
      stripHidden(next, found);
      current = runs[found];
      next = found + 1;
    }
    const run = current ?? runs[next];
    if (run === undefined || !runVisible(run, view)) {
      previousKept = undefined;
      continue;
    }
    previousKept = { s: item.s, eol: item.eol === true };
    kept.push(previousKept);
  }
  stripHidden(next, runs.length);
  let text = "";
  let eol = false;
  for (const entry of kept) {
    if (entry.s.trim() === "") continue;
    text += (text === "" ? "" : eol ? "\n" : " ") + entry.s;
    eol = entry.eol;
  }
  return cleanText(text);
}

/** The Markdown of the extracted pages: one `## Page n` section per page with text (specs/web-fetch.md#pdf). */
export function pagesToMarkdown(pages: readonly PdfPage[]): string {
  let markdown = "";
  for (const { page, text } of pages) {
    if (text.trim() === "") continue;
    markdown += `## Page ${page}\n\n${text.trimEnd()}\n\n`;
  }
  return markdown;
}

const WORKER_SOURCE = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", async (message) => {
  try {
    const pdfjs = await import(message.moduleUrl);
    const doc = await pdfjs.getDocumentProxy(message.bytes, { verbosity: 0 });
    const total = doc.numPages;
    const limit = Math.min(total, message.pageLimit);
    const showOps = ${JSON.stringify(SHOW_OPS)};
    const runOps = ${JSON.stringify(RUN_OPS)};
    for (let page = 1; page <= limit; page++) {
      const p = await doc.getPage(page);
      const view = p.view;
      const tc = await p.getTextContent();
      const items = [];
      for (const item of tc.items) {
        if (typeof item.str !== "string") continue;
        items.push({ s: item.str, eol: item.hasEOL === true, t: [item.transform[4], item.transform[5]] });
      }
      const ol = await p.getOperatorList();
      const runs = [];
      const arg = (v) => {
        if (typeof v === "number") return v;
        if (typeof v !== "string" && v && typeof v[Symbol.iterator] === "function") {
          return Array.from(v, (x) => Number(x));
        }
        return null;
      };
      for (let i = 0; i < ol.fnArray.length; i++) {
        const op = ol.fnArray[i];
        const a = ol.argsArray[i];
        if (showOps.includes(op)) {
          const glyphs = (op === 47 ? a && a[2] : a && a[0]) || [];
          const s = Array.from(glyphs, (g) => (g && typeof g === "object" ? (g.unicode ?? "") : "")).join("");
          runs.push({ op, s });
        } else if (runOps.includes(op)) {
          runs.push({ op, a: Array.from(a || []).map(arg) });
        }
      }
      parentPort.postMessage({ type: "page", page, total, items, runs, view: Array.from(view) });
    }
    parentPort.postMessage({ type: "done", total });
  } catch (error) {
    parentPort.postMessage({ type: "error", message: String(error && error.message ? error.message : error) });
  }
});
`;

interface WorkerMessage {
  type: "page" | "done" | "error";
  page?: number;
  total?: number;
  items?: RawItem[];
  runs?: RawRun[];
  view?: readonly [number, number, number, number];
  message?: string;
}

/**
 * Extracts the PDF's pages (specs/web-fetch.md#pdf). The worker stops at `timeoutMs`; on the abort signal the
 * call ends with `WebFetch: cancelled`.
 */
export async function extractPdf(
  bytes: Buffer,
  options: { timeoutMs: number; signal?: AbortSignal | undefined; pageLimit?: number },
): Promise<PdfExtraction> {
  const pageLimit = options.pageLimit ?? PAGE_LIMIT;
  const moduleUrl = String(import.meta.resolve("unpdf"));
  let worker: Worker | undefined;
  const stop = (): void => {
    worker?.terminate();
    worker = undefined;
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  const pages: PdfPage[] = [];
  try {
    const thread = new Worker(WORKER_SOURCE, { eval: true });
    worker = thread;
    const result = await new Promise<PdfExtraction>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = (value: PdfExtraction): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      };
      if (options.timeoutMs !== Infinity) {
        timer = setTimeout(
          () => settle({ pages, total: undefined, outcome: "timeout" }),
          options.timeoutMs,
        );
      }
      const onAbort = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        reject(new WebFetchError("cancelled", "WebFetch: cancelled"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      thread.on("message", (message: WorkerMessage) => {
        if (message.type === "page" && message.items !== undefined && message.runs !== undefined) {
          const view = message.view ?? ([0, 0, 612, 792] as const);
          pages.push({
            page: message.page ?? pages.length + 1,
            text: pageText(message.items, message.runs, view),
          });
        } else if (message.type === "done") {
          const stopped = pages.length < (message.total ?? 0) ? "page-limit" : "complete";
          settle({ pages, total: message.total, outcome: stopped });
        } else if (message.type === "error") {
          settle({
            pages,
            total: undefined,
            outcome: "failed",
            reason: message.message ?? "the extraction failed",
          });
        }
      });
      thread.on("error", (error: unknown) => {
        settle({ pages, total: undefined, outcome: "failed", reason: errorMessage(error) });
      });
      thread.postMessage({ moduleUrl, bytes, pageLimit });
    });
    return result;
  } finally {
    if (options.signal !== undefined) options.signal.removeEventListener("abort", stop);
    stop();
  }
}
