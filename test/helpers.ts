/** Shared fixtures: a local HTTP server, a temporary cwd, a stub model registry, and the call. */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import type { WebConfig } from "../lib/config.ts";
import type { Registry } from "../lib/reformat.ts";
import { runWebFetch, type WebFetchParams } from "../lib/tool.ts";

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface TestServer {
  readonly origin: string;
  readonly requests: IncomingMessage[];
  route(path: string, handler: Handler): void;
}

/** A loopback server, closed after the test; unknown paths answer 404. */
export async function startServer(t: TestContext): Promise<TestServer> {
  const routes = new Map<string, Handler>();
  const requests: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    requests.push(req);
    const handler = routes.get((req.url ?? "/").split("?")[0] ?? "/");
    if (handler === undefined) {
      res.writeHead(404).end();
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    route(path, handler) {
      routes.set(path, handler);
    },
  };
}

export function html(body: string, head = "<title>Test page</title>"): Handler {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`);
  };
}

export function text(body: string, type = "text/markdown"): Handler {
  return (_req, res) => {
    res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
    res.end(body);
  };
}

export async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-dent-web-fetch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export interface StubModel {
  readonly provider: string;
  readonly id: string;
  readonly maxTokens: number;
  readonly reasoning: boolean;
}

export interface StubReply {
  readonly text?: string;
  readonly stopReason?: string;
  readonly throws?: boolean;
}

/** A model registry whose one completion per call answers by `reply`, recording each prompt. */
export function stubRegistry(
  reply: (prompt: string, index: number) => StubReply,
  models: StubModel[] = [{ provider: "stub", id: "fast", maxTokens: 8000, reasoning: false }],
  auth = true,
) {
  const prompts: string[] = [];
  const registry = {
    getAll: () => models,
    hasConfiguredAuth: () => auth,
    streamSimple(_model: unknown, context: { messages: { content: string }[] }) {
      const prompt = context.messages[0]?.content ?? "";
      const index = prompts.length;
      prompts.push(prompt);
      return {
        async result() {
          const answer = reply(prompt, index);
          if (answer.throws === true) throw new Error("provider down");
          return {
            content: [{ type: "text", text: answer.text ?? "" }],
            stopReason: answer.stopReason ?? "stop",
          };
        },
      };
    },
  };
  return { registry: registry as unknown as Registry, prompts };
}

const noModel = stubRegistry(() => ({ text: "" })).registry;

export interface CallOptions {
  readonly config?: WebConfig;
  readonly registry?: Registry;
  readonly resolve?: (host: string) => Promise<string[]>;
  readonly allowed?: readonly string[];
  readonly signal?: AbortSignal;
  /** specs/web-fetch.md#test-seam: the environment (default empty), home and temporary folders. */
  readonly env?: Record<string, string>;
  readonly homeDir?: string;
  readonly tmpDir?: string;
  readonly sessionId?: string;
  readonly warn?: (message: string) => void;
}

/** Calls the tool's core with the test seam allowing the loopback server. */
export function call(cwd: string, params: WebFetchParams, options: CallOptions = {}) {
  return runWebFetch(
    params,
    {
      cwd,
      modelRegistry: options.registry ?? noModel,
      sessionManager: { getSessionId: () => options.sessionId ?? "test-session" },
      ...(options.warn === undefined ? {} : { warn: options.warn }),
    },
    options.config ?? { diagnostics: [] },
    options.signal,
    {
      allowedAddresses: options.allowed ?? ["127.0.0.1"],
      env: options.env ?? {},
      homeDir: options.homeDir ?? join(cwd, "no-home"),
      tmpDir: options.tmpDir ?? join(cwd, "no-tmp"),
      ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
    },
  );
}

export function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}
