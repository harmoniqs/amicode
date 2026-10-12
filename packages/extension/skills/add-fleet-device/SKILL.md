---
name: add-fleet-device
description: Add ONE more machine to a researcher's EXISTING Amicode fleet — the common, low-friction repeat action (join a laptop to a workstation you already set up). Confirms a fleet already exists, discovers the one machine, verifies the machines can really reach each other over their chosen connection, drives the enroll primitive for that single machine, proves the link works end-to-end, and hands off to troubleshoot-fleet on a broken link. Use when a fleet already exists and the user wants to bring in one more machine; for first-time / multi-machine setup use create-a-fleet instead.
agents: []
surface: public
---

# Add a Device to the Fleet

**Announce at start:** "Let's bring this machine into your fleet."

The focused, single-machine path: a fleet already exists and the user wants one
more machine in it. This is the everyday repeat action, so it should feel like two
questions and a confirmation — not the full setup interview. It **drives** the
enroll primitive (`amico fleet enroll`); it never re-implements it, never writes
fleet config by hand, and — unlike `/create-a-fleet` — it **never provisions home
base**. If there is no fleet yet, this is the wrong skill: send the user to
`/create-a-fleet`.

## How to talk about this

Translate the internals every time; the raw words stay in the commands, never in
what you say:

| Internal term | Say instead |
|---|---|
| hub / server / canonical | "home base" — the machine that hosts your work |
| enroll / join token | "link this machine in" |
| client | "a window onto home base" |
| standalone + advertise `serving` (peer) | "its own studio, with fleet sessions and prompts syncing between machines" |
| verify-attach / roster health | "check the link actually works" |
| transport (ssh / tailscale) | "how the machines reach each other" |

Questions are **one outcome at a time**, readable in two seconds. A caveat is one
sentence in plain terms, followed immediately by the choice it changes.

## Step 0 — you are on one machine; every other machine is an SSH hop

Check `hostname`. Any command against the machine you're *adding* (or against home
base, if you're not on it) must be wrapped in `ssh <alias> '…'`, or you'll test the
wrong machine and call a dead link healthy. The fleet port is almost always
**4096**; read the real one from `~/.amico/ops/fleet/fleet.json` (`canonical.port`).

## Step 1 — confirm a fleet already exists (precondition)

Read the current state silently:

- `~/.amico/ops/fleet/fleet.json` — is this fleet's home base known
  (`role: server` somewhere, a `canonical` host)?
- The roster — is there at least one machine already linked?

