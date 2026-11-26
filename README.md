# pi-dent-web

A pi extension whose `WebFetch` tool fetches a web page as Markdown and caches it under the
session's working folder, in `.pi/web-cache/`, so a page fetched once can be read and searched from
disk by later turns and sessions. A sanitizer keeps text a reader would not see out of the result,
and an optional second model can fix the Markdown's formatting, accepted only where a check proves
the text unchanged. pi-dent bundles it through its `pi.extensions`.

## The tool

`WebFetch` takes `url` (http or https), `refresh`, `maxAgeHours` (default 24) and `reformat`.
It returns the path of the cached `content.md`, the status (`fetched`, `cached`, `revalidated` or
`stale`), the title, final URL, fetch time, length, and a preview of the first 4000 characters.
A fresh entry is served without network access; an older one is revalidated with its `ETag` or
`Last-Modified`. Loopback, private and link-local addresses are refused, redirects included.

## Configuration

In pi-dent's `pi-dent.conf`:

```jsonc
{
  "web": {
    "reformat": true, // the default of the reformat parameter
    "reformatModel": "fast", // a model string or a modelClasses class
  },
}
```

## Install

```sh
pi -e <absolute path of this repository>   # try it for one run
```

Requires Node 26 or later, and a pi that provides the extension API
(`@earendil-works/pi-coding-agent`).

## Documentation

- `specs/web-fetch.md` — the `WebFetch` tool.
- `AGENTS.md` — how to work on the repository.

## License

MIT, see `LICENSE`.
