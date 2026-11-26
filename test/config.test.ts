/** specs/web-fetch.md, Sections 7.1 and 8: configuration, model strings, and the wiring. */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import piDentWebFetch from "../index.ts";
import { layerPaths, loadWebConfig } from "../lib/config.ts";
import { resolveModelString } from "../lib/model.ts";
import { reformat } from "../lib/reformat.ts";
import { stubRegistry } from "./helpers.ts";

const { global: GLOBAL, project: PROJECT } = layerPaths("/work", "/home/u");

function load(files: Record<string, string>, env: Record<string, string> = {}) {
  return loadWebConfig({ cwd: "/work", homeDir: "/home/u", env, readFile: (path) => files[path] });
}

test("8 reads web.reformat and web.reformatModel; the project layer wins", () => {
  const config = load(
    {
      [GLOBAL]:
        '{ "web": { "reformat": true, "reformatModel": "a/b" }, "modelClasses": { "fast": "a/b" } }',
      [PROJECT]: '// comment\n{ "web": { "reformatModel": " ${env.MODEL} ", }, }',
    },
    { MODEL: "c/d:low" },
  );
  assert.deepEqual(config, {
    reformat: true,
    reformatModel: "c/d:low",
    modelClasses: { fast: "a/b" },
    diagnostics: [],
  });
});

test("8 reports each invalid value once, naming its layer, and ignores it", () => {
  const config = load({
    [GLOBAL]: '{ "web": { "reformat": "yes", "reformatModel": "  ", "extra": 1, "another": 2 } }',
  });
  assert.equal(config.reformat, undefined);
  assert.equal(config.reformatModel, undefined);
  assert.deepEqual(config.diagnostics, [
    `${GLOBAL}: web.reformat must be true or false`,
    `${GLOBAL}: web.reformatModel must be a non-empty string`,
    `${GLOBAL}: web has unknown keys another, extra`,
  ]);
  assert.deepEqual(load({ [PROJECT]: '{ "web": [] }' }).diagnostics, [
    `${PROJECT}: web must be an object`,
  ]);
});

test("8 a layer that does not parse is dropped without a diagnostic", () => {
  const config = load({ [GLOBAL]: '{ "web": { "reformat": true } }', [PROJECT]: "{ nope" });
  assert.deepEqual(config, { reformat: true, diagnostics: [] });
});

const INVENTORY = [
  { provider: "p", id: "plain", reasoning: false },
  { provider: "p", id: "think", reasoning: true },
  { provider: "gw", id: "org/model:free", reasoning: false },
];

test("7.1 resolves concrete selectors, thinking suffixes and colons in ids", () => {
  assert.deepEqual(resolveModelString("p/plain", INVENTORY, undefined), {
    model: INVENTORY[0],
    thinking: undefined,
  });
  assert.equal(resolveModelString("p/think:high", INVENTORY, undefined).thinking, "high");
  assert.equal(resolveModelString("gw/org/model:free", INVENTORY, undefined).model, INVENTORY[2]);
  assert.throws(
    () => resolveModelString("p/plain:high", INVENTORY, undefined),
    /does not support thinking level "high"/,
  );
  assert.throws(
    () => resolveModelString("p:x/y", INVENTORY, undefined),
    /slash after the first colon/,
  );
});

test("7.1 resolves a class, lets its suffix override the mapping, and falls back on no match", () => {
  const classes = { fast: { provider: "p", id: "think", thinking: "low" }, fallback: "p/plain" };
  assert.deepEqual(resolveModelString("fast", INVENTORY, classes), {
    model: INVENTORY[1],
    thinking: "low",
  });
  assert.equal(resolveModelString("fast:medium", INVENTORY, classes).thinking, "medium");
  assert.equal(resolveModelString("unknown", INVENTORY, classes).model, INVENTORY[0]);
  assert.equal(resolveModelString("p/missing", INVENTORY, classes).model, INVENTORY[0]);
  assert.throws(
    () => resolveModelString("unknown", INVENTORY, { fast: "p/plain" }),
    /modelClasses\.unknown is not configured/,
  );
  assert.throws(
    () => resolveModelString("fast", INVENTORY, { fast: "other" }),
    /class references must not appear/,
  );
});

test("7.4 a completion that passes its time limit is kept as timed out", async () => {
  const stub = stubRegistry(() => ({ text: "never" }));
  const hanging = {
    ...stub.registry,
    streamSimple: () => ({ result: () => new Promise(() => {}) }),
  } as unknown as typeof stub.registry;
  const model = { provider: "stub", id: "fast", maxTokens: 8000, reasoning: false } as never;
  const result = await reformat({
    registry: hanging,
    model,
    thinking: undefined,
    modelString: "stub/fast",
    extracted: "Some text\n",
    extractedSha256: "x",
    timeoutMs: 20,
  });
  assert.deepEqual(result.meta.kept, { "timed out": 1 });
  assert.equal(result.content, "Some text\n");
});

test("7.4 cancelling during a reformat is a cancelled error", async () => {
  const controller = new AbortController();
  const stub = stubRegistry(() => {
    controller.abort();
    return { text: "x" };
  });
  const model = { provider: "stub", id: "fast", maxTokens: 8000, reasoning: false } as never;
  await assert.rejects(
    reformat({
      registry: stub.registry,
      model,
      thinking: undefined,
      modelString: "stub/fast",
      extracted: "Text\n",
      extractedSha256: "x",
      signal: controller.signal,
    }),
    { message: "WebFetch: cancelled" },
  );
});

test("2.1 the extension registers WebFetch, and reports configuration diagnostics once as warnings", async () => {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) =>
      handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "pi-dent-web-fetch-index-"));
  await mkdir(join(dir, ".pi", "pi-dent"), { recursive: true });
  await writeFile(join(dir, ".pi", "pi-dent", "pi-dent.conf"), '{ "web": { "reformat": 1 } }');
  const saved = process.cwd();
  process.chdir(dir);
  try {
    piDentWebFetch(pi);
    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.label]),
      [["WebFetch", "Web Fetch"]],
    );
    const notified: string[] = [];
    const ctx = {
      hasUI: true,
      ui: { notify: (message: string, level: string) => notified.push(`${level}: ${message}`) },
    } as unknown as ExtensionContext;
    handlers.get("session_start")?.({ type: "session_start" }, ctx);
    handlers.get("session_start")?.({ type: "session_start" }, ctx);
    assert.deepEqual(notified, [
      `warning: pi-dent-web-fetch: ${join(process.cwd(), ".pi", "pi-dent", "pi-dent.conf")}: web.reformat must be true or false`,
    ]);
  } finally {
    process.chdir(saved);
    await rm(dir, { recursive: true, force: true });
  }
});
