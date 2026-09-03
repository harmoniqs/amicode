# Amicode

The VSCode extension + CLI autoresearch studio — researchers propose, run, verify, and record experiments through a structured loop. Quantum optimal control is the primary Domain Pack; the product is the loop, not the domain.

## Language

### Backends & access

**Connection**:
A credentialed, validated link to an external service — compute (Company Compute), hardware (Pasqal Cloud), communication (Slack), or tooling (GitHub, Linear). Comes in two kinds: built-in (ships with a specific validator and brand icon) and custom (user-defined, optimistically stored with no probe). Owns one Credential and zero-or-more Devices; carries a status (e.g. connected / needs key / invalid / expired / unreachable). Only configured Connections appear in the panel; unconfigured built-ins are available through the "Add" picker. Establishing the Company Compute Connection also unlocks the HP stack (grants the entitlement, flips Solver mode).
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
The unit of work organization — a directory registered with amicode where files, solves, and Sessions live. Every Session belongs to exactly one Project. Two flavors:
- **Research Project** — identified by a `research-project.toml` manifest at its root. Prescribed layout (`scripts/`, `data/`, `paper/`, `ledger/`, `reports/`, `config/`, `skills/`) and a linear lifecycle (proposing → designing → running → analyzing → writing → complete). Self-contained: all data, campaign ledgers, and project-specific skills live inside the directory. Created via `amico project create`.
- **Dev Project** — the existing git-repo model; any registered directory without `research-project.toml`. Canonical default: `~/armonia/`.

_Avoid_: Workspace, folder (as a concept name), repo, Study (rejected alternative — researchers think in "projects")

**Session**:
One agent conversation, bound to exactly one Project at creation and never re-parented. Sessions are children of a Project — surfaced nested under their Project, never as a global flat list.
_Avoid_: Chat (as a concept name), conversation

**Bug session**:
A single-purpose Session spawned by the Report-a-Bug entry point. Bound to the active Project like any Session, but machine-managed: archived once its report is filed, deleted if abandoned before filing, and kept out of the Project's session history in every state.
_Avoid_: chat, side chat, ticket

### Knowledge

**Armonia**:
The canonical workspace and knowledge system. As a workspace: the `~/armonia/` directory tree (`repos/{packages,demos}`, `data/{env,problems,runs,vaults}`) surfaced as the structured "Armonia" sidebar panel via ArmoniaService. As a knowledge system: the precedence-ordered stack of mounted Vaults under `data/vaults/` (personal → project → team) that the agent reads for context. The sidebar panel shows both — semantic buckets for the full workspace, with Vaults as one bucket.
_Avoid_: Vault (as the system name), knowledge base

**Vault**:
One mounted knowledge tier within Armonia — a git-backed store of notes, specs, and catalog entries at a single precedence level, one of five kinds: personal, engagement, project, team, public. Many Vaults mount into the Armonia stack; the panel lists them as its roots and reads them top-to-bottom.
_Avoid_: Armonia (the whole stack), workspace, folder

**Vault naming rule**:
Vaults minted by the provisioning tool are named `vault-<owner-or-purpose>`; "armonia" names the workspace and never a minted vault. Team vaults riding code repos keep the repo's own name — exempt by construction, never "overridden". The mount's public identity is its marker file's `name` field; the directory name matches it.
_Avoid_: vault branding, armonia-<name> (the retired convention)

**Sync health**:
The per-machine, never-silent state of a mounted Vault's sync: OK · STALE (consecutive failures, behind-count over threshold, or fetch-blocked) · UNKNOWN (no record — a pre-sidecar script version or a mount the loop never reached) · ZOMBIE (the newest record older than 3× the sync cadence — a dead scheduler is not a quiet all-clear) · ro-by-policy (an expected failure on a read-only mount, muted). Sensed by the status sidecar outside vault content; rendered by the status command and the fleet digest. No state is silent.
_Avoid_: sync status (as a state name), stale (unqualified — name the state)

