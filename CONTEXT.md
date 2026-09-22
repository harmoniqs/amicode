# Amicode

The VSCode extension + CLI research studio — researchers propose, run, verify, and record experiments through a structured loop. Quantum optimal control is the primary Domain Pack; the product is the loop, not the domain.

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

**Research Environment**:
A shared substrate for related Research Projects — a git-backed directory identified by `research-environment.toml`, carrying shared skills, insights, methods, and configuration. Bound to a Research Project via the project's `[environment].slug` field. Multiple Projects may share one Environment; an Environment has no lifecycle of its own (no phase or status). Surfaced in the Sidebar as a first-class accordion section above Research Projects, with entries color-coded by an 8-color palette derived from the slug hash. Created via `amico env create`.
_Avoid_: workspace, shared folder, template

**Session**:
One agent conversation, bound to exactly one Project at creation and never re-parented. Sessions are children of a Project — surfaced nested under their Project, never as a global flat list.
_Avoid_: Chat (as a concept name), conversation

**Session Lineage**:
The rooted set formed by one Session and every Session it explicitly spawns through a registered task or session-spawn edge. A root Session may aggregate its descendants' Mutation Receipts in Files Changed, but each receipt retains its originating Session. A fork starts a separate Session Lineage.
_Avoid_: session tree (too structural), parent chat, fork lineage

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

**Research**:
The research mode (renamed from `autoresearch` — the three-mode surface, spec-20260907-011500; old ids read-resolve for one release cycle, never migrated in place): hypothesis queue → deliberate spec → experiment → gates → analyzer — the shipped, name-frozen autonomous mode, binding the research gate pack over the director core.
_Avoid_: autoresearch (the pre-rename id — an alias at read time, not a name)

**Develop**:
The development mode (renamed from `autodev` — the three-mode surface, spec-20260907-011500; old ids read-resolve for one release cycle, never migrated in place): issue DAG → TDD slices → CI/review → landed delta — the second autonomous mode, binding the dev gate pack. The loop is issue → PR → merge; automating the walk never weakens the dev gate or the never-merge-non-green rule.
_Avoid_: autobuild ("build" already means CI to everyone), autodev (the pre-rename id — an alias at read time, not a name)

**Campaign**:
One bounded run of either autonomous mode, with a ledger and a closing artifact — the umbrella word for what a director executes. Copilot sessions are not campaigns; campaign-internal state (receipts, dispatch logs, scratch) crosses a campaign boundary only by distilling into issues, vault cards, or the artifact banks. Within a Research Project, campaign ledgers live at `ledger/campaigns/campaign-<YYYYMMDD>-<slug>.md`; outside a project, they live in the personal vault's `sessions/` directory.
_Avoid_: session (a copilot session is never a campaign; a campaign ledger is never a session ledger)

**Gate pack**:
The typed set of gates + phase templates an autonomous mode binds — the entire mode-specific part of the loop, held as committed data rather than prose, so the same director core runs any pack.

**Mode**:
One of the three director postures — copilot (the zeroth: default, interactive, packless), research, develop. A mode binds a gate pack iff it is autonomous; the copilot mode binds none.
_Avoid_: surface, rail (they render and switch modes; a mode is a posture, not a surface)

**Pause**:
The deliberate interruption of a Session's in-flight turn to a safe, resumable stopping point. Reuses the existing cancel path (fiber interruption, dangling-tool-call reconciliation) but settles the Session to **Paused** rather than idle or done. Scoped: targets one Session, a lineage, or all in-flight turns. A no-running-turn target is a benign no-op.
_Avoid_: cancel, stop, abort (all of those end work; Pause makes it resumable)

**Paused**:
The durable Session state after a Pause — visibly distinct from idle, finished, error, and working on every surface. Stored in the Session's metadata JSON column; survives an engine restart. A Paused Session is discoverable and filterable. Paused is never silently read as done.
_Avoid_: stopped (implies finality), suspended (implies mid-fiber checkpoint, which this is not)

