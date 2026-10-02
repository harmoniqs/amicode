---
name: create-a-fleet
description: Set up a researcher's Amicode fleet for the FIRST time — turn a machine that's on its own into a multi-machine studio. Poses the one plain choice (one machine hosts the work, or each works on its own), defaults to the fully-wired home-base setup, discovers the machines, verifies they can really reach each other, drives the enroll primitive per machine, proves the fleet works end-to-end, and hands off cleanly. Use when there is no fleet yet; to add one more machine to a fleet that already exists use add-fleet-device, and to fix a broken fleet use troubleshoot-fleet.
agents: []
surface: public
---

# Create a Fleet

**Announce at start:** "Let's set up your machines to work as one studio."

The first-time setup: a machine that's on its own becomes a multi-machine studio.
This is the orchestrator — it discovers the machines, decides the shape with the
user in one plain question, provisions **home base**, links each machine in, and
proves the whole thing works. It **drives** the enroll primitive (`amico fleet
enroll`); it never re-implements it (no hand-written fleet config, no roster
writes, no health probes of its own beyond honest read-only reachability checks).

**Which fleet skill is this?** State-based, so the user never says a skill name:

- **No fleet yet** (this machine is on its own, no roster) → **this skill**.
- **A fleet already exists + add one more machine** → `/add-fleet-device`.
- **A fleet exists + something's broken** → `/troubleshoot-fleet`.

## How to talk about this

The words below are the code's, not the researcher's. Translate every time — raw
terms live in the commands you run, never in what you say:

