/**
 * pi-dent-web-fetch - see specs/web-fetch.md.
 *
 * Wiring only: the `WebFetch` tool and its building blocks live in lib/.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadWebConfig, type WebConfig } from "./lib/config.ts";
import { createWebFetchTool } from "./lib/tool.ts";

export default function piDentWebFetch(pi: ExtensionAPI): void {
  // Read once per extension instance, at its first session_start or first call (specs/web-fetch.md#configuration).
  let config: WebConfig | undefined;
  const load = (): WebConfig => {
    config ??= loadWebConfig({ cwd: process.cwd() });
    return config;
  };

  pi.registerTool(createWebFetchTool(load));

  pi.on("session_start", (_event, ctx) => {
    if (config !== undefined) return;
    const loaded = load();
    if (!ctx.hasUI) return;
    for (const message of loaded.diagnostics)
      ctx.ui.notify(`pi-dent-web-fetch: ${message}`, "warning");
  });
}
