---
name: troubleshoot-fleet
description: Diagnose and repair a researcher's Amicode fleet when something is wrong — the machines have stopped acting like one studio, a link dropped, sessions went missing, or a boot warning fired. Reads the fleet's real state, gives ONE plain-language diagnosis and ONE next action, prefers the in-app repair, and escalates only genuinely deep/rare surgery to the internal fleet playbook. Use when the sidebar "Troubleshoot" button or the boot-time fleet warning lands here, or when a user says their fleet is broken / "works on one machine but not the other."
agents: []
surface: public
---

# Troubleshoot a Fleet

**Announce at start:** "Let me take a look at your fleet."

The repair front door for a researcher's multi-machine studio. The shipping app
already routes here: the sidebar **Troubleshoot** button and the boot-time fleet
warning both open a `/troubleshoot-fleet` session — so the person on the other
end usually has a fleet that *just broke*, not a spare afternoon to read
diagnostics. Your job is to find what's wrong, say it in one plain sentence,
offer one action, and only escalate to deep surgery when the simple fix fails.

This skill **diagnoses and repairs**; it does not build fleets (that is
`/create-a-fleet` and `/add-fleet-device`). It is the public, researcher-facing
front door — the deep operator playbook (`/fleet`: chat-database recovery, shard
merges, the team mesh) is an internal card you escalate to at the very end, never
the first thing a novice sees.

## How to talk about this (read before you open your mouth)

The words below are how the *code* names things; they are **not** how you talk to
a researcher. Translate every time — the raw term stays in the commands you run,
never in what you say:

| Internal term | Say instead |
|---|---|
| hub / server / canonical | "home base" — the machine that hosts your work |
| client / thin client | "a window onto home base" |
| standalone | "working on its own" |
| tunnel | "the steady link between your machines" |
| guard | (don't mention it — it's plumbing) |
| verify-attach / roster / health | "whether the link actually works" |
| transport (ssh/tailscale) | "how the machines reach each other" |

A caveat is one sentence, in plain outcomes, immediately followed by the choice
it changes — never a bare disclaimer, never a wall of internals.

## The posture: detect → one diagnosis → one action → escalate last

1. **Detect** — read the real state (below). Do the reads silently; the user does
   not want a running commentary of `curl`s.
2. **Diagnose** — lead with ONE plain sentence: what broke and the most likely
   cause. "Your laptop lost its steady link to the workstation — most likely the
   workstation went to sleep."
3. **Act** — offer ONE next action, and **prefer the in-app button** over a shell
   command: **Fleet — Repair**, **Restart Hub Server**, **Go Standalone**, **Open
   Fleet Manager** (all in the Command Palette). Drop to a terminal only when no
   button covers it.
4. **Escalate last** — only if the simple fix fails and the symptom is genuinely
   deep (missing chat history, a corrupted or forked database, a merge) do you
   hand off to the internal `/fleet` playbook — and you say plainly that you're
   going one level deeper.

Never dump a check name, a `plist` path, `ServerAliveInterval`, or a raw error
string at the user. Those are yours to read, not theirs to parse.

## Step 0 — know which machine you are on (this is the #1 source of wrong answers)

You run on exactly **one** machine (check `hostname`). Every check against *any
other* machine is an SSH hop — you must wrap it in `ssh <alias> '…'`, or you will
accidentally test the wrong machine and call a broken link healthy. When you run
a cross-machine probe, run it inside `ssh` and keep the command you used so you
can show your work if asked.

- If the fleet has a **home base** (a `server`) and you're on it, the other
  machines reach you through the link — to test *their* side you must `ssh` into
  them.
- The fleet port is almost always **4096**. Read the real one from
  `~/.amico/ops/fleet/fleet.json` (`canonical.port`) before assuming.

## Step 1 — read the real state (silently)

Run the app's own health read first — it is the fastest honest picture:

