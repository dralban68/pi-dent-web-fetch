/**
 * The configuration of pi-dent-web (specs/web-fetch.md, Section 8): the root key `web` of
 * pi-dent's layered `pi-dent.conf`, read as pi-dent-agent `specs/config-file.md`, Sections 1, 2,
 * 3 and 7 specify, plus the merged `modelClasses` value for Section 7.1. A layer whose read or
 * parse fails is dropped without a diagnostic from this extension: pi-dent reports it.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseTree, type Node, type ParseError } from "jsonc-parser";

const ROOT_KEY = "web";
const WEB_KEYS: readonly string[] = ["cache", "reformat", "reformatModel"];

export type Environment = Readonly<Record<string, string | undefined>>;

export interface ConfigLayer {
  readonly path: string;
  readonly root: Readonly<Record<string, unknown>>;
}

export interface WebConfig {
  readonly reformat?: boolean;
  readonly reformatModel?: string;
  /** `web.cache`, trimmed, with the file of the layer that set it (Section 4.1). */
  readonly cache?: { readonly value: string; readonly file: string };
  readonly modelClasses?: Readonly<Record<string, unknown>>;
  /** Each is reported as `pi-dent-web: <message>`. */
  readonly diagnostics: readonly string[];
}

export interface ConfigDependencies {
  readonly cwd: string;
  readonly homeDir?: string;
  readonly env?: Environment;
  /** The file's text, or `undefined` when it is missing or cannot be read. */
  readonly readFile?: (path: string) => string | undefined;
}

export function layerPaths(cwd: string, homeDir: string): { global: string; project: string } {
  return {
    global: join(homeDir, ".pi", "pi-dent", "pi-dent.conf"),
    project: join(cwd, ".pi", "pi-dent", "pi-dent.conf"),
  };
}

const ABSENT = Symbol("absent");
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sets `key` as an own data property, so that `__proto__` stays a key. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function expansion(token: string, cwd: string, env: Environment): string | undefined {
  if (token === "project.root") return cwd;
  if (!token.startsWith("env.")) return undefined;
  const name = token.slice("env.".length);
  return ENV_NAME.test(name) ? env[name] : undefined;
}

/** config-file.md, Section 7: placeholders expanded, or `ABSENT` when one is invalid. */
function substituteString(value: string, cwd: string, env: Environment): string | typeof ABSENT {
  let out = "";
  let index = 0;
  while (index < value.length) {
    if (value.startsWith("$$", index)) {
      out += "$";
      index += 2;
    } else if (value.startsWith("${", index)) {
      const end = value.indexOf("}", index + 2);
      if (end === -1) return ABSENT;
      const replacement = expansion(value.slice(index + 2, end), cwd, env);
      if (replacement === undefined) return ABSENT;
      out += replacement;
      index = end + 1;
    } else {
      out += value.charAt(index);
      index += 1;
    }
  }
  return out;
}

function substitute(value: unknown, cwd: string, env: Environment): unknown {
  if (typeof value === "string") return substituteString(value, cwd, env);
  if (Array.isArray(value)) {
    return value.map((v) => substitute(v, cwd, env)).filter((v) => v !== ABSENT);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const replaced = substitute(child, cwd, env);
      if (replaced !== ABSENT) setOwn(out, key, replaced);
    }
    return out;
  }
  return value;
}

function nodeValue(node: Node): unknown {
  if (node.type === "object") {
    const out: Record<string, unknown> = {};
    for (const property of node.children ?? []) {
      const [keyNode, valueNode] = property.children ?? [];
      if (keyNode === undefined || valueNode === undefined) continue;
      setOwn(out, String(keyNode.value), nodeValue(valueNode));
    }
    return out;
  }
  if (node.type === "array") return (node.children ?? []).map((child) => nodeValue(child));
  return node.value;
}

/** A layer of a file's text, or `undefined` when config-file.md, Section 2 drops it. */
export function parseLayer(
  path: string,
  text: string,
  cwd: string,
  env: Environment = {},
): ConfigLayer | undefined {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || tree === undefined || tree.type !== "object") return undefined;
  const substituted = substitute(nodeValue(tree), cwd, env);
  return isRecord(substituted) ? { path, root: substituted } : undefined;
}

