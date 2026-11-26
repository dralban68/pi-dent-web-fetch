# pi-dent-web-fetch specifications

Write and review specs per the `dx:writing-specs` skill, which defines the requirement keywords and
the conformance rule. This file holds only this repository's differences from it.

## Specs

| Spec           | Subject                                                                    |
| -------------- | -------------------------------------------------------------------------- |
| `web-fetch.md` | The `WebFetch` tool: fetching, guard, sanitizer, reformat, cache, settings |

## Differences

- A length counted in characters counts UTF-16 code units.
- No term registry: every term is used by one spec and defined where it is first used.
