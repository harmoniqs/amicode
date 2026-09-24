# ADR 0025 — Remote-SSH as the default fleet posture; the thin client as the degraded lifeboat

- **Status:** proposed
- **Date:** 2026-09-19
- **Context refs:** ADR 0005 (managed fleet — **this ADR partially supersedes its Remote-SSH
  rejection**), ADR 0024 (pluggable transport under the thin client — **this ADR recasts, does
  not retire, that work**), ADR 0002 (loopback graft / mutation refusal), ADR 0020 (standalone
  survives reload). Program: #792 (thin-client PRD, merged), #1258 (durable hub, merged), #1260
  (pluggable transport, merged), #780 (posture, merged), #1267 (FileSystemProvider host mount).
- **Supersedes:** ADR 0005 lines 24–27 and 56 (Remote-SSH "rejected as the primary pattern" /
  "wrong workflow") — overturned as a *direction*, gated as a *rollout* (see Sequencing).

## Context

ADR 0005 rejected Remote-SSH "as the primary pattern" with one specific reason (`0005:24-27`):

> "Remote-SSH moves the user's whole editing context to the server (rejected as the primary
> pattern — 'chat on the laptop about the laptop's files' breaks)"

and listed it again under Considered (`0005:56`): *"Remote-SSH pivot (zero fleet code, wrong
workflow)."* That objection assumed a **laptop-centric** workflow: the editing context is local,
so moving it to the server would split chat (local) from files (remote).

**The thin-client program inverted that assumption.** The merged work (#792/#1262: host-owns-all-
state; #1258: durable host service; #1260: the transport carries the *full* data plane per
`0024:69-72`) makes the product **host-centric**: chat, sessions, `/amicode/*`, the event stream,
and the terminal all resolve to the host. The workflow is now "work *on the host* from a thin
panel" — which is exactly the workflow Remote-SSH is built to serve, and it delivers natively what
the thin client cannot: language servers, the integrated terminal on the host, debug, source
control, native search, and the **native Explorer showing host files** (the split reported by the
user; #1267 is the thin-client's partial answer, and an honestly hollow one — a virtual-scheme
mount carries files but none of that tooling).