- **In-app:** Command Palette → **Amicode: Healthcheck**. It reports the fleet
  role, the guard, the machine settings, and the link (the tunnel), with a fix
  line on each failure. The four fleet checks only run in full on a machine that
  is a window onto home base (a `client`).
- **The status snapshot** (written on home base every few minutes):
  `~/.amico/ops/fleet-status.json` — per-device reachability, the chat DB
  (session count + last-updated), the server-guard state, vault-sync age, repo
  drift. A good first glance at "what does home base think is true."
- **The roster** — the list of known machines and each one's claimed health.
  Read it, but see the honesty note next.

**Truth is the runtime endpoint, not the roster and not "verify-attach."** Two
traps, both real in the current build:

- A machine's roster **health is a self-asserted claim** — its heartbeat stamps
  `reachable` on a timer whether or not the link is actually up. A machine that
  died an hour ago can still read `reachable`. So **cross-check freshness**
  (treat a `last_report` older than a few minutes as stale, not reachable) and,
  when it matters, **re-probe the real path** yourself.
- The link a machine *actually uses* is its own loopback, not the public address.
  To prove a window-onto-home-base machine can really reach home base, probe the
  endpoint it truly dials, **from that machine**:

  ```bash
  # from the client (ssh in if you're not on it): does home base answer on the link?
  ssh <client-alias> 'curl -fsS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<port>/global/health'
  # 200 = the link works. Connection refused / timeout = the link is down.
  ```

  For a machine that reaches home base over Tailscale, the real endpoint is the
  `https://<magicdns-name>/global/health` origin instead of the loopback — probe
  that, from the client. (A machine that only checks the public `host:port`
  directly can look healthy while the link it depends on is dead — don't trust
  that probe.)

## Step 2 — match the symptom (one diagnosis, one action)

| What the user sees / the state shows | Say (plain) | Do (prefer the button) |
|---|---|---|
| "Go standalone?" popup; the link keeps dropping | "Your machine lost its steady link to home base — usually home base slept or restarted." | Confirm home base is awake, then **Restart Hub Server**; if it can't come back now, **Go Standalone** to keep working locally. |
| A banner: running on a local engine, "hub down" | "Home base is unreachable, so this window fell back to its own local copy. Your shared sessions are on home base." | Bring home base back (**Restart Hub Server** / wake it), then reload the window to rejoin. |
| A machine shows a row but the link never confirmed | "This machine got half-linked — it registered but couldn't actually reach home base to confirm." | Re-run the join (`/add-fleet-device` re-drives it); read the exact fix it reports and clear that first (usually sleep, a missing SSH alias, or Tailscale down). |
| Boot warning "fleet issue"; guard/settings/link drift | "Your machine's link setup drifted out of sync." | **Fleet — Repair** (re-installs the link + settings from source; idempotent). |
| Sessions look wrong / a machine seems to have its *own* private history | Likely a silent fork — see **Step 3**. | Detect the fork first; do NOT reload blindly. |
| Version/pin mismatch on join | "The two machines are on different Amicode builds." | Get both on the same build (**Repo Sync**, then rebuild/reload), then re-join. |
| "attached server unreachable" / a peer won't load | "The other machine isn't reachable right now over the way it's set to connect." | Check that peer is on and reachable by its set method; re-probe its real endpoint (Step 1). This is an honest "it's off," not a bug. |
| Approval prompts on every fleet action | "VS Code is asking permission for each fleet file it touches." | It's a one-time settings fix; offer to walk it (allow the external directories in the opencode config), then it stops. |

## Step 3 — transport & OS-specific failures (the cross-machine gotchas)

The link is set up differently per machine, so the fix depends on the machine's
OS and how it connects:

- **SSH link down (the common case).** The steady link is an SSH forward. If it
  won't stay up: confirm the SSH alias still resolves and reaches the machine
  (`ssh -o BatchMode=yes -o ConnectTimeout=6 <alias> 'echo ok'`), and that home
  base has Remote Login (macOS) / sshd (Linux) on. Re-establish with **Fleet —
  Repair**.
