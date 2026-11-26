/**
 * Resolution of the reformat model string (specs/web-fetch.md, Section 7.1), per pi-dent-agent
 * `specs/model-string.md`, Sections 1 to 4: concrete selectors, class references through
 * `modelClasses`, the `fallback` class and thinking precedence. Self-contained: pi-dent's
 * implementation is the reference, not a dependency.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface InventoryModel {
  readonly provider: string;
  readonly id: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null | undefined>>;
}

export interface Resolved<TModel> {
  readonly model: TModel;
  readonly thinking: ThinkingLevel | undefined;
}

export class ModelStringError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ModelStringError";
    this.code = code;
  }
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const invalid = (message: string) => new ModelStringError("invalid-plan", message);

function checkProvider(provider: string): void {
  if (provider === "" || /[\s/:]/.test(provider)) {
    throw invalid("empty provider, model, or thinking component");
  }
}

function checkId(id: string): void {
  if (id === "" || /\s/.test(id) || id.startsWith("/") || id.endsWith("/") || id.includes("//")) {
    throw invalid("empty provider, model, or thinking component");
  }
  if (id.endsWith(":")) throw invalid("empty provider, model, or thinking component");
  if (isThinkingLevel(id.slice(id.lastIndexOf(":") + 1))) throw invalid("reserved thinking suffix");
}

interface Concrete {
  readonly provider: string;
  readonly id: string;
  readonly thinking: ThinkingLevel | undefined;
}

type Parsed =
  | (Concrete & { readonly kind: "concrete" })
  | {
      readonly kind: "class";
      readonly name: string;
      readonly thinking: ThinkingLevel | undefined;
    };

/** Sections 1 and 2: the grammar, the components and the thinking suffix. */
export function parseModelString(raw: string): Parsed {
  const text = raw.trim();
  if (text === "") throw invalid("model string must be non-empty");
  if (/\s/.test(text)) throw invalid("model string must contain no internal whitespace");
  const slash = text.indexOf("/");
  const colon = text.indexOf(":");
  if (slash !== -1 && colon !== -1 && colon < slash) {
    throw invalid(`slash after the first colon: "${text}"`);
  }
  let selector = text;
  let thinking: ThinkingLevel | undefined;
  const last = text.lastIndexOf(":");
  const tail = last === -1 ? "" : text.slice(last + 1);
  if (isThinkingLevel(tail)) {
    thinking = tail;
    selector = text.slice(0, last);
  }
  const at = selector.indexOf("/");
  if (at === -1) {
    if (selector === "" || selector.includes(":"))
      throw invalid(`invalid class name "${selector}"`);
    return { kind: "class", name: selector, thinking };
  }
  const provider = selector.slice(0, at);
  const id = selector.slice(at + 1);
  checkProvider(provider);
  checkId(id);
  return { kind: "concrete", provider, id, thinking };
}

/** Section 3: a `modelClasses` value as a concrete selector, or `invalid-plan`. */
function mapping(name: string, value: unknown): Concrete {
  if (typeof value === "string") {
    const parsed = parseModelString(value);
    if (parsed.kind !== "concrete") {
      throw invalid(
        `modelClasses.${name}: class references must not appear as configuration values`,
      );
    }
    return parsed;
  }
  if (isRecord(value) && typeof value.provider === "string" && typeof value.id === "string") {
    checkProvider(value.provider);
    checkId(value.id);
    const thinking = value.thinking;
    if (thinking !== undefined && !(typeof thinking === "string" && isThinkingLevel(thinking))) {
      throw invalid(`modelClasses.${name}: invalid thinking level`);
    }
    return { provider: value.provider, id: value.id, thinking };
  }
  throw invalid(
    `modelClasses.${name}: value must be a concrete model string or a { provider, id, thinking? } object`,
  );
}

/** Section 4.4: the levels a model supports. */
function supports(model: InventoryModel, level: ThinkingLevel): boolean {
  if (model.reasoning !== true) return level === "off";
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) return false;
  if (level === "xhigh" || level === "max") return mapped !== undefined;
  return true;
}

class NoMatch extends ModelStringError {}

/** Section 4.1: the one inventory model of a selector, with its thinking checked. */
function match<TModel extends InventoryModel>(
  inventory: readonly TModel[],
  selector: Concrete,
): Resolved<TModel> {
  const key = `${selector.provider}/${selector.id}`;
  const found = inventory.filter((m) => m.provider === selector.provider && m.id === selector.id);
  if (found.length > 1) {
    throw new ModelStringError(
      "ambiguous-model",
      `"${key}" matches ${found.length} inventory models: ${found.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
    );
  }
  const model = found[0];
  if (model === undefined) {
    throw new NoMatch(
      "missing-model",
      `"${key}" does not exactly match the available model inventory`,
    );
  }
  if (selector.thinking !== undefined && !supports(model, selector.thinking)) {
    throw new ModelStringError(
      "unsupported-thinking",
      `model "${key}" does not support thinking level "${selector.thinking}"`,
    );
  }
  return { model, thinking: selector.thinking };
}

function withThinking(selector: Concrete, explicit: ThinkingLevel | undefined): Concrete {
  return explicit === undefined ? selector : { ...selector, thinking: explicit };
}

/** Section 4: a model string to its inventory model and thinking level. */
export function resolveModelString<TModel extends InventoryModel>(
  raw: string,
  inventory: readonly TModel[],
  classes: Readonly<Record<string, unknown>> | undefined,
): Resolved<TModel> {
  const parsed = parseModelString(raw);
  const classOf = (name: string): unknown =>
    classes !== undefined && Object.hasOwn(classes, name) ? classes[name] : undefined;
  const fallback = (error: NoMatch): Resolved<TModel> => {
    const value = classOf("fallback");
    if (value === undefined) throw error;
    return match(inventory, withThinking(mapping("fallback", value), parsed.thinking));
  };
  try {
    if (parsed.kind === "concrete") return match(inventory, parsed);
    const value = classOf(parsed.name);
    if (value === undefined) {
      throw new NoMatch("missing-model-class", `modelClasses.${parsed.name} is not configured`);
    }
    return match(inventory, withThinking(mapping(parsed.name, value), parsed.thinking));
  } catch (error) {
    if (error instanceof NoMatch) return fallback(error);
    throw error;
  }
}