**The honest counter, which gates this decision.** ADR 0024 documents the fleet link as genuinely
fragile (`0024:26-35`): at ~750 ms RTT a healthy hub is *unattachable* against a 1.5 s budget
(#777); SSH `-L` collapses under loss (TCP-over-TCP); a network roam drops every stream. Remote-SSH
puts the *entire* editor on that link, and when the link degrades it freezes everything (the
extension host is on the far side), which is **worse** than the thin client — whose whole reason to
exist is to keep the local shell alive on a bad link. So Remote-SSH is the better default **only
when a degraded link falls back to the thin client**, and that fallback is not yet buildable
(`extensionKind: ["workspace"]` puts the switch sensor on the dead far side of the link).

## Decision

1. **Adopt Remote-SSH as the *target* default fleet posture** for a client attaching to a host —
   the "as if working on the host locally" experience (native Explorer, LSP, terminal, debug, git,
   search on the host).
2. **Recast the merged thin-client program as the degraded / roaming lifeboat**, not the default
   and not waste: it is the posture the product falls back to when the link cannot carry a live
   Remote-SSH session. Everything merged for #792/#1258/#1260/#780/#1264 serves the lifeboat.
3. **Gate the default flip behind its prerequisites (Sequencing).** Until they land, **Remote-SSH
   is opt-in and the thin client remains the shipping default** — this ADR sets direction and
   sequence, it does not flip the default on merge.

## Sequencing (the flip is earned, not declared)

- **P1 — the lifeboat shows host files (#1267, filed).** The `amico-host://` FileSystemProvider +
  honest capability label, so dropping to the thin client keeps host files in the native Explorer.
  Ships first; independent of the default flip.
- **P2 — a UI-kind extension split.** A companion component that runs on the *client* even under
  Remote-SSH (where `extensionKind: ["workspace"]` otherwise puts everything on the host), giving
  the link sensor an invariant local home. Prerequisite for any auto-switch; the critics' blocking
  finding was that without it the auto-DOWN sensor sits on the dead far side of the link.
- **P3 — posture-driven switch.** Auto-DOWN to the lifeboat on sustained link loss; prompt-UP to
  Remote-SSH on sustained recovery. Reuses the merged link-health detector (`fleet_posture.ts`,
  founding case "750 ms plane wifi"), retuned for a window-reopen (not a status-bar popup), with a
  switch-frequency floor, a dirty-editor guard, and cross-scheme editor-URI carry. The chat is
  continuous across the reopen because it is host-owned (#1262); the host-file view is continuous
  because both postures show host files (native `file:` under Remote-SSH, `amico-host://` under the
  lifeboat).

**Only when P1–P3 are in does the default flip to Remote-SSH.** If P2 proves infeasible, the flip
does not happen (see Flip/abort).

## Invariants held

1. **Loopback-only bind + mutation refusal (ADR 0002/0005).** Unchanged in both postures: under
   Remote-SSH the host runs the engine/service on `127.0.0.1` (VS Code's remote channel is the
   transport); under the lifeboat the transport providers proxy to loopback per `0024:76-79`.
   Remote-SSH does **not** introduce a non-loopback bind.
2. **Never-fork (ADR 0005).** A client still holds no engine and no store in either posture.
   Remote-SSH runs the engine on the *host*, adopting the durable hub service (#1258); it does not
   spawn a client-side shard.
3. **One topology reader (ADR 0023).** The posture machinery reads the projection; this ADR adds no
   second reader.
4. **Window-mode is a separate axis from link-health posture.** `FleetPostureMode`
   (fleet/degraded/standalone) is single-writer, transition-only; "which window mode am I in"
   (Remote-SSH vs lifeboat) takes its **own** field — never an overload of the link-health mode.
5. **No silent fallback.** An unreachable host is the honest degraded posture; the switch to the
   lifeboat is an explicit, surfaced transition, never a silent reroute.

## Consequences

- **ADR 0024 is recast, not retired.** The pluggable transport (ssh/tailscale/direct), the durable
  hub, the SSE resume, and the `/amicode/*` proxy become the lifeboat's machinery. `tailscale`
  gains importance: a roaming client that wants to *stay* in Remote-SSH on a changing network is
  best served by WireGuard connection migration, so the transport seam serves Remote-SSH too, not
  only the lifeboat.
- **A new dependency on VS Code Remote-SSH** as a first-class, tested posture: the durable hub
  (#1258) must be reachable as a Remote-SSH target; the extension must behave correctly when it
  relocates to the host (it already declares `extensionKind: ["workspace"]`, as devcontainer/WSL
  already exercise).
- **The chat webview rides the Remote-SSH channel** in the default posture: on a good link this is
  fine; on a bad link it is the reason P3 exists. This ADR does not claim Remote-SSH makes chat
  *faster* on a bad link — it does not; it claims the *default* experience is richer on a good link
  and that the product degrades honestly to the lifeboat on a bad one.
- **The reported file-surface split is closed twice over:** natively under Remote-SSH (the default),
  and via the FSP mount under the lifeboat (#1267).

## Flip / abort conditions

- **Abort the default flip if P2 (the UI-kind split) proves infeasible.** Remote-SSH then remains a
  documented opt-in posture and the thin client stays the default — the lifeboat becomes the whole
  story, and this ADR's direction is not realized. This is a real possible outcome, stated up front.
- **Retire the provider seam if opencode upstream gains native remote-attach with identity + auth**
  (inherits ADR 0005's and ADR 0024's flip condition — adopt rather than maintain).
- **Keep `ssh` as the lifeboat floor** if `tailscale serve` proves worse in practice (inherits
  `0024:116-117`).

## Accepted costs

- Two first-class postures to test and surface, plus the switch between them — mitigated by
  sequencing (P1 ships alone; the default flip waits for P2/P3) and by reusing the merged detector
  rather than forking one.
- Remote-SSH's own connect/reconnect UX and host-side server install become part of the supported
  surface.
- The merged thin-client program is demoted from "the remote story" to "the degraded story" — an
  honest re-scoping of recent work, recorded here rather than smuggled.

## Considered

- **Keep the thin client as the default; Remote-SSH opt-in only (the review's recommendation).**
  Rejected as the *direction* per the human decision to pursue the richer host-native default — but
  retained verbatim as the **abort state** if P2 is infeasible, and as the shipping state until
  P1–P3 land. The disagreement between this ADR and the review is therefore about sequencing and
  end-state, not about what ships first (#1267 ships first either way).
- **Flip the default to Remote-SSH now.** Rejected: without P2/P3 a bad link freezes the editor with
  no lifeboat — the exact fragility (`0024:26-35`) the thin client was built to survive.
- **A virtual FS (#1267) as the whole answer, no Remote-SSH.** Rejected as the end-state: a
  custom-scheme mount is a hollow host surface (no LSP/terminal/debug/git/search); it is the
  lifeboat's file bridge, not the host-native experience.
