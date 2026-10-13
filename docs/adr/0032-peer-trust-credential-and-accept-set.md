# ADR 0032 — Peer-trust credential and the accept-set: replacing server `auth=open`

- **Status:** proposed (review: manual adversarial critics — `amico spec review` tooling absent on this machine; see the design-of-record PRD for the recorded review round)
- **Date:** 2026-09-22
- **Context refs:** ADR 0002 (per-boot server password), ADR 0005 (managed fleet / Fleet
  token), ADR 0026 (host-owned roster), ADR 0027 §7 (the **declared, not-built** peer-trust
  credential — D10b — **promoted to built here**), ADR 0031 (Fleet Studio — the consumer),
  `#955` (the `auth=open` service posture on servers), `#1267` (the host write-route gap).

## Context

Today the fleet's trust boundary is the **transport**, not an application token. On a
`server`, the amicode service runs with **`auth=open`** behind the SSH/tailscale tunnel
(`#955`), and the engine itself validates a **single per-boot password**. The **Fleet
token** (ADR 0005) is a **shared secret** — every machine authenticates to every peer with
the same value — which means distrusting one machine requires **re-minting and re-enrolling
the whole fleet**. There is no per-machine revocation, no least-privilege scoping, and no
attribution: to a peer, every caller looks identical.

