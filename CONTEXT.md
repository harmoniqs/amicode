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

### Fleet & serving

**Server mode**:
The per-machine stance for where Sessions are served from, in three values. `standalone` — this machine spawns and owns its own chat server (the default; the only mode that ever spawns). `server` — this machine runs the Canonical Server as a system service and the panel attaches to it. `client` — this machine never serves; the panel attaches to the Canonical Server through a Managed Tunnel. Machine-scoped, never synced: a synced "client" landing on the server would silence the fleet.
_Avoid_: profile, spawn vs attach (as concept names)

**Canonical Server**:
The one chat server that owns the fleet's Session store — the single writer every panel attaches to. Runs as a system service on the machine in `server` Server mode, available headless (no editor required). Only one may exist per Fleet.
_Avoid_: master, primary, host

**Fleet**:
The user's machines acting as one logical studio: exactly one Canonical Server plus zero-or-more clients, all attaching to the same Session store.
_Avoid_: mesh, cluster

**Local fallback**:
The deliberate, user-invoked escape hatch: a `client` machine temporarily serving itself locally (a `standalone` spawn) while the Canonical Server is unreachable. Explicit about its trade-off — fleet history returns on reconnect, and Sessions made during fallback merge back into the Canonical Server on rejoin. Never silent: an active Local fallback is a first-class, visible state.
_Avoid_: offline mode, degraded mode

**Rejoin**:
The closing half of Local fallback: on reconnect, the client ships its local Session shard to the Canonical Server, which merges it as the single writer (id-guarded inserts, strictly-newer-wins per row, event-position guard, schema-drift column mapping). After Rejoin, fleet history is whole again — nothing strands on the client.
_Avoid_: sync (bidirectional connotation), upload

**Fleet token**:
The shared secret authenticating a client to the Canonical Server's data routes — minted when the fleet server is enabled, stored at 0600, handed to clients during the ssh-based setup flow. The sibling of the per-boot server password (ADR 0002): that guards a spawned server its extension owns; this guards the service no extension spawns.
_Avoid_: API key, password

**Managed Tunnel**:
The self-healing SSH local-forward a `client` uses to reach the Canonical Server — one component with two launchers. The extension spawns and supervises it for interactive panels (reconnect with backoff, address candidates probed LAN-before-overlay, health surfaced in the status bar); a headless launcher (`amico fleet tunnel`) serves panel-less consumers such as scheduled jobs. Failures are always visible to its consumer — never an invisible external service.
_Avoid_: port forward (as a concept name), launchd tunnel

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