**Resume (session control)**:
Clearing the Paused marker and starting a fresh continuing turn on a Paused Session. Re-dispatch, not resurrection of a killed fiber: for a Task subagent it rides the existing `task_id` continue; for any Session it is a message-initiated turn. Accepts an optional steer message injected before the continuing turn. The UI verb is **"Continue"** to avoid collision with the "Resume session" navigation widget.
_Avoid_: restart (implies a cold start), reconnect (that is Server adoption), resume (unqualified, in UI — use "Continue")

**Redirect**:
The composition of Pause + Resume(message) on a running Session — a single action expressing "send a correction to a running subagent." Never a distinct mechanism; always decomposes to Pause then Resume with a steer.
_Avoid_: interrupt (too vague), override (implies replacing, not steering)

**Mutation Context**:
A short-lived, server-issued capability that binds a declared local mutation to an authenticated initiating panel and Session Lineage, origin, exact operation, canonical authorized resources, and evidence policy. Known local mutators require a valid Mutation Context before changing session-visible storage; an invalid context denies before filesystem access, while an exact idempotent retry returns the prior operation result. It is server or extension-host local and never part of a browser, transcript, share, telemetry, log, or error payload.
_Avoid_: write token, filesystem permission

**Mutation Ledger**:
The server-owned, append-only compact record of Mutation Receipts for a Session Lineage. It is the ownership authority behind Files Changed; filesystem snapshots and watchers may revalidate a receipt but never create one. Ledger storage, evidence retention, and compaction are operational infrastructure, not ledger resources.
_Avoid_: change log, Git status, filesystem journal

**Mutation Receipt**:
One immutable record for one resource affected by a requested operation. It records the originating Session, origin, logical and canonical resource identity, operation, execution outcome, timing, and safe evidence reference. Current observation confidence, net state, and evidence availability live in a separate Mutation Assessment so revalidation never rewrites history.
_Avoid_: diff (a diff is one possible evidence form), event (too broad)

**Unknown Mutation Receipt**:
An operation-level record for an opaque action whose affected resources cannot be declared. It has no resource identity or patch evidence, is rendered in Files Changed as an explicit uncertainty item, and contributes to coverage counts without authorizing a local write.
_Avoid_: unknown file, inferred diff

**Mutation Assessment**:
The current or append-only assessment attached to a Mutation Receipt. It records observation confidence, net state, evidence availability, revision, and expiry without changing the original receipt.
_Avoid_: receipt status, mutable receipt

**Mutation Evidence**:
The bounded host-local patch, preimage, or structured metadata a Mutation Receipt may reference. Evidence is distinct from the compact Mutation Ledger, follows explicit redaction and retention policy, and never enters ordinary session sharing by default. Root quotas, pagination, retention, and compaction bound both receipt metadata and evidence.
_Avoid_: ledger blob, session attachment

### Development and installation

**Rebuild candidate**:
A complete platform-specific VSIX tied to an immutable source-pair manifest and
independently verified before installation. A candidate identifies the Amicode
main SHA, promoted fork SHA, overlay-manifest fingerprint, target platform, UI
channel, artifact digest, and CI provenance. It is adopted only after a matching
health receipt; it is never a directory of files copied into a live extension.
_Avoid_: Rebuild output, partial deploy, local binary (when the complete VSIX is
meant)

**Managed rebuild environment**:
The user-scoped toolchain cache, source cache, and owned temporary worktrees
used by the rebuild coordinator. It contains pinned, integrity-checked tools and
may never alter a developer checkout, global PATH, or system package-manager
state.
_Avoid_: Developer checkout, global toolchain, build folder

**Rebuild operation**:
One durable user-initiated lifecycle that preflights, resolves, builds or
downloads, verifies, adopts, rolls back, or refuses one rebuild candidate. Its
status survives a VS Code reload and has a receipt-backed terminal outcome.
_Avoid_: Spinner, background rebuild (when the durable operation is meant)

