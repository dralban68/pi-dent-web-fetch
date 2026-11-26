/** specs/web-fetch.md#cache-location, specs/web-fetch.md#configuration, specs/web-fetch.md#result-text: the cache location, its sources and the path lines. */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { test, type TestContext } from "node:test";

import { layerPaths, loadWebConfig, type WebConfig } from "../lib/config.ts";
import { chooseLocation, relativeUnder } from "../lib/location.ts";
import { createWebFetchTool } from "../lib/tool.ts";
import { call, resultText, startServer, tempDir, text, type CallOptions } from "./helpers.ts";

interface Dirs {
  readonly cwd: string;
  readonly home: string;
  readonly tmp: string;
  readonly base: string;
}

/** A cwd, home and temporary folder of their own, all under one test folder. */
async function dirs(t: TestContext): Promise<Dirs> {
  const base = await tempDir(t);
  const cwd = join(base, "work");
  const home = join(base, "home");
  const tmp = join(base, "tmp");
  await Promise.all([cwd, home, tmp].map((dir) => mkdir(dir)));
  return { base, cwd, home, tmp };
}

async function serve(t: TestContext): Promise<string> {
  const server = await startServer(t);
  server.route("/page", text(`# Page\n\n${"x".repeat(4100)}\n`));
  return `${server.origin}/page`;
}

function options(d: Dirs, extra: CallOptions = {}): CallOptions {
  return { homeDir: d.home, tmpDir: d.tmp, ...extra };
}

