// The shared-spine bookkeeping verbs — the `amicode_*` opencode-plugin tools, migrated
// to `amico` CLI verbs (spec-20260708-112732 §7.3 triage). Each is deterministic
// filesystem/vault work: callable by agents via bash, by the deterministic harness
// directly, and by cron/CI/Julia.
//
// SLICE STATUS: ALL FOUR spine verbs are now REAL. `catalog` landed in B2 (issue
// #111 — body in catalog_verb.ts / repertoire.ts); `vault` / `device` / `note`
// land in B3 (issue #113 — bodies in vault_verb.ts / device_verb.ts / note_verb.ts,
// pure cores in vault_query.ts / device_graph.ts / note.ts). The B1 `stub()` helper
// remains for any FUTURE seam, but no spine verb uses it today. Keep each verb's
// real body in its dedicated module and wire it here, never inline in this file.
//
// Each verb is a plain (args) => {json, code} function so the SAME function backs both the
// CLI dispatch (amico.ts) and the MCP facade (mcp_serve.ts). One impl, two transports.

import { catalogVerb } from "./catalog_verb.js";
import { vaultVerb } from "./vault_verb.js";
import { papersVerb } from "./papers_verb.js";
import { deviceVerb } from "./device_verb.js";
import { noteVerb } from "./note_verb.js";
import { ledgerVerb } from "./ledger_verb.js";
import { profileVerb } from "./profile_verb.js";
import { fleetVerb } from "./fleet_verb.js";
import { specVerb } from "./spec_verb.js";
import { planVerb } from "./plan_verb.js";
import { handoffVerb } from "./handoff_verb.js";
import { campaignVerb } from "./campaign_verb.js";
import { projectVerb } from "./project_verb.js";
import { sessionsVerb } from "./sessions_verb.js";

export interface VerbResult {
  json: unknown; // structured result (stdout as JSON for the CLI; tool content for MCP)
  code: number; // process exit code (0 ok, 64 usage/gate, else failure)
}

export interface Verb {
  name: string;
  summary: string; // one-line help + MCP tool description
  generalizes: string; // the real module/plugin tool whose body lands in a later slice
  slice: string; // which spine slice implements the real body
  stub?: boolean; // true while the body is still a B1 seam (help renders "[stub → slice]")
  run: (args: string[]) => VerbResult | Promise<VerbResult>;
}

/** A uniform B1 stub body: echo the intent, name the target module + slice, exit 0. */
function stub(verb: Omit<Verb, "run" | "stub">): Verb {
  return {
    ...verb,
    stub: true,
    run: (args) => ({
      json: {
        verb: verb.name,
        stub: true,
        args,
        intent: verb.summary,
        generalizes: verb.generalizes,
        implemented_by: verb.slice,
        note: "B1 seam only — routing works; the real body lands in a later spine slice",
      },
      code: 0,
    }),
  };
}

// catalog — warm-start query + verified pulse ingest against the repertoire
// (metadata.toml). REAL as of B2: `query` ranks incumbents by fidelity; `ingest`
// promotes a run to a new versioned entry, gated on verification.agree.
const catalog: Verb = {
  name: "catalog",
  summary: "warm-start query / verified pulse ingest against the repertoire (metadata.toml)",
  generalizes: "the amico-catalog skill (repertoire retrieval + ingestion protocol)",
  slice: "spine bookkeeping (B2)",
  run: catalogVerb,
};

// vault — retrieval over the knowledge graph + Armonia mount-stack introspection.
// REAL as of B3: `query` (union-over-mounts relevance ranking), `status` (resolved
// mount stack, field-compatible with `amico-vault status --json`), `resolve`
// (first-hit relpath lookup across the stack).
const vault: Verb = {
  name: "vault",
  summary: "query the knowledge graph (union over mounts) / mount-stack status / resolve a relpath",
  generalizes: "the amicode_* vault plugin tools (retrieval half) + amico-vault status",
  slice: "spine bookkeeping (B3)",
  run: vaultVerb,
};

// device — the dispatcher successor. REAL as of B3: `status` (honesty rule:
// uncharacterized/stale), `next` (ranked actions via pure evaluate()), `lock`
// (benchmark-exclusivity: a locked device accepts no concurrent submission).
const device: Verb = {
  name: "device",
  summary: "device status / next-actions / benchmark-exclusivity lock (dispatcher successor)",
  generalizes: "the amicode_* device/dispatcher plugin tools + the dispatcher agent",
  slice: "spine bookkeeping (B3)",
  run: deviceVerb,
};

