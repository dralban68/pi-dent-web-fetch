/** The cache (specs/web-fetch.md, Sections 4.1 to 4.3): location, entry layout, writing. */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { WebFetchError, errorMessage } from "./errors.ts";

export const CACHE_DIR = join(".pi", "web-cache");
export const NOTICE_UNREADABLE = "The cache entry was unreadable and has been replaced.";

export const KEPT_REASONS = [
  "too long",
  "chunk limit",
  "timed out",
  "model error",
  "truncated",
  "empty output",
  "code changed",
  "links changed",
  "text changed",
] as const;
export type KeptReason = (typeof KEPT_REASONS)[number];
export type PartResult = "reformatted" | KeptReason;

export interface ReformatPart {
  readonly result: PartResult;
  readonly length: number;
}

export interface ReformatMeta {
  readonly model: string;
  readonly sourceSha256: string;
  readonly chunks: number;
  readonly reformatted: number;
  readonly kept: Partial<Record<KeptReason, number>>;
  readonly parts: readonly ReformatPart[];
}

export interface Meta {
  readonly url: string;
  readonly canonicalUrl: string;
  readonly finalUrl: string;
  readonly fetchedAt: string;
  readonly status: number;
  readonly contentType: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly title: string | null;
  readonly bytes: number;
  readonly extractedSha256: string;
  readonly reformat: ReformatMeta | null;
}

export interface Entry {
  readonly meta: Meta;
  readonly extracted: string;
  readonly content: string;
}

export interface EntryPaths {
  readonly dir: string;
  readonly content: string;
  readonly extracted: string;
  readonly meta: string;
  /** `content.md` and `extracted.md` relative to cwd, with `/` separators. */
  readonly relativeContent: string;
  readonly relativeExtracted: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** `<host>` of Section 4.2. */
export function hostDirectory(url: URL): string {
  const host = url.hostname.replace(/[[\]]/g, "").replace(/:/g, "_");
  return url.port === "" ? host : `${host}_${url.port}`;
}

/** `<slug>` of Section 4.2. */
export function slug(url: URL): string {
  const text = url.pathname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return text === "" ? "index" : text;
}

/** The entry's directory under the cache directory: `<host>/<slug>-<hash>`. */
export function entryDirectory(canonical: string): string {
  const url = new URL(canonical);
  return join(hostDirectory(url), `${slug(url)}-${sha256(canonical).slice(0, 8)}`);
}

export function entryPaths(cwd: string, canonical: string): EntryPaths {
  const dir = join(cwd, CACHE_DIR, entryDirectory(canonical));
  const toPosix = (path: string) => relative(cwd, path).split(sep).join("/");
  const content = join(dir, "content.md");
  const extracted = join(dir, "extracted.md");
  return {
    dir,
    content,
    extracted,
    meta: join(dir, "meta.json"),
    relativeContent: toPosix(content),
    relativeExtracted: toPosix(extracted),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

function isReason(value: unknown): value is KeptReason {
  return KEPT_REASONS.some((reason) => reason === value);
}

function isPart(value: unknown): value is ReformatPart {
  return (
    isRecord(value) &&
    (value.result === "reformatted" || isReason(value.result)) &&
    isNumber(value.length)
  );
}

function isReformat(value: unknown): value is ReformatMeta {
  if (!isRecord(value)) return false;
  const kept = value.kept;
  return (
    isString(value.model) &&
    isString(value.sourceSha256) &&
    isNumber(value.chunks) &&
    isNumber(value.reformatted) &&
    isRecord(kept) &&
    Object.entries(kept).every(([key, count]) => isReason(key) && isNumber(count)) &&
    Array.isArray(value.parts) &&
    value.parts.every(isPart)
  );
}

export function isMeta(value: unknown): value is Meta {
  return (
    isRecord(value) &&
    isString(value.url) &&
    isString(value.canonicalUrl) &&
    isString(value.finalUrl) &&
    isString(value.fetchedAt) &&
    isNumber(value.status) &&
    isString(value.contentType) &&
    isNullableString(value.etag) &&
    isNullableString(value.lastModified) &&
    isNullableString(value.title) &&
    isNumber(value.bytes) &&
    isString(value.extractedSha256) &&
    (value.reformat === null || isReformat(value.reformat))
  );
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The entry, `"absent"` when its directory holds none of its files, or `"unreadable"` when some
 * file is missing or `meta.json` is not valid (Section 4.2).
 */
export async function readEntry(paths: EntryPaths): Promise<Entry | "absent" | "unreadable"> {
  let texts: (string | undefined)[];
  try {
    texts = await Promise.all([paths.meta, paths.extracted, paths.content].map(readOptional));
  } catch {
    // A read error other than a missing file counts as an unreadable entry, which is reported.
    return "unreadable";
  }
  const [metaText, extracted, content] = texts;
  if (metaText === undefined && extracted === undefined && content === undefined) return "absent";
  if (metaText === undefined || extracted === undefined || content === undefined) {
    return "unreadable";
  }
  let meta: unknown;
  try {
    meta = JSON.parse(metaText);
  } catch {
    // Reported as an unreadable entry.
    return "unreadable";
  }
  return isMeta(meta) ? { meta, extracted, content } : "unreadable";
}

/** Creates the cache directory and its `.gitignore` when absent (Section 4.1). */
export async function ensureCacheDirectory(cwd: string): Promise<void> {
  const dir = join(cwd, CACHE_DIR);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, ".gitignore"), "*\n", { flag: "wx" });
  } catch (error) {
    if (!(isRecord(error) && error.code === "EEXIST")) throw error;
  }
}

/**
 * Writes the given files of an entry in order, each through a temporary file and a rename,
 * skipping a file whose content is unchanged (Section 4.3).
 */
export async function writeEntry(
  cwd: string,
  paths: EntryPaths,
  files: readonly (readonly [path: string, text: string])[],
): Promise<void> {
  const temporary: string[] = [];
  try {
    await ensureCacheDirectory(cwd);
    await mkdir(paths.dir, { recursive: true });
    for (const [path, text] of files) {
      if ((await readOptional(path)) === text) continue;
      const temp = join(paths.dir, `.${randomBytes(6).toString("hex")}.tmp`);
      temporary.push(temp);
      await writeFile(temp, text, "utf8");
      await rename(temp, path);
    }
  } catch (error) {
    await Promise.all(temporary.map((temp) => rm(temp, { force: true })));
    throw new WebFetchError(
      "fetch",
      `WebFetch: cannot write the cache entry ${paths.dir}: ${errorMessage(error)}`,
    );
  }
}

export function serializeMeta(meta: Meta): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}