- **Tailscale link down.** If a machine connects over Tailscale, `tailscale
  status` must show *both* machines online and MagicDNS must resolve, and home
  base must be sharing its engine over the tailnet with `tailscale serve` — **not**
  `tailscale funnel`. This matters for safety, not just reachability: home base
  trusts the link itself as the boundary, so it must stay on the private tailnet
  (`serve`) and never be exposed to the public internet (`funnel`) or bound to a
  public address. If Tailscale is down, the honest move is to fall back to the
  SSH link.
- **Linux / WSL window-onto-home-base machine — the known gap (#1260).** On macOS
  the steady link is a managed background service that auto-reconnects. **On Linux
  and WSL that managed link is not wired yet (#1260)** — the app installs the
  guard and settings but no auto-reconnecting link — and the app's link health
  check reports "skipped" there, so it can look fine while there's nothing keeping
  the link up. If a Linux/WSL machine keeps dropping to local-only after a sleep,
  a network blip, or a reboot, that's this gap, not user error. The durable fix is
  a supervised link the machine runs itself; instruct the researcher to install a
  user-level `systemd` service (or a supervised `autossh` / `ssh -o
  ServerAliveInterval=15 -o ExitOnForwardFailure=yes -N -L 127.0.0.1:<port>:127.0.0.1:<port> <home-base-alias>`),
  then confirm it survives by killing the link once and watching it come back. Say
  the gap plainly and offer, as the low-friction alternative, making that Linux
  machine home base instead (so the always-on machine is the host).

## Step 4 — silent fork detection (why "reload" is not always safe)

The whole point of a window-onto-home-base machine is that it **never runs its own
copy of the engine** against a private database — two live writers on one database
is the corruption case. When a window machine silently spawns its own engine, it
grows a private history and the two machines quietly diverge. Detect it before you
tell anyone to reload:

```bash
# on the suspect window machine (ssh in if needed), on the fleet port:
#   macOS:
ssh <alias> 'lsof -nP -iTCP:<port> -sTCP:LISTEN'
#   Linux/WSL:
ssh <alias> 'ss -ltnp "sport = :<port>"'
# an `opencode` process listening (not `ssh`) = a local fork holding the port.
# corroborate with the auth tell:
ssh <alias> 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<port>/session'
# 401 on a window machine = an armed LOCAL fork; home base answers 200 (anonymous).
```

If you find a fork, the fix is to stop the fork, restore the guard + link
(**Fleet — Repair**), and — if the forked copy grew real history the user cares
about — hand off to `/fleet` for the recovery, which knows how to merge a
stranded database safely. **Never** "just reload" over a fork: you would either
lose the forked history or keep two writers alive.

Home base itself keeps its shared database at `~/.amico/server/session.db` and
runs as the `co.harmoniqs.amico-hub` service (a launchd agent on macOS, a
`systemd --user` unit on Linux). If home base's history looks empty or wrong,
that is a home-base problem, not a window-machine fork — go to `/fleet`.

## When to escalate to the internal `/fleet` playbook

Escalate — and tell the user you're going one level deeper — only for the
genuinely deep, rare cases:

- **Missing or wrong chat history** on home base (needs shard triage / a merge).
- **A confirmed database fork** with history worth recovering.
- **Vault-sync conflicts**, settings-sync clobbering a machine, or the team's own
  multi-machine mesh specifics.

Everything else — link down, drift, half-linked machine, standalone/rejoin, a
peer that's simply off — you resolve here. If a simple fix didn't hold after one
honest attempt, say so plainly and escalate; don't loop on the same button.

## Close the loop

When you've fixed it, prove it in the user's terms, not with a status table:
"Fixed — your laptop can see home base again. Open a chat and your shared sessions
are back." If you couldn't fix it, say exactly what's still wrong and the one
thing that would unblock it (a machine to wake, a build to match, the #1260 gap),
and — when it fits — offer the escape hatch of working on this machine alone for
now.