### Agentic work

**Notturno**:
The scheduled agentic-work context — jobs that run unattended on a schedule, each producing staged, reviewable output rather than direct changes. The engine and its full language (Job, Surface, Warrant tier, Registry) live in the premium bundle, `harmoniqs/amicissimo` — this glossary does not duplicate them. One night's run of the registered jobs is "tonight's notturno".
_Avoid_: cron, scheduler (as concept names), night shift

**Director**:
The role that leads any autonomous loop — one canonical protocol (ledger discipline, dispatch through gates, analyze, record) that every campaign runs under, whichever mode it is bound to. Research and development differ in their gate packs, never in their director.
_Avoid_: conductor (standing decision)

**Autoresearch**:
The research mode: hypothesis queue → deliberate spec → experiment → gates → analyzer — the shipped, name-frozen autonomous mode, binding the research gate pack over the director core.

**Autodev**:
The development mode: issue DAG → TDD slices → CI/review → landed delta — the second autonomous mode, binding the dev gate pack. The loop is issue → PR → merge; automating the walk never weakens the dev gate or the never-merge-non-green rule.
_Avoid_: autobuild ("build" already means CI to everyone)

**Campaign**:
One bounded run of either autonomous mode, with a ledger and a closing artifact — the umbrella word for what a director executes. Copilot sessions are not campaigns; campaign-internal state (receipts, dispatch logs, scratch) crosses a campaign boundary only by distilling into issues, vault cards, or the artifact banks. Within a Research Project, campaign ledgers live at `ledger/campaigns/campaign-<YYYYMMDD>-<slug>.md`; outside a project, they live in the personal vault's `sessions/` directory.
_Avoid_: session (a copilot session is never a campaign; a campaign ledger is never a session ledger)

**Gate pack**:
The typed set of gates + phase templates an autonomous mode binds — the entire mode-specific part of the loop, held as committed data rather than prose, so the same director core runs any pack.

**Mode**:
One of the three director postures — copilot (the zeroth: default, interactive, packless), autoresearch, autodev. A mode binds a gate pack iff it is autonomous; the copilot mode binds none.
_Avoid_: surface, rail (they render and switch modes; a mode is a posture, not a surface)

### Fleet & serving

**Server mode**:
The per-machine stance for where Sessions are served from, in three values. `standalone` — this machine spawns and owns its own chat server (the default; the only mode that ever spawns). `server` — this machine runs the Canonical Server as a system service and the panel attaches to it. `client` — this machine never serves; the panel attaches to the Canonical Server through a Managed Tunnel. Determined by `~/.amico/ops/fleet/fleet.json` (no file = standalone). Machine-scoped, never synced.
_Avoid_: profile, spawn vs attach (as concept names)

**Fleet config**:
The file at `~/.amico/ops/fleet/fleet.json` that declares this machine's fleet role and the canonical server's coordinates (`host`, `port`, `sshAlias`). No file on disk = standalone. The guard script, extension, and installer all resolve role from this file — never from a hardcoded hostname.
_Avoid_: fleet.toml, fleet settings (those are VS Code settings, a different thing)

**Canonical Server**:
The one chat server that owns the fleet's Session store — the single writer every panel attaches to. Runs as a system service on the machine in `server` Server mode, available headless (no editor required). Only one may exist per Fleet.
_Avoid_: master, primary, host

**Fleet**:
The user's machines acting as one logical studio: exactly one Canonical Server plus zero-or-more clients, all attaching to the same Session store.
_Avoid_: mesh, cluster

**Go Standalone**:
The user-invoked mode switch from `client` to `standalone` — the machine leaves the fleet and serves itself permanently. Not an escape hatch: a first-class choice. Sessions made locally stay local. Re-enrollment in a fleet is a separate flow (Enroll, deferred).
_Avoid_: local fallback, offline mode, degraded mode

