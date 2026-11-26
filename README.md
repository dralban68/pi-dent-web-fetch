# pi-dent-web

A pi extension whose `WebFetch` tool fetches a web page as Markdown and caches it under the
session's working folder, in `.pi/web-cache/`, so a page fetched once can be read and searched from
disk by later turns and sessions. A sanitizer keeps text a reader would not see out of the result,
and an optional second model can fix the Markdown's formatting, accepted only where a check proves
the text unchanged. pi-dent bundles it through its `pi.extensions`.

Status: specified in `specs/web-fetch.md`, not yet implemented.

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
