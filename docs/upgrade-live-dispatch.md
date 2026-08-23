# Upgrade verbs — live dispatch proof (server-binary on the mini)

The hermetic suite (`packages/amico-run/test/upgrade*.test.ts`) is the
CI-green-blocking evidence for #526. **This checklist is the review-blocking
live proof**: ONE real `amico upgrade server-binary` dispatch on the mini
(Aaron's launchd `co.harmoniqs.amicode-server`, port 4096), the appended JSONL
receipt cited in the PR body. Separability per the spec: the PR cannot merge
without the live receipt, but CI does not wait on it.

**The implementer of #526 does not run this** — the parent (walk) dispatches it
after merge, on the machine that owns the surface.

## Preconditions (verify each, one line of output)

```bash
# 1. the machine is the server (this IS the mini) and the service is alive
launchctl print gui/$(id -u)/co.harmoniqs.amicode-server | grep -E 'state|pid'
curl -fsS 'http://127.0.0.1:4096/session?limit=1' >/dev/null && echo healthy

# 2. the fork checkout is clean and on local/amicode (a dirty or diverged
#    checkout aborts aborted-diverged — the human resolves it, never the verb)
git -C ~/armonia/repos/opencode status --porcelain          # must print NOTHING
git -C ~/armonia/repos/opencode rev-parse --abbrev-ref HEAD # local/amicode

# 3. bun is on PATH (the build step needs it) and the amico bundle is current
bun --version
cd ~/armonia/repos/amicode && git pull --ff-only && pnpm --filter @amicode/amico-run build
```

## The dispatch

```bash
cd ~/armonia/repos/amicode
node packages/amico-run/dist/amico.js doctor   # sanity: server-binary reads STALE (the reason to upgrade)
node packages/amico-run/dist/amico.js upgrade server-binary
```

Defaults, no stubs: `bun install` + `bun run build --single` in
`~/armonia/repos/opencode/packages/opencode`, artifact at
`packages/opencode/dist/opencode-<platform>/bin/opencode`, freeze into
`~/.amico/server/bin/opencode` (+ sidecar, `opencode.prev` preserved), kick via
`launchctl kickstart -k gui/$(id -u)/co.harmoniqs.amicode-server`, then poll
`GET /session?limit=1` **and** the running process's binary sha vs the sidecar
(120 s, one re-kick retry). Use `--ref <rev>` only to pin a specific rev.

The verb prints its step trace to stderr and the receipt (single-line JSON) to
stdout; expect several minutes for `bun install` + the single-binary compile.

## The receipt the PR cites

```bash
tail -1 ~/.amico/server/upgrade-receipts/upgrade-receipts.jsonl | python3 -m json.tool
```

The proof passes iff that receipt shows:

- `"verb": "server-binary"`, `"outcome": "upgraded"`, `"verification": true`
- `pre[0].verdict == "stale"` and `post[0].verdict == "current"`
- `source_digests.artifact_sha256 == source_digests.frozen_sha256`, and
  `fork_head_after == fork_head_at_ref` (the clean-but-behind ff, if any, ran)
- `detail` walks the chain: smoke → freeze (`preserved current binary as
  opencode.prev`) → kick → verify (`verified: healthy + running sha == sidecar`)
  → `deleted opencode.prev`

Independent cross-checks (never trust the receipt's own flag):

```bash
node packages/amico-run/dist/amico.js doctor   # server-binary must now read current
shasum -a 256 ~/.amico/server/bin/opencode     # == the sidecar AND receipt frozen_sha256
ls ~/.amico/server/bin/                        # opencode + opencode.sha256, NO opencode.prev
```

Idempotence spot-check (optional but cheap): re-run the verb — it must exit 0
with a `no-op` receipt and touch nothing.

## If it goes wrong

The verb restores automatically: a `restored` receipt means the previous binary
is back, healthy, sidecar rewritten — surface honestly `stale` again. A
`restore-failed` receipt means the server is DOWN: `opencode.prev` is retained
(deliberately — the only good copy); escalate by hand
(`launchctl print gui/$(id -u)/co.harmoniqs.amicode-server`, the server log,
then the amico-server.sh header runbook). The receipt records why; the
watchdog/morning-brief is the failure-delivery path, never silence.

## Known live caveats (stated, not blocking)

- **staged-skills reads stale forever on the mini while internal-only skills
  (fleet, develop, implement-issue, …) remain staged**: doctor #525's
  extras-are-drift predicate vs `stage-internal-skills.sh`'s deliberate
  no-delete staging disagree. The `skills` verb preserves internal skills
  (per-skill exact re-stage of the VSIX set, set-level no-delete) and reports
  the residual drift honestly in its post record — it never deletes fleet
  skills. Resolving the predicate/design conflict is a doctor-slice decision,
  not the verb's.
- Single-operator lock: every invocation path (SSH, panel) runs as the launchd
  user; a second concurrent verb exits `aborted-locked`.
- Receipts land in `~/.amico/server/upgrade-receipts/upgrade-receipts.jsonl`
  (append-only; `--root-receipts` redirects for fixtures).
