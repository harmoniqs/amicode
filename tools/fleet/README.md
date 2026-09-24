# Fleet — configurable multi-machine studio

Operational tooling for Amicode's fleet. Two **additive** topologies share the same
roster, discovery, and Fleet Manager:

- **Hub / star** (ADR 0005/0025) — one canonical `role=server`; every other machine is a
  never-fork `role=client` that tunnels to the hub and shares the hub's database. This is
  what `amico fleet enroll` builds and what the rest of this doc describes.
- **Peer studios** (ADR 0027, Horizon 1 — merged in #1353) — each machine runs its **own**
  engine on its **own** database and *advertises* itself; you attach/switch between peers
  from the Fleet Manager. A peer stays `standalone` — it never takes the `client` stance,
  so the never-fork guard is never triggered. See [Peer studios](#peer-studios-adr-0027).

The two coexist; peer support **adds** files and never edits the hub path (`enroll`, the
guard, and ADR 0025 are byte-unchanged).

## Architecture (hub / star)

Fleet topology is declared in `~/.amico/ops/fleet/fleet.json`:

```json
{
  "role": "client",
  "canonical": {
    "host": "my-server-hostname",
    "port": 4096,
    "sshAlias": "my-server"
  }
}
```

- **No file = standalone** (safe default — local server, pre-fleet behavior). A **peer** is
  a standalone machine that additionally advertises `serving` — no `client` role, no `fleet.json` change.
- `role`: `"standalone"` | `"server"` | `"client"` (there is **no** `peer` role — peer = standalone + advertise)
- The guard script, extension, installer, and CI all read from this file

## Components

* **Guard** — `amico-opencode-fleet-guard` installed to `~/.local/bin`. Client reads fleet.json and exits 1 (panel rides tunnel); server/standalone execs the frozen opencode binary. Prevents silent fork (ADR 0005, #279, #324, #338).
* **Tunnel** — `co.harmoniqs.amico-tunnel.plist` (launchd) with `ServerAliveInterval 15 / CountMax 2 / TCPKeepAlive yes`. The SSH alias and port come from fleet.json.
* **Extension** — detects fleet role at activation; client mode polls the tunnel; "Go Standalone" switches permanently to local mode.

## Commands

| Command | What it does |
|---------|-------------|
| `Amicode: Fleet — Go Standalone` | Leave the fleet permanently. Writes `role: "standalone"`, clears guard/port settings, unloads tunnel, spawns local server. |
| `Amicode: Fleet — Repair` | Re-installs guard + tunnel from repo (same as `bash tools/fleet/install.sh`). |

## Install (for fleet clients/servers)

```bash
# Create fleet.json first:
mkdir -p ~/.amico/ops/fleet
cat > ~/.amico/ops/fleet/fleet.json << 'EOF'
{
  "role": "client",
  "canonical": {
    "host": "your-server-hostname",
    "port": 4096,
    "sshAlias": "your-ssh-alias"
  }
}
EOF

# Then install guard + tunnel + settings:
bash tools/fleet/install.sh          # idempotent: guard + tunnel + machine settings
bash tools/fleet/install.sh --check  # check only (CI + healthcheck)
```

## Verification

```bash
cat ~/.amico/ops/fleet/fleet.json    # role + canonical
lsof -nP -iTCP:4096 -sTCP:LISTEN    # ssh LISTEN (tunnel), no opencode
curl http://127.0.0.1:4096/session   # 200 via tunnel
```

## Go Standalone

When the canonical is offline or you want to leave the fleet:

```bash
# In VS Code:
#   Command Palette → Amicode: Fleet — Go Standalone
#   — writes fleet.json role=standalone, clears guard override
#     (opencodeBinary="" + opencodePort=0 → ephemeral), unloads tunnel, restarts locally.

# Manual (no VS Code):
cat > ~/.amico/ops/fleet/fleet.json << 'EOF'
{"role": "standalone"}
EOF
# Then restart VS Code / the extension.
```

## Peer studios (ADR 0027)

The additive **peer** topology (Horizon 1, merged in #1353). Where the hub/star model has one
engine and N thin clients, peer studios give every machine its **own** engine and let you hop
between them. It exists because the north star — engines dispatching agents to one another
(compute federation, Horizon 2) — is impossible with never-fork clients; peer studios are the
substrate for it. Horizon 2 itself is **declared, not built** (`compute` stays inert).

### What a peer is

- **Independent studio.** Each peer runs its own engine on its own DB (single-writer-per-DB
  preserved *per machine* by the existing adopt-or-spawn gate). If one peer is off, the others
  keep working — **there is no single engine whose loss stops the fleet.** This is the key
  difference from a hub client, which is dead whenever the hub is down.
- **Standalone, never a client.** A peer keeps `role: standalone` (or no `fleet.json`) and
  *advertises*; it never writes `role: client` and never installs the never-fork guard.
  Attaching to another peer is a **proxy** operation that spawns no engine.

### The pieces (all merged, ADR 0027 §3–7)

| Piece | Where | What it does |
|---|---|---|
| Serving advertisement | `@amicode/schema` `fleet_roster.ts` — the `serving` capability tag + `placementDescriptor(row)` | A peer advertises its running engine by carrying `serving` in its roster row's `capabilities[]` plus reach coordinates. Does **not** change `server_mode`. |
| Directory keeper pointer | `keeper_pointer.ts` → `~/.amico/ops/fleet/keeper.json` (env `$AMICO_FLEET_KEEPER_FILE`) | A resolvable `{sshAlias, transport}` coordinate for the roster host, carried in its own file (never derived from the `roster.json` it hosts — that would be circular). |
| Switch-control pointer | `attachment_pointer.ts` (env `$AMICO_FLEET_ATTACHMENT_FILE`); honesty surface `GET /amicode/fleet/attachment` | The "currently attached server". Empty ⇒ local. Never proxied. |
| Attach / detach | `POST /amicode/fleet/attach {machine_id, base_url?, token?}` and `POST /amicode/fleet/detach` (registered **unconditionally** — a standalone peer must attach) | Adds/removes an upstream and drives the pointer; the roster is the sole candidate source. A switch resets the SSE cursor. |
| Per-attachment transport + credential | `attachment_transport.ts`, `attachment_credential.ts` | SSH is the universal default; `roaming` → tailscale, direct opt-in. Each attach injects a UI client credential to authenticate to the peer engine. |
| Fleet Manager **Attach** control | overlay `packages/app/src/pages/session/fleet-manager.ts:219` | The per-device-row Attach/Detach button — the front-end that drives the attach route. |
| Placement seam | `amicode_session` / Task dispatch `placement` field, default `local` | Threaded and defaulted for Horizon 2; **provably inert** today (nothing routes on it). |

### The honest limitation — live re-target is NOT wired yet

This is the one caveat to state plainly, and the reason a peer setup does not yet fully
replace a hub for *shared* work: **`server.ts` is held byte-identical, so the three-way
resolver (`resolveAmicodeTarget`, `attachment_pointer.ts`) is not in the live proxy's
`dispatch()`.** An attach flips the switch-control pointer and resets the SSE cursor, but the
**live proxy/SSE still target the local (or hub) engine** — "switch → now driving the peer's
live engine end-to-end" needs the `server.ts` invariant relaxed in a scoped, reviewed edit
(a flagged follow-up from #1353). So today:

- **Works:** each peer as an independent, resilient studio; advertising; the roster/keeper
  directory; the Attach control and pointer flip; the credential/transport plumbing;
  everything at the unit/route level.
- **Not yet:** clicking Attach and having your live session actually run on the other peer's
  engine.

### Making two hub machines into peers (no single point of failure)

There is **no `amico fleet` peer subcommand and no Command Palette wizard** yet — peer entry
is not a turnkey flow the way `enroll` is. To convert an existing hub/client pair so neither
machine is a single point of failure:

1. On the **client** machine, leave the hub: `Amicode: Fleet — Go Standalone` (writes
   `role: standalone`, clears the guard override + tunnel, spawns a local engine). It now runs
   its own studio.
2. On the **former hub**, it is already `role: server` with its own engine; either leave it as
   `server` (it can also act as the roster keeper) or `Go Standalone` it too — either way it
   keeps its own engine, so it is no longer a dependency for the other machine.
3. Have each machine advertise `serving` (its roster self-report carries the tag) and set the
   keeper bootstrap pointer (`~/.amico/ops/fleet/keeper.json`) to the roster host, so both show
   up in the Fleet Manager and expose the Attach control.

After step 1–2 the single-point-of-failure is gone (each machine has its own engine); step 3
adds mutual discovery + the Attach scaffolding, with the live hop pending the caveat above.

## Prevention

* **In-extension fleet health** — `src/fleet_health.ts` + `amicode.healthcheck` report `Fleet role / guard / settings / tunnel` (darwin-only, skipped when standalone).
* **Installer** — `tools/fleet/install.sh` reads fleet.json for topology. No file = skip.
* **CI gate** — `ci.yml` `fleet-gate` runs `assert_fleet_guard.sh` (verifies guard references fleet.json, has exit 1, packaged copies in sync).
