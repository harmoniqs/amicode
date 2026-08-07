# Amicode

The VSCode extension + CLI that lets researchers author, run, and inspect quantum optimal-control solves — locally, on company compute, or against real hardware.

## Language

### Backends & access

**Connection**:
A credentialed, validated link to an external backend (e.g. Company Compute, Pasqal Cloud). Owns one Credential and zero-or-more Devices; carries a status (e.g. connected / needs key / invalid / expired / unreachable). Establishing the Company Compute Connection also unlocks the HP stack (grants the entitlement, flips Solver mode).
_Avoid_: Configuration, integration, account

**Credential**:
The secret payload inside a Connection — at rest, always a revocable token. A username/password pair may be used transiently at key entry to mint the token, and is never persisted. Authenticates to the service, never to an individual Device; users manage Connections, not Credentials.
_Avoid_: API key (as a concept name), login

**Device**:
A specific QPU or emulator reached through a Connection (e.g. EMU_FREE, AnalogDevice behind Pasqal Cloud). A Connection may have none — Company Compute is pure compute.
_Avoid_: Backend, hardware target

**Company Compute**:
The Connection to Harmoniqs' cloud solve service — remote machines that run the optimization itself. Has a Credential (token) and no Devices.
_Avoid_: HP cloud, cloud solve service (in UI copy)

**Submitter**:
The tenant identity a Credential maps to — the single join key tying a credential to its runs' records and artifacts. Immutable for the life of a Credential; changing identity means issuing a new Credential.
_Avoid_: User, tenant, owner (interchangeably)

### Work organization

**Project**:
The unit of work organization — a directory registered with amicode where files, solves, and Sessions live. The dashboard's project surface owns switching between Projects and creating new ones. Every Session belongs to exactly one Project.
_Avoid_: Workspace, folder (as a concept name), repo

**Session**:
One agent conversation, bound to exactly one Project at creation and never re-parented. Sessions are children of a Project — surfaced nested under their Project, never as a global flat list.
_Avoid_: Chat (as a concept name), conversation

**Bug session**:
A single-purpose Session spawned by the Report-a-Bug entry point. Bound to the active Project like any Session, but machine-managed: archived once its report is filed, deleted if abandoned before filing, and kept out of the Project's session history in every state.
_Avoid_: chat, side chat, ticket

### Knowledge

**Armonia**:
The knowledge system amicode reads for context — a precedence-ordered stack of mounted Vaults (personal → project → team). Surfaced as the "Armonia" sidebar panel; backed by ArmoniaService. Distinct from a Project: Armonia is shared knowledge that mounts in, a Project is the directory you work in.
_Avoid_: Vault (as the system name), knowledge base

**Vault**:
One mounted knowledge tier within Armonia — a git-backed store of notes, specs, and catalog entries at a single precedence level (personal / project / team). Many Vaults mount into the Armonia stack; the panel lists them as its roots and reads them top-to-bottom.
_Avoid_: Armonia (the whole stack), workspace, folder

### Agentic work

**Notturno**:
The scheduled agentic-work context — a registered set of jobs that run unattended on a schedule, each producing staged, reviewable output rather than direct changes. Already live as the team-facing nightly Slack automation in `harmoniqs/amico` (morning brief, per-member briefs, EOD check-in, news posts) on GitHub Actions; the unified context grows it to all scheduled agentic work, including local repo/Julia-heavy jobs. Subsumes the dream cycle: `dream-reflect` runs as one job within Notturno. One night's run of the registered jobs is "tonight's notturno".
_Avoid_: cron, scheduler (as concept names), night shift

**Specialist**:
The expert-model consult seat — a domain expert in quantum device operation and pulse physics that the session's engine consults through a stable, typed contract. Model-agnostic on both sides: an engine swap changes only when-to-consult guidance, a model swap changes only what serves the seat. Capability is earned in stages — context first, weights only on attribution-ledger evidence. Not the Understudy (a persona of the user); the Specialist models the domain, not the user.
_Avoid_: engine, brain, replacement, understudy

### Orthogonal axes

**Entitlement**:
A grant of capability, in two linked senses. Locally: a license code granting access to a set of Julia packages (e.g. `issimo` unlocks Piccolissimo) — holdable with no Connection at all. Service-side: the authorization set a Credential carries on its service record. The Company Compute Connection bridges them: establishing it grants the local code.
_Avoid_: License, unlock

**Solver mode**:
The sticky choice of authoring stack: `piccolo` (free) or `hp` (Piccolissimo). Set by the user's toggle, or unlocked to `hp` when a valid Company Compute key is entered.
_Avoid_: Solver toggle (the toggle is the control, the mode is the state)

**Routing**:
The per-solve, explicit choice of where one solve executes: local or Company Compute. Informed by the Estimate; always user-confirmed, never automatic.
_Avoid_: Offload (as the decision name), auto-routing

**Estimate**:
The predicted size/cost of a solve (sizeClass, time) computed at solve-assembly time. Informs the Routing confirm; suggests, never decides.
_Avoid_: Classifier
