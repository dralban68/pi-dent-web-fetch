/**
 * The `WebFetch` tool (specs/web-fetch.md): registration (specs/web-fetch.md#tool), the call's flow over the
 * cache (specs/web-fetch.md#cache), the reformat (specs/web-fetch.md#reformat) and the result (specs/web-fetch.md#result).
 */

import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  NOTICE_UNREADABLE,
  KEPT_REASONS,
  entryPaths,
  filePath,
  readEntry,
  serializeMeta,
  sha256,
  writeEntryFiles,
  type Entry,
  type EntryPaths,
  type Meta,
  type ReformatMeta,
} from "./cache.ts";
import type { Environment, WebConfig } from "./config.ts";
import { contentKind, decodeBody, fileExtension } from "./decode.ts";
import { WebFetchError, errorMessage } from "./errors.ts";
import { extract } from "./extract.ts";
import { fetchPage, systemResolver, type Resolver } from "./http.ts";
import { chooseLocation, relativeUnder, type CacheLocation } from "./location.ts";
import { resolveModelString } from "./model.ts";
import {
  NOTICE_NO_TEXT,
  NOTICE_PAGE_LIMIT,
  NOTICE_TIMEOUT,
  EXTRACTION_BUDGET_MS,
  extractPdf,
  noticeFailed,
  pagesToMarkdown,
} from "./pdf.ts";
import { isReusable, reformat, type Registry } from "./reformat.ts";
import { canonicalIp } from "./address.ts";
import { canonicalUrl, validateUrl } from "./url.ts";

export const PREVIEW_CHARS = 4000;
export const DEFAULT_MAX_AGE_HOURS = 24;

export const WebFetchSchema = Type.Object({
  url: Type.String({ description: "The http or https page to fetch" }),
  refresh: Type.Optional(
    Type.Boolean({ description: "Fetch unconditionally, even when the cached copy is fresh" }),
  ),
  maxAgeHours: Type.Optional(
    Type.Number({ minimum: 0, description: "Freshness limit in hours; default 24" }),
  ),
  reformat: Type.Optional(
    Type.Boolean({
      description: "Have the reformat model fix the Markdown's formatting; text is never changed",
    }),
  ),
  cache: Type.Optional(
    Type.String({
      description:
        'Where to cache: "project" (.pi/web-cache/ in the working directory), "session" (the session\'s temporary folder), or a folder path; omit it for the configured default',
    }),
  ),
});

export const WEBFETCH_DESCRIPTION =
  "Fetch a web page (http or https) as Markdown and cache it, by default under .pi/web-cache/ in the working directory. A non-text response (image, archive, PDF, anything without a text content type) is stored unchanged into the cache entry as file.<ext>; PDFs also get their text extracted. Returns the cache path of content.md, the status (fetched, cached, revalidated, stale) and a preview; read the rest of the page from the path. Text hidden from readers is removed. A fresh cached copy is served without network access.";

export type FetchStatus = "fetched" | "cached" | "revalidated" | "stale";

export interface StoredFileDetails {
  readonly path: string;
  readonly absolutePath: string;
  readonly contentType: string;
  readonly bytes: number;
}

export interface WebFetchDetails {
  readonly status: FetchStatus;
  readonly path: string;
  readonly extractedPath: string;
  readonly absolutePath: string;
  readonly cacheDir: string;
  readonly url: string;
  readonly canonicalUrl: string;
  readonly finalUrl: string;
  readonly title: string | null;
  readonly fetchedAt: string;
  readonly length: number;
  readonly previewLength: number;
  readonly reformat: ReformatMeta | null;
  readonly file: StoredFileDetails | null;
  readonly notices: readonly string[];
}

/** The test seam of specs/web-fetch.md#test-seam. */
export interface WebFetchOptions {
  readonly resolve?: Resolver;
  readonly allowedAddresses?: readonly string[];
  /** specs/web-fetch.md#cache-location: the environment, read at each call; the home and temporary folders. */
  readonly env?: Environment;
  readonly homeDir?: string;
  readonly tmpDir?: string;
}

export interface CallContext {
  readonly cwd: string;
  readonly modelRegistry: Registry;
  readonly sessionManager?: { getSessionId(): string };
  /** Reports a warning of specs/web-fetch.md#cache-location to the UI, when there is one. */
  readonly warn?: (message: string) => void;
}

