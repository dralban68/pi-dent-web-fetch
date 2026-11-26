/** Hiding methods shared by the page and the Markdown-body tests (specs/web-fetch.md, Section 10). */

export const VOID = new Set([
  "frame",
  "input",
  "source",
  "track",
  "link",
  "meta",
  "base",
  "param",
  "area",
  "embed",
]);

export const ATTRIBUTE_CASES: readonly [string, string][] = [
  ["hidden", '<span hidden="until-found">INJECTION-hidden</span>'],
  ["inert", "<span inert>INJECTION-inert</span>"],
  ["popover", "<span popover>INJECTION-popover</span>"],
  ["aria-hidden", '<span aria-hidden=" TRUE ">INJECTION-aria-hidden</span>'],
];

export const STYLE_CASES: readonly [string, string][] = [
  ["display", "display: none !important"],
  ["visibility-hidden", "visibility:hidden"],
  ["visibility-collapse", "VISIBILITY: Collapse"],
  ["content-visibility", "content-visibility: hidden"],
  ["opacity", "opacity: 0.05"],
  ["opacity-percent", "opacity: 5%"],
  ["font-size-zero", "font-size: 0"],
  ["font-size-px", "font-size: 0.5px"],
  ["font-size-em", "font-size: 0.05em"],
  ["font-size-percent", "font-size: 5%"],
  ["width", "width: 0; overflow: hidden"],
  ["height", "height:0px;overflow-y:clip"],
  ["max-height", "max-height: 0; overflow-x: hidden"],
  ["clip", "position:absolute; clip: rect(0 0 0 0)"],
  ["clip-path-inset", "clip-path: inset(50%)"],
  ["clip-path-circle", "clip-path: circle(0)"],
  ["transform", "transform: translateX(1px) scale(0)"],
  ["transform-scaley", "transform: scaleY(0)"],
  ["scale", "scale: 0"],
  ["text-indent", "text-indent: -9999px"],
  ["left", "position: absolute; left: -10000px"],
  ["top-percent", "position: absolute; top: -100%"],
  ["margin-left", "margin-left: -999em"],
  ["color-transparent", "color: transparent"],
  ["color-rgba", "color: rgba(0, 0, 0, 0)"],
  ["color-hsl", "color: hsl(0 0% 0% / 0%)"],
  ["color-hex", "color: #ffffff00"],
  ["color-hex4", "color: #fff0"],
  ["later-declaration", "display: block; display: none"],
];
