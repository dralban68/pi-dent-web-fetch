/**
 * The request: address guard, redirects, timeout, cancellation and size cap
 * (specs/web-fetch.md#request-headers, specs/web-fetch.md#address-guard,
 * specs/web-fetch.md#redirects, specs/web-fetch.md#timeout-and-cap, specs/web-fetch.md#responses).
 * Uses `node:http` and `node:https` so that each connection goes to the
 * address the guard checked.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { blockedKind, canonicalIp, isLocalhostName } from "./address.ts";
import { isTextMediaType, mediaType } from "./decode.ts";
import { WebFetchError, errorMessage } from "./errors.ts";

export const MAX_REDIRECTS = 5;
export const TIMEOUT_MS = 30_000;
/** The cap of specs/web-fetch.md#timeout-and-cap for the text kinds of specs/web-fetch.md#content-types. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** The cap of specs/web-fetch.md#timeout-and-cap for stored files, PDFs included (5.8). */
export const MAX_STORED_BYTES = 50 * 1024 * 1024;
export const ACCEPT = "text/markdown, text/html;q=0.9, text/plain;q=0.8, application/pdf;q=0.7";

/** Every address of a host name (the test seam of specs/web-fetch.md#test-seam). */
export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

export interface Validators {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface FetchRequest {
  readonly url: string;
  readonly userAgent: string;
  readonly validators?: Validators | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly resolve: Resolver;
  readonly allowedAddresses: ReadonlySet<string>;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface FetchResponse {
  readonly status: number;
  readonly finalUrl: string;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  /** The body after content decoding; empty for a 304. */
  readonly body: Buffer;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value.join(", ");
  return value ?? null;
}

/** The checked address to connect to, or the guard's refusal (specs/web-fetch.md#address-guard). */
async function guardedAddress(url: URL, request: FetchRequest): Promise<string> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) === 0 && isLocalhostName(host)) {
    throw new WebFetchError("fetch", `WebFetch: refused ${url.href}: ${host} is a loopback name`);
  }
  let addresses: string[];
  if (isIP(host) === 0) {
    try {
      addresses = await request.resolve(host);
    } catch (error) {
      throw new WebFetchError("fetch", `WebFetch: cannot resolve ${host}: ${errorMessage(error)}`);
    }
    if (addresses.length === 0) {
      throw new WebFetchError("fetch", `WebFetch: cannot resolve ${host}: no addresses`);
    }
  } else {
    addresses = [host];
  }
  for (const address of addresses) {
    if (request.allowedAddresses.has(canonicalIp(address))) continue;
    const kind = blockedKind(address);
    if (kind !== undefined) {
      throw new WebFetchError(
        "fetch",
        `WebFetch: refused ${url.href}: ${host} is a ${kind} address (${address})`,
      );
    }
  }
  const first = addresses[0];
  if (first === undefined) throw new WebFetchError("fetch", `WebFetch: cannot resolve ${host}`);
  return first;
}

function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function send(url: URL, address: string, headers: Record<string, string>, signal: AbortSignal) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const options = {
    host,
    port: url.port === "" ? undefined : Number(url.port),
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers,
    signal,
    agent: false,
    lookup: pinnedLookup(address),
    ...(isIP(host) === 0 ? { servername: host } : {}),
  };
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req =
      url.protocol === "https:" ? httpsRequest(options, resolve) : httpRequest(options, resolve);
    req.on("error", reject);
    req.end();
  });
}

function decoded(response: IncomingMessage): Readable {
  const encoding = (header(response.headers, "content-encoding") ?? "").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return response;
  if (encoding === "gzip" || encoding === "x-gzip") return response.pipe(createGunzip());
  if (encoding === "deflate") return response.pipe(createInflate());
  if (encoding === "br") return response.pipe(createBrotliDecompress());
  response.destroy();
  throw new Error(`unknown Content-Encoding ${encoding}`);
}

