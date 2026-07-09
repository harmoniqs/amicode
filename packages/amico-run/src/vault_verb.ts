// `amico vault` — knowledge-graph retrieval (issue #113, slice B3;
// spec-20260708-112732 §3.1, §7.3). One subcommand today, read-only:
//
//   amico vault query --q "<query>" [--type insight|experiment]
//                     [--platform <p>] [--kind <g>] [--limit <n>]
//       → the notes (insights/experiments) most RELEVANT to the query, ranked
//         (title > tags > body weighting), read from the mounted vault. This is
//         the retrieval seam an agent hits on demand — retrieval, not
//         front-loading the whole graph into context.
//
// Pure ranking logic lives in vault_query.ts; this is the flag surface + I/O.
// FLAG NAMES (S31 guard): the physics-knob double-dash flags (gate/pulse/system)
// are banned in src/; the gate discriminator is `--kind` (mapping onto the note
// `gate` field, exactly as `amico catalog` does), and the free-text query is
// `--q`.
import { loadNotes, rankNotes, vaultDir, type QueryOpts } from "./vault_query.js";
import type { VerbResult } from "./verbs.js";

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export function vaultQuery(argv: string[]): VerbResult {
  const q = flagValue(argv, "--q");
  if (q === undefined || q.trim() === "") {
    return { json: { verb: "vault", subcommand: "query", error: "--q <query> is required" }, code: 64 };
  }
  const opts: QueryOpts = {
    type: flagValue(argv, "--type"),
    platform: flagValue(argv, "--platform"),
    gate: flagValue(argv, "--kind"),
  };
  const limitRaw = flagValue(argv, "--limit");
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n <= 0) return { json: { verb: "vault", subcommand: "query", error: `--limit must be a positive number (got "${limitRaw}")` }, code: 64 };
    opts.limit = Math.floor(n);
  }
  const dir = vaultDir();
  const hits = rankNotes(loadNotes(dir), q, opts);
  return {
    json: {
      verb: "vault",
      subcommand: "query",
      vault: dir,
      query: q,
      filters: { type: opts.type ?? null, platform: opts.platform ?? null, gate: opts.gate ?? null },
      count: hits.length,
      hits,
    },
    code: 0,
  };
}

/** The `vault` verb body: dispatch on the subcommand. Backs BOTH the CLI
 *  (amico.ts) and the MCP facade (mcp_serve.ts). */
export function vaultVerb(argv: string[]): VerbResult {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "query") return vaultQuery(rest);
  return {
    json: {
      verb: "vault",
      error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
      usage: 'amico vault query --q "<query>" [--type insight|experiment] [--platform <p>] [--kind <g>] [--limit <n>]',
    },
    code: 64,
  };
}
