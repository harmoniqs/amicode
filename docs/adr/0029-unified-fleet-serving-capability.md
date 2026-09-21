# ADR 0029 — One fleet, differentiated by a `serving` capability (retire the hub-vs-peer topology split)

- **Status:** accepted
- **Date:** 2026-09-21
- **Context refs:** ADR 0005 (managed fleet — `Server mode`, the never-fork guard), ADR 0023
  (base-tier projection — the one-parser invariant), ADR 0025 (Remote-SSH default / thin-client
  lifeboat / host-owns-all-state), ADR 0026 (generalizable capabilities + host-owned roster —
  `server_mode` is the *closed* serve-stance union, `capabilities[]` the *open* axis), ADR 0027
  (peer fleet studios — chose "additive, two topologies"), ADR 0028 (self-reported device
  identity in the roster). Program: #1316/#1319/#1341–#1346 (#1353, merged), #1369 (the doc PR
  that documents the current two-topology reality this ADR proposes to unify).
- **Amends:** **ADR 0027 Decision #1 (§D1).** ADR 0027 shipped peer studios as a *second topology
  additive alongside* the hub/star, leaving "am I a hub or a peer?" as a user-facing distinction.
  This ADR reframes that distinction out of the product: there is **one fleet**, and whether
  others may attach to a device is a **per-device `serving` capability**, not a topology or a
  role. It changes the *model and the surface*, not the merged mechanism — the never-fork guard,
  `enroll`, and single-writer-per-DB are preserved (see Invariants).

## Context

After ADR 0027 the fleet has **two** things a user must distinguish:

- **Hub / star** — one `role=server`; the rest are never-fork `role=client` machines that tunnel
  to the hub and share its DB (ADR 0005/0025).
- **Peer studios** — each machine `standalone`, running its own engine, *advertising* `serving`,
  attachable from the Fleet Manager (ADR 0027).