// note — librarian bookkeeping. REAL as of B3: `write` (experiment note) +
// `bump-best` (best_gates); `route` (routed generic note by intent, Task 8) — all
// deterministic.
const note: Verb = {
  name: "note",
  summary: "write experiment note / bump best_gates / route a generic note by intent (librarian bookkeeping)",
  generalizes: "the amicode_* librarian/note plugin tools (bookkeeping half)",
  slice: "spine bookkeeping (B3)",
  run: noteVerb,
};

// ledger — the run-ledger single writer (learning-loops L1). `append` (extension
// stanzas shell into this — never touch runs.jsonl directly) + `query` (L-A honest
// priors: medians/IQR + "n runs, m verified" + interim-capped confidence).
const ledger: Verb = {
  name: "ledger",
  summary:
    "append a run-ledger record (single writer) / query honest priors at a structure_hash / tier-dispatch table (learning-loops L-A + fleet §6.3)",
  generalizes: "the amicode learning substrate: the run ledger + amicode_recommend retrieval + tier dispatch",
  slice: "learning-loops (L1) + fleet substrate",
  run: ledgerVerb,
};

// profile — the capability-profile resolver (fleet §2/§3.1). The extension's spool-up
// path shells THIS verb before injecting an agent def through OPENCODE_CONFIG_CONTENT,
// so schema validation, entitlement filtering, and the spool-up composition rule all
// live in one deterministic place instead of in two runtimes.
const profile: Verb = {
  name: "profile",
  summary: "resolve a capability profile: validate + entitlement-filter skills + apply the spool-up composition rule",
  generalizes: "the fleet substrate's profile tree (armonissima vault profiles/ + gates/) at session spool-up",
  slice: "fleet substrate (§9 step 2)",
  run: profileVerb,
};

// fleet — the fleet registry's CLI surface (fleet §3.2/§3.3). Read verbs (`list`,
// `status`) render the one-file-per-session TOML records; the write verbs (`steer`,
// `stop`, `re-tier`) ENQUEUE SIGNAL FILES and never touch a record, because at most one
// writer holds a record at a time (extension while `spooling`, harness after the handoff).
// `sweep` is the one exception that writes, and only for an orphaned holder pid.
// `digest` is the fourth RENDERING (unified-fleet spec slice 1): it reads the registry,
// probes configured machines, and posts the distilled block through the amico-slack
// contract — a projection, never a second state machine.
//
// Deliberate contrast with `ledger` above: the ledger is an append-only immutable JSONL
// event log; this registry is mutable per-session TOML state. They share record I/O
// conventions, single-writer discipline, and the pid probe — not a state model.
const fleet: Verb = {
  name: "fleet",
  summary:
    "fleet registry: list/status read verbs, steer/stop/re-tier as signal enqueuers (never a record write), sweep with a pid-liveness guard, digest as the Slack projection",
  generalizes: "the fleet view + in-chat /fleet + Amico's conversational fleet questions + the Slack digest, over ~/.amico/ops/fleet",
  slice: "fleet substrate (§9 step 2)",
  run: fleetVerb,
};

// spec — the deliberation front half: adversarially review a Spec before it compiles to a
// plan. REAL as of the deliberation slice: tier-1 (mechanical) lenses, the lens registry,
// design_hash, the findings sidecar and the spec_review record. Tier-2 frontier critics
// ride the injected spawn seam and are G-2-gated.
//
// NOTE (advisory A-4): registering here also publishes `amico_spec` as an MCP tool, since
// listMcpTools() maps this registry. That does not weaken D-2 — the point of the CLI-verb
// design is that the critic is not a subagent the REVIEWED agent spawns, so no agent ever
// holds `task`. An agent invoking the verb is the intended path.
const spec: Verb = {
  name: "spec",
  summary: "adversarially review a Spec (mechanical lenses + judgment critics) / validate its frontmatter",
  generalizes: "the brainstorming skill's own reviewer subagent (which it now calls instead of carrying)",
  slice: "deliberation front half (D1)",
  run: (args) => specVerb(args),
};

