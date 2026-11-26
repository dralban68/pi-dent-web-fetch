/** Text cleaning (specs/web-fetch.md#text-cleaning). */

/** Cc except tab and line feed, all of Cf, and the variation selectors. */
const INVISIBLE = /(?![\t\n])[\p{Cc}\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
/** A run of White_Space other than tab, line feed and space. */
const OTHER_SPACE = /(?:(?![\t\n ])\p{White_Space})+/gu;

/** Removes invisible characters and maps other white space to one space; keeps space runs. */
export function cleanText(text: string): string {
  return text.replace(INVISIBLE, "").replace(OTHER_SPACE, " ");
}

/** Collapses each run of tab, line feed and space to one space, as rendering does outside `pre`. */
export function collapseSpace(text: string): string {
  return text.replace(/[\t\n ]+/g, " ");
}

/** Cleaned, collapsed and trimmed: the form of a title or an `alt` value. */
export function cleanLine(text: string): string {
  return collapseSpace(cleanText(text)).trim();
}
