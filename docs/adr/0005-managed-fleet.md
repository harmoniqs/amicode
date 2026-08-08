# Managed Fleet: one canonical server, clients attach, nothing silently forks

Status: draft (2026-08-07)

A user's machines form one logical studio — one canonical chat server, many panels — but
until now that topology lived entirely in ops duct tape: a hand-written ssh config, a
hand-rolled launchd tunnel agent, and an extension whose only behavior was to spawn a local
server, so the "client attaches through the tunnel" design worked *by accident* (the spawn
lost a port race and the health probe rode the tunnel). On 2026-08-07 this failed three
times in one day on one fleet: a silent three-week fork (279 sessions invisible to the
canonical store), a fork reborn during a tunnel reconnect gap, and a panel stranded dead
after a tunnel outage with no self-recovery. Each failure mode was detected by a human
running diagnostics by hand; the product saw nothing.

This ADR makes the fleet a product feature: explicit **Server mode** (`standalone` /
`server` / `client`), the **Canonical Server** as a product-managed system service, the
**Managed Tunnel** as a self-healing extension-owned component, an identity handshake and
**Fleet token** on the server, and **Local fallback** with **Rejoin** merge as the
user-facing repair hatch. Terms per `CONTEXT.md` (Fleet & serving).

**Why:** the deciding requirement is not elegance but repairability for an open-source
user: when the fleet breaks, the user must be able to keep working (Local fallback) and
later rejoin without losing sessions — and the product must never, under any network
condition, silently serve a forked store. Weighing the alternatives: Remote-SSH moves the
user's whole editing context to the server (rejected as the primary pattern — "chat on the
laptop about the laptop's files" breaks); ops-only hardening keeps the fragility (rejected
— we spent a day chasing it); spawning on the server machine from its editor ties fleet
liveness to an editor's lifetime (rejected — the couch scenario). The server-side merge and
identity routes follow ADR 0002's seam precedent: the fork server owns what it owns, with
CLI/headless parity.

**Conditions of merge (the hardening grafts):** the never-fork invariant is enforced by
construction (client/server modes contain no spawn path) and pinned by tests; machine-scoped
settings (`scope: machine`) so Settings Sync can never carry `client` onto the server or leak
the token into a synced file; the merge policy is locked by golden-shard fixtures recovered
from the 2026-08-07 incident (id-guarded inserts, strictly-newer-wins per row with
`directory` excluded, event `(aggregate_id, seq)` position guard, column-name mapping for
schema drift, single FK-off transaction, refuse-and-preserve on unmappable drift); identity
handshake verified before every attach (role + fleet id), mismatch refused with actionable
copy; loopback-only binding with mutation routes refusing otherwise (ADR 0002 graft
persists); the service binary lives at a stable path with the upgrade choreography
(replace → restart → health probe) owned by the extension.

**Flip condition:** revisit the Managed Tunnel + identity ownership if opencode upstream
gains a native remote-attach capability with identity and auth (we would adopt rather than
maintain ours); revisit the Rejoin merge toward park-local if cross-version schema drift
produces merges we cannot verify — the invariant is "never lose, never silently corrupt",
and a merge we cannot verify violates it.

**Accepted costs:** the vendored fork's route surface grows again (identity + rejoin) —
ADR 0002's highest-conflict-on-rebase spot gets busier; the rejoin merge is the most
intricate component and its correctness budget is paid in fixtures and tests, not in review
cleverness; the service installer is per-platform (launchd now, systemd when a Linux server
appears); headless fleet consumers wait for the tunnel's second launcher.

**Considered:** Remote-SSH pivot (zero fleet code, wrong workflow); ops-only hardening
(zero build, keeps the fragility); two modes spawn/attach (server behaviors smear into
spawn); a named Fleet object with membership (heavier than a studio needs); CLI-daemon
tunnel (invisible failures); editor-owned canonical server (fleet dies with the editor);
mDNS auto-discovery setup (LAN-only, extra surface — ssh bootstrap with manual fallback
chosen); anonymous loopback auth (SSH as the boundary — rejected per ADR 0002's threat
model; the fleet token is the per-boot password's sibling for a service no extension
spawns).

**Prior art / source:** the 2026-08-07 incident and recovery (fixtures at
`~/.amico/fleet-recovery/2026-08-07/`); harmoniqs/amicode#279 (attach-only mode, filed from
the incident); the fleet playbook in the Amico skill set; ADR 0001 (at-rest secret
discipline), ADR 0002 (server-route seam, per-boot password, loopback graft).
