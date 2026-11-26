/** Inline styles that hide an element (specs/web-fetch.md, Section 6.2.1). */

interface CssNumber {
  readonly value: number;
  /** Lowercase unit; empty for a bare number. */
  readonly unit: string;
}

const NUMBER = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/;

function cssNumber(text: string): CssNumber | undefined {
  const match = NUMBER.exec(text.trim());
  if (match?.[1] === undefined) return undefined;
  return { value: Number(match[1]), unit: match[2] ?? "" };
}

/** The declarations of a `style` value; a later declaration of a property replaces an earlier. */
export function parseStyle(style: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration
      .slice(colon + 1)
      .trim()
      .toLowerCase()
      .replace(/\s*!important$/, "")
      .replace(/\s+/g, " ");
    if (property !== "") out.set(property, value);
  }
  return out;
}

/** The arguments of the first `name(` function in a value, split on commas, slashes and spaces. */
function functionArgs(value: string, names: readonly string[]): string[][] {
  const out: string[][] = [];
  const pattern = /([a-z0-9-]+)\(([^)]*)\)/g;
  for (const match of value.matchAll(pattern)) {
    if (match[1] !== undefined && names.includes(match[1])) {
      out.push((match[2] ?? "").split(/[\s,/]+/).filter((arg) => arg !== ""));
    }
  }
  return out;
}

const isZero = (text: string | undefined): boolean =>
  text !== undefined && cssNumber(text)?.value === 0;

function hidesOpacity(value: string): boolean {
  const n = cssNumber(value);
  if (n === undefined) return false;
  if (n.unit === "%") return n.value < 10;
  return n.unit === "" && n.value < 0.1;
}

function hidesFontSize(value: string): boolean {
  const n = cssNumber(value);
  if (n === undefined) return false;
  if (n.value === 0) return true;
  if (n.unit === "px" || n.unit === "pt") return n.value < 1;
  if (["em", "rem", "ex", "ch"].includes(n.unit)) return n.value < 0.1;
  return n.unit === "%" && n.value < 10;
}

function hidesOffset(value: string): boolean {
  const n = cssNumber(value);
  if (n === undefined) return false;
  if (n.unit === "%") return n.value <= -100;
  return n.value <= -999;
}

function alphaIsZero(text: string | undefined): boolean {
  if (text === undefined) return false;
  const n = cssNumber(text);
  return n !== undefined && n.value === 0 && (n.unit === "" || n.unit === "%");
}

function hidesColor(value: string): boolean {
  if (value === "transparent") return true;
  const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/.exec(value)?.[1];
  if (hex !== undefined) return hex.length === 4 ? hex.endsWith("0") : hex.endsWith("00");
  return functionArgs(value, ["rgba", "hsla", "rgb", "hsl"]).some((args) => alphaIsZero(args[3]));
}

function hidesClip(value: string): boolean {
  return functionArgs(value, ["rect"]).some(
    (args) =>
      args.length === 4 &&
      args.every((arg) => {
        const n = cssNumber(arg);
        return n !== undefined && n.value <= 1;
      }),
  );
}

function hidesClipPath(value: string): boolean {
  const inset = functionArgs(value, ["inset"]).some((args) =>
    args.some((arg) => {
      const n = cssNumber(arg);
      return n !== undefined && n.unit === "%" && n.value >= 50;
    }),
  );
  return inset || functionArgs(value, ["circle", "ellipse"]).some((args) => isZero(args[0]));
}

function hidesTransform(value: string): boolean {
  return functionArgs(value, ["scale", "scalex", "scaley", "scale3d"]).some(
    (args) => isZero(args[0]) || isZero(args[1]),
  );
}

const SIZE_PROPERTIES = ["width", "height", "max-width", "max-height"];
const OFFSET_PROPERTIES = ["left", "top", "right", "bottom", "margin-left", "margin-top"];
const OVERFLOW_PROPERTIES = ["overflow", "overflow-x", "overflow-y"];

/** Whether a `style` value hides its element per the table of Section 6.2.1. */
export function styleHides(style: string): boolean {
  const d = parseStyle(style);
  const get = (property: string): string => d.get(property) ?? "";
  if (get("display") === "none") return true;
  if (["hidden", "collapse"].includes(get("visibility"))) return true;
  if (get("content-visibility") === "hidden") return true;
  if (hidesOpacity(get("opacity"))) return true;
  if (hidesFontSize(get("font-size"))) return true;
  const clipped = OVERFLOW_PROPERTIES.some((p) => ["hidden", "clip"].includes(get(p)));
  if (clipped && SIZE_PROPERTIES.some((p) => isZero(d.get(p)))) return true;
  if (hidesClip(get("clip"))) return true;
  if (hidesClipPath(get("clip-path"))) return true;
  if (hidesTransform(get("transform"))) return true;
  if (isZero(get("scale").split(" ")[0])) return true;
  const indent = cssNumber(get("text-indent"));
  if (indent !== undefined && indent.value < 0) return true;
  if (OFFSET_PROPERTIES.some((p) => hidesOffset(get(p)))) return true;
  return hidesColor(get("color"));
}