The distinction is the wrong **user-facing** seam. "Is this a hub fleet or a peer fleet?" is a
question about our implementation history, not about what the user wants ("some of my machines
should host, some shouldn't"). It is also actively misleading: the stale docs that described
only the hub/star topology led a fresh read of the tree (and this very session) to conclude peer
support did not exist — the fix for which is #1369, but the *framing* is what made the error
possible.

Two facts make the unification tractable rather than a rewrite:

1. **The substrate is already capability-shaped.** ADR 0026 gives every device a row on a
   host-owned roster with an **open** `capabilities[]` axis; `serving` is already a known tag
   (`fleet_roster.ts`), and `placementDescriptor(row)` already answers "reachable + serving."
   ADR 0028 makes a device's identity (name, type — and, naturally, its capabilities)
   **self-reported** into that row. "Which devices can host" is therefore already expressible as
   data, without a new topology.
2. **"Hub" was never really a role — it was two capabilities wearing one hat.** A hub is a device
   that (a) others may attach to (`serving`) and (b) holds the roster (the **keeper**, ADR 0027
   §D7). Both are already separable facts. The only thing genuinely distinct about the old
   `client` is that it runs **no local engine at all** — a real capability difference, not a
   topology.

## Decision

**One fleet. Every device is an independent studio. A capability says who may host for others.**

1. **No hub/peer topology in the model.** A fleet is a set of devices sharing one roster. The
   words "hub fleet" and "peer fleet" are retired from the product surface, docs, and the Fleet
   Manager. What remains is a device list where each device advertises what it can do.

2. **Own-engine is the default (this resolves the sharp question).** Every device runs its own
   engine on its own DB by default — the ADR 0027 §D2 "independent studios" invariant, generalized
   from "peer mode" to "the default." A device is therefore resilient by default: **no single
   device's loss stops the fleet.** The old never-fork thin client is *not* the default for
   non-hosting machines; it is a distinct, explicit opt-in (§4).

3. **`serving` (can-host) is the attachability capability.** Whether others may attach to a
   device is exactly its `serving` tag on the roster row — nothing else. The old "hub" is just a
   device that is `serving` **and** is the current keeper. Attach targets **any** `serving`
   device in the roster (the ADR 0027 attach path generalized); the hub tunnel becomes one case
   of "attach to a serving device," not a privileged mode.

4. **The thin client survives as an explicit capability, not a topology.** ADR 0025's lifeboat —
   a weak or locked-down machine that *should not* run an engine — is preserved as an explicit
   **`hosted-only`** device stance: it runs no local engine and attaches to a designated
   `serving` device (its `canonical`), guarded by the unchanged never-fork guard. It is honestly
   rare and never the default; choosing it is opting *out* of the own-engine default, not the
   fallback for "can't host."

5. **`server_mode` stays the closed guard decision; attachability leaves it.** ADR 0026 keeps
   `server_mode` as the *closed* serve-stance union that the never-fork guard and `amicissimo`
   depend on. This ADR does **not** widen it. The guard's local question — *do I fork an engine?*
   — is still answered by the closed union (`standalone`/`server` fork; `hosted-only`/`client`
   does not). What moves off `server_mode` is the **product-facing** question "can others attach
   to me," which becomes the `serving` capability. `server_mode` becomes an implementation-level
   guard input, not a user-chosen topology.

6. **The keeper is an assignment, not a role.** Exactly one `serving` device holds the roster,
   named by the keeper bootstrap pointer (ADR 0027 §D7). Any serving device can be the keeper; it
   is a designation, not a special kind of machine. "Hub" ≡ "the serving device that is currently
   keeper."

7. **`fleet.json` is reinterpreted, not re-parsed.** The one parser (ADR 0023) is untouched. The
   existing `role` values map onto the new model with no schema change: `standalone` ⇒ own-engine
   device (advertise `serving` or not); `server` ⇒ own-engine + `serving` + keeper; `client` ⇒
   the `hosted-only` stance (needs `canonical`). Existing hub/client fleets keep working
   verbatim — this is a relabelling of what those values *mean* to the user, plus the surface
   changes in §8, not a migration.

8. **The surface collapses to one flow.** Fleet Manager becomes a single device list; each row
   shows the device's identity (ADR 0028) and a **serving** toggle + an **Attach** control — no
   "enroll as hub vs client" mode choice. `enroll` becomes "add this device to the fleet and set
   its capabilities" (the same primitive, minus the hub/client fork in the *interview*);
   `Go Standalone` becomes "drop `hosted-only`" (run your own engine). The `create-a-fleet` skill
   loses its "exactly one server, the rest clients" step in favour of "which devices should be
   `serving`."

9. **The live-attach enabler is named, not built here.** Uniform "attach to any serving device
   and drive its engine" needs the live proxy re-target that #1353 left intentionally unwired
   (`server.ts` byte-identical; `resolveAmicodeTarget` has no live caller). This ADR **depends on**
   that follow-up for the full attach UX but does not build it — the model and surface changes
   here stand on their own (own-engine default + capability advertisement are already real).

## Approaches considered

- **Keep two topologies (ADR 0027 status quo)** — rejected: "hub or peer?" is an
  implementation-history question, not a user goal, and its framing is what made peer support
  invisible in the docs (the bug behind #1369).
- **Retire the thin client entirely (pure peer mesh, every device runs an engine, no exceptions)**
  — rejected: ADR 0025's locked-down / weak-machine lifeboat is a real, supported case; dropping
  it to get a tidier model removes a capability people rely on. Demote it to an explicit
  capability instead (§4).
- **Widen `server_mode` into the open capability axis (fold `serving` into the role union)** —
  rejected for the same reason ADR 0026/0027 rejected it: the never-fork guard and `amicissimo`
  depend on a *closed* serve-stance union. Keep the guard's closed decision; move only
  attachability to the open `capabilities[]` axis.
- **Rename in docs only, leave the two-mode artifacts** — rejected: that is #1369 (which honestly
  documents *today's* reality). The point of this ADR is to make it one fleet **in the model and
  the surface**, so a user never picks a topology — not merely to relabel the prose.

## Invariants held

1. **One parser of `fleet.json` (ADR 0023).** No schema change and no new parser; the existing
   `role` values are reinterpreted (§7). Everything capability-shaped rides the roster row
   (ADR 0026) and the keeper/attachment pointers (ADR 0027).
2. **Never-fork + single-writer-per-DB (ADR 0005).** The guard and `enroll` mechanism are
   unchanged; `hosted-only` is exactly today's `client` stance (no engine spawn), own-engine
   devices adopt-or-spawn one writer per machine. Attaching to a serving device is a proxy op that
   spawns nothing.
3. **`Server mode` remains the closed serve-stance authority (ADR 0026).** It is not widened;
   attachability moves to the `serving` capability, orthogonal to it.
4. **The thin-client lifeboat is preserved (ADR 0025).** It becomes an explicit `hosted-only`
   capability rather than the meaning of "non-hosting device" — no supported case is dropped.
5. **No silent fallback (ADR 0024/0025).** A non-serving, non-`hosted-only` device runs its own
   engine honestly; a `hosted-only` device with an unreachable `canonical` is an honest failure,
   never a fabricated attach.
6. **Additive to ADR 0028.** A device's capabilities are part of its self-reported roster
   identity; this ADR adds no new identity producer, it reuses that seam.

## Consequences

- The user never chooses a topology. They add devices to one fleet and toggle which ones are
  `serving`; the "hub" is just whichever serving device is keeper. This is the model your machines
  already physically have (own engine each) minus a misleading label.
- **No single point of failure by default** — every device is an independent studio; a machine
  opts *into* dependence (`hosted-only`) rather than being made dependent by being a "client."
- Existing hub/client fleets keep working unchanged; migration is opt-in relabelling, not a break.
- The Fleet Manager, `enroll` interview, `create-a-fleet` skill, and the fleet README all
  simplify to one flow (device list + `serving` toggle + Attach).
- The full "attach and drive any serving device's engine" UX is gated on the #1353 live-re-target
  follow-up; this ADR makes that the single named enabler instead of one of two topologies.

## Non-goals

- **Wiring the live proxy/SSE re-target** (`server.ts` / `resolveAmicodeTarget`) — named as the
  enabler (§9), specced/built separately (the #1353 follow-up).
- **Horizon-2 compute federation** — unchanged from ADR 0027; `compute` stays inert.
- **Any change to the never-fork guard mechanism, the `fleet.json` schema, or the `amicissimo`
  contract** — this is a model/surface reframe over the merged substrate.
- **Forced migration** of existing hub/client fleets — they keep working; adoption is opt-in.

## Source

- Prior art in-tree: `packages/schema/src/fleet_roster.ts` (`serving` tag + `placementDescriptor`),
  `packages/amico-run/src/fleet_enroll_verb.ts` (the enroll primitive + role writer),
  `packages/extension/src/amicode_service/{attachment_pointer,keeper_pointer,attach_action}.ts`
  (the attach substrate), the Fleet Manager (`packages/app/src/pages/session/fleet-manager.ts`),
  and `tools/fleet/README.md` (the two-topology reality documented by #1369).
- Design-of-record follow-ups (if approved): a spec decomposing (1) the surface collapse (Fleet
  Manager + enroll interview + skill), (2) the `hosted-only` capability rename over `client`, and
  (3) dependence on the #1353 live-re-target enabler.
