# P2 go/no-go — UI-kind always-local companion (extension split) (#1274)

> **STATUS: DECISION PENDING — the kill-switch is not yet thrown.** This is the ADR 0025
> **P2 feasibility gate** and its recorded outcome (AC4). The three *unit-provable* halves
> are **PROVEN in CI** and cited below. The one *runtime* half (survives a LIVE
> main-extension relocation under Remote-SSH) is **PENDING a live remote**, and the
> **final feasible / abort decision is PENDING a human** — it is deliberately left
> unmarked. Do not read a "feasible" verdict into the proven proofs: P2 is feasible only
> when the live proof is observed AND a human signs the verdict at the bottom.

- **Issue:** #1274 — "P2: UI-kind always-local companion (extension split) — feasibility
  spike + go/no-go" (part of #1269).
- **Design of record:** ADR 0025 (Remote-SSH default posture; thin client as lifeboat).
  This slice is the **load-bearing feasibility gate for the entire default-flip**: the
  auto-switch's link sensor must run on the CLIENT and survive the host going unreachable,
  but the main extension declares `extensionKind: ["workspace"]` and relocates to the host
  under Remote-SSH — a single manifest runs in exactly one location. If P2 is infeasible,
  the flip never happens and Remote-SSH stays opt-in.
- **The artifact under test:** a SEPARATE `ui`-kind extension, `packages/companion`
  (`amicode-companion`, `extensionKind: ["ui"]`). It bundles its own probe (`src/probe.ts`)
  and reopen driver (`src/reopen.ts`); it holds **no engine and no store** (never-fork,
  ADR 0025 inv. 2). It is a NEW workspace package with working `build` / `typecheck` /
  `test` scripts, green in `pnpm -r`.

## The Approach, restated (so the verdict is against the right claim)

A separate always-local `ui`-kind companion — NOT a manifest change to the existing
extension (a `["workspace"]` manifest runs in exactly one place; you cannot make one
manifest run on both sides). "Reuse the existing detector in place" was **rejected**:
under Remote-SSH it runs on the host — the dead side of the link. The companion is the
live side.

## Feasibility proofs

Three proofs are unit-provable and one is not. Each unit proof cites the test that
establishes it, in `packages/companion/test/companion.test.ts` (25 tests, all green;
`pnpm --filter amicode-companion test` → `25 passed`).

### (a) Activates on the CLIENT — **PROVEN (unit)**

- **Claim:** a `ui`-kind companion activates on the client — `activate()` runs, registers
  its command, and wires its probe + reopen.
- **Proof:** `describe("activate (AC1 — client-side activation)")` — `activate` registers
  `amicode.companion.reopenWindow` and pushes a disposable to `context.subscriptions`; the
  returned API wires the client-side probe and both reopen directions; `deactivate` is a
  safe no-op. `extensionKind: ["ui"]` in `packages/companion/package.json` is what places
  that activation on the client under Remote-SSH.
- **Not covered here:** that the activation *remains running* through a LIVE relocation —
  that is the runtime proof below.

### (b) Executes a probe from the CLIENT SIDE, independent of any host-side instance — **PROVEN (unit)**

- **Claim:** the companion runs its own probe, reading only the client-configured hub URL
  and an injected/global fetch — never the host-side running instance, posture file, or
  projection.
- **Proof:** `describe("probeHubHealth (AC2 — client-side probe)")` — it dials EXACTLY the
  client base URL + `/global/health` and nothing else (`f.hits` assertion), treats any
  answered status (incl. 5xx) as reachable, a transport error / timeout / empty URL as an
  honest unreachable, and never throws. That the only inputs are the client URL and the
  injected fetch **is** the host-independence.
- **Seam for #1275:** the full unified detector bundles ON TOP of `probeHubHealth`; this
  slice ships the minimal probe + the seam only.

### (c) Programmatically triggers a Remote-SSH↔local window reopen — **WIRING PROVEN (unit); LIVE reopen pending**