| Internal term | Say instead |
|---|---|
| hub / star / server / canonical | "home base" — the machine that hosts your work |
| client / thin client | "a window onto home base" |
| standalone | "works on its own" |
| peer studios | "two independent studios you hop between" |
| enroll / join token | "link this machine in" |
| verify-attach / roster / health | "check the link actually works" |
| transport (ssh / tailscale) | "how the machines reach each other" |
| capabilities / role | (don't say these — pick behind the scenes) |

Questions are **one outcome at a time**, readable in two seconds. A caveat is one
plain sentence followed immediately by the choice it changes.

## Invariants (never violate)

1. **Truth is the real link, not "verify-attach" and not the roster.** A machine
   is linked ONLY when the endpoint it *actually uses* answers from that machine
   (Step 5d). The enroll verb's `verify_attach.ok` is **necessary but not
   sufficient** — it probes home base's public address directly, which is not the
   path the machine will use. And a roster row's `health` is a **self-asserted
   claim** (stamped on a timer), never proof. Report "linked" only on the real
   probe.
2. **Per-machine confirm — no silent fan-out.** Every link-in is surfaced and
   confirmed for *that* machine before it runs. One machine, one confirm, one
   enroll.
3. **Drive the primitive; never re-implement it.** All enroll behavior — config,
   the roster row, transport selection, the installer/guard, verify-attach — lives
   in `amico fleet enroll`. This skill shells it and reads its JSON.
4. **Guide-and-resume, never abort the fleet.** A machine with a broken link or no
   Amicode install **pauses** with one exact step and **resumes** after the human
   acts — while the other machines proceed. One stuck machine never aborts the run.

## Step 0 — you are on one machine; every other machine is an SSH hop

Check `hostname`. Any command against another machine must be wrapped in
`ssh <alias> '…'`, or you'll test the wrong machine and call a dead link healthy.
The fleet port is almost always **4096**.

## Step 1 — the one question that decides the shape

Ask it in outcomes, never with "hub" or "peer":

> **"When your machines are apart — one's off, or you've taken the laptop out —
> what should happen?"**
> - **"One machine hosts my work; the others are windows into it"** (recommended)
>   → home-base setup. The fully-wired path: your sessions live on home base and
>   follow you to any machine.
> - **"Each machine should fully work on its own, and I'll hop between them"** →
>   independent studios.

**Default to home base with the always-on machine as home base** (the workstation,
not the laptop) — it's the coherent, fully-wired experience. Pick "independent
studios" only when the user explicitly wants each machine usable alone, and then
give the honest caveat up front: *"You can set that up today and hop between them,
but running a live chat directly on the other machine's engine is still landing —
so the smoothest 'both as one' is still home base. Independent anyway, or home
base?"* Honor their choice; jump to **Peer studios** below for that path.

The rest of this skill is the home-base (hub/star) build.

## Step 2 — discover the machines

Gather the read-only inputs and hand them to `discoverFleetCandidates`
(`@amicode/amico-run`):

- **Tailnet peers** — `tailscale status --json`, parsed to
  `{ hostName, dnsName?, tailscaleIP?, online? }` per peer.
- **SSH hosts** — `~/.ssh/config`, parsed to `{ alias, hostName? }` per `Host`.
- **Roster rows** — the machines already known (empty on a first run).

```
discoverFleetCandidates({ tailnet, sshConfig, roster }) → FleetCandidate[]
```

The helper is **pure and read-only** — it dedupes by normalized machine name
(`mini`, `mini.local`, `mini.tail-abcd.ts.net.` fold to one machine), tags each
with its `sources`, reach hints (`sshAlias`, `address`), and — from the roster —
`inRoster`, `enrolled` (true only when `health === "reachable"`), and `health`. It
mutates nothing; you gather, it reasons. Present the machines and ask **which to
include** (multi-select is fine — this is planning, not mutation). Offer friendly
names for ugly hostnames.

## Step 3 — provision home base

Enroll the always-on machine as home base first (idempotent — a re-run repairs in
place):

```bash
amico fleet enroll --as-server \
  [--host <home-base-host>] [--port <port>] [--ssh-alias <alias>] \
  [--transport-hint <ssh|tailscale>]
```

On success this provisions the durable home-base service, mints the fleet secret,
and writes a **join token** (a secret, mode 0600) at
`~/.amico/ops/fleet/join-token.json` — its path is echoed in `join_token_path`.
Every window machine redeems this token. Confirm home base is healthy before
linking any window machine.

**Safety invariant:** home base trusts the connection itself as its boundary, so
the link must stay private — a private SSH tunnel or the tailnet via `tailscale
serve` — and **never** a publicly exposed port (`tailscale funnel`, or a bind to a
public address). Never advise exposing home base to the open internet.

## Step 4 — readiness, per machine (plain question first)

Before touching a machine, ask the plain question:

> **"Have you ever connected to this machine over SSH from here?"**

Then **probe silently** and surface a prerequisite only if it fails:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=6 <alias> 'echo ok'     # seat → machine
```

On failure, walk **one** step in plain terms and retry — don't recite a pipeline:

- **Can't reach it / permission denied** → "This machine needs to accept
  connections — turn on Remote Login (macOS: System Settings › General › Sharing)
  or sshd (Linux) and trust this computer. Tell me when it's on and I'll retry."
  (Behind the scenes: enable the service, append this machine's public key to the
  target's `~/.ssh/authorized_keys`, add a `Host <alias>` block.)
- **No SSH alias** → add the `Host <alias>` block first; the link install refuses
  without one.
- **No Amicode on the machine** → guided install (not automated): install the
  extension + toolchain there, then resume. Bare-machine bootstrap is out of scope.

## Step 5 — per machine: transport → confirm → link → verify

One machine at a time. While one is paused awaiting a human step, move to the next.

**a. How it connects (transport).** Default **SSH** (the universal floor, works
everywhere). Choose **Tailscale** only for a machine that roams *and* only after
verifying both machines are online in `tailscale status`, MagicDNS resolves, and
home base shares its engine via `tailscale serve` (never `funnel`) — else fall back
to SSH and say so.

**b. Confirm.** Show the exact link-in for this one machine; get an explicit yes.

**c. Link it in.** Redeem the join token on the machine:

```bash
amico fleet enroll --join-token ~/.amico/ops/fleet/join-token.json \
  [--transport-hint tailscale]   # add only for a roaming machine
```

The verb runs the whole primitive: build check → link config → roster row →
transport → installer/guard → verify-attach.

**d. Verify by the REAL link (the truth probe).** Read the JSON, but prove the
path the machine will actually use, **from that machine**:

```bash
ssh <alias> 'curl -fsS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<port>/global/health'
# 200 = the real link works. (Tailscale machine: probe its
# https://<magicdns-name>/global/health origin from the machine instead.)
```

- Real probe answers **and** `json.result.verify_attach.ok` → linked. Record it
  quietly; never recite `role`/`transport`/`verify_attach` at the user.
- `json.ok: false` → **not** linked. The actionable fix is at **`json.fix`**
  (top-level); surface it in plain terms, clear it (usually sleep, a missing alias,
  or Tailscale down), and retry. A row that exists but whose real probe fails is
  "almost — it registered but couldn't actually reach home base," never "done."

**e. Linux / WSL machine — give it a link that stays up (#1260).** On macOS the
steady link is a managed auto-reconnecting service. **On Linux and WSL it is not
wired yet (#1260)** — the guard and settings install, but nothing keeps the link
up, and the app's link health check reports "skipped" there (so it can look fine
while there's nothing holding the link). Don't leave such a machine on a one-shot
forward. Install a supervised link it runs itself and **verify it recovers**:

```bash
# a user-level systemd service that keeps the forward up (preferred), OR:
autossh -M 0 -N -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:<port>:127.0.0.1:<port> <home-base-alias>
```

Prove it by killing the link once and watching it come back (~30s). If the user
would rather not, offer the alternative: **make the Linux machine home base** (the
always-on host), and add the others as windows.

## Step 6 — prove the fleet works, then say so plainly

A fleet isn't built until the machines actually share one studio. Prove it
end-to-end and give a felt confirmation — never a status table:

1. Create a throwaway session on home base.
2. Confirm it appears from a window machine through the link (in the app there, or
   `GET /amicode/fleet/sessions`).
3. Delete the throwaway.
4. **Sanity check:** exactly ONE machine is home base. If two machines each think
   they're home base (two `server` rows, different machines), that's a
   misconfiguration — resolve to one before declaring done.

Then: **"Done — your machines now share one studio. Open a chat on any of them and
you'll see the same sessions."** Name any machine still paused and the one step
it's waiting on — nothing is silently dropped. Anything still stuck after its
guided step is a job for `/troubleshoot-fleet`; hand off and stop.

## Peer studios (the independent-studios path)

The additive topology: every machine runs its **own** engine on its **own**
database and *advertises* itself; you attach/switch between them. A machine that's
off doesn't strand the others — there is no single machine whose loss stops the
fleet. A peer stays "on its own" (never a window onto home base) and never installs
the never-fork guard.

**What works today — and the honest edges (state it plainly):**

- **Works:** each machine as its own independent, resilient studio; advertising
  (`serving`); the shared directory of machines (the keeper); the **Attach** control
  and per-machine transport/credential plumbing; **observing** another machine's
  sessions (read) works without a grant.
- **Sharp edge — observe hands a write-capable credential:** *controlling* another
  machine's session (prompting/archiving it) is wired, but the machine you attach to
  currently accepts the same credential it accepts for *reading* — so granting
  someone "observe" effectively grants write too. A separate control-only credential
  is future work. Scope who you grant to accordingly.
- **Not yet:** clicking **Attach** does not yet run your *live* session on the other
  machine's engine (the live re-target is a scoped follow-up). So peer is great for
  independent + resilient studios today; live shared driving across them is landing.
- Per-machine removal is `amico fleet revoke <machine_id>` (drops the grant + bars
  re-mint + fans out to serving peers); verify a revoked machine can no longer reach
  the others rather than trusting the exit code.

**No turnkey peer wizard exists yet**, so guide it by hand. To make an existing
home-base/window pair into independent studios:

1. On the **window machine**, run **Amicode: Fleet — Go Standalone** — it now runs
   its own studio and no longer depends on home base.
2. The **former home base** already runs its own engine; leave it as home base (it
   can double as the machine directory) or `Go Standalone` too. Either way it keeps
   its own engine, so it's no longer a single point of failure.
3. Have each advertise `serving` and point `~/.amico/ops/fleet/keeper.json` at the
   directory host, so both appear with the **Attach** control.

For the full mechanics, see `tools/fleet/README.md` § Peer studios. For a broken
peer or home-base link, hand off to `/troubleshoot-fleet`.

## What this skill does NOT do

- **Re-implement enroll.** No fleet-config writes, no roster POSTs, no health
  probes of its own beyond honest read-only reachability checks.
- **Silent fan-out.** Never link multiple machines from one confirmation.
- **Add to an existing fleet.** One-more-machine is `/add-fleet-device`.
- **Deep diagnosis / recovery.** A genuinely broken fleet — missing history, a
  forked database — is `/troubleshoot-fleet` (which escalates the deepest surgery
  to the internal operator playbook). Hand off.
- **Automated bare-machine bootstrap.** A machine with no Amicode is *guided*
  through install, not auto-provisioned.
