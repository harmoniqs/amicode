---
status: proposed
date: 2026-11-04
deciders: Aaron Trowbridge
tags: [armonia, central-hub, identity, lab, spend, ec2, modal]
supersedes: []
related: ["#1872", "#1873", "#1874", "#1875", "#1876", "#1880", "#1882", "#1887", "#1958", "ADR 0031", "ADR 0032", "ADR 0033", "ADR 0034", "ADR 0037", "ADR 0039", "aws-infra#360"]
---

# ADR 0041: Armonia team deployment — central hub, person principals, execution sites, spend plane

## Context

Amicode today is single-tenant: one person's engine, one shared password or open tunnel,
no per-person identity, no membership boundary, budgets that live in prompts, and compute
reached through per-machine paths. Ten Harmoniqs researchers cannot share one engine — see
each other's agents, delegate between them, and run unattended campaigns across HPC and lab
machines — without trusting every caller with everything.

Parent design-of-record: #1872 ("Armonia: one shared coordination service, people as
principals, distributed execution sites"). This ADR records the *central hub* slice of that
design: how Harmoniqs moves onto one central coordination service on EC2, with Modal and
AWS as execution sites, Bedrock reached through an instance role, and spend tracked and capped
per Lab and per person. It is the model for what labs get later; the Lab is the tenant
primitive (members, budget, compute lane, data boundary).

