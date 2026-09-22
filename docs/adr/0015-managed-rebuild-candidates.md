# 0015 - Adopt complete rebuild candidates through staged VSIX installation

Status: proposed (2026-09-11)

Tracking: harmoniqs/amicode#1016

Depends on: harmoniqs/amicode#1010

## Context

A developer rebuild changes extension-host code, contributed metadata, bundled
skills and templates, the app bundle, and a host-native engine. The existing
rebuild paths copy portions of that closure into an installed extension after
building against ambient dependencies. They cannot verify the complete payload,
atomically activate it, or restore a known-good version when the next extension
activation fails.

Main source identity is constrained by the promoted-overlay contract. The
authoritative fork revision is the immutable SHA recorded by the selected
Amicode main manifest, not the current head of `local/amicode`. Falling forward
to a newer fork head creates a mixed, unreviewable build.

## Decision

Developer rebuilds produce and adopt complete, platform-specific VSIX rebuild
candidates. Each candidate is tied to an immutable manifest containing the
selected Amicode main SHA, promoted fork SHA, overlay-manifest fingerprint,
upstream-base SHA, platform, UI channel, artifact digest, and CI provenance.

Rebuild from Main resolves and verifies a published candidate for that exact
promoted pair first. If no compatible candidate is available, a separately
confirmed source fallback uses an owned temporary worktree leased by the
Amicode main SHA and manifest-pinned fork SHA. It never changes a developer
checkout, promotion branch, or the current fork head.

Before installation, the coordinator validates the candidate payload and its
isolated runtime. It retains the prior VSIX, launches an external watchdog,
installs the candidate through VS Code, and reloads. The candidate becomes
current only after it emits a matching health receipt. The watchdog restores the
retained VSIX on a failed or missing receipt.

## Considered Options

1. **Complete staged VSIX candidate** - chosen. It verifies the whole runtime
   closure and gives a recoverable activation boundary.
2. **Incremental installed-file copying** - rejected. It leaves partial states
   and has no trustworthy rollback path.
3. **Resolve the newest fork head during a Main rebuild** - rejected. It
   violates the promoted-manifest contract in #1010.
4. **Rebuild-time overlay promotion** - rejected. It turns a consumer into a
   cross-repository source mutator.
5. **Dynamic extension loader** - rejected. It expands the executable-code and
   resource-root trust boundary beyond this need.

## Consequences

Rebuilds become user-scoped and reproducible on macOS arm64, Linux x64, Linux
arm64, and WSL hosts. Native Windows remains a WSL-routing surface rather than
a native rebuild host. The rebuild system owns candidate manifests, toolchain
pins, temporary-worktree leases, health receipts, and rollback receipts. CI
must publish durable candidate prereleases after the promoted source pair has
passed required gates. The existing shell entry points remain supported wrappers
over the coordinator. The old copy bridge is retired only after successful
candidate adoption and rollback drills.