- **Claim:** the companion can programmatically drive a window reopen in BOTH directions.
- **Proof (wiring):** `describe("resolveRemoteSshReopenTarget …")`,
  `describe("resolveLocalReopenTarget …")`, and `describe("reopenWindow …")` — the pure URI
  builders produce `vscode-remote://ssh-remote+<alias>/<path>` (local→remote) and
  `file://<path>` (remote→local), reject a blank alias / relative path (never a
  half-window), and `reopenWindow` fires `vscode.commands.executeCommand("vscode.openFolder",
  …)` **exactly once** with the resolved URI + `forceNewWindow`, or opens NOTHING and
  surfaces the honest message on an unresolvable target. The activation tests further show
  the wired `reopen()` picks direction from `vscode.env.remoteName` (a remote window flips
  to local, a local one to remote).
- **Pending (runtime):** the actual window reopen — VS Code tearing down and re-opening the
  window under a real Remote-SSH authority — is not unit-testable; it is part of the live
  proof below.
- **Duplication note (judgment call):** the ~10-line pure Remote-SSH URI builder is
  DUPLICATED from the main extension's `src/fleet_connect_remote_ssh.ts`
  (`resolveRemoteSshTarget`) rather than imported — the companion is a separate package and
  must not take a (cyclic) dependency on the workspace extension. The contract fields
  (`authority` / `path` / `uri`) are kept identical so #1275 can extract a shared pure
  helper trivially if the surface grows.

### (LIVE) Survives the main extension relocating to the host under Remote-SSH — **PENDING a live remote (runtime / HITL)**

- **Claim:** the companion, activated on the client, **remains running** while the main
  extension (`["workspace"]`) is relocated to the host under Remote-SSH — i.e. the client
  side of the link stays alive when the host side moves away.
- **Why not unit-testable:** it requires a real VS Code client, a real Remote-SSH window
  onto a live hub, and observation that the `ui` extension host on the client keeps the
  companion alive across the relocation. No unit test reaches this.
- **Manual check (fill on a live run):** open a workspace locally (companion active on the
  client — confirm via its command in the palette and an Output line); connect that window
  to the hub over Remote-SSH (`Amicode: Connect to Hub over Remote-SSH`, #1271); confirm the
  MAIN extension is now host-side (`extensionKind: ["workspace"]`) while the COMPANION is
  still active on the client (its command still resolves; a `probeHub()` still executes from
  the client). Then invoke `amicode.companion.reopenWindow` and confirm it drives the window
  back to local.
  - [ ] PASS  [ ] BROKEN — Notes: `__________`
  - Environment: client OS = `__________`, hub host = `__________`, extension version =
    `__________`, `vscode.env.remoteName` in the connected window = `__________`.

## Release-matrix flag (for release owners — NOT wired here)

The companion is a **second VSIX** — a NEW release-matrix artifact. Per the Key Decision and
this slice's scope, it is **deliberately NOT wired into `release.yml`, the main `amicode`
VSIX, or the packaging scripts**, and is inert to `vsix-gate` / `packaging.test.ts` (those
test the main VSIX only). Before the default-flip ships, **release owners must decide** how
`amicode-companion` is built, versioned, and published (its own VSIX on the Marketplace vs.
bundled distribution) and add it to the release matrix. This is a follow-up, gated on the
verdict below being "feasible".

## VERDICT (fill and sign — the ADR 0025 P2 kill-switch)

- Unit proofs green: **(a) activates client-side ✓, (b) client-side probe ✓, (c) reopen
  wiring ✓** (cited above; `pnpm --filter amicode-companion test` → 25 passed).
- Live proof observed: [ ] yes  [ ] no  (from the LIVE section above).
- **Decision — PENDING human:**
  - [ ] **P2 FEASIBLE → proceed** to the classified sensor (#1275) and the switch
        orchestration (#1276–#1278); flag the second VSIX to release owners.
  - [ ] **P2 INFEASIBLE → ABORT per ADR 0025** — the default-flip does not happen;
        Remote-SSH stays opt-in (no flip). Record why here: `__________`.
- Decider: `__________`   Date: `__________`   Commit/branch under test: `__________`.
