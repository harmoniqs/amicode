# ADR 0028 — Self-reported device identity (friendly name + device type) in the roster

- **Status:** proposed
- **Date:** 2026-09-21
- **Context refs:** ADR 0026 (host-owned roster + capability model — defines the row and the
  single-writer self-report), ADR 0023 (one-parser invariant — `fleet.json` untouched),
  ADR 0025 (host-owns-all-state). Program: #1318 (roster + capability model, merged),
  #1319 (enroll primitive, merged), #1321 (sidebar section, merged), #1359 (`device_type`
  field + type pill, merged), #1363 (client peer visibility — proxy-read + server-node
  synthesis, merged).
- **Supersedes / amends:** ADR 0027's byte-freeze of the enroll verb. ADR 0027 (#1346)
  froze `packages/amico-run/src/fleet_enroll_verb.ts` (+ its test) byte-for-byte to prove
  *its* peer-studio work was additive; producing self-reported device identity requires the
  enroll producer to write `name`/`device_type` onto the roster row, so this ADR lifts that
  whole-file freeze — the additive-invariants gate's AC1 `FROZEN` set drops the enroll verb.
  ADR 0027's *actual* safety invariants are untouched: the never-fork guard shims stay
  byte-frozen, and one-parser / single-writer / no-client-stance remain enforced (the gate's
  AC2 / AC3 / AC4 + `assert_fleet_guard.sh`). Otherwise additive to the roster contract.

## Context

