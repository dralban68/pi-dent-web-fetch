/** Content types and character decoding (specs/web-fetch.md, Sections 3.8 and 5.1). */

import { WebFetchError } from "./errors.ts";

export type ContentKind = "html" | "markdown" | "plain";

/** The media type: the `Content-Type` value before any `;`, trimmed and lowercased. */
export function mediaType(contentType: string | null): string | null {
  if (contentType === null) return null;
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return type === "" ? null : type;
}

/** The handling of a content type, or the refusal of Section 5.1. */
export function contentKind(contentType: string | null, finalUrl: string): ContentKind {
  const type = mediaType(contentType);
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type === "text/plain") return "plain";
  throw new WebFetchError(
    "fetch",
    `WebFetch: unsupported content type ${type ?? "none"} from ${finalUrl}; only HTML, Markdown and plain text are fetched`,
  );
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
