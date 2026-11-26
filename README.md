# pi-dent-web-fetch

A pi extension whose `WebFetch` tool lets an agent fetch a web page, PDF or file into a cache on
disk and read it from there. pi-dent bundles it; it also runs standalone in pi.

## Why

An agent that pastes whole pages into its context pays for every token, and reads any text a page
hides from humans: hidden elements, invisible PDF text, zero-width characters, all ways to smuggle
in instructions. So `WebFetch` writes the page to disk as Markdown and returns only its path, a
status and a 4000-character preview; the agent reads more from the file when it needs to. A
deterministic sanitizer removes what a reader would not see before anything reaches the model.

Binaries never enter the context: they are stored as files the agent can hand to other tools. The
network guard refuses loopback, private and link-local addresses, redirects included, so a page
cannot steer the agent into the local network.

## How it works

- **Input:** `url` (http or https), and optionally `refresh`, `maxAgeHours` (default 24),
  `reformat` and `cache`.
- **HTML** goes through the sanitizer, then Readability and conversion to Markdown. Markdown and
  plain text keep their text; their embedded HTML is sanitized.
- **JSON, CSV and XML** are kept as cleaned text, their structure intact.
- **Anything else** is saved unchanged as `file.<ext>` in the cache entry; the result gives its
  path, type and size, never its bytes. A **PDF** is saved too, and its text extracted, one
  `## Page n` section per page, without invisible, sub-1 pt or off-page text.
- **Cache:** one folder per URL, `<host>/<slug>-<hash>/`, holding `content.md`, `meta.json`
  and any stored file, plus `extracted.md`, the text before the reformat, when a reformat changed it. A fresh entry is served with no network access; an older one is
  revalidated with its `ETag` or `Last-Modified`; if a refetch fails, the old copy is served as
  `stale`.
- **Reformat (optional):** a second model fixes the Markdown's structure; a chunk is accepted only
  when a check proves its text, code and links unchanged. Setting `web.reformatModel` turns it on
  for every fetch; `"reformat": false` (setting or parameter) turns it off.
- **Limits:** 30 s to fetch, PDF extraction included; 10 MiB for text bodies, 50 MiB for stored
  files; 100 PDF pages.

The exact rules, every limit and the result format are in [web-fetch.md](specs/web-fetch.md).

## Using it

pi-dent bundles it. Standalone:

```sh
pi install npm:pi-dent-web-fetch
```

Settings go under `web` in pi-dent's `pi-dent.conf` ([web-fetch.md, configuration](specs/web-fetch.md#configuration)); the
cache location also comes from the `cache` parameter or `PI_DENT_WEB_CACHE_DIR`
([web-fetch.md, cache location](specs/web-fetch.md#cache-location)):

```jsonc
{ "web": { "cache": "project", "reformatModel": "fast" } }
```

`project`, the default, caches in `<working folder>/.pi/web-cache/`; `session` uses the session's
temporary folder; any other value is a folder path.

Requires Node 26 or later.

## Documentation

- [web-fetch.md](specs/web-fetch.md): the `WebFetch` tool, every rule and limit.
- `AGENTS.md`: how to work on the repository.

## License

MIT, see `LICENSE`.
