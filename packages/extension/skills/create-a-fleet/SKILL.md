---
name: create-a-fleet
description: Build a multi-machine Amicode fleet end-to-end — discover candidate machines, confirm each one, and drive the `amico fleet enroll` primitive (#1319) per machine with guide-and-resume on broken links, then verify the whole fleet. Use when turning one machine into a working fleet, adding machines to an existing fleet, or when the user says "create a fleet" / "set up the fleet."
agents: []
surface: public
---

# Create a Fleet

An **agentic orchestrator** that turns one machine into a working Amicode fleet
(a canonical server + attached clients) by driving the enroll primitive
`amico fleet enroll` (#1319) across machines. Building a fleet by hand is N
separate enroll runs where the hard parts — finding the machines, confirming
2-way reachability, and un-sticking a broken SSH/Tailscale link — are left to you.
This skill runs that loop for you, one confirmed machine at a time.

It **drives** the primitive; it never re-implements enroll logic. The only code
it owns is the small read-only discovery helper `discoverFleetCandidates`
(`@amicode/amico-run`); everything else is the interview, the per-machine
confirm, and reading the primitive's honest JSON verdict.

It **complements** the `fleet` diagnosis skill — when a link is broken in a way
this loop can't guide past, hand off to `/fleet` for the deep playbook (DB
recovery, tunnel forensics, sync drift).

## When to invoke

- User says "create a fleet," "set up the fleet," "add my laptop to the fleet,"
  or similar.
- A single machine works and the user wants to bring more machines in.
- The Fleet Manager surfaces unenrolled/discovered machines and the user wants
  them enrolled.

For pure diagnosis of an *existing* fleet that's misbehaving, use `/fleet`
instead — this skill builds/extends; that one debugs.

## Invariants (never violate)

1. **Per-machine confirm — no silent fan-out.** Every remote enroll is surfaced
   and confirmed for *that machine* before it runs. Never batch-enroll a set of
   machines from one confirmation. This is the warrant/sign-off posture: one
   machine, one confirm, one enroll.
2. **Never report a machine enrolled until verify-attach passed.** A machine is
   enrolled ONLY when its enroll-result JSON shows
   `json.result.verify_attach.ok === true`. A row that exists but whose
   verify-attach failed is **not** enrolled — say so plainly ("has a row,
   verify-attach failed, unenrolled until resolved"). This inherits #1319's
   honesty; do not soften it.
3. **Drive the primitive; never re-implement it.** All enroll behavior —
   fleet.json, the roster row, transport selection, the installer/guard, the
   pin check, verify-attach — lives in `amico fleet enroll`. This skill shells
   that command and reads its JSON. It never writes fleet.json, posts a roster
   row, or probes health itself.
4. **Guide-and-resume, never abort the fleet.** A machine with a broken link or
   no amicode install **pauses** with an exact guided step and **resumes** after
   the human acts — while the *other* machines proceed. One stuck machine never
   aborts the run.

## The loop

### 1. Read current fleet state

Gather (read-only) what already exists, so the loop starts from reality:

- **The roster** (#1318) — the host-owned device roster:
  `GET http://<hub-host>:<port>/amicode/roster` (on the hub, the local
  `~/.amico/ops/fleet/roster.json`). Rows are the machines already known, each
  with its `health` (`reachable` = enrolled-and-verified; `down`/`degraded` =
  has a row but not trustworthy).
- **This machine's role** — its own `fleet.json` (`standalone|server|client`).
  If no server exists yet, this run will provision one.

### 2. Discover candidates

Gather the three discovery inputs and hand them to `discoverFleetCandidates`:

- **Tailnet peers** — `tailscale status --json` (or `tailscale status`), parsed
  to `{ hostName, dnsName?, tailscaleIP?, online? }` per peer.
- **SSH config hosts** — `~/.ssh/config`, parsed to `{ alias, hostName? }` per
  `Host` block.
- **Roster rows** — from step 1.

```
discoverFleetCandidates({ tailnet, sshConfig, roster }) → FleetCandidate[]
```

The helper is **pure and read-only** — it enumerates the union of machines,
**deduped** by normalized machine name (lowercased first DNS label, so `mini`,
`mini.local`, and `mini.tail-abcd.ts.net.` are one machine), and tags each with
its `sources`, reach hints (`sshAlias`, `address`), and — from the roster —
`inRoster`, `enrolled` (true only when `health === "reachable"`), `serverMode`,
and `health`. It mutates nothing and touches no filesystem or network; you do
the gathering, it does the reasoning. A candidate that is discovered on the wire
but `enrolled: false` is exactly what this loop exists to fix.

### 3. Choose machines + per-machine role and capabilities

Present the candidates and ask **which to include** (one question; multi-select
is fine here — this is planning, not mutation). For each chosen machine ask its
**role** and **capabilities** (one question per machine, atomic):

- **Role** — exactly **one server** (the canonical hub), the **rest clients**.
  Role is not a flag you pass to a capabilities field — it is *which enroll path
  runs*: the server is `--as-server`, every client redeems the join token.
- **Capabilities** (ADR 0026, an open tag set) — `roaming` (a transport hint:
  the machine defaults to Tailscale — realized here by enrolling it with
  `--transport-hint tailscale`), `compute` (a solve-target hint — **declared but
  inert**: there is no fleet-peer executor yet, an explicit non-goal; record it,
  don't promise it), plus any free descriptive tag. Capability tags live on the
  machine's roster row; the enroll CLI itself takes no `--capabilities` flag, so
  the only capability with wired behavior at enroll time is the transport hint.

### 4. Provision the server + join token

Enroll the chosen hub first (idempotent — a second run repairs in place):

```bash
amico fleet enroll --as-server \
  [--host <hub-host>] [--port <port>] [--ssh-alias <alias>] \
  [--transport-hint <ssh|tailscale>]
```

On success this provisions the durable hub service, mints the Fleet token, and
emits a **join token** (a secret, written 0600) at
`~/.amico/ops/fleet/join-token.json` — its path is echoed in the result's
`join_token_path`. Every client redeems this token. Confirm the hub is healthy
before enrolling any client (a client can't attach to a hub that isn't up).

### 5. Per client: reachability → guide-and-resume → confirm → enroll → record

For **each** client machine, in order — one at a time:

**a. Verify 2-way reachability first (both directions).** The link must work
*seat→machine* (you can reach the client to run enroll there) **and**
*machine→hub* (the client can reach the hub for verify-attach). Probe both:

- seat→machine: `ssh -o BatchMode=yes -o ConnectTimeout=6 <alias> 'echo ok'`
- machine→hub: from the client, the hub's health must answer — this is exactly
  what enroll's verify-attach will check, so a failure here predicts a
  verify-attach failure.

**b. Guide-and-resume on a gap** (a missing link OR no amicode install) — pause
*this* machine, give the **exact** step, resume when the human confirms, and
**keep the other machines moving**:

| Gap | Exact guided step (then resume this machine) |
|---|---|
| seat→machine SSH fails | On the client: enable Remote Login (macOS) / sshd (Linux); from the seat, plant the key: `cat ~/.ssh/id_ed25519.pub \| ssh <client> 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys'`; add a `Host <alias>` block to `~/.ssh/config`. |
| machine→hub unreachable | Bring the transport up on the client: `tailscale up` (roaming) or start the SSH local-forward / tunnel to the hub; confirm the hub's `/global/health` answers from the client. |
| no amicode installed on the client | Guided install (not automated): install the Amicode extension + toolchain on the client, then resume. Full remote bootstrap from a bare machine is out of scope — the human installs, the loop resumes. |

While a machine is paused, move to the next client; return to the paused one
after the human signals the step is done. Nothing is reported for a paused
machine except "paused — awaiting <step>."

**c. Per-machine confirm.** Show the exact enroll command for this machine and
get an explicit yes before running it. No confirm, no enroll.

**d. Drive the enroll.** Redeem the join token on the client (add
`--transport-hint tailscale` when its capabilities include `roaming`):

```bash
amico fleet enroll --join-token ~/.amico/ops/fleet/join-token.json \
  [--transport-hint tailscale]
```

(The token can also be passed inline with `--join-token-json '<json>'`.) The
verb runs the whole primitive: pin check → fleet.json → roster row → transport →
installer/guard → verify-attach.

**e. Read the verdict (the enroll-result JSON contract).** Parse the command's
JSON and branch on the honest fields:

- **`json.ok === true` AND `json.result.verify_attach.ok === true`** → enrolled.
  Record the row from `json.result`
  (`{ machine_id, name, server_mode, capabilities[], transport, verify_attach }`).
  Only now may you call this machine attached.
- **`json.ok === false`** → **not** enrolled. The actionable fix is at
  **`json.fix`** (top-level — *not* inside `verify_attach`), the cause at
  `json.cause` / `json.result.verify_attach.cause`. Surface `json.fix`
  verbatim as the guided step, treat it as a gap (step 5b), and resume. The
  roster row's `health` already reflects the failure — do not paper over it.

Never infer enrollment from a zero exit code or a written row alone —
`verify_attach.ok` is the only truth.

### 6. Verify the whole fleet

When every chosen machine is enrolled or explicitly paused, report **fleet-wide
state** — re-read the roster and summarize:

- **Each client attached** — one line per client: name · role · transport ·
  `verify_attach.ok` · health.
- **Hub healthy** — the server answers `/global/health`.
- **Roster complete** — every chosen machine has a row; name the ones still
  paused/unenrolled and the exact step each is waiting on (nothing is silently
  dropped).

Then offer the hand-off: anything still stuck after its guided step is a job for
`/fleet` (deep diagnosis) — say so and stop; don't loop forever on a link the
human step didn't fix.

## What this skill does NOT do

- **Re-implement enroll.** No fleet.json writes, no roster POSTs, no health
  probes of its own — it shells `amico fleet enroll` and reads the JSON.
- **Silent fan-out.** Never enroll multiple machines from one confirmation.
- **Automated bare-machine bootstrap.** A client with no amicode is *guided*
  through install, not auto-provisioned.
- **The roster route (#1318) or the fleet-peer executor.** Out of scope; the
  `compute` capability is recorded but inert.
- **Deep diagnosis.** A genuinely broken fleet is `/fleet`'s job — hand off.