The roster row (ADR 0026, since enriched by #1359) already carries a `name` and an optional
`device_type`, and the sidebar already renders them (`typeLabel = device_type ?? server_mode`).
But nothing **produces** meaningful values: the enroll verb writes a row with
`name = hostname()` (the raw FQDN, e.g. `JVs-MacBook-Pro.local`) and no `device_type` at all.

The consequence is a split identity. Each machine already labels *itself* nicely on its own
sidebar — the extension synthesizes a local self-row from `scutil --get ComputerName` (the
user's chosen name, e.g. "JJ's MacBook Pro") and a `system_profiler`-derived form factor. But
that derivation lives only in the extension, so it never reaches the **roster row a peer reads**.
A machine and its peers therefore disagree about the machine's name and type: the server sees
`JVs-MacBook-Pro.local / client` while the laptop calls itself `JJ's MacBook Pro / laptop`.

The disagreement is symmetric. A client never sees a friendly server either: the client
synthesizes the canonical-server node (#1363) from `fleet.json`'s `canonical.host`, so it renders
the raw host string (`Mac.mynetworksettings.com`) with a hardcoded `server` type — because the
server does not self-register a roster row at all.

## Decision

1. **One derivation, shared by producer and consumer.** The name+type derivation becomes a
   machine's **self-report**, computed by logic shared between the enroll producer
   (`amico-run`) and the extension self-row — so a machine and its peers cannot disagree by
   construction. The **pure** classification lands in `@amicode/schema` beside
   `KNOWN_DEVICE_TYPES` (the vocabulary it targets): `classifyMacModel` (the rehomed existing
   classifier), `classifyLinuxChassis`, `normalizeDeviceName`, and `isWslKernel` (the pure core
   of the proven `rebuild/host_matrix.ts` WSL check). Every one is pure and unit-testable on any
   OS from string inputs.

2. **The impure shell stays per-package; `@amicode/schema` stays `child_process`-free.** The
   `execSync` calls (`scutil`/`system_profiler` on darwin, `hostnamectl`/`/sys` DMI on linux)
   live in a thin (~25-line) platform-branching caller in *each* node package (extension host +
   `amico-run`), each delegating all judgment to the shared pure functions. Schema must not gain
   `child_process`: `sidebar_fleet_section.ts` is browser-bundled and deliberately node-import-
   free, and a `child_process` import in a shared contract module risks poisoning that bundle.

3. **Cross-platform, honest where detection is unreliable.** macOS uses the existing commands;
   Linux uses `hostnamectl --pretty` (the `PRETTY_HOSTNAME`, the Linux analog of the macOS
   ComputerName) for the name and, for the type, `hostnamectl` chassis **first** then
   `/sys/class/dmi/id/chassis_type` **second** then abstain — mapping
   `laptop|notebook|portable → laptop`, `desktop|tower → desktop`, `server|rack → server`.
   `hostnamectl` absent (minimal container / no systemd) ⇒ prettified hostname + omitted type.
   **WSL is detected and abstains** to an undefined type — the WSL VM's chassis does not reflect
   the physical machine. Resolution precedence for both fields: **explicit setting → OS detection
   → prettified hostname (name) / `undefined` (type)**. The override reads **one namespace both
   producers share**: `amicode.device.name` (already read by the extension self-row) plus a new
   `amicode.device.type`; naming a *different* key on the producer would reintroduce split
   identity on the override path, so this is a load-bearing choice, not a detail. An undefined
   type is honest: the sidebar already falls back to `server_mode`. The friendly `name` is
   derived on a seam **kept separate from the `canonical.host` derivation** — a friendly name
   must never leak into `canonical`/the minted join token.

4. **The server self-registers, keyed by its canonical host — and its own self-row agrees.**
   `enroll --as-server` POSTs its own roster row to the loopback `/amicode/roster` **after
   verifying the hub is reachable** (retry-or-honest-fail, like the client verify-attach path —
   the pin probe's `dev` fallback tolerates an unreachable hub and is skipped when a version is
   injected, so it is *not* proof of reachability), reusing the validated `parseRosterRow` +
   single-writer upsert path. The server's row uses **`machine_id = canonical.host`** — the same
   identity a client references it by — so the client's existing `maybeAddCanonicalServer`
   de-dupe (`d.machineId === server.machineId`) collapses the synthesized node against the real
   row with **zero client-side change**. But the client view is only half of it: the server's
   OWN self-row is keyed by `os.hostname()`, which differs from `canonical.host` under a
   non-default `--host` or macOS FQDN drift (the live fleet's `Mac.mynetworksettings.com` is
   exactly this case), so the server would render *itself* twice. Slice 2 therefore also
   reconciles the server's self-row identity to `canonical.host` (or de-dupes the self-row
   against the roster on it). `machine_id` need only match what *other* machines use to reference
   a machine; clients keep `machine_id = hostname()`. `canonical.host` is treated as **immutable
   after first server enroll** — changing it orphans clients' synthesized node and requires
   re-enrolling clients, not just the server.

## Approaches considered

- **Duplicate the classifier in `amico-run`, leave the extension's copy** — rejected: the two
  producers of a machine's identity would silently drift, which is precisely the split-identity
  bug this ADR closes.
- **Put the whole detector (pure + impure) in `@amicode/schema`** — rejected: schema is kept
  side-effect-free and `child_process`-free for hygiene. (Note the honest nuance: schema already
  imports `node:os`/`node:path`, so it is not browser-safe regardless, and the browser sidebar
  module `sidebar_fleet_section.ts` re-declares the roster vocabulary rather than importing
  schema — so the risk is not that schema "poisons" that specific module today, but that adding
  `child_process` erodes the contract package into a runtime-effect package. "One derivation,
  two consumers" is really two *node* consumers: `amico-run` and the extension host.)
- **Enrich the join token / `canonical` with the server's name+type instead of a server row** —
  rejected: it stretches the secret join-token contract to carry display data and leaves the
  server a non-citizen of the roster, against ADR 0026's "each machine owns its own row."
- **De-dupe the synthesized server node by `server_mode == "server"` instead of id-alignment** —
  rejected: it adds client-side matching logic with edge cases (multiple server-role rows) to
  avoid a one-line identity rule on the producer.
- **Ship a Linux `hostnamectl`/DMI auto-detector with no override, and detect WSL chassis** —
  rejected for WSL type: unreliable from inside the VM; the settings override is the honest
  escape hatch. The Linux path itself is kept; only the WSL type auto-guess is dropped.
- **A periodic self-report heartbeat** so identity refreshes without re-enroll — deferred: a
  new subsystem, not needed to fix the reported bug. Re-enroll (idempotent upsert) is the
  documented refresh path; the heartbeat is a named follow-up.

## Invariants held

1. **One topology reader (ADR 0023).** `fleet.json` is untouched; the roster remains the only
   new artifact. No new parser.
2. **Single-writer self-report (ADR 0026).** A machine writes only its own row; the server's
   self-registration is its own row, keyed by its canonical host.
3. **`@amicode/schema` stays side-effect-free.** Only pure functions are added; the impure shell
   stays in the node packages. The browser bundle is unaffected.
4. **No silent fallback (ADR 0024/0025).** An undetectable type is an honest `undefined` that
   falls back to `server_mode`; a name with no friendly source falls back to the prettified
   hostname; a hub that is not reachable at server self-register time is an honest failure, never
   a false success. Nothing is fabricated.
5. **Never-fork (ADR 0005).** No engine spawn is added on any path.
6. **The friendly `name` never feeds `canonical.host`** or the minted join token — the display
   seam and the canonical-host derivation are kept separate.

## Consequences

- A machine and its peers agree on its name and type by construction — the split-identity bug is
  closed on both halves (client-as-seen-by-server and server-as-seen-by-client).
- The server becomes a first-class roster row, making ADR 0026's "each machine owns its own row"
  literally true and letting the client render the real server (`JJ's Mac Studio / desktop`)
  instead of a synthesized raw-host node.
- Linux/WSL clients get real detection with an explicit override; the extension's existing
  `classifyDeviceType` is rehomed to schema and imported back, removing a soon-to-drift copy.
- Already-enrolled machines keep their old rows until they **re-enroll once** (idempotent) — the
  documented refresh path until a self-report heartbeat lands.
- ADR 0027's additive-invariants gate (`assert_additive_invariants.sh`) drops the enroll verb from
  AC1's `FROZEN` set (the never-fork guard shims stay frozen; AC2/AC3/AC4 unchanged). The enroll
  verb's never-fork / single-writer semantics are still enforced — by the guard freeze and the
  one-parser / single-writer / no-client-stance checks — so relaxing the whole-file byte-freeze does
  not weaken any real invariant.

## Non-goals

- The periodic self-report heartbeat (auto-refresh without re-enroll) — a named follow-up.
- A Linux chassis auto-guess under WSL (the override covers it).
- Any change to `Server mode`, the `fleet.json` contract, `amicissimo`, or the roster schema
  (the `name`/`device_type` fields already exist).

## Source

- Design of record: **#1368** (this ADR's paired GitHub issue), decomposed into two vertical
  slices — the client-row producer (+ the shared schema derivation) and the server
  self-registration (+ the `machine_id = canonical.host` reconciliation).
- Prior art in-tree: `packages/schema/src/fleet_roster.ts` (the row + vocabulary),
  `packages/amico-run/src/fleet_enroll_verb.ts` (the producer), and the extension's
  `sidebar_view.ts` / `sidebar_fleet_section.ts` (the existing derivation + the consumer).