export interface WebFetchParams {
  readonly url: string;
  readonly refresh?: boolean | undefined;
  readonly maxAgeHours?: number | undefined;
  readonly reformat?: boolean | undefined;
  readonly cache?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userAgent(): string {
  const pkg: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const version = isRecord(pkg) && typeof pkg.version === "string" ? pkg.version : "0.0.0";
  const homepage = isRecord(pkg) && typeof pkg.homepage === "string" ? pkg.homepage : "";
  return `pi-dent-web-fetch/${version} (+${homepage})`;
}

const USER_AGENT = userAgent();

/** specs/web-fetch.md#result-text: the preview, not splitting a surrogate pair. */
function preview(content: string): string {
  if (content.length <= PREVIEW_CHARS) return content;
  const code = content.charCodeAt(PREVIEW_CHARS - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? PREVIEW_CHARS - 1 : PREVIEW_CHARS;
  return content.slice(0, end);
}

/** specs/web-fetch.md#result-text: the `Reformat:` state. */
export function reformatState(meta: ReformatMeta | null): string {
  if (meta === null) return "none";
  const head = `${meta.model}: ${meta.reformatted} of ${meta.chunks} chunks reformatted`;
  const kept = KEPT_REASONS.flatMap((reason) => {
    const count = meta.kept[reason];
    return count === undefined ? [] : [`${reason} ${count}`];
  });
  const total = meta.chunks - meta.reformatted;
  return kept.length === 0 ? head : `${head}; ${total} kept: ${kept.join(", ")}`;
}

function resultText(
  details: WebFetchDetails,
  underCwd: boolean,
  content: string,
  shown: string,
): string {
  const file = details.file;
  const lines = [
    `WebFetch: ${details.status}`,
    ...(underCwd ? [`Path: ${details.path}`] : []),
    `Absolute path: ${details.absolutePath}`,
    ...(file === null
      ? []
      : [
          `File: ${file.path} (${file.bytes} bytes)`,
          `Absolute file: ${file.absolutePath}`,
          `File type: ${file.contentType}`,
        ]),
    ...(details.extractedPath === details.path ? [] : [`Extracted: ${details.extractedPath}`]),
    `Title: ${details.title ?? "(none)"}`,
    `URL: ${details.finalUrl}`,
    `Fetched at: ${details.fetchedAt}`,
    `Length: ${content.length} characters`,
    `Reformat: ${reformatState(details.reformat)}`,
    ...details.notices,
    "",
    shown,
  ];
  const remaining = content.length - shown.length;
  if (remaining > 0)
    lines.push(`[${remaining} more characters; read the rest from ${details.path}]`);
  return lines.join("\n");
}

interface Served {
  readonly entry: Entry;
  readonly status: FetchStatus;
}

async function fetchAndStore(
  params: WebFetchParams,
  canonical: string,
  paths: EntryPaths,
  previous: Entry | undefined,
  location: CacheLocation,
  notices: string[],
  signal: AbortSignal | undefined,
  options: WebFetchOptions,
  extractionBudgetMs: number,
): Promise<Served> {
  const response = await fetchPage({
    url: canonical,
    userAgent: USER_AGENT,
    validators: params.refresh === true ? undefined : previous?.meta,
    signal,
    resolve: options.resolve ?? systemResolver,
    allowedAddresses: new Set((options.allowedAddresses ?? []).map(canonicalIp)),
  });
  const now = new Date().toISOString();
  if (response.status === 304 && previous !== undefined) {
    const meta: Meta = { ...previous.meta, fetchedAt: now };
    await writeEntryFiles(location, paths, {
      extracted: previous.extracted,
      content: previous.content,
      meta: serializeMeta(meta),
    });
    return { entry: { ...previous, meta }, status: "revalidated" };
  }
  const kind = contentKind(response.contentType, response.finalUrl);
  if (kind === "pdf" || kind === "binary") {
    // specs/web-fetch.md#stored-files, specs/web-fetch.md#pdf: the body is stored unchanged; a PDF's text is extracted.
    const fileName = `file.${fileExtension(response.contentType, response.finalUrl)}`;
    let markdown = "";
    if (kind === "pdf") {
      const extraction = await extractPdf(response.body, {
        timeoutMs: Math.max(0, extractionBudgetMs),
        signal,
      });
      if (extraction.outcome === "failed") {
        notices.push(noticeFailed(extraction.reason ?? "the extraction failed"));
      }
      if (extraction.outcome === "timeout") notices.push(NOTICE_TIMEOUT);
      if (extraction.outcome === "page-limit") notices.push(NOTICE_PAGE_LIMIT);
      markdown = pagesToMarkdown(extraction.pages);
      if (
        (extraction.outcome === "complete" || extraction.outcome === "page-limit") &&
        markdown === ""
      ) {
        notices.push(NOTICE_NO_TEXT);
      }
    }
    const meta: Meta = {
      url: params.url,
      canonicalUrl: canonical,
      finalUrl: response.finalUrl,
      fetchedAt: now,
      status: response.status,
      contentType: response.contentType ?? "",
      etag: response.etag,
      lastModified: response.lastModified,
      title: null,
      bytes: response.body.length,
      fileName,
      fileBytes: response.body.length,
      extractedSha256: sha256(markdown),
      reformat: null,
    };
    await writeEntryFiles(location, paths, {
      file: [filePath(paths.dir, fileName), response.body],
      extracted: markdown,
      content: markdown,
      meta: serializeMeta(meta),
    });
    return { entry: { meta, extracted: markdown, content: markdown }, status: "fetched" };
  }
  const decoded = decodeBody(response.body, response.contentType, kind);
  if (decoded.notice !== undefined) notices.push(decoded.notice);
  const result = extract(kind, decoded.text, response.finalUrl);
  notices.push(...result.notices);
  const meta: Meta = {
    url: params.url,
    canonicalUrl: canonical,
    finalUrl: response.finalUrl,
    fetchedAt: now,
    status: response.status,
    contentType: response.contentType ?? "",
    etag: response.etag,
    lastModified: response.lastModified,
    title: result.title,
    bytes: response.body.length,
    fileName: null,
    fileBytes: null,
    extractedSha256: sha256(result.markdown),
    reformat: null,
  };
  await writeEntryFiles(location, paths, {
    extracted: result.markdown,
    content: result.markdown,
    meta: serializeMeta(meta),
  });
  return {
    entry: { meta, extracted: result.markdown, content: result.markdown },
    status: "fetched",
  };
}

/** specs/web-fetch.md#reformat-model, specs/web-fetch.md#reuse: the reformat of the served entry, or a skip notice. */
async function applyReformat(
  served: Entry,
  config: WebConfig,
  ctx: CallContext,
  location: CacheLocation,
  paths: EntryPaths,
  notices: string[],
  signal: AbortSignal | undefined,
): Promise<Entry> {
  const modelString = config.reformatModel;
  if (modelString === undefined) {
    notices.push("Reformat skipped: no reformat model is configured (web.reformatModel).");
    return served;
  }
  let resolved;
  try {
    resolved = resolveModelString(modelString, ctx.modelRegistry.getAll(), config.modelClasses);
  } catch (error) {
    notices.push(
      `Reformat skipped: reformat model ${modelString} cannot be resolved: ${errorMessage(error)}.`,
    );
    return served;
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(resolved.model)) {
    notices.push(`Reformat skipped: reformat model ${modelString} has no configured auth.`);
    return served;
  }
  const { meta } = served;
  if (isReusable(meta.reformat, modelString, meta.extractedSha256)) return served;
  const result = await reformat({
    registry: ctx.modelRegistry,
    model: resolved.model,
    thinking: resolved.thinking,
    modelString,
    extracted: served.extracted,
    extractedSha256: meta.extractedSha256,
    previous: meta.reformat === null ? undefined : { meta: meta.reformat, content: served.content },
    signal,
  });
  const next: Meta = { ...meta, reformat: result.meta };
  await writeEntryFiles(location, paths, {
    extracted: served.extracted,
    content: result.content,
    meta: serializeMeta(next),
  });
  return { meta: next, extracted: served.extracted, content: result.content };
}

/** One call of the tool (specs/web-fetch.md#request, specs/web-fetch.md#cache, specs/web-fetch.md#content, specs/web-fetch.md#sanitizer, specs/web-fetch.md#reformat, specs/web-fetch.md#configuration, specs/web-fetch.md#result). */
export async function runWebFetch(
  params: WebFetchParams,
  ctx: CallContext,
  config: WebConfig,
  signal: AbortSignal | undefined,
  options: WebFetchOptions = {},
): Promise<AgentToolResult<WebFetchDetails>> {
  const startedAt = Date.now();
  const maxAgeHours = params.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  if (!Number.isFinite(maxAgeHours) || maxAgeHours < 0) {
    throw new WebFetchError("input", "WebFetch: maxAgeHours must be a number of 0 or more");
  }
  const url = validateUrl(params.url);
  const canonical = canonicalUrl(url);
  const location = chooseLocation({
    cwd: ctx.cwd,
    param: params.cache,
    setting: config.cache,
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? homedir(),
    tmpDir: options.tmpDir ?? tmpdir(),
    sessionId: ctx.sessionManager?.getSessionId(),
  });
  for (const warning of location.warnings) ctx.warn?.(warning);
  const paths = entryPaths(ctx.cwd, location.dir, canonical);
  const notices: string[] = [...location.notices];
  const read = await readEntry(paths);
  if (read === "unreadable") notices.push(NOTICE_UNREADABLE);
  const entry = typeof read === "string" ? undefined : read;

  let served: Served;
  const age = entry === undefined ? Number.NaN : Date.now() - Date.parse(entry.meta.fetchedAt);
  if (entry !== undefined && params.refresh !== true && age < maxAgeHours * 3_600_000) {
    served = { entry, status: "cached" };
  } else {
    try {
      served = await fetchAndStore(
        params,
        canonical,
        paths,
        entry,
        location,
        notices,
        signal,
        options,
        startedAt + EXTRACTION_BUDGET_MS - Date.now(),
      );
    } catch (error) {
      if (entry === undefined || !(error instanceof WebFetchError) || error.kind !== "fetch") {
        throw error;
      }
      notices.push(
        `Refetch failed (${error.message}); serving the copy fetched at ${entry.meta.fetchedAt}.`,
      );
      served = { entry, status: "stale" };
    }
  }

  let final = served.entry;
  if (params.reformat ?? config.reformat ?? false) {
    final = await applyReformat(final, config, ctx, location, paths, notices, signal);
  }
  const meta = final.meta;
  const storedFile =
    meta.fileName == null
      ? null
      : (() => {
          const absolutePath = filePath(paths.dir, meta.fileName);
          return {
            path: relativeUnder(ctx.cwd, absolutePath) ?? absolutePath,
            absolutePath,
            contentType: meta.contentType,
            bytes: meta.fileBytes ?? meta.bytes,
          };
        })();
  const shown = preview(final.content);
  const details: WebFetchDetails = {
    status: served.status,
    path: paths.displayContent,
    extractedPath:
      final.extracted === final.content ? paths.displayContent : paths.displayExtracted,
    absolutePath: paths.content,
    cacheDir: location.dir,
    url: params.url,
    canonicalUrl: canonical,
    finalUrl: final.meta.finalUrl,
    title: final.meta.title,
    fetchedAt: final.meta.fetchedAt,
    length: final.content.length,
    previewLength: shown.length,
    reformat: final.meta.reformat,
    file: storedFile,
    notices,
  };
  const text = resultText(details, paths.relativeContent !== undefined, final.content, shown);
  return { content: [{ type: "text", text }], details };
}

function isDetails(value: unknown): value is WebFetchDetails {
  return isRecord(value) && typeof value.status === "string" && typeof value.path === "string";
}

/** Builds the tool (specs/web-fetch.md#test-seam); `config` returns the configuration read per specs/web-fetch.md#configuration. */
export function createWebFetchTool(
  config: () => WebConfig,
  options: WebFetchOptions = {},
): ToolDefinition<typeof WebFetchSchema, WebFetchDetails> {
  // specs/web-fetch.md#cache-location: each distinct warning is reported once per extension instance.
  const warned = new Set<string>();
  return {
    name: "WebFetch",
    label: "Web Fetch",
    description: WEBFETCH_DESCRIPTION,
    promptSnippet: "Fetch a web page as Markdown, cached in the working folder",
    parameters: WebFetchSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const warn = (message: string): void => {
        if (!ctx.hasUI || warned.has(message)) return;
        warned.add(message);
        ctx.ui.notify(`pi-dent-web-fetch: ${message}`, "warning");
      };
      const call: CallContext = {
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        sessionManager: ctx.sessionManager,
        warn,
      };
      return runWebFetch(params, call, config(), signal, options);
    },
    renderCall(args) {
      return new Text(`WebFetch ${args.url}`, 0, 0);
    },
    renderResult(result) {
      const details = result.details;
      if (isDetails(details)) return new Text(`${details.status} ${details.path}`, 0, 0);
      const first = result.content[0];
      return new Text(first !== undefined && first.type === "text" ? first.text : "", 0, 0);
    },
  };
}