**Promoted fork SHA**:
The immutable fork revision recorded by the merged Amicode main overlay
manifest. It is the only fork revision a Main rebuild may consume. A newer
`local/amicode` head is pending-promotion information, never a rebuild source.
_Avoid_: Latest fork head, current branch (when referring to the Main rebuild
source)

### Fleet & serving

**Server mode**:
The per-machine stance for where Sessions are served from, in three values. `standalone` — this machine spawns and owns its own chat server, detached and survivable so it outlives an extension-host reload and is re-adopted rather than dying with the editor (the default; the only mode that ever spawns). `server` — this machine runs the Canonical Server as a system service and the panel attaches to it. `client` — this machine never serves; the panel attaches to the Canonical Server through a Managed Tunnel. Determined by `~/.amico/ops/fleet/fleet.json` (no file = standalone). Machine-scoped, never synced.
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

**Server handshake**:
The `0600` record at `~/.amico/ops/server/standalone.json` that lets a re-activating extension discover, authenticate to, and adopt the surviving standalone server — port, PID, start time, the per-boot password, and `binaryHash`/`configHash`/`protocolVersion`. The single-machine sibling of the Fleet token and the per-boot server password (ADR 0002/0005): written once per cold spawn, its password rotated on each cold spawn and reused only on adoption.
_Avoid_: session token, lock file, pid file

**Server adoption**:
A re-activating extension attaching to the surviving standalone server instead of spawning a new one, gated on four checks — health, PID alive, password challenge, protocol compatible. Distinct from fleet attach (which reaches a remote Canonical Server through a Managed Tunnel); adoption is same-machine, same-process, over loopback.
_Avoid_: reconnect, reuse, fleet attach

**Active-work pin**:
The condition that keeps a detached standalone server alive past the grace window — one or more in-flight agent turns. A Run does not pin the server (a Julia solve is detached and survives independently, re-attached by the Run Inspector on the next activation); only a turn, which lives in server memory, does.
_Avoid_: keepalive, lock, busy flag

**Grace window**:
The interval after an extension-host teardown during which a detached standalone server stays alive awaiting re-adoption. On expiry with no adoption and no active-work pin the server self-exits and deletes its handshake; a reload re-adopts well within it, a genuine quit does not.
_Avoid_: timeout, linger period

### Surfaces

**Work Column**:
The session-scoped auxiliary surface beside Chat that contains Home, Files Changed, Context, Pulse Inspector, and Preview. On desktop it may dock right, left, or bottom of Chat or move into a paired panel-only VS Code editor tab; every host presents the same logical state and features.
_Avoid_: Side panel, sidebar, editor

**Detached Work Column**:
The panel-only VS Code editor-tab host for a Work Column record. It is fully connected to its bound Chat and session, owns the record's live lease while detached, and exposes the same features as an attached Work Column; it is never a copied view or a separate Chat.
_Avoid_: Floating chat, copied panel, separate chat

**Suspended Work Column**:
A durable Work Column record with no live host after its source Chat and detached panel have closed. A matching Chat may recover it without losing acknowledged state.
_Avoid_: Discarded panel, orphaned window

**Home**:
The always-present first tab in the Work Column that renders the user's widget grid — profile cards, run status, problem summaries, and custom agent-authored widgets. The single canonical surface for widgets; replaces the standalone home page. Internally powered by the widget kernel (WidgetGrid, WidgetFrame, the bridge protocol, `/amicode/widgets` + `/amicode/dashboard` endpoints).
_Avoid_: Dashboard (as the surface name), widget panel

**Widget**:
A sandboxed ES-module card rendered in an iframe within Home. Authored by the agent (`amicode_author_widget` tool) or shipped as a builtin. Communicates with the host via the bridge protocol (postMessage). Two size classes: hero (full panel width) and tile (half-width, 2-across). Each has a TOML manifest, a JS module, and optional config fields.
_Avoid_: Card (ambiguous — the UI has many cards), tile (as the concept name — tile is a size class)

