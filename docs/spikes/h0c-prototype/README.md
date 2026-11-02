# H0c prototype — v2 handler behind a deny-by-default front

Spike code for amicode#2048 (see `../2026-11-01-h0c-seam.md`). **Not shipped, not a pnpm workspace member**
(the workspace globs are `packages/*`). It runs against a *scratch checkout of upstream opencode*, never against the
machine's opencode service or its database.

## What it is

| File | Role |
|---|---|
| `src/host.ts` | **The prototype**: `EmbeddedHost.create(...)` (route 1) + our front + in-process plugin + a workspace provider |
| `src/front.ts` | Deny-by-default front (Basic auth over every path), `/amicode/ping`, and a streaming proxy (used for route 3) |
| `src/check.ts` | Starts the prototype and prints PASS/FAIL per criterion (C1–C9) |
| `src/targets/*.ts` | One module per candidate seam (c1, c2a, c2b, c2c, c3) used by the comparison |
| `src/criteria.ts` | The criteria themselves (shared by all candidates) |
| `src/env.ts` | Safety envelope: refuses to run outside a sandbox |
| `raw/` | Saved output of the runs quoted in the note |

## Safety envelope (enforced in `src/env.ts`, not just documented)

Every process runs with temp `XDG_*` dirs and a fresh `OPENCODE_DB` under `/tmp/opencode/h0c/xdg/<name>/`,
`OPENCODE_TEST_HOME` redirected, the inspector env unset, and listens only on `127.0.0.1:51000-51999`
(free port picked at bind time; never 49374/49375/4094–4296/9230). `serve --service` is never used. No model is
called; no credential exists (the passwords are throwaway literals).

## Running

```sh
# 1. a scratch checkout of upstream at the tested SHA (read-only reference clone, install is slow: nice it)
git clone --no-checkout <path-to-opencode-clone> /tmp/opencode/h0c/upstream
git -C /tmp/opencode/h0c/upstream checkout 12f7e1b59a
(cd /tmp/opencode/h0c/upstream && nice -n 19 env -u BUN_INSPECT bun install)

# 2. OPTIONAL instrumentation so abort can be observed server-side (private subscriber map in event-feed.ts)
git -C /tmp/opencode/h0c/upstream apply "$PWD/raw/instrumentation-event-feed.diff"   # scratch clone only!

# 3. run
./run.sh prototype            # the prototype: prints PASS/FAIL per criterion
./run.sh c2a bare,fronted     # any candidate; modes: bare, fronted, fronted-default-idle, fronted-body-cancel-only, fronted-no-abort-forward
./run-all.sh                  # everything; writes raw/*.log
```

`run.sh` symlinks `node_modules` to `packages/sdk/node_modules` of the scratch checkout so `@opencode/*` and a single
`effect` instance resolve (two `effect` copies would break service tags). `H0C_UPSTREAM` overrides the checkout path.

The `raw/` logs were produced with the instrumentation patch applied (criterion C6 reads its log; without it C6 FAILs
by construction with "NO release", because the subscriber map is private).
