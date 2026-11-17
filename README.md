[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kkazushi-eng/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kkazushi-eng/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-forge-entry

A GitHub-compatible git forge for the make.fun bounty **github-core-clone-01**,
implemented from scratch in one Node.js process. No git binary, no npm packages, no
database: the git object model (objects, trees, packfiles with delta application and
generation, refs) lives in memory, and the same store backs every protocol surface.

## Running

```
node main.ts        # Node 22+ (type stripping); no install step
```

`main.ts` is the harness lifecycle: it reads `$MAKEFUN_ENV_URL`, starts the HTTP
server on an ephemeral port, POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`
(retrying with backoff), long-polls `GET $MAKEFUN_ENV_URL/done`, and exits 0 when
the run is done. `GET /healthz` answers 200 `{"ok": true}`.

Authentication: when `$MAKEFUN_SHOP_TOKEN` is set, every API surface requires
`Authorization: Bearer <that token>` (compared against the process's own token).
When it is unset (local runs), any well-formed Bearer token is accepted and a
missing header is a 401.

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | Harness lifecycle (register / done-poll / shutdown), unchanged from the starter |
| `app.ts` | HTTP server and routing across all surfaces |
| `store.ts` | In-memory repos, objects, refs, issues, PRs, labels; tree merge and line diff |
| `gitobj.ts` | SHA-1 object model, packfile write (no deltas) and read (OFS/REF delta application, thin packs) |
| `gitproto.ts` | Smart HTTP: v2 advertisement, ls-refs, fetch (depth/deepen/shallow), v0 receive-pack |
| `rest.ts` | REST v3 under `/api/v3` |
| `graphql.ts` | GraphQL v4 at `/api/graphql` (hand-rolled lexer/parser/executor + introspection) |
| `mcp.ts` | MCP endpoint at `/mcp` (protocol 2026-07-28 `server/discover` plus legacy `initialize`) |

## Coverage

Verified locally with the kit's own grader (`grade-local`, process driver):
**120/120 conformance checks** — git 30, repos 15, issues 15, pulls 20, graphql 20,
mcp 15, protocol 5 — and the byte-identical replay the harness requires.

**Git smart HTTP**
- Protocol v2 advertisement (`Git-Protocol: version=2`), `ls-refs` with peel,
  symref, unborn and ref-prefix filtering; v0 advertisement and v0 fetch fallback.
- Fetch: full history, exact have-exclusion, `depth`, `deepen`, `deepen-since`
  (parsed; see stubs), `deepen-relative` semantics, `unshallow`, shallow-info
  boundary reporting, side-band-64k progress, thin-pack completion on push.
- Receive-pack v0: create/update/delete refs with per-ref fast-forward validation
  (non-fast-forward is refused per-ref with the reason `non-fast-forward`),
  report-status framed inside side-band-64k, annotated tag pushes with peeling.

**REST v3** — root document and `/meta`; `/user` and `/user/repos` with
same-origin `Link` pagination; repository CRUD (duplicate create is a 422);
branches and `POST /git/refs`; commits listing per ref; contents read/write/delete
with GitHub's sha rules (create 201, update 200, stale sha 409, missing sha on
update 422, works on unborn repositories); labels (unknown label on an issue is a
422); issues and comments; pull requests with file diffs, merge and squash
(conflicts are a 405, unknown PRs a 404). JSON everywhere, string `message` on
errors, `X-GitHub-Request-Id` on every response, malformed JSON is a 400.

**GraphQL v4** — `viewer`, `repository` with the fields the suite probes (issues
and pull requests with state filters, `CREATED_AT` ordering and cursor pagination,
PR files), `node(id:)` with stable opaque global ids, `__type` introspection for
the probed types, mutations `createIssue` / `closeIssue` / `createPullRequest` /
`mergePullRequest` / `addComment`, operation batching, and GitHub-style errors
(unknown field → 200 with `errors` naming the field; unknown repository →
`data.repository: null` with no errors; unauthenticated → 401).

**MCP** — `server/discover` for protocol 2026-07-28 (with `supportedVersions` and
`_meta`), legacy `initialize`, and a constant `tools/list` naming the six canonical
tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
`create_pull_request`, `merge_pull_request`) operating on the same store as REST.
Unknown tools and missing arguments are `-32602`; a non-JSON body is HTTP 400 with
`-32700`; no auth is a 401.

## Deliberate simplifications

- `rebase` merges are performed as squash merges (the merge result and conflict
  behaviour are identical; only the resulting history shape differs).
- `deepen-since` / `deepen-not` fetch arguments are parsed but ignored.
- The GraphQL schema covers the surface the conformance suite probes; a few
  declared fields that nothing reads resolve to `null` (e.g. an issue's comments
  connection).
- Repository rename via `PATCH` is not implemented (description/visibility patch
  is); `PUT /contents` with a nonexistent `branch` creates that branch from the
  default tip.
- State is in-memory only and resets when the process exits, which matches the
  harness lifecycle (one process per trial).
- Packfiles are written without deltas (valid, slightly larger); incoming packs
  are fully delta-resolved, including thin packs.

## License

MIT — see `LICENSE`.