ADR 0027 §7 anticipated this and **reserved** — but explicitly did **not build** — a
per-peer, separately-mintable and separately-**revocable** *peer token*, keyed by
`machine_id`, as the distinct trust act for peer-to-peer engine access (deliberately *not*
the Fleet token, which guards *enrollment*, and *not* the UI client mint, which authorizes
*a human's window*).

Fleet Studio (ADR 0031) makes this necessary now: it drives **full session interaction**
(read + write + tool execution) across every serving peer. The researcher chose to build
the real thing — per-peer revocable trust, validated at the boundary — rather than reuse
the shared secret.

## Decision

### §D1 — The peer-trust credential

Each **serving** machine mints a **per-peer, separately-revocable token** granting access
**to itself**, keyed by the requesting machine's `machine_id`, and records each issuance in
a **revocable issued-token registry** (`~/.amico/fleet-peer-tokens.json`, `0600`, atomic
via the shared credentials writer). Revocation = drop the registry entry. This is the
credential ADR 0027 §7 (spec D10b) reserved — **not** the Fleet token, **not** the UI client
mint. The **reader** side stores each target's token in a **dedicated peer-token store**
(mirroring the minter registry), **not** the existing `attachment_credential.ts` store —
whose own header explicitly disclaims the peer-trust identity ("NOT the Horizon-2
peer-trust identity … explicitly NOT built here"). Overloading one store with two
credential kinds of different lifecycle risks a revoke clearing the wrong entry; the two
stores stay distinct (or `attachment_credential.ts` is generalized *and its contract note
updated* so the kinds are distinguishable at read time).

### §D2 — The accept-set replaces full `auth=open`

The server's `/amicode/*` + engine boundary stops being fully open and instead validates
every caller against an **accept-set**:

```
accept ⟺ caller presents  (local service/engine mint)
                        OR (a non-revoked peer token from the issued-registry)
                        OR (the transitional hub credential)   [until §D3 close]
                        OR (the enrollment nonce — the /…/peer-token MINT ENDPOINT only, §D4)
```

Every accepted credential is thus a **named** accept-set member — including the mint
endpoint's enrollment nonce, enumerated here so the mint-honesty invariant below holds
literally rather than by prose exception. The framed app authenticates with the local mint
(its `?auth_token=`), so it is unaffected.

**Two boundaries, one accept-set.** Peer traffic terminates at the loopback port the
transport forwards to; whichever process owns that port — the extension `amicode_service`
(`authorized()`) and/or the vendored engine's per-boot-password middleware — **both**
implement the *identical* accept-set. A partial rollout (one boundary flipped, the other
not) is the failure this clause forbids: an anonymous request to **each** boundary must be
refused after close (an explicit AC).

Validation is **constant-time and per-request**: the peer-token check iterates the issued
registry with a constant-time compare and no early exit (preserving the existing
timing-safe discipline), and reads the registry fresh enough that a revocation takes effect
on the immediately following request (write-through to any in-memory accept-set, or a
per-request read).

### §D3 — Staged rollout: additive first, then a readiness-gated close

The posture change ships in two steps so a half-migrated fleet can **never lock itself
out**:

1. **Additive** — the boundary begins **accepting** peer tokens *in addition to* `auth=open`.
   Nothing breaks; peer-token auth starts working.
2. **Close** — the boundary flips to **require** an accept-set member, gated on a
   **precise, single-vocabulary, locally-observable readiness predicate**:

   > Resolve every roster row with `capabilities ∋ serving` **and** `health = reachable` to
   > its `machine_id`. Close is permitted **iff**, for every such `machine_id`, **both** this
   > machine's issued-token registry **and** this machine's reader peer-store contain a
   > non-revoked entry. A serving row whose `machine_id` cannot be resolved **refuses** close
   > (never satisfies it vacuously). A serving peer not yet in the roster likewise **blocks**
   > close (it is not stranded — it is waited for).

   Both sides of the comparison are keyed on **`machine_id`** (the roster's alias/`peer_origin`
   is resolved to `machine_id` first) — never a mixed-vocabulary join. The predicate is
   **local**: it reads only this machine's two stores, so "closeable here" is a fact this
   machine can prove without querying peers. (Fleet-wide mutual reachability is achieved by
   *each* machine gating its own close on the same local predicate — not by one machine
   asserting the whole mesh.) At close, the **transitional hub credential is withdrawn** in
   the same step — after close, only the local mint and non-revoked peer tokens are accepted
   (the mint endpoint's enrollment nonce excepted, §D4).

Until the gate passes, the posture stays additive-open. A **documented rollback** re-opens
the additive posture if a peer is stranded post-close. Both the readiness gate and the
rollback are explicit acceptance criteria of the slice, not afterthoughts.

### §D4 — Distribution: mutual exchange at enroll + heartbeat reconcile

Peer tokens are exchanged **mutually at `amico fleet enroll`** and **reconciled on the
heartbeat** when a new serving peer appears (via the existing `pushToPeers` transport
dispatch), so the fleet converges with no manual step. Token material is exchanged **only
over an authenticated, encrypted transport** (SSH / tailscale); a plaintext `direct` hop is
refused for token exchange.

**Bootstrap without a standing skeleton key.** A joining machine obtains its first peer
token via a **short-TTL, single-use enrollment nonce** minted for that specific join — *not*
the standing Fleet token. This closes the revocation hole: if the bootstrap were the
long-lived, machine-scoped Fleet token, a **compromised** machine could simply re-mint a
fresh peer token after `revoke`, defeating containment (the exact case §Consequences
names). The mint endpoint therefore (a) accepts only an unexpired, unused enrollment nonce,
and (b) **refuses to mint for a `machine_id` that appears on any peer's revocation list** —
so revoking a machine also bars its re-enrollment until an operator explicitly re-admits it.

### §D5 — Revocation and rotation surface

`amico fleet revoke <machine_id>` drops the entry (a revoked token 401s on its next
request; the reader surfaces that peer distinctly as **revoked** — a `NoPermissions`
outcome, never conflated with an unreachable peer's `HubDown`, so a suspected compromise
reads as revocation, not an outage). A Fleet Manager control mirrors it.

**Fleet-wide expulsion is a fan-out, not one write.** Because a machine is the single writer
of the registry granting access **to itself** (invariant below), expelling machine X means
**every** serving peer drops *its own* issued entry for X. `amico fleet revoke <machine_id>`
therefore **fans the revocation out** to each peer (each peer applies it to its own
registry; no machine writes another's), and X is added to the revocation list §D4's mint
endpoint consults. The Consequences headline is read accordingly: "revoke a machine" is a
fan-out of per-registry drops, not one atomic entry deletion.

Rotation is **on demand / on re-enroll**; a scheduled rotation is not built for v1
(revocation, not rotation cadence, is the load-bearing property).

### §D6 — Scope: full session interaction, shaped for reuse

The peer token grants **full session interaction** on the owner's engine — the *same plane
the agent already uses* (`file.read`/`file.write`, prompts, tools, SSE). Its write reach is
therefore the agent's: **arbitrary-path write** on the owner (the engine handler
mkdir-creates outside the workspace). Fleet Studio's *human* Preview write path is
deliberately narrowed **below** that by a server-side workspace-relative gate (ADR 0031
§D7); the peer token itself is not so narrowed, so a leaked peer token is shell-equivalent
on its owner — state it plainly rather than as "no new blast radius."

The minted token carries an explicit **scope claim** shaped so the Horizon-2 engine↔engine
RPC (ADR 0027 §7) can reuse the same credential without re-plumbing. **In v1 the scope claim
is recorded but inert** — the accept-set (§D2) checks membership only and does **not** read
it, so every non-revoked peer token grants the full plane regardless of the claim (the same
"declared-but-inert" posture ADR 0026 gives the `compute` tag). Least-privilege is a
**future** capability the claim enables, not a v1 control.

## Approaches considered

- **Reuse the Fleet token for peer RPC** — rejected (ADR 0027 §7 already rejected it): it
  conflates enrollment trust with peer-interaction trust and has no per-machine revocation.
- **Transport-layer revocation only (deauthorize the SSH key / tailscale ACL), keep
  `auth=open`** — rejected: ADR 0027 §7 specifies an **app-layer** peer token as a distinct
  trust act; transport-layer revocation lives outside Amicode (ssh/tailnet config) and
  cannot express least-privilege or attribution.
- **Build the token but defer the accept-set close** — considered as a smaller first cut;
  rejected as the *end state* because without the close, revocation is not enforced at the
  boundary. Retained only as the additive first step of §D3's staged rollout.

## Invariants held

- **Loopback bind + credentialed upstream (ADR 0002).** Every peer hop stays credentialed;
  the accept-set is the credential check, not a new listener.
- **Local honesty surface (ADR 0027 §4).** `/amicode/fleet/*` and posture surfaces stay
  local; the accept-set never gates them behind a *peer* token (a machine must always be
  able to report its own posture) — but an **external** caller still needs the local mint,
  so "not gated behind a peer token" is not "anonymously readable" after close.
- **No silent mint fallback (the D5 mint-honesty rule).** Every accepted credential is a
  named accept-set member; an unrecognized token is refused, never silently allowed.
- **Single-writer registry.** A machine is the sole minter/revoker of tokens granting access
  to itself.

## Consequences

- Losing/retiring/compromising one machine → **revoke it** (a fan-out of per-registry drops
  plus a mint-list bar, §D5), no fleet-wide re-enroll. Because the bootstrap is a single-use
  nonce and a revoked `machine_id` is barred from re-minting (§D4), revocation **contains a
  compromise** rather than being re-mintable around.
- The peer relationship is **attributable** (per-machine token, not a shared secret).
  Least-privilege is **enabled but inert in v1** (the scope claim is recorded, not enforced —
  §D6).
- A leaked peer token compromises **one** peer relationship — but on that owner it is
  **shell-equivalent** (arbitrary-path write, §D6), so it is not a small credential; the
  human Preview path is narrowed below it (ADR 0031 §D7), the raw token is not.
- Servers stop being fully `auth=open` — a **security-invariant change** with fleet-wide
  reach, which is why the close is readiness-gated and rollback-documented (§D3).
- Horizon-2 engine RPC inherits this credential unchanged.

## Non-goals

- Scheduled/automatic rotation cadence (revocation is the property that matters for v1).
- The Horizon-2 compute-federation executor itself (ADR 0027 non-goal).
- A host-FS write plane over `amico-host://` (ADR 0031 §D7 non-goal).

## Source

Design-of-record: the Fleet Studio PRD (2026-09-22). Consumer ADR: 0031. Promotes ADR 0027
§7 (D10b) from *declared* to *built*.
