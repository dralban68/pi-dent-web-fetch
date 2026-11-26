/**
 * pi-dent-web - see specs/web-fetch.md.
 *
 * Wiring only. The `WebFetch` tool is registered once it is implemented; until then the
 * extension registers nothing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piDentWeb(_pi: ExtensionAPI): void {}
