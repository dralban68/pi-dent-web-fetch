/** The cache (specs/web-fetch.md#cache-location, specs/web-fetch.md#entry-layout, specs/web-fetch.md#writing): location, entry layout, writing. */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { WebFetchError, errorMessage } from "./errors.ts";
import { relativeUnder, type CacheLocation } from "./location.ts";

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
  /** The stored file's name (`file.<ext>`, 5.8), null when the entry stores no file. */
  readonly fileName?: string | null;
  /** The stored file's size in bytes, null when the entry stores no file. */
  readonly fileBytes?: number | null;
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
  /** `content.md` relative to cwd, with `/` separators, when it is under cwd (specs/web-fetch.md#cache-location). */
  readonly relativeContent: string | undefined;
  /** The display paths of specs/web-fetch.md#cache-location. */
  readonly displayContent: string;
  readonly displayExtracted: string;
}

/** The path of a stored file inside the entry (specs/web-fetch.md#stored-files). */
export function filePath(dir: string, name: string): string {
  return join(dir, name);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** `<host>` of specs/web-fetch.md#entry-layout. */
export function hostDirectory(url: URL): string {
  const host = url.hostname.replace(/[[\]]/g, "").replace(/:/g, "_");
  return url.port === "" ? host : `${host}_${url.port}`;
}

/** `<slug>` of specs/web-fetch.md#entry-layout. */
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

export function entryPaths(cwd: string, cacheDir: string, canonical: string): EntryPaths {
  const dir = join(cacheDir, entryDirectory(canonical));
  const content = join(dir, "content.md");
  const extracted = join(dir, "extracted.md");
  const relativeContent = relativeUnder(cwd, content);
  return {
    dir,
    content,
    extracted,
    meta: join(dir, "meta.json"),
    relativeContent,
    displayContent: relativeContent ?? content,
    displayExtracted: relativeUnder(cwd, extracted) ?? extracted,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isNullableNumber = (value: unknown): value is number | null =>
  value === null || typeof value === "number";

const STORED_NAME = /^file\.[a-z0-9]{1,8}$/;

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
    // Entries written by an older version may lack both fields; they store no file.
    (value.fileName === undefined ||
      (isNullableString(value.fileName) &&
        (value.fileName === null || STORED_NAME.test(value.fileName)))) &&
    (value.fileBytes === undefined || isNullableNumber(value.fileBytes)) &&
    ((value.fileName ?? null) === null) === ((value.fileBytes ?? null) === null) &&
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
 * file is missing or `meta.json` is not valid (specs/web-fetch.md#entry-layout). A stored file (5.8) counts: an entry
 * whose `meta.json` names one requires it to exist.
 */
export async function readEntry(paths: EntryPaths): Promise<Entry | "absent" | "unreadable"> {
  let metaText: string | undefined;
  let extractedText: string | undefined;
  let contentText: string | undefined;
  try {
    [metaText, extractedText, contentText] = await Promise.all(
      [paths.meta, paths.extracted, paths.content].map(readOptional),
    );
  } catch {
    // A read error other than a missing file counts as an unreadable entry, which is reported.
    return "unreadable";
  }
  if (metaText === undefined && extractedText === undefined && contentText === undefined) {
    return "absent";
  }
  if (metaText === undefined || extractedText === undefined || contentText === undefined) {
    return "unreadable";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(metaText);
  } catch {
    return "unreadable";
  }
  if (!isMeta(parsed)) return "unreadable";
  const meta = normalizeMeta(parsed);
  const name: string | null = meta.fileName ?? null;
  if (name !== null && !(await isFile(filePath(paths.dir, name)))) return "unreadable";
  return { meta, extracted: extractedText, content: contentText };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Fills the fields an older entry may lack (specs/web-fetch.md#entry-layout). */
function normalizeMeta(meta: Meta): Meta {
  return meta.fileName === undefined ? { ...meta, fileName: null, fileBytes: null } : meta;
}

/**
 * Creates the cache directory when absent, and its `.gitignore` when absent for an owned location,
 * or when this call created a folder-path location (specs/web-fetch.md#cache-location).
 */
export async function ensureCacheDirectory(location: CacheLocation): Promise<void> {
  const created = await mkdir(location.dir, { recursive: true });
  if (!location.owned && created === undefined) return;
  try {
    await writeFile(join(location.dir, ".gitignore"), "*\n", { flag: "wx" });
  } catch (error) {
    if (!(isRecord(error) && error.code === "EEXIST")) throw error;
  }
}

/**
 * Writes the given files of an entry in order, each through a temporary file and a rename,
 * skipping a file whose content is unchanged (specs/web-fetch.md#writing). A `Buffer` is written as bytes, a
 * string as UTF-8 text.
 */
export async function writeEntry(
  location: CacheLocation,
  paths: EntryPaths,
  files: readonly (readonly [path: string, content: string | Buffer])[],
): Promise<void> {
  const temporary: string[] = [];
  try {
    await ensureCacheDirectory(location);
    await mkdir(paths.dir, { recursive: true });
    for (const [path, content] of files) {
      const unchanged =
        typeof content === "string"
          ? (await readOptional(path)) === content
          : (await readOptionalBytes(path))?.equals(content) === true;
      if (unchanged) continue;
      const temp = join(paths.dir, `.${randomBytes(6).toString("hex")}.tmp`);
      temporary.push(temp);
      await writeFile(temp, content);
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

async function readOptionalBytes(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function serializeMeta(meta: Meta): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}
