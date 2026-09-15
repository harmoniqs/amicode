# Pause, Resume, and Redirect for subagent sessions

Status: proposed (2026-09-15)

A running subagent blocks its parent's turn: the Task tool suspends the parent
until the subagent finishes, so there is no way to interject a correction while
one runs. Separately, a deliberate engine restart (Restart-engine, ADR 0020)
hard-kills every in-flight turn — the in-memory background-job registry is
non-durable — so researchers wait subagents out rather than restart and lose
the work. Both pains reduce to one missing capability: bring a running agent
to a safe, resumable stopping point.

**The decision.** Add one universal primitive set — **Pause**, **Resume**, and
**Redirect** — operating on Sessions, not on background jobs or fibers.

*Pause* deliberately interrupts a Session's in-flight turn by reusing the
existing cancel path (fiber interruption, dangling-tool-call reconciliation in
`message-v2.ts`) but settles the Session to a new **Paused** state rather than
idle or done. The Paused state is durable: it is stored in the Session's
metadata JSON column (the same column that already holds `spawned_by` and
`spawned_depth`), so it survives an engine restart and needs no schema
migration. Pause is scoped: it targets one Session, a lineage (target +
descendants), or all in-flight turns. A no-running-turn target is a benign
no-op; pausing is idempotent.

*Resume* clears the Paused marker and starts a fresh continuing turn on the
Session — it is re-dispatch, not resurrection of a killed fiber. For a Task
subagent it rides the existing `task_id` continue path; for any Session it is a
fresh message-initiated turn. Resume accepts an optional *steer message* that
injects a new instruction into the transcript before the continuing turn, so
the agent acts on the correction. The steer lands on a clean transcript: the
interrupted turn's dangling tool calls are reconciled to an interrupted marker
before the steer is appended.

*Redirect* is their composition — Pause + Resume(message) on a running Session
— expressed as a single action for the common "send a correction down to a
subagent" intent. It is never a distinct mechanism.

**Why this shape.** The conversation is already durable (persisted to SQLite
per turn), and Resume is re-dispatch, so no durable job registry is introduced
— honoring ADR 0020's explicit rejection of auto-resuming killed turns. The
only new persistence is the per-Session Paused marker in metadata. The design
is deliberately narrow: it solves the two stated pains (blocked parent,
restart kills work) without introducing mid-fiber checkpointing, a durable job
graph, or headless resume-on-boot.

**The load-bearing edge case: foreground subagents.** Today, both the `error`
and `cancelled` outcomes in the Task tool's background-job result handler
(`task.ts:324-330`) trigger `Effect.fail`, which fails the parent's turn. A
Paused child must NOT fail the parent. Slice 1a introduces a parallel
background-job outcome path that settles to `paused` instead of `cancelled`,
and the Task tool gains a `paused` branch returning a resumable sentinel
distinct from completed, error, and cancelled. This is the single trickiest
behavior — the one most likely to bite — and is the critical path for slice 1.

**Cross-boundary dependency.** Three primitives live in the pinned upstream
engine base, not in the overlay: `SessionStatus` (the in-memory status map),
`BackgroundJob.Status` (the job outcome union), and the session persistence
schema (`SessionTable`). The implementation must either create overlay files
that shadow them or coordinate a base change. The durable marker uses the
session metadata JSON column — already present, already used — to avoid a
database schema migration.

**Scope.** Slice 1 (user-driven): Pause with three scopes (one, lineage, all),
the durable Paused state, Resume with optional steer, Redirect, the composer
and per-tab UI, pause-all wired into the Restart-engine action (replacing the
current warn-then-kill), a Paused filter in session views, and the
foreground-parent resumable sentinel. Slice 2 (agent-driven): a director
`redirect_subagent` tool, director resume-from-ledger, background-subagent
hardening so agents can redirect a running child without foreground blocking.
Within slice 1, the UI work (1b) and the pause-all/restart/filter work (1c)
are independent of each other after the engine primitive (1a) lands.

Out of scope: engine auto-resume on boot; a durable job registry; mid-fiber
suspend/checkpoint; changes to fleet server/client mode.

**UI label.** The composer action is labeled **"Continue"**, not "Resume", to
avoid confusion with the existing "Resume session" navigation widget (the
jump-back-in action). "Resume" stays the conceptual vocabulary; "Continue" is
the UI verb.

**Invariants.** Pause never claims to preserve the in-flight turn's partial
output — that single turn is discarded; durability is at the conversation and
turn boundary, stated honestly. A rebuilt binary or config applies only to
turns started after restart (the ADR 0020 boundary); a resumed turn runs on
the new build — expected and intended. Paused is never silently read as done
by any surface. Lineage-scoped pause is atomic: Resume waits for any
in-progress cascade to settle before acting. Paused sessions are not silently
orphaned: deleting a parent with Paused children warns or blocks.

**Alternatives considered.** *(A) The unified Pause/Resume primitive* —
**chosen** (this ADR). *(B) Ship only the existing detach-to-background
("promote") path* — rejected: it does not pause (work races the update) and
does nothing for the restart pain. *(C) Durable job store with engine
auto-resume on boot* — rejected: it is the "durable ownership slice" the engine
already flags as deferred and the auto-resume that ADR 0020 explicitly rejected;
it also blindly continues subagents on a freshly-rebuilt binary, the worst
moment not to eyeball them.

**Accepted costs.** The engine gains a `paused` job-outcome branch and the
metadata-column marker — one overlay change requiring a binary rebuild
(`build:binary`). The UI gains a "Continue" action and a Paused tab state, plus
a Paused filter. The restart path gains pause-all as a prerequisite step. An
agent-driven redirect (slice 2) requires hardening the background-subagent
model, which does not exist in production today.

**Relation to prior decisions.** Builds on **ADR 0020** (standalone server
survives reload): pause-all wires into the Restart-engine action that ADR 0020
introduced, and honors its rejection of auto-resume-on-boot. Builds on
**ADR 0017** (session-lineage mutation ledger): the durable `parentID` and
lineage edges make paused children rediscoverable after restart. The existing
cancel path and its descendant cascade, the `task_id` continue path, the
interrupted-tool reconciliation in message serialization, and the
experiment-gated background-subagent promote path are all reused.

**Flip condition.** Revisit toward mid-fiber checkpointing if the engine gains
a durable execution model (e.g. Temporal-style workflows). Revisit toward
auto-resume if the fleet mode acquires headless job scheduling that subsumes
the standalone restart case.

Implementation: harmoniqs/amicode#1208
