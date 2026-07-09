// The shared-spine bookkeeping verbs — the `amicode_*` opencode-plugin tools, migrated
// to `amico` CLI verbs (spec-20260708-112732 §7.3 triage). Each is deterministic
// filesystem/vault work: callable by agents via bash, by the deterministic harness
// directly, and by cron/CI/Julia.
//
// SLICE STATUS: `catalog` is REAL (issue #111, slice B2 — its body lives in
// catalog_verb.ts / repertoire.ts). `vault` / `device` / `note` are still STUBS:
// each is a routing seam that prints its intent (the module it will generalize +
// the slice that lands the body) and exits 0. Do not add real reads/writes for a
// stubbed verb in this file without its corresponding slice — put the body in a
// dedicated module and wire it here, as catalog does.
//
// Each verb is a plain (args) => {json, code} function so the SAME function backs both the
// CLI dispatch (amico.ts) and the MCP facade (mcp_serve.ts). One impl, two transports.

import { catalogVerb } from "./catalog_verb.js";

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

// vault — retrieval over the knowledge graph (query tools, not front-loading context).
const vault = stub({
  name: "vault",
  summary: "query the knowledge graph (insights/experiments/strategy) — retrieval, not front-load",
  generalizes: "the amicode_* vault plugin tools",
  slice: "spine bookkeeping (B3)",
});

// device — the dispatcher successor (device status / next-actions; benchmark-exclusivity lock).
const device = stub({
  name: "device",
  summary: "device status / next-actions (dispatcher successor; benchmark-exclusivity lock)",
  generalizes: "the amicode_* device/dispatcher plugin tools",
  slice: "spine bookkeeping (B5)",
});

// note — write an experiment note / bump best_gates (librarian bookkeeping half).
const note = stub({
  name: "note",
  summary: "write experiment note / update best_gates (librarian bookkeeping → deterministic)",
  generalizes: "the amicode_* librarian/note plugin tools",
  slice: "spine bookkeeping (B3)",
});

export const SPINE_VERBS: Verb[] = [catalog, vault, device, note];
