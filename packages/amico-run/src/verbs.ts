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
import { deviceVerb } from "./device_verb.js";
import { noteVerb } from "./note_verb.js";

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

export const SPINE_VERBS: Verb[] = [catalog, vault, device, note];