**Fleet token**:
The shared secret authenticating a client to the Canonical Server's data routes — minted when the fleet server is enabled, stored at 0600, handed to clients during the ssh-based setup flow. The sibling of the per-boot server password (ADR 0002): that guards a spawned server its extension owns; this guards the service no extension spawns.
_Avoid_: API key, password

**Managed Tunnel**:
The self-healing SSH local-forward a `client` uses to reach the Canonical Server — one component with two launchers. The extension spawns and supervises it for interactive panels (reconnect with backoff, address candidates probed LAN-before-overlay, health surfaced in the status bar); a headless launcher (`amico fleet tunnel`) serves panel-less consumers such as scheduled jobs. Failures are always visible to its consumer — never an invisible external service.
_Avoid_: port forward (as a concept name), launchd tunnel

### Surfaces

**Home**:
The always-present first tab in the Work Column that renders the user's widget grid — profile cards, run status, problem summaries, and custom agent-authored widgets. The single canonical surface for widgets; replaces the standalone home page. Internally powered by the widget kernel (WidgetGrid, WidgetFrame, the bridge protocol, `/amicode/widgets` + `/amicode/dashboard` endpoints).
_Avoid_: Dashboard (as the surface name), widget panel

**Widget**:
A sandboxed ES-module card rendered in an iframe within Home. Authored by the agent (`amicode_author_widget` tool) or shipped as a builtin. Communicates with the host via the bridge protocol (postMessage). Two size classes: hero (full panel width) and tile (half-width, 2-across). Each has a TOML manifest, a JS module, and optional config fields.
_Avoid_: Card (ambiguous — the UI has many cards), tile (as the concept name — tile is a size class)

**Sidebar**:
The webview in the VS Code activity bar container, showing project navigation and system status. Contains action buttons (open chat, create project), a session-aware unified project tree (Research Projects with lifecycle metadata expanding into file trees; Dev Projects as plain expandable folders), and a collapsible fleet section (deferred). The sidebar is navigation chrome — it follows the active session's project binding but never drives session switching. Destinations open in the editor area.
_Avoid_: Explorer (VS Code's native file explorer is separate), Panel (the in-app dismissible drawer is a different concept)

### Orthogonal axes

**Domain Pack**:
A deeply integrated capability set covering one research domain — its skills, Substrate, tools, solver modes, interview flows, and result semantics. Quantum control is the first and primary Domain Pack; it ships active by default. A pack is not a plugin: it is tightly integrated code that is identifiably domain-specific rather than scattered across generic infrastructure. Code that belongs to a Domain Pack is visibly gated behind pack activation (even when the gate is always true today).
_Avoid_: Plugin, add-on, module (as the concept name)

**Substrate**:
The runtime environment a Domain Pack requires — language, packages, precompilation. For the quantum-control pack: Julia + Piccolo. Substrate setup is gated behind pack activation, not hardcoded into core extension activation.
_Avoid_: Runtime, toolchain (as concept names)

**Run**:
One execution of an experiment script, producing a result artifact and an iteration log. Domain-agnostic at the protocol level (iteration count, objective value, status); domain-specific at the rendering level (e.g. fidelity display, pulse visualization for quantum control). The generic run protocol is `AMICODE_ITER` (iteration, objective, constraints); domain extensions (e.g. `AMICODE_PULSE`) layer on top.
_Avoid_: Solve (as the generic concept — "solve" is quantum-control vocabulary for a Run)

**Entitlement**:
A grant of capability, in two linked senses. Locally: a license code granting access to a set of surfaces — `issimo` unlocks the Piccolissimo package skills; `amicissimo` unlocks the premium bundle's surfaces (`amico premium` reports them; repo access to the bundle pairs with the code) — holdable with no Connection at all. Service-side: the authorization set a Credential carries on its service record. The Company Compute Connection bridges them: establishing it grants the local code.
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