function declares(root: Readonly<Record<string, unknown>>, path: readonly string[]): boolean {
  let node: unknown = root;
  for (const key of path) {
    if (!isRecord(node) || !Object.hasOwn(node, key)) return false;
    node = node[key];
  }
  return true;
}

function mergeValues(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) setOwn(out, key, value);
  for (const [key, value] of Object.entries(override)) {
    setOwn(out, key, Object.hasOwn(base, key) ? mergeValues(base[key], value) : value);
  }
  return out;
}

/** The configuration from the parsed layers (config-file.md, Sections 3 and 4). */
export function resolveConfig(layers: {
  readonly global?: ConfigLayer | undefined;
  readonly project?: ConfigLayer | undefined;
}): WebConfig {
  const ordered = [layers.global, layers.project].filter(
    (layer): layer is ConfigLayer => layer !== undefined,
  );
  const ownerOf = (path: readonly string[]): string =>
    [...ordered].toReversed().find((layer) => declares(layer.root, path))?.path ?? "";
  const merged = (key: string): unknown => {
    let value: unknown;
    for (const layer of ordered) {
      if (declares(layer.root, [key])) value = mergeValues(value, layer.root[key]);
    }
    return value;
  };

  const classes = merged("modelClasses");
  const modelClasses = isRecord(classes) ? { modelClasses: classes } : {};
  const web = merged(ROOT_KEY);
  if (web === undefined) return { ...modelClasses, diagnostics: [] };
  if (!isRecord(web)) {
    return { ...modelClasses, diagnostics: [`${ownerOf([ROOT_KEY])}: web must be an object`] };
  }

  const diagnostics: string[] = [];
  let reformat: { reformat?: boolean } = {};
  if (Object.hasOwn(web, "reformat")) {
    if (typeof web.reformat === "boolean") reformat = { reformat: web.reformat };
    else diagnostics.push(`${ownerOf([ROOT_KEY, "reformat"])}: web.reformat must be true or false`);
  }
  let model: { reformatModel?: string } = {};
  if (Object.hasOwn(web, "reformatModel")) {
    const value = web.reformatModel;
    if (typeof value === "string" && value.trim() !== "") model = { reformatModel: value.trim() };
    else {
      diagnostics.push(
        `${ownerOf([ROOT_KEY, "reformatModel"])}: web.reformatModel must be a non-empty string`,
      );
    }
  }
  let cache: { cache?: { value: string; file: string } } = {};
  if (Object.hasOwn(web, "cache")) {
    const value = web.cache;
    const file = ownerOf([ROOT_KEY, "cache"]);
    if (typeof value === "string" && value.trim() !== "") {
      cache = { cache: { value: value.trim(), file } };
    } else diagnostics.push(`${file}: web.cache must be a non-empty string`);
  }
  const unknown = Object.keys(web)
    .filter((key) => !WEB_KEYS.includes(key))
    .toSorted();
  if (unknown.length > 0) {
    diagnostics.push(`${ownerOf([ROOT_KEY])}: web has unknown keys ${unknown.join(", ")}`);
  }
  return { ...reformat, ...model, ...cache, ...modelClasses, diagnostics };
}

/** Both layers read, parsed and resolved; called once per extension instance (Section 8). */
export function loadWebConfig(dependencies: ConfigDependencies): WebConfig {
  const homeDir = dependencies.homeDir ?? homedir();
  const env = dependencies.env ?? process.env;
  const readFile = dependencies.readFile ?? readText;
  const paths = layerPaths(dependencies.cwd, homeDir);
  const layerOf = (path: string): ConfigLayer | undefined => {
    const text = readFile(path);
    return text === undefined ? undefined : parseLayer(path, text, dependencies.cwd, env);
  };
  return resolveConfig({ global: layerOf(paths.global), project: layerOf(paths.project) });
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // Section 8: a layer that cannot be read is dropped; pi-dent reports it.
    return undefined;
  }
}