// Same A-4 note as `spec`: registering publishes `amico_plan` as an MCP tool. That is the
// intended path — an agent compiling its own plan and reading its own status is the loop. What an
// agent CANNOT do through this verb is move a step: there is no subcommand for it, because step
// state is derived from gate verdicts rather than written.
const plan: Verb = {
  name: "plan",
  summary: "compile an approved Spec into a gated, budgeted Plan / read its derived state / close an advisory",
  generalizes: "the ad-hoc markdown to-do lists a plan used to be, which nothing could verify",
  slice: "deliberation back half (D1)",
  run: (args) => planVerb(args),
};

// handoff — atomic repo-handoff receipts (spec-20260804-211500; memory
// feedback_repo_handoff_access). Grant → verify → receipt: the 201-vs-204
// distinction (invitation pending vs access now) is encoded in the exit code, so a
// "grant then announce" workflow mechanically cannot announce into a 404.
const handoff: Verb = {
  name: "handoff",
  summary: "atomic repo handoff: grant access + verify readability (pending-invitation honest) / check / lookup",
  generalizes: "the manual gh api collaborator dance that 404'd Ann on the ions handoff (2026-08-04)",
  slice: "ops hardening (spec-20260804-211500)",
  run: (args) => handoffVerb(args),
};

// papers — the unified literature corpus (#405): one read-only view over
// vault paper notes + the library PDF store — collected, unified, deduped
// (reported, never merged), orphans surfaced both ways. Read-only.
const papers: Verb = {
  name: "papers",
  summary: "list the unified literature corpus (vault notes + library PDFs; filters + drift)",
  generalizes: "the literature plane's collect/unify/search surface (spec-20260817-140000)",
  slice: "literature plane (1)",
  run: papersVerb,
};

// campaign — the SEAM 7 (#709) flywheel surface: the campaign-family derivation
// + the decay computation, per family, over existing records only. The CLI is
// the delivery path this slice owns; the studio panel surfacing rides the fork
// flow (the SEAM 1 UI-half pattern — a named follow-up). Read-only: the verb
// never stamps a record.
const campaign: Verb = {
  name: "campaign",
  summary:
    "decay — the flywheel trend: per campaign family, (acquisitions, iterations, wall clock) deltas vs prior same-family campaigns",
  generalizes: "the studio flywheel panel (SEAM 7's UI half — fork-flow follow-up) over the run store + task records + pulse bank",
  slice: "codesign SEAM 7 (#709)",
  run: campaignVerb,
};

// project — the research-project entity: create (scaffold + git init) and
// import (non-destructive scaffold over an existing directory). Part of #665.
const project: Verb = {
  name: "project",
  summary: "create a scaffolded research project / import an existing directory as a research project",
  generalizes: "the amicode research-project entity lifecycle (PRD #663)",
  slice: "research projects (#665)",
  run: projectVerb,
};

// sessions — the D4 retention surface (spec-20260905-045114 slice 3, #795):
// the chat DB's lifecycle as product verbs. `list` respects the visibility
// rules (default hides archived; `--archived` is the explicit opt-in); `archive`
// RELOCATES old sessions by stamping the engine's time_archived (dry-run by
// default; deletion is out of the vocabulary); `restore` clears the field;
// `index` regenerates sessions/SESSION-INDEX.md from the DB. The archive cutoff
// is the workspace preference ($AMICODE_OPS_DIR/session-retention.json, default
// 30 days). The vault ledger plane and the coordination board are separate
// transports — this verb never touches them.
//
// NOTE: the DB access lives behind a lazy `node:sqlite` import, so this module
// stays import-safe in vitest's graph (vite-node's builtin list predates
// node:sqlite); only calling the verb resolves it.
const sessions: Verb = {
  name: "sessions",
  summary: "session retention over the chat DB: list (visibility rules) / archive (relocate) / restore / index (generated) / prefs",
  generalizes: "the hand-built 2026-09-05 SESSION-INDEX.md + hand SQL consolidation (the D4 anti-pattern, made contractual)",
  slice: "session-device lifecycle D4 (slice 3, #795)",
  run: (args) => sessionsVerb(args),
};

export const SPINE_VERBS: Verb[] = [
  catalog,
  vault,
  device,
  note,
  ledger,
  profile,
  fleet,
  spec,
  plan,
  handoff,
  papers,
  campaign,
  project,
  sessions,
];