function setting(value: string, file = "/conf/pi-dent.conf"): WebConfig {
  return { cache: { value, file }, diagnostics: [] };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

test("4.1 project is the default and caches under <cwd>/.pi/web-cache", async (t) => {
  const d = await dirs(t);
  const url = await serve(t);
  for (const cache of [undefined, "project", "  project  "]) {
    const result = await call(d.cwd, { url, cache }, options(d));
    assert.equal(result.details.cacheDir, join(d.cwd, ".pi", "web-cache"));
    assert.ok(result.details.path.startsWith(".pi/web-cache/"));
  }
  assert.equal(await readFile(join(d.cwd, ".pi", "web-cache", ".gitignore"), "utf8"), "*\n");
});

test("4.1 a relative folder path resolves against cwd, with a .gitignore and cwd-relative paths", async (t) => {
  const d = await dirs(t);
  const url = await serve(t);
  const result = await call(d.cwd, { url, cache: ".cache" }, options(d));
  const { details } = result;
  assert.equal(details.cacheDir, join(d.cwd, ".cache"));
  assert.match(details.path, /^\.cache\/127\.0\.0\.1_\d+\/page-[0-9a-f]{8}\/content\.md$/);
  assert.equal(details.absolutePath, join(d.cwd, details.path));
  assert.equal(await readFile(join(d.cwd, ".cache", ".gitignore"), "utf8"), "*\n");
  const lines = resultText(result).split("\n");
  assert.equal(lines[1], `Path: ${details.path}`);
  assert.equal(lines[2], `Absolute path: ${details.absolutePath}`);
  assert.equal(details.extractedPath, details.path, "no reformat: content.md is the extraction");
  assert.ok(!lines.some((line) => line.startsWith("Extracted: ")));
  assert.match(lines.at(-1) ?? "", new RegExp(`read the rest from ${details.path}\\]$`));
  assert.equal(await exists(join(d.cwd, ".pi")), false);
});

test("9.1 a cache outside cwd shows absolute paths and no Path line", async (t) => {
  const d = await dirs(t);
  const url = await serve(t);
  const folder = join(d.base, "elsewhere", "cache");
  const result = await call(d.cwd, { url, cache: folder }, options(d));
  const { details } = result;
  assert.equal(details.cacheDir, folder);
  assert.ok(details.absolutePath.startsWith(`${folder}/`));
  assert.equal(details.path, details.absolutePath);
  assert.equal(details.extractedPath, details.absolutePath);
  const lines = resultText(result).split("\n");
  assert.equal(lines[0], "WebFetch: fetched");
  assert.equal(lines[1], `Absolute path: ${details.absolutePath}`);
  assert.ok(!lines.some((line) => line.startsWith("Path: ")));
  assert.match(lines.at(-1) ?? "", new RegExp(`read the rest from ${details.absolutePath}\\]$`));
  assert.equal(await readFile(join(folder, ".gitignore"), "utf8"), "*\n");
});

test("4.1 a leading ~/ expands to the home folder", async (t) => {
  const d = await dirs(t);
  const url = await serve(t);
  const result = await call(d.cwd, { url, cache: "~/web cache" }, options(d));
  assert.equal(result.details.cacheDir, join(d.home, "web cache"));
  assert.equal(await readFile(join(d.home, "web cache", ".gitignore"), "utf8"), "*\n");
});

test("4.1 session uses <PI_DENT_SESSION_DIR>/tmp/web-cache when it is set", async (t) => {
  const d = await dirs(t);
  const url = await serve(t);
  const sessionDir = join(d.base, "agent-session");
  const result = await call(
    d.cwd,
    { url, cache: "session" },
    options(d, { env: { PI_DENT_SESSION_DIR: sessionDir } }),
  );
  const dir = join(sessionDir, "tmp", "web-cache");
  assert.equal(result.details.cacheDir, dir);
  assert.deepEqual(result.details.notices, []);
  assert.equal(await readFile(join(dir, ".gitignore"), "utf8"), "*\n");
});

test("4.1 session falls back to <tmpDir>/pi-dent-web-fetch/<session id>, with a notice", async (t) => {
  const d = await dirs(t);
  const url = await serve(t);
  const result = await call(
    d.cwd,
    { url, cache: "session" },
    options(d, { env: { PI_DENT_SESSION_DIR: "  " }, sessionId: "019a/b c" }),
  );
  const dir = join(d.tmp, "pi-dent-web-fetch", "019a_b_c");
  assert.equal(result.details.cacheDir, dir);
  const notice = `PI_DENT_SESSION_DIR is not set; the session cache is ${dir}.`;
  assert.deepEqual(result.details.notices, [notice]);
  assert.ok(resultText(result).split("\n").includes(notice));
  assert.equal(await readFile(join(dir, ".gitignore"), "utf8"), "*\n");
  const empty = await call(d.cwd, { url, cache: "session" }, options(d, { sessionId: "" }));
  assert.equal(empty.details.cacheDir, join(d.tmp, "pi-dent-web-fetch", "unknown"));
});

test("4.1 a refused or empty cache parameter is a tool error, and nothing is written", async (t) => {
  const d = await dirs(t);
  const url = await serve(t);
  const root = parse(d.cwd).root;
  const tail = '; give "project", "session" or a folder of its own';
  const cases: [string, string][] = [
    ["", "is empty"],
    ["   ", "is empty"],
    [".", `"." resolves to the working folder (${d.cwd})`],
    [d.cwd, `${JSON.stringify(d.cwd)} resolves to the working folder (${d.cwd})`],
    ["../work/", `"../work/" resolves to the working folder (${d.cwd})`],
    ["~", `"~" resolves to the home folder (${d.home})`],
    ["~/", `"~/" resolves to the home folder (${d.home})`],
    [d.home, `${JSON.stringify(d.home)} resolves to the home folder (${d.home})`],
    [root, `${JSON.stringify(root)} resolves to the filesystem root (${root})`],
    ["/..", `"/.." resolves to the filesystem root (${root})`],
    ["a\0b", '"a\\u0000b" is not a folder path'],
  ];
  for (const [cache, problem] of cases) {
    await assert.rejects(call(d.cwd, { url, cache }, options(d)), {
      message: `WebFetch: cache ${problem}${tail}`,
    });
  }
  assert.deepEqual(await readdir(d.cwd), []);
  assert.deepEqual(await readdir(d.home), []);
});

test("4.1 the URL checks come before the cache parameter", async (t) => {
  const d = await dirs(t);
  await assert.rejects(call(d.cwd, { url: "ftp://x/", cache: "" }, options(d)), /only http/);
});

test("4.1 precedence: parameter, then PI_DENT_WEB_CACHE_DIR, then web.cache, then project", async (t) => {
  const d = await dirs(t);
  const url = await serve(t);
  const env = { PI_DENT_WEB_CACHE_DIR: "from-env" };
  const config = setting("from-setting");
  const dirOf = async (cache: string | undefined, extra: CallOptions) =>
    (await call(d.cwd, { url, cache }, options(d, extra))).details.cacheDir;
  assert.equal(await dirOf("from-param", { env, config }), join(d.cwd, "from-param"));
  assert.equal(await dirOf(undefined, { env, config }), join(d.cwd, "from-env"));
  assert.equal(
    await dirOf(undefined, { env: { PI_DENT_WEB_CACHE_DIR: " " }, config }),
    join(d.cwd, "from-setting"),
  );
  assert.equal(await dirOf(undefined, { config }), join(d.cwd, "from-setting"));
  assert.equal(await dirOf(undefined, {}), join(d.cwd, ".pi", "web-cache"));
  assert.equal(
    await dirOf(undefined, {
      env: { PI_DENT_WEB_CACHE_DIR: "session", PI_DENT_SESSION_DIR: join(d.base, "s") },
    }),
    join(d.base, "s", "tmp", "web-cache"),
  );
  assert.equal(await dirOf(undefined, { config: setting("~/cached") }), join(d.home, "cached"));
});

test("4.1 one location per call: an entry elsewhere is not read", async (t) => {
  const server = await startServer(t);
  const d = await dirs(t);
  server.route("/one", text("# One\n"));
  const url = `${server.origin}/one`;
  await call(d.cwd, { url }, options(d));
  const other = await call(d.cwd, { url, cache: "other" }, options(d));
  assert.equal(other.details.status, "fetched");
  assert.equal(server.requests.length, 2);
  const again = await call(d.cwd, { url }, options(d));
  assert.equal(again.details.status, "cached");
});

test("4.1 a refused variable or setting is skipped with a notice and a warning", async (t) => {
  const d = await dirs(t);
  const url = await serve(t);
  const warnings: string[] = [];
  const env = { PI_DENT_WEB_CACHE_DIR: "~" };
  const both = await call(
    d.cwd,
    { url },
    options(d, { env, config: setting(".", "/conf/a.conf"), warn: (m) => warnings.push(m) }),
  );
  const envProblem = `PI_DENT_WEB_CACHE_DIR "~" resolves to the home folder (${d.home}); it is ignored`;
  const settingProblem = `/conf/a.conf: web.cache "." resolves to the working folder (${d.cwd}); it is ignored`;
  assert.equal(both.details.cacheDir, join(d.cwd, ".pi", "web-cache"));
  assert.deepEqual(warnings, [envProblem, settingProblem]);
  assert.deepEqual(both.details.notices, [`${envProblem}.`, `${settingProblem}.`]);

  const toSetting = await call(d.cwd, { url }, options(d, { env, config: setting("kept") }));
  assert.equal(toSetting.details.cacheDir, join(d.cwd, "kept"));
  assert.deepEqual(toSetting.details.notices, [`${envProblem}.`]);

  const param = await call(d.cwd, { url, cache: "p" }, options(d, { env, config: setting(".") }));
  assert.deepEqual(param.details.notices, []);
});

test("4.1 a refused variable warns through notify once per extension instance, only with a UI", async (t) => {
  const d = await dirs(t);
  const url = await serve(t);
  const tool = createWebFetchTool(() => ({ diagnostics: [] }), {
    allowedAddresses: ["127.0.0.1"],
    env: { PI_DENT_WEB_CACHE_DIR: "/" },
    homeDir: d.home,
    tmpDir: d.tmp,
  });
  const notified: string[] = [];
  const ctx = (hasUI: boolean) =>
    ({
      cwd: d.cwd,
      hasUI,
      modelRegistry: {},
      sessionManager: { getSessionId: () => "s" },
      ui: { notify: (message: string, level: string) => notified.push(`${level}: ${message}`) },
    }) as unknown as Parameters<typeof tool.execute>[4];
  await tool.execute("1", { url }, undefined, undefined, ctx(false));
  await tool.execute("2", { url }, undefined, undefined, ctx(true));
  const result = await tool.execute("3", { url }, undefined, undefined, ctx(true));
  const root = parse(d.cwd).root;
  const message = `PI_DENT_WEB_CACHE_DIR "/" resolves to the filesystem root (${root}); it is ignored`;
  assert.deepEqual(notified, [`warning: pi-dent-web-fetch: ${message}`]);
  assert.deepEqual(result.details.notices, [`${message}.`]);
});

test("4.1 a folder path that exists gets no .gitignore; a created one does, and an existing one is kept", async (t) => {
  const d = await dirs(t);
  const url = await serve(t);
  await mkdir(join(d.cwd, "existing"));
  await call(d.cwd, { url, cache: "existing" }, options(d));
  assert.equal(await exists(join(d.cwd, "existing", ".gitignore")), false);

  await call(d.cwd, { url, cache: "deep/new/cache" }, options(d));
  assert.equal(await readFile(join(d.cwd, "deep", "new", "cache", ".gitignore"), "utf8"), "*\n");
  assert.equal(await exists(join(d.cwd, "deep", ".gitignore")), false);

  const sessionDir = join(d.base, "s");
  await mkdir(join(sessionDir, "tmp", "web-cache"), { recursive: true });
  await writeFile(join(sessionDir, "tmp", "web-cache", ".gitignore"), "mine\n");
  const env = { PI_DENT_SESSION_DIR: sessionDir };
  await call(d.cwd, { url, cache: "session" }, options(d, { env }));
  assert.equal(
    await readFile(join(sessionDir, "tmp", "web-cache", ".gitignore"), "utf8"),
    "mine\n",
  );
});

test("4.1 a session cache that exists without a .gitignore gets one", async (t) => {
  const d = await dirs(t);
  const url = await serve(t);
  const dir = join(d.tmp, "pi-dent-web-fetch", "s");
  await mkdir(dir, { recursive: true });
  await call(d.cwd, { url, cache: "session" }, options(d, { sessionId: "s" }));
  assert.equal(await readFile(join(dir, ".gitignore"), "utf8"), "*\n");
});

test("4.1 relativeUnder: under cwd only", () => {
  assert.equal(relativeUnder("/w", "/w/a/b"), "a/b");
  assert.equal(relativeUnder("/w", "/w"), undefined);
  assert.equal(relativeUnder("/w", "/wx/a"), undefined);
  assert.equal(relativeUnder("/w", "/a"), undefined);
  assert.equal(relativeUnder("/w", "/w/..a/b"), "..a/b");
});

test("4.1 chooseLocation resolves PI_DENT_SESSION_DIR against cwd", () => {
  const chosen = chooseLocation({
    cwd: "/w",
    param: "session",
    setting: undefined,
    env: { PI_DENT_SESSION_DIR: "rel" },
    homeDir: "/h",
    tmpDir: "/t",
    sessionId: "s",
  });
  assert.equal(chosen.dir, join("/w", "rel", "tmp", "web-cache"));
});

test("8 reads web.cache trimmed, with its layer's file; a non-string or empty value is a diagnostic", () => {
  const { global, project } = layerPaths("/work", "/home/u");
  const load = (files: Record<string, string>) =>
    loadWebConfig({ cwd: "/work", homeDir: "/home/u", env: {}, readFile: (path) => files[path] });
  assert.deepEqual(
    load({
      [global]: '{ "web": { "cache": "session" } }',
      [project]: '{ "web": { "cache": " .cache " } }',
    }),
    { cache: { value: ".cache", file: project }, diagnostics: [] },
  );
  assert.deepEqual(load({ [global]: '{ "web": { "cache": " " } }' }).diagnostics, [
    `${global}: web.cache must be a non-empty string`,
  ]);
  assert.deepEqual(load({ [project]: '{ "web": { "cache": 1 } }' }), {
    diagnostics: [`${project}: web.cache must be a non-empty string`],
  });
});