Ground truth (verified 2026-11-04):
- Today's hub is `erlich`, Aaron's workstation (i9-12900KS, 24 threads, 62 GB): frontdoor on
  4096 (loopback only after #1957), three engine shards on 4095/4195/4295 sharing one DB,
  under user systemd. No per-user identity in frontdoor logs; no evidence anyone but Aaron
  connects.
- `aws-infra` has no hub module. Closest template: `cpu_dev_box` (c6i.2xlarge, private
  subnet, SSM/EIC, persistent EBS + AWS Backup, staging only, idle-stop). Bedrock
  least-privilege template: `app_ai_bedrock_gateway`. `budget_alarm` auto hard-cap attaches
  Deny + SCP when net spend passes $50 (prod) / $25 (staging), which would deny Bedrock for
  everyone — so the hub goes in an account/tag scope whose budget is sized for it, coordinated
  with the cloud-launch session's dedicated compute account.
- Compute accounting gaps (`packages/amico-run`): `scheduler.ts` is a serial in-process queue;
  `run.lock` and `ReceiptRecord` carry no principal or Lab; local and Modal runs record no
  cost; there is no Modal executor; the warrant has no dollar field. `session.cost` in the
  chat DB already gives Bedrock spend per session.
- Host spike (#2114): one host is fine up to ~12 concurrent sessions; at 36 latency degrades
  with uptime (#2115). Size and restart-policy the hub accordingly; do not promise more than
  ~12–20 concurrent sessions per hub yet.
- Org access was locked on 2026-11-02 to four people (aarontrowbridge, jacktrnr, bc037,
  loganwillits) for proprietary software. The hub must not widen it.

## Decision

### 1. Topology: EC2 hub, execution sites elsewhere

**Chosen: a central EC2 coordination host with Modal and AWS as execution sites.** Rejected:
(1) Modal-as-hub — Modal is a compute plane, not a coordination authority; it has no durable
session store, no per-person identity, and no place for a frontdoor. (2) Federated personal
engines (extend Fleet Studio's peer model across people) — preserves local machines but makes
shared state, access enforcement and collaboration depend on every peer being reachable.
(3) One large shared server running every workload — simplest, but experiments and failures
disrupt everyone and isolation is weak.

The coordination authority is a single process on EC2 (the "hub"). Scientific compute, HPC
and lab hardware run at **execution sites** that dial *out* to the hub and lease durable jobs;
sites never accept inbound connections. This matches ADR 0037 §1 (sites are identities by tag,
never by person) and the #1882 execution-site registry.

### 2. Reconciling #1887 and aws-infra#360

These are **complementary, not competing**:
- **#1887 (this ADR's hub slice)** provisions the EC2 host, its instance profile granting
  Bedrock invoke only, persistent EBS + AWS Backup, SSM access, Tailscale, a dedicated system
  user, tags for budgets, no inbound from the internet. It is the *host*.
- **aws-infra#360 (Modal OIDC role)** lets Modal workers assume an AWS role via OIDC to reach
  Bedrock/S3 *without long-lived keys*. It is one *execution site* reaching into AWS.

The hub host never holds AWS keys for Bedrock; Bedrock is reached through the instance profile
(#1887) on the hub and through OIDC-assumed roles on Modal sites (#360). Both are
least-privilege and both are tag-scoped for budgets. Neither widens org access.

### 3. Person principal

Every request resolves to a **Principal** (ADR 0037, #1874). A Person is one kind of
Principal, alongside Site and Machine. The frontdoor authenticates each person against a
deployment-local people registry (#1874) and forwards a *signed* principal; engines reject any
principal they cannot verify, so bypassing the edge grants nothing. Unauthenticated requests
are rejected. Machine credentials never stand in for a person.

Identity transport: Tailscale `serve` injects `Tailscale-User-Login` / `Tailscale-User-Name`
headers; the frontdoor maps them to the person principal, trusting them only on the loopback
hop from `tailscaled` (#1958). OIDC is the later, transport-independent path.

### 4. Lab = environment membership (not editor state)

Research Environments become a server-side membership record: environment × person × role,
with project restriction lists that can only narrow access (#1876). No editor workspace
folders or process env vars in production (ADR 0021). Membership is the knowledge and
visibility boundary; projects may restrict further, never broaden. The Lab is the tenant
primitive: members, budget, compute lane, data boundary.

### 5. Spend plane

- **Pool unit is dollars, one pool** (tokens + hosted solves), reusing the nano-USD
  reservation ledger pattern from `app-harmoniqs-ai` (`inference_accounts`,
  `inference_reservations`). Generalize `budget#{campaign}` → `budget#{submitter}` in
  `solves_api`; settle from `solves_completion_ping` (cloud-launch sibling campaign).
- **Cost attribution:** add principal and Lab to `run.lock` and `ReceiptRecord`; cost every
  local run from CPU-seconds; add a `modal` executor under the gate; roll Bedrock cost up from
  `session.cost` per person and Lab. Label every number "list price, not invoice" until
  reconciled against invoices.
- **Budgets are server-side and fail closed** (#1880): per-Lab and per-person dollar budgets
  checked before every provider turn and every launch. Budgets are an input file that only a
  human edits, seeded from Aaron's credit numbers (~$14k AWS, ~$5k Modal). The model never
  enforces its own budget.
- **Budget scoping vs. the hard cap:** the hub lives in an account/tag scope sized for it so
  the $50/$25 `budget_alarm` auto hard-cap does not deny Bedrock for everyone. Coordinate
  with the cloud-launch session's dedicated compute account.

### 6. Access (do not widen)

Org access stays locked to the four people. Hub access starts with exactly those four plus a
documented way to add a person (onboarding runbook). No change to org membership, 2FA, or
proprietary-repo grants is made by this campaign.

### 7. Capacity and restart policy

Size the hub for ~12–20 concurrent sessions (host spike, #2114/#2115). Restart policy must
account for the latency-degrades-with-uptime finding: schedule periodic restarts inside
maintenance windows, never during live solves (A0 solve-aware restart guard). Do not promise
more.

### 8. Relationship to other ADRs

- **ADR 0037 (trust boundaries)** — this ADR assumes it: Tailscale transport, sovereign
  client, sandboxed agents, `armonia init`/`doctor`. Identity (#1874/#1958) rides the
  frontdoor; authorization stays in Armonia, not in Tailscale.
- **ADR 0031–0034 (fleet: studio, peer trust, per-session SSE fanout, base peer control)** —
  person-scoped grants reuse Fleet Studio's observe/control grant model with person principals;
  machine-scoped grants are unchanged. No new routing authority beyond #1760.
- **ADR 0039 (host)** — host spike results set the hub's size/restart policy; the v2 host
  runs on the hub.
- **ADR 0007 (amicissimo)** — signed artifacts/entitlements are for paying labs later; not
  needed for internal hub.

## Consequences

- A request without a valid person or site credential is rejected at every entry point; every
  accepted request carries a resolved principal.
- Every session and admitted prompt records the authenticated person; attribution cannot be set
  or changed through client-supplied metadata.
- A person sees sessions, events, work requests, artifacts only for environments they belong to.
- Campaigns stop issuing provider turns, tool calls, job submissions when budget/stopping
  condition is reached, regardless of what the model requests.
- Delegated work requests draw from the originator's budget, carry no broader permissions, and
  survive a coordinator restart.
- Execution sites dial out; reconnect reconciles rather than resubmits.
- Hardware authority stays lab-side (Strumento).
- Training eligibility is opt-in per environment.

## Slices (this ADR is the design-of-record for)

- #1873 (this ADR + glossary) — done when merged.
- #1874 identity (frontdoor auth) + #1958 (Tailscale serve + header mapping).
- #1875 attribution (owner/author).
- #1876 Lab membership store.
- #1880 campaign authorization / budgets.
- #1887 hub host Terraform module + instance-role Bedrock.
- Cost ledger (run.lock/ReceiptRecord principal+Lab, local CPU-sec cost, modal executor,
  Bedrock rollup from session.cost) — filed as part of this campaign.
- Onboarding runbook (Jackson, Brad) — filed as part of this campaign.
- #1888 end-to-end acceptance test (needs #1878, #1880, #1881, #1883, #1884, #1887).

## Glossary

- **Person** — a human principal in a deployment's people registry. Has an id, display name,
  credential. Never inferred from a machine or site credential.
- **Principal** — the resolved caller of a request: Person, Site, or Machine. Immutable per
  credential. *Avoid:* using "user" or "account" as a synonym; those imply billing identity.
- **Team deployment** — one coordination authority (the hub) plus its outbound execution sites.
  Exactly one coordination authority. *Avoid:* "cluster", "fleet" (fleet = machines, not people).
- **Membership** — environment × person × role record, server-side. *Avoid:* "access list",
  "workspace membership" (editor state is not membership).
- **Session owner** — the person who created the session; immutable. *Avoid:* "creator" as a
  free-text field.
- **Collaborator** — a person invited by the owner to control a session. *Avoid:* "shared
  session" without an explicit invite.
- **Execution site** — a registered compute/lab/batch node that dials out and leases jobs.
  Identity by tag. *Avoid:* "worker", "agent" (an agent runs *on* a site).
- **Job** — a durable work item leased to a site; reconnect reconciles, never resubmits.
  *Avoid:* "task" (task = delegation record, #1881).
- **Work request** — a durable delegation record (deliverable, acceptance checks, budget slice,
  permission set, assignee). *Avoid:* "subtask", "child session".
- **Campaign authorization** — owner, scope, budget, tool allowlist, device access, stopping
  conditions, consumed totals. Enforced by the server. *Avoid:* "warrant" alone (a warrant is
  the approval artifact; authorization is the live record).
- **Artifact reference** — content-addressed pointer recording custody site, provenance, access
  policy, verification status. *Avoid:* "file", "result" (those lose custody/provenance).
- **Training eligibility** — per-environment opt-in for use of trajectories/verdicts in
  post-training. Collaboration access ≠ training eligibility. *Avoid:* "data sharing".

### How these differ from fleet terms
- **Machine** (fleet) — a device. A person may own many machines; a machine is never a person.
- **Peer studio** (fleet) — a machine running its own engine. In a team deployment, peers are
  execution sites, not coordination authorities.
- **Observe / Control** (fleet) — machine-scoped grants; unchanged. Team deployment adds
  person-scoped grants on top.
- **Canonical Server** (fleet) — the single-writer session store; in a team deployment the hub
  is the canonical server.
- **Submitter** — who submitted a solve; becomes a person in team deployments.
- **Lifecycle-admin authority** — machine provisioning rights; separate from person membership.

## Reversibility

Reversible: revert the ADR and the slices; the hub can be decommissioned and researchers
return to local engines (onboarding runbook includes rollback). Irreversible only at the
human gates: org access changes, account creation, key minting, partner agreements.
glossary.md
