# pi-dent-web-fetch

A pi extension whose `WebFetch` tool fetches a web page as Markdown and caches it in the session's
working folder. pi-dent bundles it through its `pi.extensions`.

This repository follows the dx repo standard.

## Read first

| Document                                  | Holds, and when to read it                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `specs/AGENTS.md`                         | The spec list and this repository's spec conventions — read before any spec     |
| pi-dent-agent `docs/pi-extension-repo.md` | The pinned pi release, loading and running — read before touching the toolchain |

## Commands

```sh
pnpm check        # the done-set: typecheck, lint, fmt:check, test
pnpm test
pnpm typecheck
pnpm lint
pnpm fmt          # rewrites files, Markdown included
pnpm fmt:check
pi -ne -e ./      # run pi with only this extension loaded
```

## Rules

- `index.ts` is wiring only; the tool and its building blocks live in `lib/`.
- Tests never reach the real internet: HTTP tests use a local `node:http` server through the test
  seam of `specs/web-fetch.md`.
- No tracked file holds an absolute home path or the user's name, except the publishing fields of
  `package.json`; write `<absolute path of …>`. `test/no-personal-paths.test.ts` enforces it.
- pi-dent-web-fetch owns the `WebFetch` tool, the default cache directory `.pi/web-cache/`, the
  `PI_DENT_WEB_CACHE_DIR` variable and the `web` key of `pi-dent.conf`.
- Published to npm, so `package.json` is not `private`: the one accepted dx audit finding, as in
  pi-dent-terms. pi-dent-agent bundles this package at an exact version.