**No fleet yet** (this machine is on its own, no roster, no home base) → say so and
switch to `/create-a-fleet` ("You don't have a fleet yet — let's set one up
first"). Do not try to stand up home base here.

## Step 2 — one outcome question: window, or its own studio?

Frame the topology choice as an outcome, never with the words "hub" or "peer":

> **"Should this machine run its own studio, or depend on one host?"**
> - **"Run its own studio, and keep fleet sessions in sync"** (recommended) → peer
>   studio. Each machine has its own engine; session activity and prompts sync
>   between them in near real time.
> - **"Use one host for all my work"** → a window onto home base. The other machine
>   depends on that host being reachable.

Honor their choice. Do not describe peer studios as simply hopping between isolated
histories: session activity and prompts sync between peer machines.

## Step 3 — pick the one machine

Gather the candidates (this is planning, read-only): the machines on the tailnet
(`tailscale status --json`), the hosts in `~/.ssh/config`, and the roster rows.
Present the machines **not yet linked** and ask which one to add. Offer a friendly
name if the real one is an ugly hostname ("I'll call this 'MacBook' — edit if
you like").

## Step 4 — readiness: can the two machines already reach each other?

First choose the connection method in Step 5. SSH is not a prerequisite when the
machines will connect over Tailscale. For Tailscale, check both devices are signed
in and online, and that MagicDNS resolves. If it is not set up, direct the user to
[Tailscale's install guide](https://tailscale.com/kb/1017/install) and resume when
they are ready. Do not ask for router port-forwarding.

For SSH, ask the plain question first, before anything is changed:

> **"Have you ever connected to this machine over SSH from here? (If you've `ssh`'d into it before, yes.)"**

Then **probe silently** and only surface a prerequisite if it actually fails:

```bash
# seat → the machine you're adding: does SSH already work?
ssh -o BatchMode=yes -o ConnectTimeout=6 <alias> 'echo ok'
```

If it fails, walk **one** missing step in plain terms, then retry — don't recite a
pipeline:

- **Can't reach it at all / permission denied** → "This machine needs to accept
  connections: turn on Remote Login (macOS: System Settings › General › Sharing) or
  sshd (Linux), and it needs to trust this computer's key. Tell me when it's on and
  I'll retry." (Behind the scenes: enable the service, append this machine's public
  key to the target's `~/.ssh/authorized_keys`, add a `Host <alias>` block to
  `~/.ssh/config`.)
- **No SSH alias** → add the `Host <alias>` block only if SSH is the chosen
  connection method.

## Step 5 — how the machines connect (transport), by OS

Recommend **Tailscale** when the machines may be on different or changing networks.
It provides private reachability without router port-forwarding. If it is not
installed or signed in, direct the user to [Tailscale's install guide](https://tailscale.com/kb/1017/install)
and pause until setup is complete. Use **SSH** for a trusted reachable network or
when the user prefers SSH:

- Before relying on Tailscale, verify both machines are online in `tailscale
  status` and the peer's MagicDNS name resolves. Do not ask the user to expose a
  port publicly, use `tailscale funnel`, or configure router port-forwarding.

**Per-OS reality of the steady link** (the machine being added is what matters):

| Machine being added | Steady auto-reconnecting link | Guardrail |
|---|---|---|
| macOS | managed background service (installed automatically) | the clean path |
| Linux / WSL | **not auto-wired yet (#1260)** — guard + settings install, but no managed link | see Step 7 — install a supervised link and verify it survives a drop, or make the Linux box home base |

WSL counts as a Linux machine (Amicode runs inside the WSL host).

## Step 6 — confirm, then drive the enroll (one machine, one confirmation)

Show the exact action for this one machine and get an explicit yes. No confirm, no
enroll.

**Window onto home base (the common case).** Redeem home base's join token on the
new machine. The token lives on home base at `~/.amico/ops/fleet/join-token.json`
(minted when home base was set up); get it onto the new machine, then:

```bash
amico fleet enroll --join-token ~/.amico/ops/fleet/join-token.json \
  [--transport-hint tailscale]   # add only for a roaming machine
```

The verb runs the whole thing: build check → link config → register → install the
guard/link → confirm. Read its JSON verdict (Step 6a).

**Its own studio (peer, recommended).** There is no turnkey wizard yet — guide it: on the new
machine run **Amicode: Fleet — Go Standalone** (it runs its own engine), then have
it advertise itself (`serving`) and point the directory pointer
(`~/.amico/ops/fleet/keeper.json`) at the roster host so both machines see each
other with an **Attach** control. Explain that each machine runs its own engine
and session activity and prompts sync between machines in near real time.

### Step 6a — read the verdict, but trust the real link

The enroll JSON reports `json.result.verify_attach.ok`. Treat that as
**necessary but not sufficient** — it probes home base's public address directly,
which is **not** the path the new machine will actually use. Confirm the link the
machine truly depends on, **from that machine**:

```bash
ssh <alias> 'curl -fsS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<port>/global/health'
# 200 = the real link works.  (For a Tailscale machine, probe its
# https://<magicdns-name>/global/health origin from the machine instead.)
```

If enroll returned `json.ok: false`, the actionable fix is at **`json.fix`**
(top-level) — surface it in plain terms, clear it (usually sleep, a missing alias,
or Tailscale down), and retry. A registered row whose real-link probe fails is
**not** linked yet — say "almost — it registered but couldn't actually reach home
base," never "done."

## Step 7 — Linux / WSL: give it a link that stays up

If the machine you added is Linux or WSL, the auto-reconnecting link is not wired
yet (#1260). Don't leave it on a one-shot forward that dies on the next sleep or
reboot. Install a supervised link the machine runs itself and **verify it
recovers**:

```bash
# a user-level systemd service that keeps the SSH forward up (preferred), OR:
autossh -M 0 -N -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:<port>:127.0.0.1:<port> <home-base-alias>
```

Then prove it: kill the link once and watch it come back within ~30s. If the user
would rather not run a supervised link, offer the low-friction alternative —
**make the always-on machine home base** and add the other as the window.

## Step 8 — prove it works, then say so plainly

A machine isn't "added" until the two actually share a studio. Prove it end-to-end,
then give a felt confirmation — not a status table:

1. Create a throwaway session on home base.
2. Confirm it appears from the new machine through the link
   (`GET /amicode/fleet/sessions`, or just look in the app on that machine).
3. Delete the throwaway.

Then: **"Done — your MacBook and workstation now share one studio. Open a chat on
either and you'll see the same sessions."** If anything above didn't hold, don't
declare victory — name the one thing still blocking it and hand off to
`/troubleshoot-fleet`.
