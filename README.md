# pi-dent-web

A pi extension whose `WebFetch` tool fetches a web page as Markdown and caches it, by default under
the session's working folder in `.pi/web-cache/`, so a page fetched once can be read and searched from
disk by later turns and sessions. A sanitizer keeps text a reader would not see out of the result,
and an optional second model can fix the Markdown's formatting, accepted only where a check proves
the text unchanged. pi-dent bundles it through its `pi.extensions`.

## The tool

`WebFetch` takes `url` (http or https), `refresh`, `maxAgeHours` (default 24), `reformat` and
`cache` (the cache location, below).
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
    "cache": "project", // the cache location, below
  },
}
```

### Cache location

The first of these wins: the tool's `cache` parameter, the environment variable
`PI_DENT_WEB_CACHE_DIR` (read at each call), the `web.cache` setting, else `project`. Each takes
the same values:

| Value         | Cache folder                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `project`     | `<working folder>/.pi/web-cache/`, the default: kept across sessions                                                           |
| `session`     | `$PI_DENT_SESSION_DIR/tmp/web-cache/` under pi-dent, else `<system temporary folder>/pi-dent-web/<session id>/`; never removed |
| a folder path | that folder; a relative path resolves against the working folder, and `~/` is the home folder                                  |

A folder path that resolves to the working folder itself, the home folder or the filesystem root is
refused: as the parameter it is an error, from the variable or the setting it is ignored with a
warning. Entries go in `<folder>/<host>/<slug>-<hash>/`. A `.gitignore` of `*` is written when the
tool creates the folder (and whenever absent in the `project` and `session` folders); an existing
one is left alone. Use `./project` or `./session` for a folder of that name.

```jsonc
{ "web": { "cache": ".cache" } } // <working folder>/.cache/
```

```jsonc
{ "web": { "cache": "session" } } // this session's temporary folder
```

```sh
PI_DENT_WEB_CACHE_DIR=/abs/dir pi   # one folder for every project
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
