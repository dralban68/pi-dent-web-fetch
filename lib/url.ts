/** URL validation and the canonical URL (specs/web-fetch.md, Sections 3.1 and 3.2). */

import { WebFetchError } from "./errors.ts";

/** The parsed `url` parameter, or an input error (Section 3.1). */
export function validateUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebFetchError("input", `WebFetch: not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchError(
      "input",
      `WebFetch: only http and https URLs are fetched, not ${url.protocol}`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new WebFetchError("input", "WebFetch: URLs with credentials are refused");
  }
  return url;
}

function isTracking(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || lower === "fbclid" || lower === "gclid";
}

function compareUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The canonical URL of Section 3.2. */
export function canonicalUrl(url: URL): string {
  const out = new URL(url.href);
  out.hash = "";
  const params = [...out.searchParams]
    .filter(([name]) => !isTracking(name))
    .toSorted((a, b) => compareUnits(a[0], b[0]) || compareUnits(a[1], b[1]));
  out.search = "";
  for (const [name, value] of params) out.searchParams.append(name, value);
  return out.href;
}
