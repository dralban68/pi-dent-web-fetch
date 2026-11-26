/**
 * The tool's errors. `kind` decides whether a stale copy may stand in
 * (specs/web-fetch.md#stale-copy): only a `fetch` failure is served stale; `input` and `cancelled` never are.
 */

export type ErrorKind = "input" | "fetch" | "cancelled";

export class WebFetchError extends Error {
  readonly kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = "WebFetchError";
    this.kind = kind;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
