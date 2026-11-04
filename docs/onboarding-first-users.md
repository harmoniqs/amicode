# Onboarding runbook: adding Jackson and Brad as the first two hub users

Companion to ADR 0041 (central hub). Adds the first two real users — Jackson Turner
(`jacktrnr`) and Brad Cole (`bc037`) — to the Harmoniqs hub without widening the
proprietary-software access lock (four people: aarontrowbridge, jacktrnr, bc037,
loganwillits). No org changes, no new repo grants. Every step below is a HUMAN step;
the agent must not run them.

## Prerequisites (human)

- Hub host applied and healthy (terraform module `hub_host`, PR for #1887 merged + applied).
- `armonia init --lab harmoniqs` completed on the hub; agent user + sandbox in place.
- Tailnet policy snippet from ADR 0037 applied (tag:armonia-hub accepts lab members).
- Frontdoor published via `tailscale serve` on the hub (MagicDNS URL reachable).
- People registry seeded with Aaron (so the hub is usable by at least one person).
- `armonia-init` available on each laptop (PR #2106).

## Per-user steps (repeat for Jackson, then Brad)

### 1. Tailnet admission
1. Send the user the join link / QR from `armonia init` (or `tailscale up` with a tagged,
   short-lived auth key scoped to `tag:armonia-hub` member).
2. User installs Tailscale on their laptop and authenticates via the institution SSO.
3. Verify the device appears in the tailnet admin with the right tags and that
   `tailscale status` on the laptop shows the hub's MagicDNS name.
   - Check: `tailscale ping <hub>.<tailnet>.ts.net` succeeds from the laptop.

### 2. Person principal in the hub people registry
1. On the hub (as admin, via SSM/EIC): add the person record:
   - id: `jacktrnr` / `bc037`
   - display name: Jackson Turner / Brad Cole
   - credential kind: person
   - deployment: harmoniqs
2. Verify: an unauthenticated request to the frontdoor is rejected (401/403); a request
   carrying a forged `Tailscale-User-Login` header from a non-loopback peer is rejected
   (#1958 test). The user's own requests resolve to their principal.

### 3. Lab membership
1. Add membership record: environment `harmoniqs` × person `jacktrnr`/`bc037` × role
   (member; admin only for Aaron).
2. Verify: the user sees only sessions/environments they belong to; they cannot see Aaron's
   private sessions or other labs. `#1876` membership filter holds.

### 4. Vault via armonia-init
1. On the laptop: run `armonia init` (or the extension's hub-join flow) against the MagicDNS
   URL.
2. Select which folders to share with the hub (default: none). Confirm the "Shared with <hub>"
   view lists exactly those.
3. Verify: no ports, keys, or settings files are involved; the laptop-side audit log records
   the hub's requests.

### 5. Working copy + first session
1. User opens a chat session against the hub; verify the session owner is recorded as them
   (#1875 attribution).
2. Run a trivial solve end-to-end; verify the run dir + receipt record carry their principal
   and Lab, and that cost rolls up under them.

### 6. Budget
1. Confirm the user's Lab/person budget is seeded from the input file (Aaron edits only).
2. Verify a run stops when the budget is exhausted (fail-closed, #1880).

## Verification checklist (human)

- [ ] `tailscale ping` hub succeeds from both laptops.
- [ ] Forged-header request rejected (test from #1958).
- [ ] Missing-header request rejected.
- [ ] User sees only their Lab's sessions.
- [ ] First solve attributes owner + principal + Lab on session, run dir, receipt.
- [ ] Budget enforcement observed (or at least configured and dry-run).
- [ ] No org membership, repo grant, or proprietary access changed (verify with
      `gh api` effective permissions; compare to lockdown baseline).

## Rollback: return a user to their local engine

If the hub is not ready or a user needs to leave:

1. On the laptop: switch the extension back to local engine (settings → engine target → local).
2. Remove the user's person record and membership from the hub people registry (admin step).
3. Revoke the Tailscale auth key / remove the device from the tailnet (admin, one click in
   the Tailscale admin console).
4. The user's local engine + vault remain untouched; their sessions created on the hub stay
   in the hub DB (export if needed before removal).
5. No org or repo access changes to revert — the hub never touched them.

## What this runbook does NOT cover

- Adding Logan or additional users (same procedure; gate behind the first two succeeding).
- Partner/paying labs (get their own hub until isolation slices land).
- Real-hardware (Strumento) access — lab-side gate must be enforced first.
EOF
