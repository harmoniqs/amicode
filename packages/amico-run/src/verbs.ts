// The shared-spine bookkeeping verbs — the `amicode_*` opencode-plugin tools, migrated
// to `amico` CLI verbs (spec-20260708-112732 §7.3 triage). Each is deterministic
// filesystem/vault work: callable by agents via bash, by the deterministic harness
// directly, and by cron/CI/Julia.
//
// B1 SCOPE (issue #108): these are STUBS. Each verb is present as a routing seam, prints
// its intent (including the real module it will generalize and the slice that lands the
// body), and exits cleanly with code 0. NO bookkeeping logic is migrated here — that is
// B2/B3/B5. Do not add real reads/writes in this file without the corresponding slice.
//
// Each verb is a plain (args) => {json, code} function so the SAME function backs both the
// CLI dispatch (amico.ts) and the MCP facade (mcp_serve.ts). One impl, two transports.

export interface VerbResult {
  json: unknown; // structured result (stdout as JSON for the CLI; tool content for MCP)
  code: number; // process exit code (0 ok, 64 usage/gate, else failure)
}

export interface Verb {
  name: string;
  summary: string; // one-line help + MCP tool description
  generalizes: string; // the real module/plugin tool whose body lands in a later slice
  slice: string; // which spine slice implements the real body
  run: (args: string[]) => VerbResult | Promise<VerbResult>;
}

/** A uniform B1 stub body: echo the intent, name the target module + slice, exit 0. */
function stub(verb: Omit<Verb, "run">): Verb {
  return {
    ...verb,
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

// catalog — warm-start lookup + pulse ingest against the repertoire (metadata.toml).
const catalog = stub({
  name: "catalog",
  summary: "warm-start lookup / pulse ingest against the repertoire (metadata.toml)",
  generalizes: "amico-run/src/catalog.ts + the amicode_* catalog plugin tool",
  slice: "spine bookkeeping (B2)",
});

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