async function readBody(response: IncomingMessage, maxBytes: number, finalUrl: string) {
  const stream = decoded(response);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBytes) {
      response.destroy();
      stream.destroy();
      throw new WebFetchError(
        "fetch",
        `WebFetch: response from ${finalUrl} exceeds ${maxBytes} bytes; nothing was cached`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Fetches `request.url` per specs/web-fetch.md#request-headers, specs/web-fetch.md#address-guard, specs/web-fetch.md#redirects, specs/web-fetch.md#timeout-and-cap, specs/web-fetch.md#responses. */
export async function fetchPage(request: FetchRequest): Promise<FetchResponse> {
  const timeoutMs = request.timeoutMs ?? TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal =
    request.signal === undefined ? deadline : AbortSignal.any([request.signal, deadline]);
  const headers: Record<string, string> = {
    "user-agent": request.userAgent,
    accept: ACCEPT,
    "accept-encoding": "gzip, deflate, br",
  };
  if (request.validators?.etag != null) headers["if-none-match"] = request.validators.etag;
  if (request.validators?.lastModified != null) {
    headers["if-modified-since"] = request.validators.lastModified;
  }
  const failure = (hop: string, error: unknown): WebFetchError => {
    if (request.signal?.aborted === true)
      return new WebFetchError("cancelled", "WebFetch: cancelled");
    if (deadline.aborted) {
      return new WebFetchError(
        "fetch",
        `WebFetch: timed out after ${timeoutMs / 1000} s fetching ${request.url}`,
      );
    }
    if (error instanceof WebFetchError) return error;
    return new WebFetchError("fetch", `WebFetch: fetching ${hop} failed: ${errorMessage(error)}`);
  };
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  // Each race below consumes the rejection; this only keeps it from counting as unhandled.
  aborted.catch(() => {});

  let url = new URL(request.url);
  for (let redirects = 0; ; redirects += 1) {
    const hop = url.href;
    let response: IncomingMessage;
    try {
      const address = await Promise.race([guardedAddress(url, request), aborted]);
      response = await send(url, address, headers, signal);
    } catch (error) {
      throw failure(hop, error);
    }
    const status = response.statusCode ?? 0;
    if (REDIRECTS.has(status)) {
      response.resume();
      if (redirects >= MAX_REDIRECTS) {
        throw new WebFetchError(
          "fetch",
          `WebFetch: more than ${MAX_REDIRECTS} redirects from ${request.url}`,
        );
      }
      const location = header(response.headers, "location");
      let target: URL;
      try {
        if (location === null) throw new Error("no Location");
        target = new URL(location, hop);
      } catch {
        throw new WebFetchError("fetch", `WebFetch: redirect from ${hop} has no valid Location`);
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new WebFetchError(
          "fetch",
          `WebFetch: redirect to ${target.href} refused: only http and https`,
        );
      }
      url = target;
      continue;
    }
    const hasValidator =
      headers["if-none-match"] !== undefined || headers["if-modified-since"] !== undefined;
    const ok = (status >= 200 && status <= 299) || (status === 304 && hasValidator);
    if (!ok) {
      response.resume();
      throw new WebFetchError("fetch", `WebFetch: HTTP ${status} from ${hop}`);
    }
    let body: Buffer;
    try {
      body =
        status === 304
          ? Buffer.alloc(0)
          : await readBody(
              response,
              request.maxBytes ??
                (isTextMediaType(mediaType(header(response.headers, "content-type")) ?? "")
                  ? MAX_BODY_BYTES
                  : MAX_STORED_BYTES),
              hop,
            );
    } catch (error) {
      throw failure(hop, error);
    }
    if (status === 304) response.resume();
    return {
      status,
      finalUrl: hop,
      contentType: header(response.headers, "content-type"),
      etag: header(response.headers, "etag"),
      lastModified: header(response.headers, "last-modified"),
      body,
    };
  }
}
