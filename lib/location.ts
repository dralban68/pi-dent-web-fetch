/** The cache location (specs/web-fetch.md, Section 4.1): its sources, values and refusals. */

import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import type { Environment } from "./config.ts";
import { WebFetchError } from "./errors.ts";

/** The `project` location, relative to cwd. */
export const CACHE_DIR = join(".pi", "web-cache");
export const ENV_CACHE_DIR = "PI_DENT_WEB_CACHE_DIR";
export const ENV_SESSION_DIR = "PI_DENT_SESSION_DIR";

export interface CacheLocation {
  /** The absolute cache directory. */
  readonly dir: string;
  /** `project` or `session`: `.gitignore` is created whenever absent; else only with the folder. */
  readonly owned: boolean;
}

export interface LocationInput {
  readonly cwd: string;
  /** The `cache` parameter, as given. */
  readonly param: string | undefined;
  /** The `web.cache` setting, with the file that set it. */
  readonly setting: { readonly value: string; readonly file: string } | undefined;
  readonly env: Environment;
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly sessionId: string | undefined;
}

export interface ChosenLocation extends CacheLocation {
  readonly notices: readonly string[];
  /** Each is reported as `pi-dent-web: <message>` when the session has a UI. */
  readonly warnings: readonly string[];
}

type Meaning = CacheLocation & { readonly notice?: string };

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function sessionDirectory(input: LocationInput): Meaning {
  const sessionDir = nonEmpty(input.env[ENV_SESSION_DIR]);
  if (sessionDir !== undefined) {
    return { dir: join(resolve(input.cwd, sessionDir), "tmp", "web-cache"), owned: true };
  }
  const id = (input.sessionId ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = join(input.tmpDir, "pi-dent-web", id === "" ? "unknown" : id);
  return {
    dir,
    owned: true,
    notice: `${ENV_SESSION_DIR} is not set; the session cache is ${dir}.`,
  };
}

/** The meaning of a trimmed, non-empty value, or the problem that refuses it. */
function meaning(value: string, input: LocationInput): Meaning | { readonly problem: string } {
  if (value === "project") return { dir: join(input.cwd, CACHE_DIR), owned: true };
  if (value === "session") return sessionDirectory(input);
  if (value.includes("\0")) return { problem: `${JSON.stringify(value)} is not a folder path` };
  let expanded = value;
  if (value === "~") expanded = input.homeDir;
  else if (value.startsWith("~/")) expanded = join(input.homeDir, value.slice(2));
  const dir = resolve(input.cwd, expanded);
  const kind =
    dir === resolve(input.cwd)
      ? "the working folder"
      : dir === resolve(input.homeDir)
        ? "the home folder"
        : dir === parse(dir).root
          ? "the filesystem root"
          : undefined;
  if (kind !== undefined) {
    return { problem: `${JSON.stringify(value)} resolves to ${kind} (${dir})` };
  }
  return { dir, owned: false };
}

/** Section 4.1: the first source that gives a usable value, in the order of precedence. */
export function chooseLocation(input: LocationInput): ChosenLocation {
  const notices: string[] = [];
  const warnings: string[] = [];
  const done = (chosen: Meaning): ChosenLocation => {
    if (chosen.notice !== undefined) notices.push(chosen.notice);
    return { dir: chosen.dir, owned: chosen.owned, notices, warnings };
  };

  if (input.param !== undefined) {
    const value = input.param.trim();
    const chosen = value === "" ? { problem: "is empty" } : meaning(value, input);
    if ("problem" in chosen) {
      throw new WebFetchError(
        "input",
        `WebFetch: cache ${chosen.problem}; give "project", "session" or a folder of its own`,
      );
    }
    return done(chosen);
  }

  const sources: [source: string, value: string | undefined][] = [
    [ENV_CACHE_DIR, nonEmpty(input.env[ENV_CACHE_DIR])],
    [`${input.setting?.file ?? ""}: web.cache`, nonEmpty(input.setting?.value)],
  ];
  for (const [source, value] of sources) {
    if (value === undefined) continue;
    const chosen = meaning(value, input);
    if (!("problem" in chosen)) return done(chosen);
    const message = `${source} ${chosen.problem}; it is ignored`;
    warnings.push(message);
    notices.push(`${message}.`);
  }
  return done({ dir: join(input.cwd, CACHE_DIR), owned: true });
}

/** Section 4.1: the path relative to cwd with `/` separators when under cwd, else `undefined`. */
export function relativeUnder(cwd: string, path: string): string | undefined {
  const rel = relative(cwd, path);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  return rel.split(sep).join("/");
}