**Sidebar**:
The webview in the VS Code activity bar container, showing project navigation and system status. Contains action buttons (open chat, create project), a session-aware unified project tree (Research Projects with lifecycle metadata expanding into file trees; Dev Projects as plain expandable folders), and a collapsible fleet section (deferred). The sidebar is navigation chrome — it follows the active session's project binding but never drives session switching. Single-clicking a file opens it as a tab in Preview (the multi-document file workspace in the side panel); double-clicking opens a native VS Code editor tab.
_Avoid_: Explorer (VS Code's native file explorer is separate), Panel (the in-app dismissible drawer is a different concept)

**Preview**:
The multi-document file workspace in the side panel. Holds zero or more files as inner tabs, each rendering its content (markdown rendered with a toggle to edit; text/code files in a CodeMirror editor; images and PDFs inline). Files arrive via Sidebar single-click or a Chat file pill and accumulate as tabs — each closeable and drag-reorderable; opening an already-open file focuses its existing tab rather than duplicating it. A breadcrumb bar under each pane's tab strip shows the active file's project-relative path with interactive sibling navigation. Supports recursive split panes via edge-drop: dragging a tab toward a pane's edge divides the view, and each resulting pane keeps its own tab bar, breadcrumb, zoom, and preview/edit toggle. Empty panes auto-collapse; a minimum pane dimension is enforced so splits can't shrink below a usable size. Opens and activates automatically when the first file is selected; shows a placeholder when no file is open. For committed editing, double-click the Sidebar entry to open a native VS Code tab.
_Avoid_: Editor (Preview is a multi-document viewer, not a primary editor — committed editing belongs in a native VS Code tab), File browser (the Sidebar is still the primary project-wide file tree; the breadcrumb is a contextual sibling-navigation aid scoped to the open file, not a second tree)

### Developer tooling

**Rebuild (local)**:
One of the two developer-tools Rebuild buttons. Builds the amicode binary and extension from the current working tree exactly as it sits — no git checkout, no pull — so a developer's in-progress edits are what gets built. The inner-loop "build what I have" action. Its request mode is `local`.
_Avoid_: Rebuild Remotely (retired wording), local build (as the concept name — it is a Rebuild mode)

**Rebuild (from main)**:
The other developer-tools Rebuild button. Syncs the amicode repo to `origin/main` (fetch + checkout main + fast-forward-only pull) and then builds — the "reset to the shared tip and build that" action. Its request mode is `main`. The two Rebuild buttons diverge only at this git step; every later build phase is identical.
_Avoid_: Rebuild Remotely / Rebuild from Latest (retired wordings), remote rebuild (the fork-era `remote` mode is retired)

**binary live-swap (retired)**:
The retired mechanism by which the developer-tools "opencode repo path" field resolved a fork binary from a path on disk and set the `opencodeBinary` override to it, restarting the server. Retired with fork absorption (#1091/#1115): the binary is now produced by the in-repo overlay build, so the full local Rebuild is the single dev build path. The general `opencodeBinary` override itself survives — it is consumed by the boot/health paths and still cleared on the developer-mode toggle-off; only the path-field-fed swap is gone.
_Avoid_: opencode repo path field (removed), binary override (the general override is not the live-swap)

**Canary**:
The fleet service that pre-tests the `dev` integration branch on real fleet state each night — CI-green artifacts installed on always-on arms (hub server-half, mini client-half), never on a daily driver — reporting a wave-ready verdict through the morning brief and filing findings to the board. Complements CI: clean runners prove the PR; the Canary proves the integration on live fleet state.
_Avoid_: nightly build (it installs, never builds), CI (what it builds on, not what it is), test machine

**Wave**:
The deliberate `dev` → `main` graduation act — the human acceptance that makes main the trunk Aaron has personally tested. Preceded by the Canary's mechanical verdict; never replaced by it.
_Avoid_: release (that is the tag flow), promote (reserved for the alpha-promotion act), merge (too generic — a Wave is a specific, human merge)

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
