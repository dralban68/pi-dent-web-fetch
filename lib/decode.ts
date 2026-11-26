/** Content types and character decoding (specs/web-fetch.md, Sections 3.8 and 5.1). */

import { WebFetchError } from "./errors.ts";

export type ContentKind = "html" | "markdown" | "plain" | "data" | "pdf" | "binary";

/** The media type: the `Content-Type` value before any `;`, trimmed and lowercased. */
export function mediaType(contentType: string | null): string | null {
  if (contentType === null) return null;
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return type === "" ? null : type;
}

/** The data text media types of Section 5.7. */
const DATA_TYPES = new Set([
  "application/json",
  "text/csv",
  "text/xml",
  "application/xml",
  "application/rss+xml",
  "application/atom+xml",
]);

/** The stored-file extensions of Section 5.8, per media type. */
const FILE_EXTENSIONS = new Map<string, string>([
  ["application/pdf", "pdf"],
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["image/bmp", "bmp"],
  ["image/x-icon", "ico"],
  ["image/svg+xml", "svg"],
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
  ["audio/mpeg", "mp3"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/ogg", "ogg"],
  ["application/ogg", "ogg"],
  ["application/zip", "zip"],
  ["application/gzip", "gz"],
  ["application/x-gzip", "gz"],
  ["application/x-tar", "tar"],
  ["application/x-7z-compressed", "7z"],
  ["application/vnd.rar", "rar"],
  ["application/wasm", "wasm"],
]);

/** Whether the media type is one of the text kinds of Section 5.1 (HTML, Markdown, plain, data). */
export function isTextMediaType(type: string): boolean {
  return (
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    type === "text/markdown" ||
    type === "text/x-markdown" ||
    type === "text/plain" ||
    isDataMediaType(type)
  );
}

function isDataMediaType(type: string): boolean {
  return DATA_TYPES.has(type) || type.endsWith("+json");
}

/** The handling of a content type, or the refusal of Section 5.1. */
export function contentKind(contentType: string | null, finalUrl: string): ContentKind {
  const type = mediaType(contentType);
  if (type === null) {
    throw new WebFetchError("fetch", `WebFetch: no media type from ${finalUrl}`);
  }
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type === "text/plain") return "plain";
  if (isDataMediaType(type)) return "data";
  if (type === "application/pdf") return "pdf";
  return "binary";
}

/**
 * The stored file's extension of Section 5.8: the map's value for the media type, else the final
 * URL's path extension (1 to 8 ASCII letters or digits), else `bin`.
 */
export function fileExtension(contentType: string | null, finalUrl: string): string {
  const type = mediaType(contentType);
  const mapped = type === null ? undefined : FILE_EXTENSIONS.get(type);
  if (mapped !== undefined) return mapped;
  const segment = new URL(finalUrl).pathname.split("/").at(-1) ?? "";
  const match = /\.([a-z0-9]{1,8})$/i.exec(segment);
  return match?.[1]?.toLowerCase() ?? "bin";
}

function headerCharset(contentType: string | null): string | undefined {
  if (contentType === null) return undefined;
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return match?.[1];
}

function metaCharset(body: Buffer): string | undefined {
  const head = body.subarray(0, 1024).toString("latin1");
  const direct = /<meta[^>]*?\scharset\s*=\s*["']?([^"'\s/>;]+)/i.exec(head);
  if (direct?.[1] !== undefined) return direct[1];
  const equiv =
    /<meta[^>]*?http-equiv\s*=\s*["']?content-type["']?[^>]*?charset\s*=\s*([^"'\s/>;]+)/i.exec(
      head,
    );
  return equiv?.[1];
}

/** The decoded body, with the notice of Section 3.8 when the label is unknown. */
export function decodeBody(
  body: Buffer,
  contentType: string | null,
  kind: ContentKind,
): { text: string; notice?: string } {
  const label = headerCharset(contentType) ?? (kind === "html" ? metaCharset(body) : undefined);
  if (label !== undefined) {
    let decoder: TextDecoder | undefined;
    try {
      decoder = new TextDecoder(label);
    } catch {
      decoder = undefined;
    }
    if (decoder !== undefined) return { text: decoder.decode(body) };
    return {
      text: new TextDecoder("utf-8").decode(body),
      notice: `Unknown charset ${label}; decoded as UTF-8.`,
    };
  }
  return { text: new TextDecoder("utf-8").decode(body) };
}
