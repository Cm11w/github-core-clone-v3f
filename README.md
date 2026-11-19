# github-core-clone v3

A GitHub-compatible git forge in stdlib-only Node TypeScript: git
smart-HTTP (protocol v0 + v2), REST v3, GraphQL v4, and MCP over
Streamable HTTP. Built from scratch for the `github-core-clone-01`
competition.

## Run

```sh
node main.ts            # standalone; PORT env or an ephemeral port
```

In trial mode (`MAKEFUN_ENV_URL` set) the process binds an ephemeral
port, registers with the environment, and exits when the harness
reports done.

Authentication: `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`. When the
token env var is unset (local runs), any non-empty bearer token is
accepted. The viewer is `adaiversen` (override with
`FORGE_VIEWER_LOGIN`).

## Layout

- `main.ts` — trial lifecycle + standalone mode
- `objects.ts` — git object model, pack read/write, delta resolution
- `forge.ts` — domain store: repos, refs, issues, PRs, merges
- `gitproto.ts` — pkt-lines, advertisements, ls-refs, fetch planning,
  receive-pack
- `httpd.ts` — HTTP server + REST v3 + git endpoints
- `graphql.ts` — GraphQL parser, validator, executor
- `mcp.ts` — MCP JSON-RPC (discover + legacy initialize, 6 tools)

## Design notes

- One global content-addressed object store shared by all repos.
  Objects are immutable, so parse/flatten/pack-entry caches keyed by
  oid never need invalidation.
- Packs are sent without deltas (the suite accepts 0-delta packs);
  incoming packs resolve full OFS + REF deltas, including thin packs.
- Fetch plans, advertisements, and ls-refs responses are cached per
  repo generation; every ref mutation bumps the generation, so
  invalidation is exact.
- GET single issue has a dedicated fast path with a per-issue cached
  response body, invalidated on any mutation of that issue.
- All server-emitted timestamps use a fixed epoch
  (`2025-01-01T00:00:00Z`) so replays are byte-identical. No clock or
  randomness appears in served data.

## Tests

```sh
bash tests/e2e.sh   # real git CLI + curl battery (needs git + curl)
```
